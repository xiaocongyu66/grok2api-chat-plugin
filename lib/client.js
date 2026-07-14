/**
 * Minimal grok2api HTTP client (OpenAI-compatible + media).
 */
import Config from "../components/Config.js"

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
  // 优先 chat / grok- 且非 imagine
  const chat = ids.filter(id => {
    const s = String(id).toLowerCase()
    if (s.includes("imagine") || s.includes("image") || s.includes("video")) return false
    return s.includes("chat") || s.startsWith("grok")
  })
  return chat.length ? chat : ids.filter(id => {
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

/** 从 Chat Completions 响应取文本 */
function extractChatContent(data) {
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.output_text ??
    ""
  )
}

/** 从 Responses API 响应取文本（兼容多种字段） */
function extractResponsesContent(data) {
  if (!data || typeof data !== "object") return ""
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text
  }
  // output: [{ type, content: [{ type: output_text, text }] }]
  if (Array.isArray(data.output)) {
    const parts = []
    for (const item of data.output) {
      if (typeof item?.text === "string") parts.push(item.text)
      if (typeof item?.content === "string") parts.push(item.content)
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c?.text === "string") parts.push(c.text)
          if (c?.type === "output_text" && c?.text) parts.push(c.text)
          if (typeof c === "string") parts.push(c)
        }
      }
    }
    if (parts.length) return parts.join("")
  }
  // 兼容 choices
  const chatLike = extractChatContent(data)
  if (chatLike) return chatLike
  return ""
}

/**
 * 将 chat 风格 content 转为 Responses content
 * - 字符串 → 原样或 input_text
 * - 数组 image_url → input_image
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

/**
 * messages → Responses input
 * system 抽到 instructions；content 支持多模态数组
 */
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
  // 单条纯文本 user 可简化；多模态必须用数组
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

async function postChatCompletions(messages, model) {
  return request("POST", "/v1/chat/completions", {
    model,
    messages,
    stream: false,
  })
}

async function postResponses(messages, model, { previousResponseId } = {}) {
  const body = messagesToResponsesBody(messages, model, { previousResponseId })
  return request("POST", "/v1/responses", body)
}

/**
 * 统一对话入口
 * chatApiMode: chat | responses | auto
 * - chat: 仅 /v1/chat/completions
 * - responses: 仅 /v1/responses
 * - auto: 先 responses，失败再 chat
 */
export async function chatCompletions({
  messages,
  model,
  temperature,
  previousResponseId,
  chatApiMode,
} = {}) {
  const c = cfg()
  const mode = String(chatApiMode || c.chatApiMode || "auto").toLowerCase()
  let resolved = await resolveChatModel(model)

  const tryChat = async mid => {
    const data = await postChatCompletions(messages, mid)
    const content = extractChatContent(data)
    return { content, raw: data, model: mid, api: "chat" }
  }
  const tryResponses = async mid => {
    const data = await postResponses(messages, mid, { previousResponseId })
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
  if (mode === "chat" || mode === "completions" || mode === "chat_completions") {
    result = await runWithModelFallback(tryChat)
  } else if (mode === "responses" || mode === "response") {
    result = await runWithModelFallback(tryResponses)
  } else {
    // auto: responses → chat
    try {
      result = await runWithModelFallback(tryResponses)
      if (!String(result.content || "").trim()) {
        throw new Error("responses 返回空，回退 chat")
      }
    } catch (e1) {
      logger?.warn?.(
        `[grok2api-chat-plugin] responses 失败，回退 chat: ${e1.message}`,
      )
      result = await runWithModelFallback(tryChat)
    }
  }

  if (!String(result.content || "").trim()) {
    throw new Error(
      `对话返回为空（api=${result.api} model=${result.model}）。请检查 grok2api 账号池与模型`,
    )
  }
  return {
    content: String(result.content),
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
  // auto: pick first imagine-image
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
export async function generateVideo({ prompt, model, duration, aspectRatio, resolution, imageUrl } = {}) {
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
    throw new Error("当前 /v1/models 没有视频模型，请在 grok2api 启用 grok-imagine-video 并导入可用账号")
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
    const job = await request("GET", `/v1/videos/${encodeURIComponent(jobId)}`, undefined, {
      timeoutMs: 60000,
    })
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
  throw new Error(`视频生成超时（已等待 ${c.videoPollMaxSec}s，进度约 ${lastProgress}%）`)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

export default { chatCompletions, generateImages, generateVideo, listModels, listChatModelIds, resolveChatModel }
