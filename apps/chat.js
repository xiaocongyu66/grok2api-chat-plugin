import Config from "../components/Config.js"
import { checkAccess } from "../lib/access.js"
import { chatCompletions, chatWithMediaTools } from "../lib/client.js"
import { sendForward, sendImagesForward, sendVideoForward } from "../lib/forward.js"
import { extractImageUrls } from "../lib/images.js"
import { buildMediaToolDefs } from "../lib/media-tools.js"
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

/** 是否私聊（非群） */
function isPrivateChat(e) {
  if (e?.isPrivate || e?.message_type === "private") return true
  if (e?.isGroup || e?.message_type === "group") return false
  // 无 group_id 视为私聊
  return e?.group_id == null || e?.group_id === ""
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
    const privOn = c.privateChatEnable !== false
    const privSelf = privOn && c.privateSessionSelfStart !== false
    const lines = [
      "【Grok2API 帮助】",
      "—— 对话 ——",
      "#开始对话  群：仅主人；私聊：" +
        (privOn ? (privSelf ? "你自己可开/关" : "仅主人可开") : "已关闭"),
      "#停止对话  群：仅主人；私聊：" +
        (privOn ? (privSelf ? "你自己可开/关" : "仅主人可关") : "已关闭"),
      "#对话 内容  会话中多轮；未开会话时" + (c.allowOneShotWithoutSession ? "可单次问答" : "需先开始"),
      "#清空对话  清空你在本会话的上下文",
      "",
      "群内自动回复（锅巴可开关）：",
      `  · 仅艾特才回：${c.replyOnAt ? "开（必须@）" : "关（会话内都回）"}`,
      `  · 艾特须带问题：${c.atReplyRequireQuestion ? "开" : "关"}`,
      `  · 引用Bot消息：${c.replyOnQuote ? "开" : "关"}`,
      `  · 强制全员闲聊：${c.activeReplyOthers ? "开" : "关"}`,
      "",
      "—— 生图 / 生视频 ——",
      "#生图 描述   #生视频 描述",
      "会话中也可直接说「画一只猫/做个视频…」，模型会当工具调用生成，结果合并转发",
      "",
      "—— 其它 ——",
      "#模型列表  #连通测试(主人)",
      "",
      `对话传图：${c.passImages ? "开" : "关"} · 对话工具：${c.chatToolsEnable !== false ? "开" : "关"}`,
      `本会话：${isSessionActive(this.e) ? "进行中" : "未开始"} (${scopeKey(this.e)})`,
    ]
    return this.reply(lines.join("\n"))
  }

  /**
   * 权限：
   * - 群：仅主人可开/关
   * - 私聊：先看 privateChatEnable；再看 privateSessionSelfStart（用户自开）
   */
  _canControlSession() {
    const c = Config.get()
    if (isPrivateChat(this.e) && c.privateChatEnable === false) {
      return { ok: false, msg: "私聊功能已关闭（锅巴 → 是否支持私聊）" }
    }
    if (this.e.isMaster) return { ok: true }
    if (isPrivateChat(this.e) && c.privateSessionSelfStart !== false) {
      return { ok: true }
    }
    if (isPrivateChat(this.e)) {
      return { ok: false, msg: "私聊需主人开启会话（锅巴已关「私聊用户可自己开/关」）" }
    }
    return { ok: false, msg: "群内仅主人可以 #开始对话 / #停止对话" }
  }

  async start() {
    const perm = this._canControlSession()
    if (!perm.ok) return this.reply(perm.msg)
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)
    startSession(this.e)
    const priv = isPrivateChat(this.e)
    const where = priv ? "本私聊" : `本群 ${this.e.group_id}`
    const c = Config.get()
    let how
    if (priv) {
      how =
        c.freeChatInSession !== false
          ? "· 直接发消息即可继续聊（不必指令）"
          : "· 请用 #对话 内容 继续"
    } else {
      how = c.replyOnAt
        ? "· 仅艾特模式：请 @我 并提问"
        : "· 本群会话内直接说话即可（不必@）"
    }
    return this.reply(
      `对话已开始（仅 ${where}）。\n` +
        `${how}\n` +
        (priv
          ? "· #停止对话 结束本私聊会话\n"
          : "· #停止对话 只关本群，其它群照常\n") +
        `· 传图：${c.passImages ? "开" : "关"} · 接口：${c.chatApiMode}`,
    )
  }

  async stop() {
    const perm = this._canControlSession()
    if (!perm.ok) return this.reply(perm.msg)
    const scope = stopSession(this.e)
    const priv = isPrivateChat(this.e)
    const where = priv ? "本私聊" : `本群 ${this.e.group_id}`
    const others = listActiveSessions().filter(s => s !== scope)
    return this.reply(
      `对话已结束（仅 ${where}）。\n` +
        (others.length
          ? `其它仍开启：${others.length} 个会话`
          : "当前没有其它进行中的会话"),
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
      if (isPrivateChat(this.e) && c.privateSessionSelfStart !== false) {
        return this.reply("请先发送 #开始对话（私聊可由你自己开启）")
      }
      return this.reply(
        isPrivateChat(this.e)
          ? "请先 #开始对话（或联系主人开启）"
          : "请先让主人在本群发送 #开始对话",
      )
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
      // 对话可挂载生图/生视频 tools；结果一律合并聊天记录转发
      const tools =
        c.chatToolsEnable !== false ? buildMediaToolDefs(c) : []
      let content = ""
      let api = "chat"
      let model = c.chatModel
      let mediaResults = []

      if (tools.length) {
        try {
          const r = await chatWithMediaTools({
            messages,
            tools,
            imageUrls: imgs,
            maxRounds: c.chatToolMaxRounds || 3,
            onToolStart: (name, args) => {
              logger?.info?.(
                `[grok2api-chat-plugin] tool start ${name} prompt=${String(args?.prompt || "").slice(0, 80)}`,
              )
              this.reply(
                name === "generate_video"
                  ? "正在用工具生成视频，请稍候…"
                  : "正在用工具生成图片，请稍候…",
                false,
                { recallMsg: 30 },
              ).catch(() => {})
            },
          })
          content = collapseDupReply(String(r.content || ""))
          mediaResults = r.mediaResults || []
          api = r.api
          model = r.model
        } catch (toolErr) {
          // 上游不支持 tools 时回退纯文本对话
          logger?.warn?.(
            `[grok2api-chat-plugin] tools 失败，回退纯对话: ${toolErr.message}`,
          )
          const r = await chatCompletions({ messages })
          content = collapseDupReply(String(r.content || ""))
          api = r.api
          model = r.model
        }
      } else {
        const r = await chatCompletions({ messages })
        content = collapseDupReply(String(r.content || ""))
        api = r.api
        model = r.model
      }

      logger?.info?.(
        `[grok2api-chat-plugin] chat ok api=${api} model=${model} len=${content.length} media=${mediaResults.length}`,
      )

      // 历史只记文本；有图时加标记；工具调用记摘要
      let histUser =
        imgs.length > 0
          ? `${prompt || ""}`.trim() + (prompt ? "\n" : "") + `[用户发送了${imgs.length}张图片]`
          : prompt
      let histAsst = content
      if (mediaResults.length) {
        const note = mediaResults
          .map(m =>
            m.type === "image"
              ? `[生成图片×${(m.urls || []).length}]`
              : `[生成视频]`,
          )
          .join(" ")
        histAsst = `${content}\n${note}`.trim()
      }
      if (useHistory) pushTurn(this.e, histUser, histAsst, c.maxHistory)

      // 1) 媒体工具结果 → 合并聊天记录转发
      for (const m of mediaResults) {
        if (m.type === "image" && m.urls?.length) {
          await sendImagesForward(
            this.e,
            m.urls,
            m.userPrompt ? `提示：${m.userPrompt}` : "",
          )
        } else if (m.type === "video" && m.url) {
          await sendVideoForward(this.e, m.url, {
            prompt: m.userPrompt,
            duration: m.duration,
          })
        }
      }

      // 2) 文本：出站审查（群+私聊）/ 长文 → 合并转发
      if (content.trim()) {
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
              `[grok2api-chat-plugin] 出站审查合并转发 channel=${channel} method=${nsfwCheck.method} score=${nsfwCheck.score}`,
            )
          }
          await sendForward(this.e, splitForForward(content, 900), title)
        } else {
          await this.reply(content, !!atUser)
        }
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
