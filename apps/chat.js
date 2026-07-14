import Config from "../components/Config.js"
import { checkAccess } from "../lib/access.js"
import { chatCompletions } from "../lib/client.js"
import { sendForward } from "../lib/forward.js"
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

function stripCmd(msg, ...names) {
  const re = new RegExp(`${CMD}(?:${names.join("|")})\\s*`, "i")
  return String(msg || "").replace(re, "").trim()
}

function isCommand(msg) {
  return /^[＃#]/.test(String(msg || "").trim())
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
      `  · 艾特询问回复：${c.replyOnAt ? "开" : "关"}`,
      `  · 艾特须带问题：${c.atReplyRequireQuestion ? "开" : "关"}`,
      `  · 引用Bot消息：${c.replyOnQuote ? "开" : "关"}`,
      `  · 不@也回别人：${c.activeReplyOthers ? "开" : "关"}`,
      "",
      "—— 生图 / 生视频 ——",
      "#生图 描述   #生视频 描述",
      "",
      "—— 其它 ——",
      "#模型列表  #连通测试(主人)",
      "",
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
    return this.reply(
      `对话已开始（仅 ${where}）。\n` +
        "· @我并提问 即可回复\n" +
        "· #停止对话 只关这里，其它群照常\n" +
        `· scope=${scope}`,
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
    if (!prompt) return this.reply("用法：#对话 你好")

    const c = Config.get()
    const active = isSessionActive(this.e)
    if (!active && !c.allowOneShotWithoutSession) {
      return this.reply("请先让主人在本群发送 #开始对话")
    }
    return this._doChat(prompt, { useHistory: active })
  }

  /**
   * 会话内：@询问优先；可选引用；可选主动回他人
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

    let should = false
    let atUser = false
    const inGroup = !!(this.e.isGroup || this.e.group_id)

    // 私聊：会话中直接接话（freeChatInSession）
    if (!inGroup) {
      if (c.freeChatInSession) should = true
    } else {
      // 群：【艾特询问回复】开关 replyOnAt
      if (atMe && c.replyOnAt) {
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
        if (!prompt) return false
        if (!checkCooldown(this.e, c.activeReplyCooldownSec)) return false
        should = true
        atUser = !!c.activeReplyAtUser
      }
    }

    if (!should || !prompt) return false

    return this._doChat(prompt, {
      useHistory: true,
      atUser: inGroup && atUser,
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

  async _doChat(prompt, { useHistory = true, atUser = false } = {}) {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)
    if (!prompt) return false

    const c = Config.get()
    const hist = useHistory ? getHistory(this.e) : []
    const messages = buildChatMessages(this.e, prompt, hist)

    try {
      const { content } = await chatCompletions({ messages })
      if (useHistory) pushTurn(this.e, prompt, content, c.maxHistory)

      if (c.chatForwardThreshold > 0 && content.length >= c.chatForwardThreshold) {
        await sendForward(this.e, [content], "Grok 对话")
      } else {
        await this.reply(content, !!atUser)
      }
    } catch (err) {
      logger.error(`[grok2api-chat-plugin] chat: ${err.stack || err}`)
      return this.reply(`对话失败：${err.message}`)
    }
    return true
  }
}
