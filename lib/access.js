import Config from "../components/Config.js"

function isPrivateChat(e) {
  if (e?.isPrivate || e?.message_type === "private") return true
  if (e?.isGroup || e?.message_type === "group") return false
  return e?.group_id == null || e?.group_id === ""
}

export function checkAccess(e, { needMaster = false } = {}) {
  const c = Config.get()
  if (!c.enable) return { ok: false, msg: "插件已关闭（锅巴 enable）" }
  if (!c.apiBase || !c.apiKey) {
    return {
      ok: false,
      msg: "请先在锅巴配置 API 地址(apiBase) 与 API Key（OpenAI 兼容 Bearer）",
    }
  }
  if (needMaster && !e.isMaster) {
    return { ok: false, msg: "仅主人可用" }
  }
  if (c.masterOnly && !e.isMaster) {
    return { ok: false, msg: "插件已设为仅主人可用" }
  }

  // 锅巴：是否支持私聊（关=私聊全部功能不可用，含对话/生图/生视频）
  if (isPrivateChat(e) && c.privateChatEnable === false) {
    return { ok: false, msg: "私聊功能已关闭（锅巴 → 是否支持私聊）" }
  }

  if (e.isGroup || e?.message_type === "group" || e?.group_id) {
    const gid = String(e.group_id)
    if (c.groupBlacklist?.includes(gid)) return { ok: false, msg: "本群已禁用" }
    if (c.groupWhitelist?.length && !c.groupWhitelist.includes(gid)) {
      return { ok: false, msg: "本群不在白名单" }
    }
  }
  return { ok: true }
}

export default { checkAccess }
