/**
 * 合并转发（聊天记录）— 群聊与私聊均支持
 */
import Config from "../components/Config.js"

function nickname() {
  const c = Config.get()
  return c.forwardNickname || "Grok"
}

function selfId(e) {
  return e?.self_id || e?.bot?.uin || e?.bot?.self_id || Bot?.uin
}

/**
 * @param {any} e 消息事件（群/私聊）
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

  const uid = selfId(e)
  const nodes = list.map(message => ({
    message,
    nickname: nickname(),
    user_id: uid,
    // 部分适配器需要
    uin: uid,
  }))

  const isPrivate =
    e?.isPrivate ||
    e?.message_type === "private" ||
    (!e?.group_id && !e?.isGroup)

  try {
    let forwardMsg

    // 1) 群
    if (!isPrivate && e.group?.makeForwardMsg) {
      forwardMsg = await e.group.makeForwardMsg(nodes)
    }
    // 2) 私聊好友对象
    if (!forwardMsg && e.friend?.makeForwardMsg) {
      forwardMsg = await e.friend.makeForwardMsg(nodes)
    }
    // 3) 全局 Bot（群/私聊通用，TRSS / Miao 常见）
    if (!forwardMsg && typeof Bot?.makeForwardMsg === "function") {
      forwardMsg = await Bot.makeForwardMsg(nodes)
    }
    // 4) e.bot
    if (!forwardMsg && typeof e.bot?.makeForwardMsg === "function") {
      forwardMsg = await e.bot.makeForwardMsg(nodes)
    }
    // 5) 部分 OneBot：通过好友 API
    if (!forwardMsg && isPrivate && e.bot?.pickFriend) {
      try {
        const f = e.bot.pickFriend(e.user_id)
        if (f?.makeForwardMsg) forwardMsg = await f.makeForwardMsg(nodes)
      } catch {
        /* ignore */
      }
    }

    if (forwardMsg) {
      return await e.reply(forwardMsg)
    }

    logger?.warn?.(
      `[grok2api-chat-plugin] 合并转发不可用(${isPrivate ? "私聊" : "群"})，降级逐条`,
    )
    for (const m of list) await e.reply(m)
    return true
  } catch (err) {
    logger.warn(
      `[grok2api-chat-plugin] 合并转发失败(${isPrivate ? "私聊" : "群"})，降级发送: ${err.message}`,
    )
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

/** 多图 → 合并转发（群/私聊） */
export async function sendImagesForward(e, urls = [], caption = "") {
  const msgs = []
  if (caption) msgs.push(caption)
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i]
    msgs.push([`图 ${i + 1}`, segment.image(u)])
  }
  return sendForward(e, msgs, "Grok 图片")
}

/** 视频 → 合并转发（群/私聊） */
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
