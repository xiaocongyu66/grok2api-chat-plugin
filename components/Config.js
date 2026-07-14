import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { Plugin_Path } from "./path.js"

const defPath = path.join(Plugin_Path, "config/default_config/config.yaml")
const cfgPath = path.join(Plugin_Path, "config/config/config.yaml")

function loadYamlLib() {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"))
    return require("yaml")
  } catch {
    try {
      return createRequire(import.meta.url)("yaml")
    } catch {
      return null
    }
  }
}

const YAML = loadYamlLib()

function simpleParse(text) {
  const out = {}
  let listKey = null
  let multiKey = null
  let multiLines = []
  const flushMulti = () => {
    if (multiKey != null) {
      out[multiKey] = multiLines.join("\n").replace(/\n$/, "")
      multiKey = null
      multiLines = []
    }
  }
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (multiKey != null) {
      // 块标量：仅接受缩进行；顶格 key / 注释 / 空顶格则结束
      if (raw === "" || /^\s/.test(raw)) {
        if (/^\s+#/.test(raw) || raw.trim() === "") {
          // 块内空行保留；纯注释缩进行跳过
          if (raw.trim() === "") multiLines.push("")
        } else {
          multiLines.push(raw.replace(/^\s{2}/, "").replace(/^\t/, ""))
        }
        continue
      }
      flushMulti()
      // fall through 解析本行
    }
    if (/^\s*#/.test(raw)) continue
    const line = raw.replace(/(^|[^:])\s+#.*$/, "$1")
    if (!line.trim()) continue
    const mList = line.match(/^([A-Za-z0-9_]+):\s*\[\s*\]\s*$/)
    if (mList) {
      out[mList[1]] = []
      listKey = null
      continue
    }
    const mBlock = line.match(/^([A-Za-z0-9_]+):\s*\|\s*$/)
    if (mBlock) {
      multiKey = mBlock[1]
      multiLines = []
      listKey = null
      continue
    }
    const mKey = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (mKey) {
      listKey = null
      const k = mKey[1]
      let v = mKey[2].trim()
      if (v === "") {
        listKey = k
        out[k] = out[k] || []
        continue
      }
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (v === "true") out[k] = true
      else if (v === "false") out[k] = false
      else if (v === "[]") out[k] = []
      else if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v)
      else out[k] = v
      continue
    }
    const mItem = line.match(/^\s*-\s*(.*)$/)
    if (mItem && listKey) {
      let v = mItem[1].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (!Array.isArray(out[listKey])) out[listKey] = []
      out[listKey].push(v)
    }
  }
  flushMulti()
  return out
}

function simpleStringify(obj) {
  const lines = ["# grok2api-chat-plugin config", ""]
  for (const [k, v] of Object.entries(obj || {})) {
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${k}: []`)
      else {
        lines.push(`${k}:`)
        for (const item of v) lines.push(`  - ${JSON.stringify(String(item))}`)
      }
    } else if (typeof v === "boolean" || typeof v === "number") {
      lines.push(`${k}: ${v}`)
    } else if (v == null) {
      lines.push(`${k}: ""`)
    } else {
      const s = String(v)
      if (s.includes("\n")) {
        lines.push(`${k}: |`)
        for (const ln of s.split("\n")) lines.push(`  ${ln}`)
      } else if (/[:#"'\\]/.test(s) || s === "") {
        lines.push(`${k}: ${JSON.stringify(s)}`)
      } else {
        lines.push(`${k}: ${s}`)
      }
    }
  }
  return lines.join("\n") + "\n"
}

function parseYaml(text) {
  if (YAML?.parse) return YAML.parse(text) || {}
  return simpleParse(text)
}

function stringifyYaml(obj) {
  if (YAML?.stringify) return YAML.stringify(obj)
  return simpleStringify(obj)
}

function merge(a, b) {
  return { ...(a || {}), ...(b || {}) }
}

function ensureConfig() {
  const dir = path.dirname(cfgPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(cfgPath)) {
    fs.copyFileSync(defPath, cfgPath)
  } else {
    try {
      const def = parseYaml(fs.readFileSync(defPath, "utf8"))
      const cur = parseYaml(fs.readFileSync(cfgPath, "utf8"))
      const next = merge(def, cur)
      let missing = false
      for (const k of Object.keys(def)) {
        if (!(k in cur)) missing = true
      }
      if (missing) fs.writeFileSync(cfgPath, stringifyYaml(next), "utf8")
    } catch {
      /* ignore */
    }
  }
}

function str(v, d = "") {
  return v == null ? d : String(v)
}

class Config {
  constructor() {
    ensureConfig()
  }

  get raw() {
    ensureConfig()
    try {
      return parseYaml(fs.readFileSync(cfgPath, "utf8"))
    } catch (e) {
      logger?.error?.(`[grok2api-chat-plugin] 读取配置失败: ${e.message}`)
      return parseYaml(fs.readFileSync(defPath, "utf8"))
    }
  }

  get() {
    const c = this.raw
    // 兼容旧字段 systemPrompt
    const chatSystemPrompt = str(c.chatSystemPrompt || c.systemPrompt, "你是有用的助手。")
    return {
      enable: c.enable !== false,
      apiBase: str(c.apiBase).replace(/\/+$/, ""),
      apiKey: str(c.apiKey).trim(),
      chatModel: str(c.chatModel, "auto").trim(),
      // chat（默认，严格 OpenAI）| responses | auto（auto=先 chat 失败再 responses）
      chatApiMode: (() => {
        const m = str(c.chatApiMode, "chat").trim().toLowerCase()
        if (m === "responses" || m === "response") return "responses"
        if (m === "auto") return "auto"
        // chat | completions | chat_completions | 其它一律 chat
        return "chat"
      })(),
      // 对话是否把用户消息里的图片传给模型（多模态）
      passImages: c.passImages !== false,
      passImagesMax: Math.min(8, Math.max(1, Number(c.passImagesMax) || 4)),
      // 对话内 OpenAI tools：生图/生视频
      chatToolsEnable: c.chatToolsEnable !== false,
      chatToolImage: c.chatToolImage !== false,
      chatToolVideo: c.chatToolVideo !== false,
      chatToolMaxRounds: Math.min(5, Math.max(1, Number(c.chatToolMaxRounds) || 3)),
      imageModel: str(c.imageModel, "grok-imagine-image").trim(),
      videoModel: str(c.videoModel, "grok-imagine-video").trim(),
      timeoutMs: Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 180000,
      videoPollIntervalSec: Number(c.videoPollIntervalSec) > 0 ? Number(c.videoPollIntervalSec) : 5,
      videoPollMaxSec: Number(c.videoPollMaxSec) > 0 ? Number(c.videoPollMaxSec) : 600,
      videoDuration: Math.min(15, Math.max(1, Number(c.videoDuration) || 8)),
      videoAspectRatio: str(c.videoAspectRatio, "16:9"),
      videoResolution: str(c.videoResolution, "720p"),
      imageN: Math.min(10, Math.max(1, Number(c.imageN) || 1)),
      imageSize: str(c.imageSize).trim(),
      imageAspectRatio: str(c.imageAspectRatio).trim(),
      maxHistory: Math.min(200, Math.max(4, Number(c.maxHistory) || 24)),
      contextCompressMaxChars: Math.min(
        8000,
        Math.max(400, Number(c.contextCompressMaxChars) || 1500),
      ),
      sessionPersist: c.sessionPersist !== false,
      chatSystemPrompt,
      imagePromptPrefix: str(c.imagePromptPrefix),
      imagePromptSuffix: str(c.imagePromptSuffix),
      imageNsfwEnable: c.imageNsfwEnable !== false,
      imageNsfwPrompt: str(c.imageNsfwPrompt),
      videoPromptPrefix: str(c.videoPromptPrefix),
      videoPromptSuffix: str(c.videoPromptSuffix),
      videoNsfwEnable: c.videoNsfwEnable !== false,
      videoNsfwPrompt: str(c.videoNsfwPrompt),
      // 是否支持私聊（总开关）；关=私聊对话/生图/生视频均不可用
      privateChatEnable: c.privateChatEnable !== false,
      // 私聊：用户自己 #开始对话 / #停止对话（默认开）；群仍仅主人
      privateSessionSelfStart: c.privateSessionSelfStart !== false,
      allowOneShotWithoutSession: c.allowOneShotWithoutSession !== false,
      freeChatInSession: c.freeChatInSession !== false,
      // 仅艾特才回：true=必须@；false/未配置=会话内都回
      replyOnAt: !!c.replyOnAt,
      atReplyRequireQuestion: c.atReplyRequireQuestion !== false,
      atReplyAtUser: c.atReplyAtUser !== false,
      replyOnQuote: c.replyOnQuote !== false,
      activeReplyOthers: !!c.activeReplyOthers,
      activeReplyCooldownSec: Math.max(0, Number(c.activeReplyCooldownSec) || 8),
      activeReplyAtUser: !!c.activeReplyAtUser,
      masterOnly: !!c.masterOnly,
      groupBlacklist: Array.isArray(c.groupBlacklist) ? c.groupBlacklist.map(String) : [],
      groupWhitelist: Array.isArray(c.groupWhitelist) ? c.groupWhitelist.map(String) : [],
      forwardNickname: str(c.forwardNickname, "Grok"),
      chatForwardThreshold: Number(c.chatForwardThreshold) >= 0 ? Number(c.chatForwardThreshold) : 800,
      // 模块 A：SillyTavern 成年内容（对话/图/视频）
      adultContentEnable: c.adultContentEnable !== false && c.chatJailbreakEnable !== false,
      chatJailbreakEnable: c.chatJailbreakEnable !== false && c.adultContentEnable !== false,
      // 模块 B：出站审查（默认群+私聊）
      outboundReviewEnable: c.outboundReviewEnable !== false && c.chatNsfwForward !== false,
      outboundReviewAi: c.outboundReviewAi !== false && c.chatNsfwAiReview !== false,
      outboundReviewScope: (() => {
        const s = str(c.outboundReviewScope, "all").trim().toLowerCase()
        if (s === "group" || s === "private") return s
        return "all"
      })(),
      outboundReviewModel: str(c.outboundReviewModel || c.chatNsfwAiModel, "auto").trim(),
      outboundReviewExtraKeywords: str(
        c.outboundReviewExtraKeywords || c.chatNsfwExtraKeywords,
      ),
      // 兼容旧键
      chatNsfwForward: c.chatNsfwForward !== false && c.outboundReviewEnable !== false,
      chatNsfwAiReview: c.chatNsfwAiReview !== false && c.outboundReviewAi !== false,
      chatNsfwExtraKeywords: str(c.chatNsfwExtraKeywords || c.outboundReviewExtraKeywords),
      chatNsfwAiModel: str(c.chatNsfwAiModel || c.outboundReviewModel, "auto").trim(),
    }
  }

  setAll(data = {}) {
    ensureConfig()
    const def = parseYaml(fs.readFileSync(defPath, "utf8"))
    const next = merge(def, data)
    fs.writeFileSync(cfgPath, stringifyYaml(next), "utf8")
    return next
  }
}

export default new Config()
