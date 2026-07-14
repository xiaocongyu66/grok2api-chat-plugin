import Config from "../components/Config.js"
import { checkAccess } from "../lib/access.js"
import { chatCompletions } from "../lib/client.js"
import { sendForward } from "../lib/forward.js"
import { extractImageUrls } from "../lib/images.js"
import { reviewOutboundContent } from "../lib/outbound-review.js"
import { buildChatMessages } from "../lib/prompt.js"
import {
  checkCooldown,
  clearHistory,
  getHistory,
  isSessionActive,
  listActiveSessions,
  pushTurn,
  scopeKey,
  startSession,
  stopSession,
} from "../lib/session.js"

/** 指令前缀：# */
const CMD = "^[＃#]"

/** 进行中请求锁，防止同消息/同用户并发双发导致重复回复 */
const inflight = new Set()

function stripCmd(msg, ...names) {
  const re = new RegExp(`${CMD}(?:${names.join("|")})\\s*`, "i")
  return String(msg || "").replace(re, "").trim()
}

function isCommand(msg) {
  return /^[＃#]/.test(String(msg || "").trim())
}

/** 折叠「整段回复粘两次」（QQ 发出前最后一道） */
function collapseDupReply(text) {
  let s = String(text ?? "")
  if (s.length < 16) return s
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^([\s\S]+?)(?:\s*)\1\s*$/)
    if (m && m[1].trim().length >= 8) {
      s = m[1]
      continue
    }
    const paras = s.split(/\n{2,}/)
    if (paras.length >= 2 && paras.length % 2 === 0) {
      const mid = paras.length / 2
      const a = paras.slice(0, mid).join("\n\n")
      const b = paras.slice(mid).join("\n\n")
      if (a.trim() && a.trim() === b.trim()) {
        s = a
        continue
      }
    }
    break
  }
  return s
}

function inflightKey(e) {
  const msgId = e?.message_id ?? e?.seq ?? e?.rand ?? ""
  const uid = e?.user_id ?? e?.sender?.user_id ?? ""
  const gid = e?.group_id ?? "private"
  const text = String(e?.msg || e?.raw_message || "").slice(0, 80)
  return `${gid}:${uid}:${msgId || `${text}:${Math.floor(Date.now() / 2000)}`}`
}

/** 合并转发时按长度/段落拆成多条，避免单节点过长 */
function splitForForward(text, maxLen = 900) {
  const s = String(text || "")
  if (s.length <= maxLen) return [s]
  const parts = []
  // 优先按双换行
  const paras = s.split(/\n{2,}/)
  let buf = ""
  const flush = () => {
    if (buf) {
      parts.push(buf)
      buf = ""
    }
  }
  for (const p of paras) {
    const piece = p.trim()
    if (!piece) continue
    if (!buf) {
      if (piece.length <= maxLen) buf = piece
      else {
        // 硬切
        for (let i = 0; i < piece.length; i += maxLen) {
          parts.push(piece.slice(i, i + maxLen))
        }
      }
      continue
    }
    if (buf.length + 2 + piece.length <= maxLen) {
      buf = `${buf}\n\n${piece}`
    } else {
      flush()
      if (piece.length <= maxLen) buf = piece
      else {
        for (let i = 0; i < piece.length; i += maxLen) {
          parts.push(piece.slice(i, i + maxLen))
        }
      }
    }
  }
  flush()
  return parts.length ? parts : [s]
}

export class GrokChat extends plugin {
  constructor() {
    super({
      name: "Grok对话",
      dsc: "会话制对话 + 艾特询问回复（按群隔离）",
      event: "message",
      priority: 4500,
      rule: [
        { reg: `${CMD}帮助$`, fnc: "help" },
        { reg: `${CMD}开始对话$`, fnc: "start" },
        { reg: `${CMD}(停止对话|结束对话|关闭对话)$`, fnc: "stop" },
        { reg: `${CMD}(清空对话|清空记忆|重置对话)$`, fnc: "clear" },
        { reg: `${CMD}(对话|聊天)\\s*.+`, fnc: "chatCmd" },
        // 会话中：艾特询问 / 引用 / 可选主动回他人
        { reg: "^[\\s\\S]+", fnc: "freeOrActive", log: false },
      ],
    })
  }

  help() {
    const c = Config.get()
    const lines = [
      "【Grok2API 帮助】",
      "—— 对话（按群隔离）——",
      "#开始对话  仅主人；只开启【本群/本私聊】",
      "#停止对话  仅主人；只关闭【本群/本私聊】，其它群不受影响",
      "#对话 内容  会话中多轮；未开会话时" + (c.allowOneShotWithoutSession ? "可单次问答" : "需先开始"),
      "#清空对话  清空你在本群的上下文",
      "",
      "会话中自动回复（锅巴可开关）：",
      `  · 仅艾特才回：${c.replyOnAt ? "开（必须@）" : "关（会话内都回）"}`,
      `  · 艾特须带问题：${c.atReplyRequireQuestion ? "开" : "关"}`,
      `  · 引用Bot消息：${c.replyOnQuote ? "开" : "关"}`,
      `  · 强制全员闲聊：${c.activeReplyOthers ? "开" : "关"}`,
      "",
      "—— 生图 / 生视频 ——",
      "#生图 描述   #生视频 描述",
      "",
      "—— 其它 ——",
      "#模型列表  #连通测试(主人)",
      "",
      `对话传图：${c.passImages ? "开" : "关"}（发图+文字可看图回答）`,
      `本会话：${isSessionActive(this.e) ? "进行中" : "未开始"} (${scopeKey(this.e)})`,
    ]
    return this.reply(lines.join("\n"))
  }

  async start() {
    if (!this.e.isMaster) return this.reply("仅主人可以 #开始对话")
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)
    const scope = startSession(this.e)
    const where = this.e.isGroup || this.e.group_id ? `本群 ${this.e.group_id}` : "本私聊"
    const c = Config.get()
    const how = c.replyOnAt
      ? "· 仅艾特模式：请 @我 并提问"
      : "· 本群会话内直接说话即可（不必@）"
    return this.reply(
      `对话已开始（仅 ${where}）。\n` +
        `${how}\n` +
        "· #停止对话 只关这里，其它群照常\n" +
        `· 传图：${c.passImages ? "开" : "关"} · 接口：${c.chatApiMode}`,
    )
  }

  async stop() {
    if (!this.e.isMaster) return this.reply("仅主人可以 #停止对话")
    const scope = stopSession(this.e)
    const where = this.e.isGroup || this.e.group_id ? `本群 ${this.e.group_id}` : "本私聊"
    const others = listActiveSessions().filter(s => s !== scope)
    return this.reply(
      `对话已结束（仅 ${where}）。\n` +
        (others.length ? `其它仍开启：${others.length} 个会话` : "当前没有其它进行中的会话"),
    )
  }

  async clear() {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)
    clearHistory(this.e)
    return this.reply("已清空你在本会话的对话记忆")
  }

  async chatCmd() {
    const prompt = stripCmd(this.e.msg, "对话", "聊天")
    const c = Config.get()
    const imgs = c.passImages !== false ? extractImageUrls(this.e, c.passImagesMax || 4) : []
    if (!prompt && !imgs.length) return this.reply("用法：#对话 你好（可带图）")

    const active = isSessionActive(this.e)
    if (!active && !c.allowOneShotWithoutSession) {
      return this.reply("请先让主人在本群发送 #开始对话")
    }
    return this._doChat(prompt || "请描述或理解这些图片。", {
      useHistory: active,
      imageUrls: imgs,
    })
  }

  /**
   * 会话内自动回复逻辑（按群隔离）：
   * - replyOnAt=true  → 仅艾特（可选须带问题）才回
   * - replyOnAt=false → 会话内有内容就回（关闭「仅艾特」= 都回）
   * - replyOnQuote / activeReplyOthers 为补充开关
   */
  async freeOrActive() {
    if (isCommand(this.e.msg)) return false

    const c = Config.get()
    const a = checkAccess(this.e)
    if (!a.ok) return false

    // 严格按当前群/私聊的 session，不会串群
    if (!isSessionActive(this.e)) return false

    if (this.e.user_id != null && String(this.e.user_id) === String(this.e.self_id)) {
      return false
    }

    const atMe = this._isAtBot()
    const quoteMe = this._isQuoteBot()
    let prompt = this._extractQuestion(atMe)
    // 非@场景用完整消息（去掉@残留后可能为空）
    if (!prompt) {
      prompt = String(this.e.msg || this.e.raw_message || "").trim()
      prompt = prompt.replace(/\[CQ:at,[^\]]+\]/g, " ").replace(/@\S+/g, " ").replace(/\s+/g, " ").trim()
    }

    let should = false
    let atUser = false
    const inGroup = !!(this.e.isGroup || this.e.group_id)

    // 私聊
    if (!inGroup) {
      // freeChatInSession 关 = 私聊也要求有明确指令；开 = 会话内都回
      if (c.freeChatInSession !== false) {
        should = !!prompt
      }
    } else {
      // ===== 群聊 =====
      // replyOnAt=true：仅艾特模式
      if (c.replyOnAt) {
        if (atMe) {
          if (!prompt) {
            if (c.atReplyRequireQuestion !== false) {
              await this.reply("请在@我的同时说明问题，例如：@机器人 今天天气怎么样", true)
              return true
            }
            return false
          }
          should = true
          atUser = c.atReplyAtUser !== false
        } else if (quoteMe && c.replyOnQuote) {
          if (!prompt) return false
          should = true
          atUser = !!c.activeReplyAtUser
        } else if (c.activeReplyOthers) {
          // 仅艾特模式下，仍可额外打开「不@也回」
          if (!prompt) return false
          if (!checkCooldown(this.e, c.activeReplyCooldownSec)) return false
          should = true
          atUser = !!c.activeReplyAtUser
        }
      } else {
        // replyOnAt=false：关闭「仅艾特」→ 会话内有内容（文字或图）就回
        const earlyImgs =
          c.passImages !== false ? extractImageUrls(this.e, c.passImagesMax || 4) : []
        if (!prompt && !earlyImgs.length) return false
        if (c.activeReplyCooldownSec > 0 && !checkCooldown(this.e, c.activeReplyCooldownSec)) {
          return false
        }
        should = true
        atUser = atMe ? c.atReplyAtUser !== false : !!c.activeReplyAtUser
      }
    }

    const imgs = c.passImages !== false ? extractImageUrls(this.e, c.passImagesMax || 4) : []
    // 允许「只发图不说话」在开启传图时触发
    if (!should) return false
    if (!prompt && !imgs.length) return false
    if (!prompt && imgs.length) prompt = "请描述或理解这些图片。"

    return this._doChat(prompt, {
      useHistory: true,
      atUser: inGroup && atUser,
      imageUrls: imgs,
    })
  }

  /** 更稳的艾特检测（OneBot / NapCat） */
  _isAtBot() {
    try {
      if (this.e.atBot || this.e.atme) return true
      const self = String(this.e.self_id || this.e.bot?.uin || "")
      if (this.e.at != null && String(this.e.at) === self) return true
      // message 段
      const segs = this.e.message
      if (Array.isArray(segs)) {
        for (const m of segs) {
          if (m?.type === "at") {
            const qq = String(m.qq ?? m.data?.qq ?? m.id ?? "")
            if (qq && (qq === self || qq === "all")) {
              if (qq === "all") continue // @全体不算问机器人
              return true
            }
          }
        }
      }
      // raw_message 兜底
      const raw = String(this.e.raw_message || this.e.msg || "")
      if (self && raw.includes(`[CQ:at,qq=${self}`)) return true
    } catch {
      /* ignore */
    }
    return false
  }

  _isQuoteBot() {
    try {
      const self = String(this.e.self_id || "")
      const src = this.e.source
      if (src) {
        const uid = src.user_id ?? src.qq ?? src.from_id
        if (uid != null && String(uid) === self) return true
      }
    } catch {
      /* ignore */
    }
    return false
  }

  /** 去掉 @CQ 与 @昵称，得到真正问句 */
  _extractQuestion(atMe) {
    let text = String(this.e.msg || this.e.raw_message || "").trim()
    // 去 CQ at
    text = text.replace(/\[CQ:at,[^\]]+\]/g, " ")
    // 去 @xxx
    text = text.replace(/@\S+/g, " ")
    text = text.replace(/\s+/g, " ").trim()
    return text
  }

  async _doChat(prompt, { useHistory = true, atUser = false, imageUrls = [] } = {}) {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)

    const lock = inflightKey(this.e)
    if (inflight.has(lock)) {
      logger?.debug?.(`[grok2api-chat-plugin] skip duplicate inflight: ${lock}`)
      return true
    }
    inflight.add(lock)

    const c = Config.get()
    const imgs =
      c.passImages !== false && Array.isArray(imageUrls) && imageUrls.length
        ? imageUrls.slice(0, c.passImagesMax || 4)
        : []
    if (!prompt && !imgs.length) {
      inflight.delete(lock)
      return false
    }

    const hist = useHistory ? getHistory(this.e) : []
    const messages = buildChatMessages(this.e, prompt || "", hist, imgs)

    try {
      // 严格走 OpenAI Chat Completions（由 chatApiMode 控制，默认 chat）
      const { content: rawContent, api, model } = await chatCompletions({ messages })
      // 二次保险：若上游/解析仍把整段拼了两遍，发 QQ 前再折叠
      let content = String(rawContent || "")
      content = collapseDupReply(content)
      logger?.info?.(
        `[grok2api-chat-plugin] chat ok api=${api} model=${model} len=${content.length}`,
      )
      // 历史只记文本；有图时加标记
      const histUser =
        imgs.length > 0
          ? `${prompt || ""}`.trim() + (prompt ? "\n" : "") + `[用户发送了${imgs.length}张图片]`
          : prompt
      if (useHistory) pushTurn(this.e, histUser, content, c.maxHistory)

      // 模块 B：出站审查 — 群聊 + 私聊均生效（与 ST 成年内容拆开）
      const channel =
        this.e.isPrivate || this.e.message_type === "private" || !this.e.group_id
          ? "private"
          : "group"
      const nsfwCheck = await reviewOutboundContent(content, c, { channel })
      const tooLong =
        c.chatForwardThreshold > 0 && content.length >= c.chatForwardThreshold

      if (nsfwCheck.forward || tooLong) {
        const title = nsfwCheck.forward
          ? `Grok 对话（出站审查·合并发送·${channel === "private" ? "私聊" : "群"}）`
          : "Grok 对话"
        if (nsfwCheck.forward) {
          logger?.info?.(
            `[grok2api-chat-plugin] 出站审查合并转发 channel=${channel} method=${nsfwCheck.method} score=${nsfwCheck.score} hits=${(nsfwCheck.hits || []).slice(0, 5).join(",")}`,
          )
        }
        const chunks = splitForForward(content, 900)
        await sendForward(this.e, chunks, title)
      } else {
        await this.reply(content, !!atUser)
      }
    } catch (err) {
      logger.error(`[grok2api-chat-plugin] chat: ${err.stack || err}`)
      return this.reply(`对话失败：${err.message}`)
    } finally {
      inflight.delete(lock)
    }
    return true
  }
}
