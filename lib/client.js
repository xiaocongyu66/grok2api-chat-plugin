/**
 * Strict OpenAI-compatible HTTP client for grok2api / CLIProxy.
 * Primary path: POST /v1/chat/completions
 * Optional: POST /v1/responses (non-OpenAI-strict; opt-in only)
 */
import Config from "../components/Config.js"
import { applyStAdultToChatMessages } from "./st-adult.js"

function cfg() {
  return Config.get()
}

function formatError(status, data, text) {
  const msg =
    data?.error?.message ||
    data?.message ||
    (typeof data?.error === "string" ? data.error : null) ||
    (text && String(text).trim()) ||
    ""
  if (status === 404 && /模型|model/i.test(String(msg))) {
    return `HTTP 404: 模型不存在。请在锅巴把 chatModel 改成 #模型列表 里真实存在的 id，或设为 auto`
  }
  if (status >= 500 && !msg) {
    return (
      `HTTP ${status}: 上游无有效响应。常见原因：grok2api 未导入可用 Web SSO / Build 账号，` +
      `或账号冷却/额度耗尽。请打开 grok2api 管理端检查「上游账号」与 /readyz`
    )
  }
  return `HTTP ${status}: ${msg || "未知错误"}`
}

async function request(method, apiPath, body, { timeoutMs } = {}) {
  const c = cfg()
  if (!c.apiBase) throw new Error("未配置 apiBase（锅巴 → grok2api 插件）")
  if (!c.apiKey) throw new Error("未配置 apiKey（g2a_...）")

  const url = `${c.apiBase}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`
  const controller = new AbortController()
  const ms = timeoutMs ?? c.timeoutMs
  const timer = setTimeout(() => controller.abort(), ms)

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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
    if (e?.name === "AbortError") throw new Error(`请求超时（>${ms}ms）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function listModels() {
  return request("GET", "/v1/models")
}

/** 从 /v1/models 解析出对话类模型 id 列表 */
export async function listChatModelIds() {
  const data = await listModels()
  const list = Array.isArray(data?.data) ? data.data : []
  const ids = list.map(m => m.id || m.model).filter(Boolean)
  const chat = ids.filter(id => {
    const s = String(id).toLowerCase()
    if (s.includes("imagine") || s.includes("image") || s.includes("video")) return false
    return s.includes("chat") || s.startsWith("grok")
  })
  return chat.length
    ? chat
    : ids.filter(id => {
        const s = String(id).toLowerCase()
        return !s.includes("imagine") && !s.includes("image") && !s.includes("video")
      })
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
      "grok2api 当前没有可用对话模型。请在管理端导入 Web SSO/Build 账号并启用对话路由后，再执行 #模型列表",
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
 */
async function postChatCompletions(messages, model) {
  // 规范化 messages：role + content（string | content parts）
  const normalized = (messages || [])
    .filter(m => m && m.role)
    .map(m => {
      const role = m.role
      let content = m.content
      if (content == null) content = ""
      // 已是 string 或 OpenAI content parts 数组则原样
      if (typeof content !== "string" && !Array.isArray(content)) {
        content = String(content)
      }
      return { role, content }
    })

  return request("POST", "/v1/chat/completions", {
    model,
    messages: normalized,
    stream: false,
  })
}

async function postResponses(messages, model, { previousResponseId } = {}) {
  const body = messagesToResponsesBody(messages, model, { previousResponseId })
  return request("POST", "/v1/responses", body)
}

/**
 * 统一对话入口
 * chatApiMode:
 * - chat（默认，严格 OpenAI）: 仅 /v1/chat/completions
 * - responses: 仅 /v1/responses
 * - auto: 先 chat，失败再 responses
 */
export async function chatCompletions({
  messages,
  model,
  temperature,
  previousResponseId,
  chatApiMode,
  /**
   * skipJailbreak / skipAdult：出站审查等内部调用必须为 true
   * 禁止把 ST 成年/破甲提示注入分类模型
   */
  skipJailbreak = false,
  skipAdult = false,
} = {}) {
  const c = cfg()
  const mode = String(chatApiMode || c.chatApiMode || "chat").toLowerCase()
  let resolved = await resolveChatModel(model)

  // 模块 A：SillyTavern 成年内容（对话）
  // 模块 B 审查调用 skipJailbreak/skipAdult=true，绝不注入
  const adultOn =
    !skipJailbreak &&
    !skipAdult &&
    c.adultContentEnable !== false &&
    c.chatJailbreakEnable !== false
  let finalMessages = messages
  if (adultOn) {
    finalMessages = applyStAdultToChatMessages(messages, { enabled: true })
  }

  const tryChat = async mid => {
    const data = await postChatCompletions(finalMessages, mid)
    const content = extractChatContent(data)
    return { content, raw: data, model: mid, api: "chat" }
  }
  const tryResponses = async mid => {
    const data = await postResponses(finalMessages, mid, { previousResponseId })
    const content = extractResponsesContent(data)
    const responseId = data?.id || data?.response_id || ""
    return { content, raw: data, model: mid, api: "responses", responseId }
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
  if (mode === "responses" || mode === "response") {
    result = await runWithModelFallback(tryResponses)
  } else if (mode === "auto") {
    // auto: 严格 OpenAI chat 优先，失败再 responses
    try {
      result = await runWithModelFallback(tryChat)
      if (!String(result.content || "").trim()) {
        throw new Error("chat 返回空，回退 responses")
      }
    } catch (e1) {
      logger?.warn?.(
        `[grok2api-chat-plugin] chat 失败，回退 responses: ${e1.message}`,
      )
      result = await runWithModelFallback(tryResponses)
    }
  } else {
    // chat | completions | chat_completions | 默认
    result = await runWithModelFallback(tryChat)
  }

  let content = collapseRepeatedContent(String(result.content || ""))
  if (!content.trim()) {
    throw new Error(
      `对话返回为空（api=${result.api} model=${result.model}）。请检查 grok2api 账号池与模型`,
    )
  }
  return {
    content,
    raw: result.raw,
    model: result.model,
    api: result.api,
    responseId: result.responseId || "",
  }
}

/** POST /v1/images/generations */
export async function generateImages({ prompt, n, model } = {}) {
  const c = cfg()
  let useModel = model || c.imageModel
  if (!useModel || String(useModel).toLowerCase() === "auto") {
    try {
      const data = await listModels()
      const ids = (data?.data || []).map(m => m.id).filter(Boolean)
      useModel =
        ids.find(id => /imagine-image(?!-edit)/i.test(id)) ||
        ids.find(id => /image/i.test(id) && !/video/i.test(id)) ||
        c.imageModel
    } catch {
      /* keep */
    }
  }
  const body = {
    model: useModel,
    prompt,
    n: n ?? c.imageN,
    response_format: "url",
  }
  if (c.imageSize) body.size = c.imageSize
  if (c.imageAspectRatio) body.aspect_ratio = c.imageAspectRatio

  const data = await request("POST", "/v1/images/generations", body, {
    timeoutMs: Math.max(c.timeoutMs, 300000),
  })
  const items = Array.isArray(data?.data) ? data.data : []
  const urls = []
  for (const it of items) {
    if (it?.url) urls.push(String(it.url))
    else if (it?.b64_json) urls.push(`base64://${it.b64_json}`)
  }
  if (!urls.length) throw new Error("图片生成无结果（检查账号与 imageModel）")
  return { urls, raw: data }
}

/** POST /v1/videos/generations → poll GET /v1/videos/{id} */
export async function generateVideo({
  prompt,
  model,
  duration,
  aspectRatio,
  resolution,
  imageUrl,
} = {}) {
  const c = cfg()
  let useModel = model || c.videoModel
  if (!useModel || String(useModel).toLowerCase() === "auto") {
    try {
      const data = await listModels()
      const ids = (data?.data || []).map(m => m.id).filter(Boolean)
      useModel = ids.find(id => /video/i.test(id)) || c.videoModel
    } catch {
      /* keep */
    }
  }
  if (!useModel) {
    throw new Error(
      "当前 /v1/models 没有视频模型，请在 grok2api 启用 grok-imagine-video 并导入可用账号",
    )
  }
  const body = {
    model: useModel,
    prompt: prompt || "",
    duration: duration ?? c.videoDuration,
    aspect_ratio: aspectRatio || c.videoAspectRatio,
    resolution: resolution || c.videoResolution,
  }
  if (imageUrl) {
    body.image = { url: imageUrl }
  }

  const created = await request("POST", "/v1/videos/generations", body, {
    timeoutMs: Math.max(c.timeoutMs, 120000),
  })
  const jobId = created?.request_id || created?.id
  if (!jobId) throw new Error("视频任务未返回 request_id")

  const interval = (c.videoPollIntervalSec || 5) * 1000
  const deadline = Date.now() + (c.videoPollMaxSec || 600) * 1000
  let lastProgress = 0

  while (Date.now() < deadline) {
    await sleep(interval)
    const job = await request(
      "GET",
      `/v1/videos/${encodeURIComponent(jobId)}`,
      undefined,
      {
        timeoutMs: 60000,
      },
    )
    const status = String(job?.status || "").toLowerCase()
    lastProgress = Number(job?.progress) || lastProgress

    if (status === "done" || status === "completed" || status === "succeeded") {
      const url = job?.video?.url || job?.url || job?.output?.url
      if (!url) throw new Error("视频完成但无 url")
      return {
        url: String(url),
        duration: job?.video?.duration ?? body.duration,
        progress: 100,
        jobId,
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

export default {
  chatCompletions,
  generateImages,
  generateVideo,
  listModels,
  listChatModelIds,
  resolveChatModel,
}
