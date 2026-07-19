/**
 * OpenAI-compatible HTTP client.
 * Primary (default): POST /v1/chat/completions  — strict OpenAI Chat Completions
 * Optional:         POST /v1/responses          — only when chatApiMode=responses|auto
 *
 * Works with any OpenAI-compatible base URL:
 * OpenAI / Azure-compatible proxies / NewAPI / OneAPI / LiteLLM /
 * grok2api / grok2api-sing / self-hosted gateways.
 */
import Config from "../components/Config.js"
import { applyStAdultToChatMessages } from "./st-adult.js"

function cfg() {
  return Config.get()
}

/** Strip trailing slash and accidental /v1 so paths always become {base}/v1/... */
export function normalizeApiBase(raw) {
  let s = String(raw || "").trim()
  if (!s) return ""
  s = s.replace(/\/+$/, "")
  // users often paste https://host/v1 or .../v1/
  s = s.replace(/\/v1$/i, "")
  s = s.replace(/\/+$/, "")
  return s
}

function formatError(status, data, text) {
  const msg =
    data?.error?.message ||
    data?.message ||
    (typeof data?.error === "string" ? data.error : null) ||
    (text && String(text).trim().slice(0, 400)) ||
    ""
  if (status === 401 || status === 403) {
    return `HTTP ${status}: 鉴权失败（检查 apiKey / Authorization）。${msg}`.trim()
  }
  if (status === 404 && /模型|model/i.test(String(msg))) {
    return `HTTP 404: 模型不存在。请把 chatModel 改成 #模型列表 里真实 id，或设为 auto`
  }
  if (status === 404) {
    return (
      `HTTP 404: 路径不存在。请确认 apiBase 是服务根地址（不要多写/少写路径），` +
      `标准 OpenAI 路径为 /v1/chat/completions。${msg ? " " + msg : ""}`
    )
  }
  if (status >= 500 && !msg) {
    return (
      `HTTP ${status}: 上游无有效响应。请检查后端账号池/额度/readyz，` +
      `以及 apiBase 是否指向可访问的 OpenAI 兼容服务`
    )
  }
  return `HTTP ${status}: ${msg || "未知错误"}`
}

/** Flatten undici/node fetch TypeError: fetch failed → actionable message */
function formatNetworkError(err, url) {
  if (err?.name === "AbortError") return null // handled by caller
  const cause = err?.cause
  const code = cause?.code || err?.code || ""
  const cmsg = cause?.message || ""
  const base = `网络错误 → ${url}`
  if (code === "ECONNREFUSED") {
    return `${base}: 连接被拒绝（服务未启动或端口不对 / apiBase 写错）`
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `${base}: DNS 解析失败（主机名错误）`
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `${base}: 连接超时（防火墙/代理/地址不可达）`
  }
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || /certificate/i.test(cmsg)) {
    return `${base}: TLS 证书校验失败（自签证书可开 tlsInsecure，或改用正确 https）`
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return `${base}: 连接被重置（${code}）`
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return `${base}: 证书域名不匹配`
  }
  const detail = [code, cmsg || err?.message].filter(Boolean).join(" — ")
  return `${base}: ${detail || "fetch failed"}`
}

function isTransientNetworkError(err) {
  const msg = String(err?.message || err || "")
  const code = err?.cause?.code || err?.code || ""
  if (/请求超时|连接超时|ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR|fetch failed|网络错误/i.test(msg)) {
    return true
  }
  return ["ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(
    code,
  )
}

/**
 * Only protocol/shape failures should fall back chat → responses.
 * Network / auth / rate-limit must NOT waste a second identical request.
 */
function shouldFallbackToResponses(err) {
  const msg = String(err?.message || err || "")
  if (/网络错误|连接被拒绝|DNS|TLS|请求超时|fetch failed|ECONN|ENOTFOUND|鉴权失败|HTTP 401|HTTP 403|HTTP 429/i.test(msg)) {
    return false
  }
  if (/chat 返回空|回退 responses/i.test(msg)) return true
  if (/HTTP 404|HTTP 405|not found|not supported|unknown endpoint|invalid url|no route/i.test(msg)) {
    return true
  }
  // other 4xx that may mean wrong body/path for chat-only gateways
  if (/HTTP 400|HTTP 422/i.test(msg)) return true
  return false
}

function buildAuthHeaders(c) {
  const headers = {
    Accept: "application/json",
  }
  if (c.apiKey) {
    // OpenAI standard
    headers.Authorization = `Bearer ${c.apiKey}`
    // Many OpenAI-compatible gateways (incl. grok2api-sing) also accept X-API-Key
    const mode = String(c.authHeaderMode || "both").toLowerCase()
    if (mode === "both" || mode === "x-api-key" || mode === "x_api_key") {
      headers["X-API-Key"] = c.apiKey
    }
    if (mode === "x-api-key" || mode === "x_api_key") {
      delete headers.Authorization
    }
  }
  if (c.apiOrganization) {
    headers["OpenAI-Organization"] = c.apiOrganization
  }
  if (c.apiProject) {
    headers["OpenAI-Project"] = c.apiProject
  }
  // optional extra headers: "Header-Name: value" per line or "Name=value"
  const extra = String(c.extraHeaders || "").trim()
  if (extra) {
    for (const line of extra.split(/\r?\n|;/)) {
      const t = line.trim()
      if (!t) continue
      const m = t.match(/^([^:=]+)\s*[:=]\s*(.*)$/)
      if (m) headers[m[1].trim()] = m[2].trim()
    }
  }
  return headers
}

let _insecureDispatcher = null
async function getFetchImpl(tlsInsecure) {
  if (!tlsInsecure) return globalThis.fetch.bind(globalThis)
  try {
    const undici = await import("undici")
    if (!_insecureDispatcher) {
      _insecureDispatcher = new undici.Agent({
        connect: { rejectUnauthorized: false },
      })
    }
    return (url, opts = {}) =>
      undici.fetch(url, { ...opts, dispatcher: _insecureDispatcher })
  } catch {
    logger?.warn?.(
      "[grok2api-chat-plugin] tlsInsecure 需要 undici，当前环境不可用，仍用默认 fetch",
    )
    return globalThis.fetch.bind(globalThis)
  }
}

async function requestOnce(
  method,
  apiPath,
  body,
  { timeoutMs, skipAuth = false, extraHeaders = null } = {},
) {
  const c = cfg()
  const base = normalizeApiBase(c.apiBase)
  if (!base) throw new Error("未配置 apiBase（锅巴 → 插件「API 地址」）")
  if (!skipAuth && !c.apiKey) {
    throw new Error("未配置 apiKey（OpenAI / 兼容网关的 Bearer Key）")
  }

  const pathPart = apiPath.startsWith("/") ? apiPath : `/${apiPath}`
  const url = `${base}${pathPart}`
  const controller = new AbortController()
  const ms = timeoutMs ?? c.timeoutMs
  const timer = setTimeout(() => controller.abort(), ms)
  const doFetch = await getFetchImpl(!!c.tlsInsecure)

  try {
    const headers = skipAuth
      ? { Accept: "application/json" }
      : buildAuthHeaders(c)
    if (extraHeaders && typeof extraHeaders === "object") {
      Object.assign(headers, extraHeaders)
    }
    if (body !== undefined) headers["Content-Type"] = "application/json"

    const res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    if (!res.ok) {
      throw new Error(formatError(res.status, data, text))
    }
    return data
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`请求超时（>${ms}ms）: ${url}`)
    if (e?.message?.startsWith("HTTP ")) throw e
    const net = formatNetworkError(e, url)
    if (net) throw new Error(net)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function request(method, apiPath, body, opts = {}) {
  const c = cfg()
  const retries = Math.min(5, Math.max(0, Number(c.requestRetries) || 0))
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestOnce(method, apiPath, body, opts)
    } catch (e) {
      lastErr = e
      const canRetry = attempt < retries && isTransientNetworkError(e)
      if (!canRetry) throw e
      const wait = Math.min(4000, 400 * 2 ** attempt)
      logger?.warn?.(
        `[grok2api-chat-plugin] 请求重试 ${attempt + 1}/${retries}（${wait}ms）: ${e.message}`,
      )
      await sleep(wait)
    }
  }
  throw lastErr
}

/** 相对媒体 URL → 绝对（部分网关返回 /v1/media/...） */
function absolutizeMediaUrl(u) {
  const s = String(u || "").trim()
  if (!s) return ""
  if (/^(https?:|data:|base64:|file:)/i.test(s)) return s
  const base = normalizeApiBase(cfg().apiBase)
  if (!base) return s
  if (s.startsWith("/")) return `${base}${s}`
  return `${base}/${s}`
}

/** 从 images 响应提取 url / b64 */
function extractImageUrls(data) {
  const urls = []
  const items = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.images)
      ? data.images
      : []
  for (const it of items) {
    if (!it) continue
    if (typeof it === "string") {
      urls.push(absolutizeMediaUrl(it))
      continue
    }
    if (it.url) urls.push(absolutizeMediaUrl(it.url))
    else if (it.b64_json) urls.push(`base64://${it.b64_json}`)
    else if (it.b64) urls.push(`base64://${it.b64}`)
    else if (it.image_url) {
      const u = typeof it.image_url === "string" ? it.image_url : it.image_url?.url
      if (u) urls.push(absolutizeMediaUrl(u))
    }
  }
  // 少数网关顶层 url
  if (!urls.length && data?.url) urls.push(absolutizeMediaUrl(data.url))
  return urls.filter(Boolean)
}

export async function resolveImageModel(preferred) {
  const c = cfg()
  let useModel = preferred || c.imageModel
  if (useModel && String(useModel).toLowerCase() !== "auto") return useModel
  try {
    const data = await listModels()
    const ids = (data?.data || []).map(m => m.id || m.model).filter(Boolean)
    return (
      ids.find(id => /imagine-image(?!-edit)/i.test(id)) ||
      ids.find(id => /dall-e|gpt-image|flux|image/i.test(id) && !/video|edit/i.test(id)) ||
      c.imageModel ||
      "grok-imagine-image"
    )
  } catch {
    return c.imageModel || "grok-imagine-image"
  }
}

export async function resolveImageEditModel(preferred) {
  const c = cfg()
  let useModel = preferred || c.imageEditModel
  if (useModel && String(useModel).toLowerCase() !== "auto") return useModel
  try {
    const data = await listModels()
    const ids = (data?.data || []).map(m => m.id || m.model).filter(Boolean)
    return (
      ids.find(id => /imagine-image-edit|image-edit|edits?/i.test(id)) ||
      ids.find(id => /edit/i.test(id) && /image|imagine/i.test(id)) ||
      c.imageEditModel ||
      "grok-imagine-image-edit"
    )
  } catch {
    return c.imageEditModel || "grok-imagine-image-edit"
  }
}

export async function resolveVideoModel(preferred) {
  const c = cfg()
  let useModel = preferred || c.videoModel
  if (useModel && String(useModel).toLowerCase() !== "auto") return useModel
  try {
    const data = await listModels()
    const ids = (data?.data || []).map(m => m.id || m.model).filter(Boolean)
    return (
      ids.find(id => /imagine-video|sora|video/i.test(id)) ||
      c.videoModel ||
      "grok-imagine-video"
    )
  } catch {
    return c.videoModel || "grok-imagine-video"
  }
}

/** GET /healthz or /readyz — no auth; useful for local grok2api-sing / gateways */
export async function healthCheck() {
  const c = cfg()
  const base = normalizeApiBase(c.apiBase)
  if (!base) throw new Error("未配置 apiBase")
  const out = { base, healthz: null, readyz: null }
  for (const ep of ["healthz", "readyz"]) {
    try {
      const data = await requestOnce("GET", `/${ep}`, undefined, {
        timeoutMs: Math.min(c.timeoutMs, 15000),
        skipAuth: true,
      })
      out[ep] = { ok: true, data }
    } catch (e) {
      out[ep] = { ok: false, error: e.message }
    }
  }
  return out
}

export async function listModels() {
  return request("GET", "/v1/models")
}

/** 从 /v1/models 解析出对话类模型 id 列表（OpenAI / Grok / 通用兼容） */
export async function listChatModelIds() {
  const data = await listModels()
  const list = Array.isArray(data?.data) ? data.data : []
  const ids = list.map(m => m.id || m.model).filter(Boolean)
  const isMedia = id => {
    const s = String(id).toLowerCase()
    return (
      s.includes("imagine") ||
      s.includes("image") ||
      s.includes("video") ||
      s.includes("dall-e") ||
      s.includes("tts") ||
      s.includes("whisper") ||
      s.includes("embedding") ||
      s.includes("moderation")
    )
  }
  // Prefer chat-ish names when present; else any non-media (gpt-4o / claude / deepseek / …)
  const preferred = ids.filter(id => {
    if (isMedia(id)) return false
    const s = String(id).toLowerCase()
    return (
      s.includes("chat") ||
      s.startsWith("grok") ||
      s.startsWith("gpt") ||
      s.startsWith("o1") ||
      s.startsWith("o3") ||
      s.startsWith("o4") ||
      s.startsWith("claude") ||
      s.startsWith("deepseek") ||
      s.startsWith("qwen") ||
      s.startsWith("gemini")
    )
  })
  if (preferred.length) return preferred
  return ids.filter(id => !isMedia(id))
}

/**
 * 解析实际使用的对话模型：
 * - 配置 auto / 空 → 取列表第一个对话模型
 * - 配置了但不在列表 → 回退列表第一个并打日志
 */
export async function resolveChatModel(preferred) {
  const c = cfg()
  const want = String(preferred || c.chatModel || "auto").trim()
  let available = []
  try {
    available = await listChatModelIds()
  } catch (e) {
    logger?.warn?.(`[grok2api-chat-plugin] 拉取模型列表失败: ${e.message}`)
    if (want && want.toLowerCase() !== "auto") return want
    throw new Error(`无法获取模型列表，且未配置固定 chatModel：${e.message}`)
  }
  if (!available.length) {
    throw new Error(
      "后端 /v1/models 无可用对话模型。请启用模型，或将 chatModel 固定为具体 id 后重试",
    )
  }
  if (!want || want.toLowerCase() === "auto") {
    return available[0]
  }
  if (available.includes(want)) return want
  logger?.warn?.(
    `[grok2api-chat-plugin] 配置的 chatModel=${want} 不在可用列表 ${available.join(",")}，改用 ${available[0]}`,
  )
  return available[0]
}

/**
 * 折叠「整段内容被拼两次」：
 *  - "你好吗？你好吗？" → "你好吗？"
 *  - "A\n\nB" + "A\n\nB" → "A\n\nB"
 * 常见于代理把 delta 与 completed 各取一遍，或 output 数组双 message。
 */
function collapseRepeatedContent(text) {
  let s = String(text ?? "")
  if (s.length < 16) return s

  // 连续完全相同片段（可带中间空白）
  for (let guard = 0; guard < 4; guard++) {
    const t = s
    const n = t.length
    let collapsed = null

    // 1) 精确对半
    if (n % 2 === 0) {
      const half = n / 2
      if (t.slice(0, half) === t.slice(half)) collapsed = t.slice(0, half)
    }

    // 2) 前半 + 可选空白 + 完全相同后半
    if (!collapsed) {
      const m = t.match(/^([\s\S]+?)(?:\s*)\1\s*$/)
      if (m && m[1].trim().length >= 8) collapsed = m[1]
    }

    // 3) 按段落对半（偶数段且前后半相同）
    if (!collapsed) {
      const paras = t.split(/\n{2,}/)
      if (paras.length >= 2 && paras.length % 2 === 0) {
        const mid = paras.length / 2
        const a = paras.slice(0, mid).join("\n\n")
        const b = paras.slice(mid).join("\n\n")
        if (a.trim() && a.trim() === b.trim()) collapsed = a
      }
    }

    // 4) 从最长可能前缀向下找「前缀重复两次」
    if (!collapsed) {
      const max = Math.floor(n / 2)
      for (let len = max; len >= 8; len--) {
        const a = t.slice(0, len)
        const rest = t.slice(len).replace(/^\s+/, "")
        if (rest === a || rest.trim() === a.trim()) {
          collapsed = a
          break
        }
      }
    }

    if (!collapsed || collapsed.length >= s.length) break
    logger?.warn?.(
      `[grok2api-chat-plugin] 折叠重复回复 ${s.length}→${collapsed.length} 字`,
    )
    s = collapsed
  }
  return s
}

/**
 * 严格 OpenAI Chat Completions 文本提取
 * 规范: choices[0].message.content（string | content parts）
 * 兼容: choices[0].text（旧 completion）、refusal
 */
function extractChatContent(data) {
  if (!data || typeof data !== "object") return ""

  // 只用第一个 choice（严格 OpenAI 单回复场景）
  const choice = Array.isArray(data.choices) ? data.choices[0] : null
  if (!choice) return ""

  // OpenAI: message.content
  const msg = choice.message
  if (msg && typeof msg === "object") {
    if (typeof msg.content === "string") {
      return collapseRepeatedContent(msg.content)
    }
    // multimodal / content parts array
    if (Array.isArray(msg.content)) {
      const parts = []
      for (const p of msg.content) {
        if (typeof p === "string") {
          if (!parts.length || parts[parts.length - 1] !== p) parts.push(p)
          continue
        }
        if (!p || typeof p !== "object") continue
        // 只取 text 一次，避免 type+text 双写
        if (typeof p.text === "string") {
          if (!parts.length || parts[parts.length - 1] !== p.text) {
            parts.push(p.text)
          }
          continue
        }
      }
      return collapseRepeatedContent(parts.join(""))
    }
    // refusal (OpenAI)
    if (typeof msg.refusal === "string" && msg.refusal.trim()) {
      return msg.refusal
    }
  }

  // legacy text completion
  if (typeof choice.text === "string") {
    return collapseRepeatedContent(choice.text)
  }

  // delta (shouldn't appear with stream:false, but some proxies mishandle)
  if (choice.delta) {
    if (typeof choice.delta.content === "string") {
      return collapseRepeatedContent(choice.delta.content)
    }
  }

  return ""
}

/**
 * Responses API 文本提取（非严格 OpenAI chat；可选路径）
 * 优先 output_text；避免同一 text 被 push 两次
 */
function extractResponsesContent(data) {
  if (!data || typeof data !== "object") return ""

  // OpenAI Responses: top-level output_text convenience field
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text
  }

  if (Array.isArray(data.output)) {
    const parts = []
    const seen = new Set()
    const push = s => {
      if (typeof s !== "string") return
      const t = s
      // 相邻完全重复片段去重（部分代理会双写 content + text）
      if (parts.length && parts[parts.length - 1] === t) return
      if (seen.has(t) && t.length > 20) return
      seen.add(t)
      parts.push(t)
    }

    for (const item of data.output) {
      if (!item || typeof item !== "object") continue
      // message item
      if (item.type === "message" || item.role === "assistant") {
        if (typeof item.content === "string") {
          push(item.content)
          continue
        }
        if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (typeof c === "string") {
              push(c)
              continue
            }
            if (!c || typeof c !== "object") continue
            // 只取一次：优先 text 字段
            if (typeof c.text === "string") {
              push(c.text)
              continue
            }
          }
        }
        continue
      }
      // output_text item
      if (item.type === "output_text" && typeof item.text === "string") {
        push(item.text)
        continue
      }
      // 已有 message 时不要再把裸 text 拼一遍
      if (typeof item.text === "string" && !parts.length) push(item.text)
    }
    if (parts.length) return collapseRepeatedContent(parts.join(""))
  }

  // 少数代理把 chat 包在 responses 壳里
  return extractChatContent(data)
}

/**
 * messages → Responses input（仅 opt-in 使用）
 */
function toResponsesContent(content) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content)
  const parts = []
  for (const c of content) {
    if (!c) continue
    if (typeof c === "string") {
      parts.push({ type: "input_text", text: c })
      continue
    }
    if (c.type === "text" || c.type === "input_text") {
      parts.push({ type: "input_text", text: String(c.text || "") })
      continue
    }
    if (c.type === "image_url" || c.type === "input_image") {
      const url =
        typeof c.image_url === "string"
          ? c.image_url
          : c.image_url?.url || c.url || ""
      if (url) parts.push({ type: "input_image", image_url: url })
      continue
    }
  }
  return parts.length ? parts : ""
}

function messagesToResponsesBody(messages, model, { previousResponseId } = {}) {
  let instructions = ""
  const input = []
  for (const m of messages || []) {
    if (!m?.role) continue
    if (m.role === "system") {
      const sys =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map(x => x?.text || "").join("\n")
            : String(m.content || "")
      instructions = (instructions ? instructions + "\n\n" : "") + sys
      continue
    }
    const role = m.role === "assistant" ? "assistant" : "user"
    input.push({
      role,
      content: toResponsesContent(m.content),
    })
  }
  let bodyInput = input
  if (
    input.length === 1 &&
    input[0].role === "user" &&
    typeof input[0].content === "string"
  ) {
    bodyInput = input[0].content
  }
  const body = {
    model,
    input: bodyInput,
    stream: false,
  }
  if (instructions) body.instructions = instructions
  if (previousResponseId) body.previous_response_id = previousResponseId
  return body
}

/**
 * 严格 OpenAI Chat Completions 请求体
 * https://platform.openai.com/docs/api-reference/chat/create
 * 支持 tools / tool_calls / tool 角色消息
 * 字段仅使用 OpenAI 标准名，兼容所有 OpenAI-compatible 网关
 */
async function postChatCompletions(
  messages,
  model,
  { tools, toolChoice, temperature, maxTokens, topP, presencePenalty, frequencyPenalty, user } = {},
) {
  const normalized = (messages || [])
    .filter(m => m && m.role)
    .map(m => {
      const out = { role: m.role }
      // tool 结果消息
      if (m.role === "tool") {
        out.tool_call_id = m.tool_call_id || m.id || ""
        out.content =
          m.content == null
            ? ""
            : typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content)
        if (m.name) out.name = m.name
        return out
      }
      // assistant 可能带 tool_calls
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.tool_calls = m.tool_calls
        if (m.content != null && m.content !== "") {
          out.content =
            typeof m.content === "string" || Array.isArray(m.content)
              ? m.content
              : String(m.content)
        } else {
          out.content = null
        }
        return out
      }
      let content = m.content
      if (content == null) content = ""
      if (typeof content !== "string" && !Array.isArray(content)) {
        content = String(content)
      }
      out.content = content
      if (m.name) out.name = m.name
      return out
    })

  const body = {
    model,
    messages: normalized,
    stream: false,
  }
  // optional OpenAI sampling params — only send when set (avoid breaking strict proxies)
  const c = cfg()
  const temp = temperature ?? c.temperature
  if (temp != null && temp !== "" && Number.isFinite(Number(temp))) {
    body.temperature = Number(temp)
  }
  const mt = maxTokens ?? c.maxTokens
  if (mt != null && mt !== "" && Number(mt) > 0) {
    body.max_tokens = Number(mt)
  }
  const tp = topP ?? c.topP
  if (tp != null && tp !== "" && Number.isFinite(Number(tp))) {
    body.top_p = Number(tp)
  }
  if (presencePenalty != null && Number.isFinite(Number(presencePenalty))) {
    body.presence_penalty = Number(presencePenalty)
  } else if (c.presencePenalty != null && c.presencePenalty !== "" && Number.isFinite(Number(c.presencePenalty))) {
    body.presence_penalty = Number(c.presencePenalty)
  }
  if (frequencyPenalty != null && Number.isFinite(Number(frequencyPenalty))) {
    body.frequency_penalty = Number(frequencyPenalty)
  } else if (c.frequencyPenalty != null && c.frequencyPenalty !== "" && Number.isFinite(Number(c.frequencyPenalty))) {
    body.frequency_penalty = Number(c.frequencyPenalty)
  }
  if (user) body.user = String(user)

  if (Array.isArray(tools) && tools.length) {
    body.tools = tools
    body.tool_choice = toolChoice || "auto"
  }
  return request("POST", "/v1/chat/completions", body)
}

/**
 * POST /v1/responses — OpenAI Responses API（一等公民，非半残回退）
 * 支持 messages 转换或直接透传 input/body
 */
async function postResponses(messages, model, { previousResponseId, temperature, maxTokens } = {}) {
  const body = messagesToResponsesBody(messages, model, { previousResponseId })
  const c = cfg()
  const temp = temperature ?? c.temperature
  if (temp != null && temp !== "" && Number.isFinite(Number(temp))) {
    body.temperature = Number(temp)
  }
  const mt = maxTokens ?? c.maxTokens
  if (mt != null && mt !== "" && Number(mt) > 0) {
    // Responses API uses max_output_tokens; some gateways also accept max_tokens
    body.max_output_tokens = Number(mt)
  }
  return request("POST", "/v1/responses", body)
}

/** 直接 POST /v1/responses（原始 body，供高级用法） */
export async function createResponse(body = {}) {
  if (!body || typeof body !== "object") throw new Error("createResponse 需要 body 对象")
  if (!body.model) {
    body = { ...body, model: await resolveChatModel(body.model) }
  }
  if (body.stream == null) body.stream = false
  return request("POST", "/v1/responses", body)
}

/** GET /v1/responses/{id} */
export async function getResponse(responseId) {
  const id = String(responseId || "").trim()
  if (!id) throw new Error("缺少 response id")
  return request("GET", `/v1/responses/${encodeURIComponent(id)}`)
}

/** DELETE /v1/responses/{id} */
export async function deleteResponse(responseId) {
  const id = String(responseId || "").trim()
  if (!id) throw new Error("缺少 response id")
  return request("DELETE", `/v1/responses/${encodeURIComponent(id)}`)
}

/** POST /v1/responses/compact */
export async function compactResponse(body = {}) {
  return request("POST", "/v1/responses/compact", body)
}

/**
 * POST /v1/messages — Anthropic Messages 兼容（grok2api-sing 等）
 * 需要 anthropic-version 头；max_tokens 必填
 */
export async function createMessage({
  model,
  messages,
  maxTokens,
  system,
  stream = false,
} = {}) {
  const c = cfg()
  const mid = await resolveChatModel(model)
  const mt = Number(maxTokens ?? c.maxTokens ?? 1024)
  if (!mt || mt <= 0) throw new Error("Anthropic /v1/messages 需要 max_tokens > 0")
  const body = {
    model: mid,
    max_tokens: mt,
    messages: messages || [],
    stream: !!stream,
  }
  if (system) body.system = system
  return request("POST", "/v1/messages", body, {
    timeoutMs: c.timeoutMs,
    extraHeaders: { "anthropic-version": "2023-06-01" },
  })
}

function extractAssistantMessage(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null
  return choice?.message || null
}

function extractToolCallsFromData(data) {
  const msg = extractAssistantMessage(data)
  if (!msg || !Array.isArray(msg.tool_calls)) return []
  return msg.tool_calls
}

/**
 * 统一对话入口 — 全量支持 OpenAI chat + Responses
 * chatApiMode:
 * - chat（默认）: POST /v1/chat/completions
 * - responses: POST /v1/responses
 * - auto: 先 chat，协议失败再 responses
 * tools 仅 chat 路径
 */
export async function chatCompletions({
  messages,
  model,
  temperature,
  maxTokens,
  topP,
  previousResponseId,
  chatApiMode,
  tools,
  toolChoice,
  /**
   * skipJailbreak / skipAdult：出站审查等内部调用必须为 true
   * 禁止把 ST 成年/破甲提示注入分类模型
   */
  skipJailbreak = false,
  skipAdult = false,
  /** tool_calls 时 content 可为空 */
  allowEmptyContent = false,
} = {}) {
  const c = cfg()
  // default always strict OpenAI chat — never force responses
  const mode = String(chatApiMode || c.chatApiMode || "chat").toLowerCase()
  let resolved = await resolveChatModel(model)

  const useTools = Array.isArray(tools) && tools.length > 0
  // tools 仅走 OpenAI chat completions（Responses 不跑 tools）
  const effectiveMode = useTools ? "chat" : mode

  const adultOn =
    !skipJailbreak &&
    !skipAdult &&
    c.adultContentEnable !== false &&
    c.chatJailbreakEnable !== false
  let finalMessages = messages
  if (adultOn) {
    finalMessages = applyStAdultToChatMessages(messages, { enabled: true })
  }

  const chatOpts = {
    tools: useTools ? tools : undefined,
    toolChoice: useTools ? toolChoice || "auto" : undefined,
    temperature,
    maxTokens,
    topP,
  }

  const tryChat = async mid => {
    const data = await postChatCompletions(finalMessages, mid, chatOpts)
    const content = extractChatContent(data)
    const toolCalls = extractToolCallsFromData(data)
    const message = extractAssistantMessage(data)
    return {
      content,
      raw: data,
      model: mid,
      api: "chat",
      toolCalls,
      message,
      finishReason: data?.choices?.[0]?.finish_reason || "",
    }
  }
  const tryResponses = async mid => {
    const data = await postResponses(finalMessages, mid, {
      previousResponseId,
      temperature,
      maxTokens,
    })
    const content = extractResponsesContent(data)
    const responseId = data?.id || data?.response_id || ""
    return {
      content,
      raw: data,
      model: mid,
      api: "responses",
      responseId,
      toolCalls: [],
      message: null,
      finishReason: "",
    }
  }

  const runWithModelFallback = async runner => {
    try {
      return await runner(resolved)
    } catch (e) {
      if (/404|模型不存在/i.test(e.message)) {
        const ids = await listChatModelIds().catch(() => [])
        if (ids.length && ids[0] !== resolved) {
          resolved = ids[0]
          return await runner(resolved)
        }
      }
      throw e
    }
  }

  let result
  if (effectiveMode === "responses" || effectiveMode === "response") {
    result = await runWithModelFallback(tryResponses)
  } else if (effectiveMode === "auto") {
    // OpenAI chat first; responses only on protocol/shape failures (not network)
    try {
      result = await runWithModelFallback(tryChat)
      if (
        !String(result.content || "").trim() &&
        !(result.toolCalls && result.toolCalls.length)
      ) {
        throw new Error("chat 返回空，回退 responses")
      }
    } catch (e1) {
      if (!shouldFallbackToResponses(e1)) {
        throw e1
      }
      logger?.warn?.(
        `[grok2api-chat-plugin] chat 失败，回退 responses: ${e1.message}`,
      )
      result = await runWithModelFallback(tryResponses)
    }
  } else {
    // chat | completions | default → strict OpenAI only
    result = await runWithModelFallback(tryChat)
  }

  let content = collapseRepeatedContent(String(result.content || ""))
  const hasTools = Array.isArray(result.toolCalls) && result.toolCalls.length > 0
  if (!content.trim() && !hasTools && !allowEmptyContent) {
    throw new Error(
      `对话返回为空（api=${result.api} model=${result.model}）。` +
        `请检查后端模型与 OpenAI chat completions 响应 choices[0].message.content`,
    )
  }
  return {
    content,
    raw: result.raw,
    model: result.model,
    api: result.api,
    responseId: result.responseId || "",
    toolCalls: result.toolCalls || [],
    message: result.message || null,
    finishReason: result.finishReason || "",
  }
}

/**
 * 对话 + 媒体工具循环
 * - 每轮最多处理 1 个 tool_call（避免连环生图）
 * - 每种工具最多成功 1 次；失败/429 后禁止再调同类
 * - 默认最多 2 轮（首轮 tool + 次轮收尾文字）
 */
export async function chatWithMediaTools({
  messages,
  model,
  tools,
  imageUrls = [],
  maxRounds = 3,
  onToolStart,
  onToolDone,
} = {}) {
  const { executeMediaTool } = await import("./media-tools.js")
  let msgs = [...(messages || [])]
  const mediaResults = []
  let last = null
  // 上限由锅巴 chatToolMaxRounds 传入，此处仅做安全夹紧 1–10
  const rounds = Math.min(10, Math.max(1, Number(maxRounds) || 3))

  let imageOk = 0
  let videoOk = 0
  let imageBlocked = false
  let videoBlocked = false
  const notified = new Set()

  for (let i = 0; i < rounds; i++) {
    // 已成功拿到媒体后，最后一轮强制不再给 tools，只收尾文字
    const toolsThisRound =
      (imageOk > 0 || videoOk > 0) && i > 0 ? undefined : tools
    const toolChoiceThis =
      toolsThisRound && toolsThisRound.length
        ? imageBlocked && videoBlocked
          ? "none"
          : "auto"
        : undefined

    last = await chatCompletions({
      messages: msgs,
      model,
      tools: toolsThisRound,
      toolChoice: toolChoiceThis,
      chatApiMode: "chat",
      allowEmptyContent: true,
    })

    let rawCalls = last.toolCalls || []
    if (!rawCalls.length) break

    // 过滤：已成功/已封锁的工具；同轮只保留第一个有效 call
    const filtered = []
    for (const tc of rawCalls) {
      const name = tc.function?.name || tc.name || ""
      if (name === "generate_image") {
        if (imageBlocked || imageOk >= 1) continue
      } else if (name === "generate_video") {
        if (videoBlocked || videoOk >= 1) continue
      } else {
        continue
      }
      filtered.push(tc)
      break // 每轮最多 1 个
    }

    if (!filtered.length) {
      // 模型还在乱调，塞一条 system 制止后收尾
      msgs.push({
        role: "user",
        content:
          "[系统] 本轮不要再调用任何工具。用一两句中文直接回复用户即可。",
      })
      last = await chatCompletions({
        messages: msgs,
        model,
        chatApiMode: "chat",
        allowEmptyContent: false,
      })
      break
    }

    const assistantMsg = {
      role: "assistant",
      content:
        last.message?.content != null && last.message.content !== ""
          ? last.message.content
          : last.content || null,
      tool_calls: filtered.map(tc => {
        const fn = tc.function || {}
        let args = fn.arguments ?? tc.arguments ?? "{}"
        if (typeof args !== "string") args = JSON.stringify(args || {})
        return {
          id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: {
            name: fn.name || tc.name || "",
            arguments: args,
          },
        }
      }),
    }
    msgs.push(assistantMsg)

    for (const tc of assistantMsg.tool_calls) {
      const name = tc.function.name
      let args = {}
      try {
        args = JSON.parse(tc.function.arguments || "{}")
      } catch {
        args = { prompt: tc.function.arguments }
      }

      if (!notified.has(name)) {
        notified.add(name)
        try {
          onToolStart?.(name, args)
        } catch {
          /* */
        }
      }

      const exec = await executeMediaTool(name, args, { imageUrls })
      if (exec.media) {
        mediaResults.push(exec.media)
        if (name === "generate_image") imageOk++
        if (name === "generate_video") videoOk++
      }
      if (!exec.ok) {
        if (name === "generate_image") imageBlocked = true
        if (name === "generate_video") videoBlocked = true
      }
      if (exec.rateLimited) {
        if (name === "generate_image") imageBlocked = true
        if (name === "generate_video") videoBlocked = true
      }

      try {
        onToolDone?.(name, exec)
      } catch {
        /* */
      }
      msgs.push({
        role: "tool",
        tool_call_id: tc.id,
        name,
        content: exec.toolContent || JSON.stringify({ ok: exec.ok }),
      })
    }

    // 成功后立刻再要一轮纯文字收尾（不再挂 tools）
    if (mediaResults.length) {
      last = await chatCompletions({
        messages: msgs,
        model,
        chatApiMode: "chat",
        allowEmptyContent: true,
      })
      break
    }
  }

  let content = collapseRepeatedContent(String(last?.content || ""))
  if (!content.trim() && mediaResults.length) {
    content = "已生成（见合并转发）"
  }
  // 工具全失败时：用简短固定文案，避免模型再编长文假装生成
  if (!content.trim() && !mediaResults.length) {
    content =
      "这次没有生成出图片/视频（可能限流或账号暂不可用）。你可以稍后再试，或让我用文字描述。"
  }

  return {
    content,
    mediaResults,
    model: last?.model,
    api: last?.api || "chat",
    raw: last?.raw,
  }
}

/**
 * POST /v1/images/generations
 * OpenAI: model, prompt, n, size, response_format
 * xAI/grok2api: + aspect_ratio, resolution
 */
export async function generateImages({
  prompt,
  n,
  model,
  size,
  aspectRatio,
  resolution,
  responseFormat,
} = {}) {
  const c = cfg()
  if (!String(prompt || "").trim()) throw new Error("图片生成需要 prompt")
  const useModel = await resolveImageModel(model)
  const fmt = String(responseFormat || c.imageResponseFormat || "url").toLowerCase()
  const body = {
    model: useModel,
    prompt: String(prompt),
    n: Math.min(10, Math.max(1, Number(n ?? c.imageN) || 1)),
    response_format: fmt === "b64_json" || fmt === "b64" ? "b64_json" : "url",
  }
  const sz = size || c.imageSize
  if (sz) body.size = sz
  const ar = aspectRatio || c.imageAspectRatio
  if (ar) body.aspect_ratio = ar
  const res = resolution || c.imageResolution
  if (res) body.resolution = res

  const data = await request("POST", "/v1/images/generations", body, {
    timeoutMs: Math.max(c.timeoutMs, 300000),
  })
  const urls = extractImageUrls(data)
  if (!urls.length) throw new Error("图片生成无结果（检查账号与 imageModel / /v1/images/generations）")
  return { urls, model: useModel, raw: data }
}

/**
 * POST /v1/images/edits
 * OpenAI/xAI: model, prompt, image: { url }, n, response_format, resolution
 */
export async function editImages({
  prompt,
  imageUrl,
  imageUrls,
  n,
  model,
  resolution,
  responseFormat,
} = {}) {
  const c = cfg()
  if (!String(prompt || "").trim()) throw new Error("图片编辑需要 prompt")
  const refs = []
  if (imageUrl) refs.push(String(imageUrl).trim())
  if (Array.isArray(imageUrls)) {
    for (const u of imageUrls) {
      if (u) refs.push(String(u).trim())
    }
  }
  const unique = [...new Set(refs.filter(Boolean))]
  if (!unique.length) throw new Error("图片编辑需要 imageUrl（原图）")

  const useModel = await resolveImageEditModel(model)
  const fmt = String(responseFormat || c.imageResponseFormat || "url").toLowerCase()
  const body = {
    model: useModel,
    prompt: String(prompt),
    n: Math.min(10, Math.max(1, Number(n ?? c.imageN) || 1)),
    response_format: fmt === "b64_json" || fmt === "b64" ? "b64_json" : "url",
    image: { url: unique[0] },
  }
  if (unique.length > 1) {
    body.images = unique.map(url => ({ url }))
  }
  const res = resolution || c.imageResolution
  if (res) body.resolution = res

  const data = await request("POST", "/v1/images/edits", body, {
    timeoutMs: Math.max(c.timeoutMs, 300000),
  })
  const urls = extractImageUrls(data)
  if (!urls.length) throw new Error("图片编辑无结果（检查 imageEditModel / /v1/images/edits）")
  return { urls, model: useModel, raw: data }
}

/**
 * POST /v1/videos/generations → poll GET /v1/videos/{request_id}
 * 支持文生视频 / 图生视频（image / reference_images）
 */
export async function generateVideo({
  prompt,
  model,
  duration,
  aspectRatio,
  resolution,
  imageUrl,
  imageUrls,
  referenceImages,
} = {}) {
  const c = cfg()
  const useModel = await resolveVideoModel(model)
  if (!useModel) {
    throw new Error(
      "无视频模型：请配置 videoModel，或在后端启用 grok-imagine-video / 其它 video 模型",
    )
  }

  const refs = []
  if (imageUrl) refs.push(String(imageUrl).trim())
  if (Array.isArray(imageUrls)) {
    for (const u of imageUrls) if (u) refs.push(String(u).trim())
  }
  if (Array.isArray(referenceImages)) {
    for (const u of referenceImages) {
      if (!u) continue
      if (typeof u === "string") refs.push(u.trim())
      else if (u.url) refs.push(String(u.url).trim())
    }
  }
  const uniqueRefs = [...new Set(refs.filter(Boolean))].slice(0, 8)

  const body = {
    model: useModel,
    prompt: prompt || "",
    duration: Math.min(15, Math.max(1, Number(duration ?? c.videoDuration) || 8)),
    aspect_ratio: aspectRatio || c.videoAspectRatio || "16:9",
    resolution: resolution || c.videoResolution || "720p",
  }
  if (uniqueRefs.length === 1) {
    body.image = { url: uniqueRefs[0] }
  } else if (uniqueRefs.length > 1) {
    body.image = { url: uniqueRefs[0] }
    body.reference_images = uniqueRefs.slice(1).map(url => ({ url }))
  }
  if (!body.prompt && !uniqueRefs.length) {
    throw new Error("视频生成需要 prompt 或参考图")
  }

  const created = await request("POST", "/v1/videos/generations", body, {
    timeoutMs: Math.max(c.timeoutMs, 120000),
  })
  // 同步返回完整结果（少数兼容网关）
  const syncUrl =
    created?.video?.url ||
    created?.url ||
    created?.data?.[0]?.url ||
    created?.output?.url
  if (syncUrl && !created?.request_id && !created?.id) {
    return {
      url: absolutizeMediaUrl(syncUrl),
      duration: created?.video?.duration ?? body.duration,
      progress: 100,
      jobId: "",
      model: useModel,
      raw: created,
    }
  }

  const jobId = created?.request_id || created?.id
  if (!jobId) throw new Error("视频任务未返回 request_id（POST /v1/videos/generations）")

  const interval = (c.videoPollIntervalSec || 5) * 1000
  const deadline = Date.now() + (c.videoPollMaxSec || 600) * 1000
  let lastProgress = 0

  while (Date.now() < deadline) {
    await sleep(interval)
    const job = await request(
      "GET",
      `/v1/videos/${encodeURIComponent(jobId)}`,
      undefined,
      { timeoutMs: 60000 },
    )
    const status = String(job?.status || "").toLowerCase()
    lastProgress = Number(job?.progress) || lastProgress

    if (status === "done" || status === "completed" || status === "succeeded") {
      const url =
        job?.video?.url ||
        job?.url ||
        job?.output?.url ||
        job?.data?.[0]?.url
      if (!url) throw new Error("视频完成但无 url")
      return {
        url: absolutizeMediaUrl(url),
        duration: job?.video?.duration ?? body.duration,
        progress: 100,
        jobId,
        model: useModel,
        raw: job,
      }
    }
    if (status === "failed" || status === "error") {
      const msg = job?.error?.message || job?.message || "视频生成失败"
      throw new Error(msg)
    }
  }
  throw new Error(
    `视频生成超时（已等待 ${c.videoPollMaxSec}s，进度约 ${lastProgress}%）`,
  )
}

/** GET /v1/videos/{request_id} 单次查询（不轮询） */
export async function getVideoJob(requestId) {
  const id = String(requestId || "").trim()
  if (!id) throw new Error("缺少 video request_id")
  return request("GET", `/v1/videos/${encodeURIComponent(id)}`, undefined, {
    timeoutMs: 60000,
  })
}

/** GET /v1/media/images/{id} — 公开归档图（若网关提供） */
export async function getMediaImage(assetId) {
  const id = String(assetId || "").trim()
  if (!id) throw new Error("缺少 media asset id")
  return request("GET", `/v1/media/images/${encodeURIComponent(id)}`, undefined, {
    skipAuth: false,
    timeoutMs: 60000,
  })
}

/**
 * 探测后端支持的 /v1 能力（连通测试用）
 */
export async function probeV1Capabilities() {
  const c = cfg()
  const base = normalizeApiBase(c.apiBase)
  const out = { base, endpoints: {} }
  const check = async (name, fn) => {
    try {
      await fn()
      out.endpoints[name] = { ok: true }
    } catch (e) {
      const msg = String(e.message || e)
      // 401/400 说明路径存在；404 可能不支持
      if (/HTTP 401|HTTP 403|HTTP 400|HTTP 422|缺少|需要|invalid/i.test(msg)) {
        out.endpoints[name] = { ok: true, note: "reachable", detail: msg.slice(0, 120) }
      } else {
        out.endpoints[name] = { ok: false, error: msg.slice(0, 200) }
      }
    }
  }

  await check("GET /v1/models", () => listModels())
  // chat: tiny invalid may 400 but proves route
  await check("POST /v1/chat/completions", async () => {
    try {
      await request("POST", "/v1/chat/completions", {
        model: c.chatModel === "auto" ? "gpt-4o-mini" : c.chatModel,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
        max_tokens: 1,
      }, { timeoutMs: Math.min(c.timeoutMs, 60000) })
    } catch (e) {
      if (/网络错误|连接|DNS|TLS|超时|fetch failed/i.test(e.message)) throw e
      // model not found etc still means endpoint works
      if (/HTTP 404: 路径不存在/i.test(e.message)) throw e
    }
  })
  await check("POST /v1/responses", async () => {
    try {
      await request("POST", "/v1/responses", {
        model: c.chatModel === "auto" ? "gpt-4o-mini" : c.chatModel,
        input: "ping",
        stream: false,
      }, { timeoutMs: Math.min(c.timeoutMs, 60000) })
    } catch (e) {
      if (/网络错误|连接|DNS|TLS|超时|fetch failed/i.test(e.message)) throw e
      if (/HTTP 404: 路径不存在/i.test(e.message)) throw e
    }
  })
  await check("POST /v1/images/generations", async () => {
    try {
      // dry: missing prompt → 400 proves route
      await request("POST", "/v1/images/generations", { model: "x" }, {
        timeoutMs: 15000,
      })
    } catch (e) {
      if (/网络错误|连接|DNS|TLS|超时|fetch failed/i.test(e.message)) throw e
      if (/HTTP 404: 路径不存在/i.test(e.message)) throw e
    }
  })
  await check("POST /v1/images/edits", async () => {
    try {
      await request("POST", "/v1/images/edits", { model: "x" }, { timeoutMs: 15000 })
    } catch (e) {
      if (/网络错误|连接|DNS|TLS|超时|fetch failed/i.test(e.message)) throw e
      if (/HTTP 404: 路径不存在/i.test(e.message)) throw e
    }
  })
  await check("POST /v1/videos/generations", async () => {
    try {
      await request("POST", "/v1/videos/generations", { model: "x" }, {
        timeoutMs: 15000,
      })
    } catch (e) {
      if (/网络错误|连接|DNS|TLS|超时|fetch failed/i.test(e.message)) throw e
      if (/HTTP 404: 路径不存在/i.test(e.message)) throw e
    }
  })
  await check("POST /v1/messages", async () => {
    try {
      await request(
        "POST",
        "/v1/messages",
        { model: "x", max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
        {
          timeoutMs: 15000,
          extraHeaders: { "anthropic-version": "2023-06-01" },
        },
      )
    } catch (e) {
      if (/网络错误|连接|DNS|TLS|超时|fetch failed/i.test(e.message)) throw e
      if (/HTTP 404: 路径不存在/i.test(e.message)) throw e
    }
  })
  return out
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

export default {
  chatCompletions,
  chatWithMediaTools,
  generateImages,
  editImages,
  generateVideo,
  getVideoJob,
  getMediaImage,
  createResponse,
  getResponse,
  deleteResponse,
  compactResponse,
  createMessage,
  listModels,
  listChatModelIds,
  resolveChatModel,
  resolveImageModel,
  resolveImageEditModel,
  resolveVideoModel,
  healthCheck,
  probeV1Capabilities,
  normalizeApiBase,
}
