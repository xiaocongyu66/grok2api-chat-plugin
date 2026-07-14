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

/** POST /v1/chat/completions */
export async function chatCompletions({ messages, model, temperature } = {}) {
  const c = cfg()
  const resolved = await resolveChatModel(model)
  let data
  try {
    data = await request("POST", "/v1/chat/completions", {
      model: resolved,
      messages,
      stream: false,
      ...(temperature != null ? { temperature } : {}),
    })
  } catch (e) {
    // 404 再强制用列表第一个重试一次
    if (/404|模型不存在/i.test(e.message)) {
      const ids = await listChatModelIds().catch(() => [])
      if (ids.length && ids[0] !== resolved) {
        data = await request("POST", "/v1/chat/completions", {
          model: ids[0],
          messages,
          stream: false,
          ...(temperature != null ? { temperature } : {}),
        })
      } else {
        throw e
      }
    } else {
      throw e
    }
  }
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.output_text ??
    ""
  if (!String(content).trim()) {
    throw new Error(
      `对话返回为空（model=${resolved}）。请检查 grok2api 账号池是否可用、额度是否耗尽`,
    )
  }
  return { content: String(content), raw: data, model: resolved }
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
