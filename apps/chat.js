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
  pushTurn,
  startSession,
  stopSession,
} from "../lib/session.js"

/** 指令前缀：/ 或 # */
const CMD = "^[/＃#]"

function stripCmd(msg, ...names) {
  const re = new RegExp(`${CMD}(?:${names.join("|")})\\s*`, "i")
  return String(msg || "").replace(re, "").trim()
}

function isCommand(msg) {
  return /^[/＃#]/.test(String(msg || "").trim())
}

export class GrokChat extends plugin {
  constructor() {
    super({
      name: "Grok对话",
      dsc: "会话制对话 + 主动回复",
      event: "message",
      priority: 4500,
      rule: [
        { reg: `${CMD}帮助$`, fnc: "help" },
        { reg: `${CMD}开始对话$`, fnc: "start" },
        { reg: `${CMD}(结束对话|关闭对话|停止对话)$`, fnc: "stop" },
        { reg: `${CMD}(清空对话|清空记忆|重置对话)$`, fnc: "clear" },
        // 显式单次/继续对话
        { reg: `${CMD}(对话|聊天)\\s*.+`, fnc: "chatCmd" },
        // 会话中自由聊 + 主动回复他人（最低优，最后匹配）
        { reg: "^[\\s\\S]+", fnc: "freeOrActive", log: false },
      ],
    })
  }

  help() {
    const c = Config.get()
    const lines = [
      "【Grok2API 帮助】",
      "—— 对话 ——",
      "/开始对话  仅主人可开（开后本群/私聊进入会话）",
      "/结束对话  仅主人",
      "/对话 内容  会话中多轮；未开会话时" + (c.allowOneShotWithoutSession ? "可单次问答" : "不可用"),
      "/清空对话  清空你的上下文",
      "会话中：可直接说话；@" + (c.replyOnAt ? "开" : "关") +
        " 引用Bot" + (c.replyOnQuote ? "开" : "关") +
        " 主动回他人" + (c.activeReplyOthers ? "开" : "关"),
      "",
      "—— 生图（合并转发，支持 NSFW 后台提示）——",
      "/生图 描述",
      "例：/生图 帮我生成雷电将军的裸照",
      "",
      "—— 生视频（合并转发）——",
      "/生视频 描述",
      "",
      "—— 其它 ——",
      "/模型列表  /连通测试(主人)",
      "",
      "※ 系统/生图/生视频提示词一律以后台（锅巴）为准，用户无法覆盖。",
      `会话状态：${isSessionActive(this.e) ? "进行中" : "未开始"}`,
    ]
    return this.reply(lines.join("\n"))
  }

  async start() {
    if (!this.e.isMaster) return this.reply("仅主人可以 /开始对话")
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)
    startSession(this.e)
    return this.reply(
      "对话已开始。\n" +
        "· 直接说话即可多轮聊天\n" +
        "· /结束对话 关闭\n" +
        "· 系统提示词仅由锅巴后台控制",
    )
  }

  async stop() {
    if (!this.e.isMaster) return this.reply("仅主人可以结束对话")
    stopSession(this.e)
    return this.reply("对话已结束，上下文已清理")
  }

  async clear() {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)
    clearHistory(this.e)
    return this.reply("已清空你的对话记忆")
  }

  async chatCmd() {
    const prompt = stripCmd(this.e.msg, "对话", "聊天")
    if (!prompt) return this.reply("用法：/对话 你好")

    const c = Config.get()
    const active = isSessionActive(this.e)
    if (!active && !c.allowOneShotWithoutSession) {
      return this.reply("请先让主人发送 /开始对话")
    }
    return this._doChat(prompt, { useHistory: active })
  }

  /**
   * 会话自由聊 / @ / 引用 / 主动回复他人
   */
  async freeOrActive() {
    if (isCommand(this.e.msg)) return false // 交给其它指令

    const c = Config.get()
    const a = checkAccess(this.e)
    if (!a.ok) return false

    const active = isSessionActive(this.e)
    if (!active) return false

    const text = String(this.e.msg || "").trim()
    if (!text) return false

    // 机器人自己
    if (this.e.user_id === this.e.self_id) return false

    const atMe = !!(this.e.atBot || this.e.atme || this.e.at === this.e.self_id)
    const quoteMe = this._isQuoteBot()

    let should = false
    if (c.freeChatInSession && !this.e.isGroup) {
      // 私聊会话：默认接话
      should = true
    } else if (atMe && c.replyOnAt) {
      should = true
    } else if (quoteMe && c.replyOnQuote) {
      should = true
    } else if (c.activeReplyOthers && this.e.isGroup) {
      // 主动回复他人普通消息
      if (!checkCooldown(this.e, c.activeReplyCooldownSec)) return false
      should = true
    } else if (c.freeChatInSession && this.e.isGroup && (atMe || quoteMe)) {
      should = true
    }

    if (!should) return false

    // 去掉 @ 文本里的机器人昵称残留
    let prompt = text
    if (atMe) {
      prompt = prompt.replace(/@\S+\s*/g, "").trim() || text
    }
    return this._doChat(prompt, {
      useHistory: true,
      atUser: c.activeReplyAtUser && this.e.isGroup,
    })
  }

  _isQuoteBot() {
    try {
      const src = this.e.source || this.e.reply_id
      if (!src) return false
      // 部分协议：source.user_id / source.qq
      const uid = src.user_id || src.qq || src.from_id
      if (uid && String(uid) === String(this.e.self_id)) return true
      // 有 reply 段
      if (this.e.message?.some?.(m => m.type === "reply")) {
        // 无法可靠判断时：若配置了 replyOnQuote 且存在 reply，尝试当引用处理
        // 更稳妥：仅当 source 指向 bot
        return !!uid && String(uid) === String(this.e.self_id)
      }
    } catch {
      /* ignore */
    }
    return false
  }

  async _doChat(prompt, { useHistory = true, atUser = false } = {}) {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)
    if (!prompt) return false

    const c = Config.get()
    const hist = useHistory ? getHistory(this.e) : []
    // 始终后台 system，不使用用户自定义 system
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
