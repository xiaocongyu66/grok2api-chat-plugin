import Config from "../components/Config.js"
import { checkAccess } from "../lib/access.js"
import {
  listModels,
  healthCheck,
  chatCompletions,
  normalizeApiBase,
  probeV1Capabilities,
} from "../lib/client.js"
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
    const base = normalizeApiBase(c.apiBase)
    const lines = [
      `apiBase: ${base || "(空)"}`,
      `apiKey: ${c.apiKey ? c.apiKey.slice(0, 8) + "…" : "(空)"}`,
      `auth: ${c.authHeaderMode}  retries=${c.requestRetries}  tlsInsecure=${!!c.tlsInsecure}`,
      `chatModel: ${c.chatModel}  mode=${c.chatApiMode}`,
      `image: ${c.imageModel}  edit: ${c.imageEditModel}`,
      `video: ${c.videoModel}`,
      `session: ${isSessionActive(this.e) ? "on" : "off"}`,
    ]

    try {
      const h = await healthCheck()
      if (h.healthz?.ok) lines.push(`GET /healthz → OK`)
      else if (h.healthz?.error) lines.push(`GET /healthz → ${String(h.healthz.error).slice(0, 100)}`)
      if (h.readyz?.ok) lines.push(`GET /readyz → OK`)
      else if (h.readyz?.error) lines.push(`GET /readyz → ${String(h.readyz.error).slice(0, 100)}`)
    } catch (err) {
      lines.push(`health: ${err.message}`)
    }

    try {
      const cap = await probeV1Capabilities()
      for (const [name, st] of Object.entries(cap.endpoints || {})) {
        if (st.ok) lines.push(`${name} → OK${st.note ? ` (${st.note})` : ""}`)
        else lines.push(`${name} → FAIL: ${st.error || "?"}`)
      }
    } catch (err) {
      lines.push(`probe v1: ${err.message}`)
    }

    // real chat completions sample (not just route probe)
    try {
      const r = await chatCompletions({
        messages: [{ role: "user", content: "ping" }],
        skipJailbreak: true,
        skipAdult: true,
        allowEmptyContent: true,
      })
      const preview = String(r.content || "")
        .replace(/\s+/g, " ")
        .slice(0, 60)
      lines.push(
        `chat sample → OK api=${r.api} model=${r.model} ${preview || "(empty)"}`,
      )
    } catch (err) {
      lines.push(`chat sample → FAIL: ${err.message}`)
    }

    return this.reply(lines.join("\n"))
  }
}
