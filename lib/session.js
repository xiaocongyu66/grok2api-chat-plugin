/** 对话记忆 + 会话开关（进程内；重启清空）
 * 会话按「机器人 + 群/私聊」隔离，停止一群不影响另一群。
 */

const history = new Map()
/** 会话是否开启：key = bot:g:群号 或 bot:p:用户 */
const sessions = new Map()
/** 主动回复冷却 */
const cooldown = new Map()

function botId(e) {
  return String(e?.self_id || e?.bot?.uin || e?.bot?.self_id || Bot?.uin || "bot")
}

function groupId(e) {
  // 统一成字符串，避免 123 vs "123" 导致开/关对不上或串台
  const g = e?.group_id ?? e?.group?.group_id ?? e?.group_id
  return g == null || g === "" ? "" : String(g)
}

function userId(e) {
  const u = e?.user_id ?? e?.sender?.user_id ?? e?.sender?.uin
  return u == null || u === "" ? "" : String(u)
}

/** 群：bot:g:群号；私聊：bot:p:用户 */
export function scopeKey(e) {
  const bot = botId(e)
  if (e?.isGroup || e?.message_type === "group" || groupId(e)) {
    // 优先群：有 group_id 即按群会话（兼容部分适配器 isGroup 不准）
    const gid = groupId(e)
    if (gid) return `${bot}:g:${gid}`
  }
  return `${bot}:p:${userId(e) || "unknown"}`
}

function histKey(e) {
  const bot = botId(e)
  const gid = groupId(e)
  const uid = userId(e)
  if (e?.isGroup || e?.message_type === "group" || gid) {
    if (gid) return `${bot}:g:${gid}:u:${uid}`
  }
  return `${bot}:p:${uid}`
}

export function isSessionActive(e) {
  const k = scopeKey(e)
  const s = sessions.get(k)
  return !!(s && s.active)
}

export function startSession(e) {
  const k = scopeKey(e)
  sessions.set(k, {
    active: true,
    startedBy: userId(e),
    startedAt: Date.now(),
    scope: k,
  })
  logger?.info?.(`[grok2api-chat-plugin] 会话开启 scope=${k}`)
  return k
}

export function stopSession(e) {
  const k = scopeKey(e)
  sessions.delete(k)
  // 只清本 scope 的历史：群用 bot:g:gid: 前缀，私聊用 histKey
  const gid = groupId(e)
  const bot = botId(e)
  if (gid) {
    const histPrefix = `${bot}:g:${gid}:`
    for (const key of [...history.keys()]) {
      if (key.startsWith(histPrefix)) history.delete(key)
    }
  } else {
    history.delete(histKey(e))
  }
  logger?.info?.(`[grok2api-chat-plugin] 会话关闭 scope=${k}（其它群不受影响）`)
  return k
}

/** 调试：当前所有活跃会话 */
export function listActiveSessions() {
  return [...sessions.entries()].filter(([, v]) => v?.active).map(([k]) => k)
}

export function getHistory(e) {
  return history.get(histKey(e)) || []
}

export function setHistory(e, messages) {
  history.set(histKey(e), messages)
}

export function clearHistory(e) {
  history.delete(histKey(e))
}

export function pushTurn(e, userText, assistantText, maxHistory) {
  const hist = getHistory(e)
  hist.push({ role: "user", content: userText })
  hist.push({ role: "assistant", content: assistantText })
  const max = Math.max(2, maxHistory || 20)
  while (hist.length > max) hist.shift()
  setHistory(e, hist)
  return hist
}

export function checkCooldown(e, sec) {
  const k = scopeKey(e) + ":cd"
  const now = Date.now()
  const last = cooldown.get(k) || 0
  if (now - last < (sec || 0) * 1000) return false
  cooldown.set(k, now)
  return true
}

export default {
  scopeKey,
  isSessionActive,
  startSession,
  stopSession,
  listActiveSessions,
  getHistory,
  setHistory,
  clearHistory,
  pushTurn,
  checkCooldown,
}
