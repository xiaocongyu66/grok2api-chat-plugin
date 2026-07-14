import Config from "../components/Config.js"
import { checkAccess } from "../lib/access.js"
import { listModels } from "../lib/client.js"
import { sendForward } from "../lib/forward.js"
import { isSessionActive } from "../lib/session.js"

const CMD = "^[＃#]"

export class GrokTools extends plugin {
  constructor() {
    super({
      name: "Grok工具",
      dsc: "模型列表与连通",
      event: "message",
      priority: 4300,
      rule: [
        { reg: `${CMD}(模型列表|模型)$`, fnc: "models" },
        { reg: `${CMD}(连通测试|测试连通)$`, fnc: "ping" },
      ],
    })
  }

  async models() {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)
    try {
      const data = await listModels()
      const list = Array.isArray(data?.data) ? data.data : []
      const ids = list.map(m => m.id || m.model).filter(Boolean)
      if (!ids.length) return this.reply("模型列表为空")
      const lines = ids.map((id, i) => `${i + 1}. ${id}`)
      if (lines.length > 30) await sendForward(this.e, [lines.join("\n")], "模型列表")
      else await this.reply(`可用模型（${ids.length}）:\n${lines.join("\n")}`)
    } catch (err) {
      return this.reply(`拉取模型失败：${err.message}`)
    }
    return true
  }

  async ping() {
    if (!this.e.isMaster) return this.reply("仅主人可测试")
    const c = Config.get()
    const lines = [
      `apiBase: ${c.apiBase || "(空)"}`,
      `apiKey: ${c.apiKey ? c.apiKey.slice(0, 8) + "…" : "(空)"}`,
      `chatModel: ${c.chatModel}`,
      `chatApiMode: ${c.chatApiMode}`,
      `image: ${c.imageModel} nsfw=${c.imageNsfwEnable}`,
      `video: ${c.videoModel} nsfw=${c.videoNsfwEnable}`,
      `session: ${isSessionActive(this.e) ? "on" : "off"}`,
      `activeReplyOthers: ${c.activeReplyOthers}`,
      `replyOnAt: ${c.replyOnAt} replyOnQuote: ${c.replyOnQuote}`,
    ]
    try {
      const data = await listModels()
      const ids = (data?.data || []).map(m => m.id).filter(Boolean)
      lines.push(`GET /v1/models → OK (${ids.length}): ${ids.join(", ") || "(空)"}`)
      if (!ids.length) lines.push("⚠ 列表为空：请在 grok2api 导入账号并启用模型")
    } catch (err) {
      lines.push(`GET /v1/models → FAIL: ${err.message}`)
    }
    return this.reply(lines.join("\n"))
  }
}
