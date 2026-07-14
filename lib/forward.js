/**
 * 合并转发（聊天记录）发送图片 / 视频 / 长文本
 */
import Config from "../components/Config.js"

function nickname() {
  const c = Config.get()
  return c.forwardNickname || "Grok"
}

/**
 * @param {any} e 消息事件
 * @param {Array<string|object>} messages 每条为文本或消息段数组
 */
export async function sendForward(e, messages = [], title = "") {
  const list = []
  if (title) list.push(title)
  for (const m of messages) {
    if (m == null || m === "") continue
    list.push(m)
  }
  if (!list.length) list.push("（空）")

  const nodes = list.map(message => ({
    message,
    nickname: nickname(),
    user_id: e.self_id || e.bot?.uin || Bot.uin,
  }))

  try {
    let forwardMsg
    if (e.group?.makeForwardMsg) {
      forwardMsg = await e.group.makeForwardMsg(nodes)
    } else if (e.friend?.makeForwardMsg) {
      forwardMsg = await e.friend.makeForwardMsg(nodes)
    } else if (typeof Bot.makeForwardMsg === "function") {
      forwardMsg = await Bot.makeForwardMsg(nodes)
    } else {
      // 降级：逐条发送
      for (const m of list) await e.reply(m)
      return true
    }
    return e.reply(forwardMsg)
  } catch (err) {
    logger.warn(`[grok2api-chat-plugin] 合并转发失败，降级发送: ${err.message}`)
    for (const m of list) {
      try {
        await e.reply(m)
      } catch (e2) {
        logger.error(e2)
      }
    }
    return false
  }
}

/** 多图 → 合并转发 */
export async function sendImagesForward(e, urls = [], caption = "") {
  const msgs = []
  if (caption) msgs.push(caption)
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i]
    if (String(u).startsWith("base64://")) {
      msgs.push([`图 ${i + 1}`, segment.image(u)])
    } else {
      msgs.push([`图 ${i + 1}`, segment.image(u)])
    }
  }
  return sendForward(e, msgs, "Grok 图片")
}

/** 视频 → 合并转发（一条说明 + 一条视频） */
export async function sendVideoForward(e, url, meta = {}) {
  const head = [
    "Grok 视频",
    meta.prompt ? `提示词：${meta.prompt}` : "",
    meta.duration != null ? `时长：${meta.duration}s` : "",
    url ? `链接：${url}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  const msgs = [head]
  try {
    // 多数协议端支持 segment.video(url)
    if (typeof segment?.video === "function") {
      msgs.push(segment.video(url))
    } else {
      msgs.push(url)
    }
  } catch {
    msgs.push(url)
  }
  return sendForward(e, msgs, "Grok 视频")
}

export default { sendForward, sendImagesForward, sendVideoForward }
