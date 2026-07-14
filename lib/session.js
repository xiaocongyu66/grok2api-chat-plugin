/**
 * 对话记忆 + 会话开关
 * - 按 bot + 群/私聊 隔离
 * - 磁盘持久化（重启不丢）
 * - 超长时压缩旧上下文（不丢语义摘要）
 * - 仅 #清理会话 清空历史；#停止对话 只关开关，不清记忆
 */

import fs from "node:fs"
import path from "node:path"
import { Plugin_Path } from "../components/path.js"
import Config from "../components/Config.js"

const history = new Map()
/** key = bot:g:群号 | bot:p:用户 → { active, startedBy, startedAt, scope } */
const sessions = new Map()
const cooldown = new Map()

const dataDir = path.join(Plugin_Path, "data")
const storePath = path.join(dataDir, "sessions.json")

let loaded = false
let saveTimer = null

function botId(e) {
  return String(e?.self_id || e?.bot?.uin || e?.bot?.self_id || Bot?.uin || "bot")
}

function groupId(e) {
  const g = e?.group_id ?? e?.group?.group_id
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

function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    if (!fs.existsSync(storePath)) return
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"))
    if (raw?.sessions && typeof raw.sessions === "object") {
      for (const [k, v] of Object.entries(raw.sessions)) {
        if (v && typeof v === "object") sessions.set(k, v)
      }
    }
    if (raw?.history && typeof raw.history === "object") {
      for (const [k, v] of Object.entries(raw.history)) {
        if (Array.isArray(v)) history.set(k, v)
      }
    }
    logger?.info?.(
      `[grok2api-chat-plugin] 已加载持久会话 sessions=${sessions.size} histories=${history.size}`,
    )
  } catch (e) {
    logger?.warn?.(`[grok2api-chat-plugin] 加载 sessions.json 失败: ${e.message}`)
  }
}

function persistEnabled() {
  try {
    const c = Config.get?.()
    return c?.sessionPersist !== false
  } catch {
    return true
  }
}

function scheduleSave() {
  if (!persistEnabled()) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistNow()
  }, 400)
}

function persistNow() {
  if (!persistEnabled()) return
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
    const payload = {
      version: 1,
      savedAt: Date.now(),
      sessions: Object.fromEntries(sessions.entries()),
      history: Object.fromEntries(history.entries()),
    }
    const tmp = storePath + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8")
    fs.renameSync(tmp, storePath)
  } catch (e) {
    logger?.warn?.(`[grok2api-chat-plugin] 保存 sessions.json 失败: ${e.message}`)
  }
}

/** 将旧轮次压成一条摘要，保留最近 keepRecent 条消息 */
export function compressHistory(messages, { keepRecent = 12, maxChars = 1200 } = {}) {
  const list = Array.isArray(messages) ? [...messages] : []
  if (list.length <= keepRecent) return list

  const old = list.slice(0, list.length - keepRecent)
  const recent = list.slice(list.length - keepRecent)

  const lines = []
  for (const m of old) {
    if (!m?.role || m.content == null) continue
    const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role
    let text = typeof m.content === "string" ? m.content : String(m.content)
    text = text.replace(/\s+/g, " ").trim()
    if (!text) continue
    if (text.length > 160) text = text.slice(0, 160) + "…"
    lines.push(`${role}: ${text}`)
  }
  let blob = lines.join("\n")
  if (blob.length > maxChars) {
    blob = blob.slice(0, maxChars) + "\n…(更早内容已省略)"
  }
  const summary = {
    role: "assistant",
    content:
      `[上下文摘要·已压缩 ${old.length} 条旧消息，仅供连贯，勿逐字复读]\n` + blob,
    compressed: true,
    at: Date.now(),
  }
  return [summary, ...recent]
}

export function isSessionActive(e) {
  ensureLoaded()
  const k = scopeKey(e)
  const s = sessions.get(k)
  return !!(s && s.active)
}

export function startSession(e) {
  ensureLoaded()
  const k = scopeKey(e)
  const prev = sessions.get(k) || {}
  sessions.set(k, {
    active: true,
    startedBy: userId(e),
    startedAt: prev.startedAt || Date.now(),
    resumedAt: Date.now(),
    scope: k,
  })
  scheduleSave()
  const histLen = (history.get(histKey(e)) || []).length
  logger?.info?.(
    `[grok2api-chat-plugin] 会话开启 scope=${k} history=${histLen}（停止不清记忆）`,
  )
  return k
}

/**
 * 仅关闭会话开关，**不清历史**
 * 历史只在 clearHistory / #清理会话 时删除
 */
export function stopSession(e) {
  ensureLoaded()
  const k = scopeKey(e)
  const prev = sessions.get(k)
  if (prev) {
    sessions.set(k, {
      ...prev,
      active: false,
      stoppedAt: Date.now(),
      stoppedBy: userId(e),
    })
  } else {
    sessions.set(k, {
      active: false,
      scope: k,
      stoppedAt: Date.now(),
      stoppedBy: userId(e),
    })
  }
  scheduleSave()
  logger?.info?.(
    `[grok2api-chat-plugin] 会话关闭 scope=${k}（记忆保留，#清理会话 才清空）`,
  )
  return k
}

export function listActiveSessions() {
  ensureLoaded()
  return [...sessions.entries()].filter(([, v]) => v?.active).map(([k]) => k)
}

export function getHistory(e) {
  ensureLoaded()
  return history.get(histKey(e)) || []
}

export function setHistory(e, messages) {
  ensureLoaded()
  history.set(histKey(e), messages)
  scheduleSave()
}

/** 仅 #清理会话 应调用：清空该用户在本 scope 的历史 */
export function clearHistory(e) {
  ensureLoaded()
  const key = histKey(e)
  history.delete(key)
  scheduleSave()
  logger?.info?.(`[grok2api-chat-plugin] 已清理会话记忆 key=${key}`)
  return key
}

/**
 * 追加一轮对话；超长则压缩旧上下文（不硬删语义）
 * maxHistory: 保留的「近期完整消息」条数（user+assistant 各算 1）
 */
export function pushTurn(e, userText, assistantText, maxHistory) {
  ensureLoaded()
  const c = Config.get?.() || {}
  const hist = getHistory(e)
  hist.push({ role: "user", content: userText, at: Date.now() })
  hist.push({
    role: "assistant",
    content: assistantText,
    at: Date.now(),
  })

  const keep = Math.max(4, Number(maxHistory) || Number(c.maxHistory) || 20)
  // 超过 keep 的 1.5 倍时压缩，避免每轮都压
  const threshold = Math.max(keep + 4, Math.floor(keep * 1.5))
  let next = hist
  if (hist.length > threshold) {
    next = compressHistory(hist, {
      keepRecent: keep,
      maxChars: Number(c.contextCompressMaxChars) || 1500,
    })
    logger?.info?.(
      `[grok2api-chat-plugin] 上下文已压缩 ${hist.length}→${next.length} key=${histKey(e)}`,
    )
  } else if (hist.length > keep * 2) {
    // 兜底：仍过大时再压一次
    next = compressHistory(hist, { keepRecent: keep })
  }

  setHistory(e, next)
  return next
}

export function checkCooldown(e, sec) {
  ensureLoaded()
  const k = scopeKey(e) + ":cd"
  const now = Date.now()
  const last = cooldown.get(k) || 0
  if (now - last < (sec || 0) * 1000) return false
  cooldown.set(k, now)
  return true
}

/** 进程退出前尽量落盘 */
function bindExitFlush() {
  const flush = () => {
    try {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      persistNow()
    } catch {
      /* ignore */
    }
  }
  process.once("exit", flush)
  process.once("SIGINT", flush)
  process.once("SIGTERM", flush)
}

ensureLoaded()
bindExitFlush()

export default {
  scopeKey,
  isSessionActive,
  startSession,
  stopSession,
  listActiveSessions,
  getHistory,
  setHistory,
  clearHistory,
  compressHistory,
  pushTurn,
  checkCooldown,
}
