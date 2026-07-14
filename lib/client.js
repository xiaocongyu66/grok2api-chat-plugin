/**
 * Minimal grok2api HTTP client (OpenAI-compatible + media).
 */
import Config from "../components/Config.js"

function cfg() {
  return Config.get()
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
      const msg =
        data?.error?.message ||
        data?.message ||
        data?.error ||
        text.slice(0, 300) ||
        res.statusText
      throw new Error(`HTTP ${res.status}: ${msg}`)
    }
    return data
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`请求超时（>${ms}ms）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** POST /v1/chat/completions */
export async function chatCompletions({ messages, model, temperature } = {}) {
  const c = cfg()
  const data = await request("POST", "/v1/chat/completions", {
    model: model || c.chatModel,
    messages,
    stream: false,
    ...(temperature != null ? { temperature } : {}),
  })
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.output_text ??
    ""
  if (!String(content).trim()) {
    throw new Error("对话返回为空")
  }
  return { content: String(content), raw: data }
}

/** POST /v1/images/generations */
export async function generateImages({ prompt, n, model } = {}) {
  const c = cfg()
  const body = {
    model: model || c.imageModel,
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
  if (!urls.length) throw new Error("图片生成无结果")
  return { urls, raw: data }
}

/** POST /v1/videos/generations → poll GET /v1/videos/{id} */
export async function generateVideo({ prompt, model, duration, aspectRatio, resolution, imageUrl } = {}) {
  const c = cfg()
  const body = {
    model: model || c.videoModel,
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

export async function listModels() {
  return request("GET", "/v1/models")
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

export default { chatCompletions, generateImages, generateVideo, listModels }
