import Config from "../components/Config.js"
import { applyStAdultToMediaPrompt } from "./st-adult.js"
import { buildChatVisionContent } from "./images.js"

/**
 * 对话 messages：仅用户配置的 system + 历史 + 当前 user
 * ST 成年/破甲由 client.chatCompletions → st-adult 注入（模块 A）
 * 出站审查由 outbound-review 独立完成（模块 B），不走本文件
 */
export function buildChatMessages(e, userText, history = [], imageUrls = []) {
  const c = Config.get()
  const messages = []
  const sys = (c.chatSystemPrompt || "").trim()
  if (sys) {
    messages.push({ role: "system", content: sys })
  }
  for (const m of history) {
    if (!m || !m.role || m.content == null) continue
    // 压缩摘要也以 assistant 角色注入，保证模型可读
    if (m.role === "user" || m.role === "assistant" || m.role === "system") {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map(x => x?.text || "").filter(Boolean).join("\n")
            : String(m.content)
      // 系统摘要用 assistant 承载，避免多 system 冲突
      const role = m.role === "system" ? "assistant" : m.role
      messages.push({ role, content: text })
    }
  }
  const imgs = Array.isArray(imageUrls) ? imageUrls : []
  const pass = c.passImages !== false && imgs.length > 0
  const userContent = pass
    ? buildChatVisionContent(userText, imgs)
    : String(userText || "")
  messages.push({ role: "user", content: userContent })
  return messages
}

/**
 * 生图：后台前后缀 + 锅巴 NSFW + ST 成年增强（模块 A，可用于图片）
 */
export function buildImagePrompt(userPrompt, { forceNsfw } = {}) {
  const c = Config.get()
  const parts = []
  if (c.imagePromptPrefix) parts.push(c.imagePromptPrefix.trim())
  if (forceNsfw || c.imageNsfwEnable) {
    if (c.imageNsfwPrompt) parts.push(c.imageNsfwPrompt.trim())
  }
  parts.push(String(userPrompt || "").trim())
  if (c.imagePromptSuffix) parts.push(c.imagePromptSuffix.trim())
  let prompt = parts.filter(Boolean).join("\n\n")
  // ST 成年增强（与对话同一套 adultContentEnable）
  if (c.adultContentEnable !== false) {
    prompt = applyStAdultToMediaPrompt(prompt, "image", { enabled: true })
  }
  return prompt
}

/**
 * 生视频：同上
 */
export function buildVideoPrompt(userPrompt, { forceNsfw } = {}) {
  const c = Config.get()
  const parts = []
  if (c.videoPromptPrefix) parts.push(c.videoPromptPrefix.trim())
  if (forceNsfw || c.videoNsfwEnable) {
    if (c.videoNsfwPrompt) parts.push(c.videoNsfwPrompt.trim())
  }
  parts.push(String(userPrompt || "").trim())
  if (c.videoPromptSuffix) parts.push(c.videoPromptSuffix.trim())
  let prompt = parts.filter(Boolean).join("\n\n")
  if (c.adultContentEnable !== false) {
    prompt = applyStAdultToMediaPrompt(prompt, "video", { enabled: true })
  }
  return prompt
}

export default { buildChatMessages, buildImagePrompt, buildVideoPrompt }
