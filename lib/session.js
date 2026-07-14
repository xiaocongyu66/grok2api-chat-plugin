/** 对话记忆 + 会话开关（进程内；重启清空） */

const history = new Map()
/** 会话是否开启：key = bot:scope */
const sessions = new Map()
/** 主动回复冷却：key = bot:scope */
const cooldown = new Map()

function botId(e) {
  return e.self_id || e.bot?.uin || "bot"
}

/** 群：整群一个会话；私聊：每人一个 */
export function scopeKey(e) {
  const bot = botId(e)
  if (e.isGroup) return `${bot}:g:${e.group_id}`
  return `${bot}:p:${e.user_id}`
}

function histKey(e) {
  // 群内按用户分历史，避免串台；私聊同 scope
  const bot = botId(e)
  if (e.isGroup) return `${bot}:g:${e.group_id}:u:${e.user_id}`
  return `${bot}:p:${e.user_id}`
}

export function isSessionActive(e) {
  const s = sessions.get(scopeKey(e))
  return !!(s && s.active)
}

export function startSession(e) {
  sessions.set(scopeKey(e), {
    active: true,
    startedBy: e.user_id,
    startedAt: Date.now(),
  })
}

export function stopSession(e) {
  sessions.delete(scopeKey(e))
  // 可选：结束时清该 scope 下历史
  const prefix = scopeKey(e)
  for (const k of [...history.keys()]) {
    if (k.startsWith(prefix) || k.includes(`:${e.isGroup ? "g:" + e.group_id : "p:" + e.user_id}`)) {
      // 更精确清理
    }
  }
  // 精确清理本群/本私聊相关历史
  for (const k of [...history.keys()]) {
    if (e.isGroup) {
      if (k.includes(`:g:${e.group_id}:`)) history.delete(k)
    } else if (k === histKey(e)) {
      history.delete(k)
    }
  }
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
  getHistory,
  setHistory,
  clearHistory,
  pushTurn,
  checkCooldown,
}
