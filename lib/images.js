/**
 * 从消息事件中提取图片 URL（OneBot / NapCat / TRSS）
 */

function pushUrl(list, u) {
  if (!u) return
  let s = String(u).trim()
  if (!s) return
  // 部分适配器 file= 本地路径或 base64
  if (s.startsWith("base64://") || s.startsWith("http://") || s.startsWith("https://") || s.startsWith("data:")) {
    list.push(s)
    return
  }
  // CQ 里可能是 file 名，优先 url 字段
  if (s.startsWith("file://") || s.startsWith("/")) {
    list.push(s)
  }
}

/**
 * @param {any} e 消息事件
 * @param {number} max 最多几张
 * @returns {string[]}
 */
export function extractImageUrls(e, max = 4) {
  const urls = []
  try {
    // TRSS / Yunzai 常见
    if (Array.isArray(e?.img)) {
      for (const u of e.img) pushUrl(urls, u)
    }
    // message 段
    const segs = e?.message
    if (Array.isArray(segs)) {
      for (const m of segs) {
        if (m?.type === "image" || m?.type === "img") {
          const d = m.data || m
          pushUrl(urls, d.url || d.file || m.url || m.file)
        }
      }
    }
    // raw_message CQ
    const raw = String(e?.raw_message || e?.msg || "")
    const re = /\[CQ:image,([^\]]+)\]/gi
    let match
    while ((match = re.exec(raw)) !== null) {
      const body = match[1]
      const urlM = body.match(/(?:url|file)=([^,\]]+)/i)
      if (urlM) {
        let u = urlM[1]
        try {
          u = decodeURIComponent(u)
        } catch {
          /* ignore */
        }
        pushUrl(urls, u)
      }
    }
  } catch {
    /* ignore */
  }
  // 去重
  const seen = new Set()
  const out = []
  for (const u of urls) {
    if (seen.has(u)) continue
    seen.add(u)
    out.push(u)
    if (out.length >= max) break
  }
  return out
}

/**
 * OpenAI Chat Completions 多模态 content
 */
export function buildChatVisionContent(text, imageUrls = []) {
  const parts = []
  const t = String(text || "").trim()
  if (t) parts.push({ type: "text", text: t })
  for (const url of imageUrls) {
    parts.push({
      type: "image_url",
      image_url: { url },
    })
  }
  if (!parts.length) return text || ""
  // 无图时保持纯字符串，兼容旧接口
  if (!imageUrls.length) return t
  return parts
}

/**
 * Responses API 多模态 content（input_text / input_image）
 */
export function buildResponsesVisionContent(text, imageUrls = []) {
  const parts = []
  const t = String(text || "").trim()
  if (t) parts.push({ type: "input_text", text: t })
  for (const url of imageUrls) {
    // 兼容 image_url 字符串与对象
    parts.push({
      type: "input_image",
      image_url: url,
    })
  }
  if (!imageUrls.length) return t
  if (!parts.length) return t || ""
  return parts
}

export default { extractImageUrls, buildChatVisionContent, buildResponsesVisionContent }
