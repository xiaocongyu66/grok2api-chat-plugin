import Config from "../components/Config.js"

export function checkAccess(e, { needMaster = false } = {}) {
  const c = Config.get()
  if (!c.enable) return { ok: false, msg: "插件已关闭（锅巴 enable）" }
  if (!c.apiBase || !c.apiKey) {
    return { ok: false, msg: "请先在锅巴后台配置 apiBase 与 apiKey" }
  }
  if (needMaster && !e.isMaster) {
    return { ok: false, msg: "仅主人可用" }
  }
  if (c.masterOnly && !e.isMaster) {
    return { ok: false, msg: "插件已设为仅主人可用" }
  }
  if (e.isGroup) {
    const gid = String(e.group_id)
    if (c.groupBlacklist?.includes(gid)) return { ok: false, msg: "本群已禁用" }
    if (c.groupWhitelist?.length && !c.groupWhitelist.includes(gid)) {
      return { ok: false, msg: "本群不在白名单" }
    }
  }
  return { ok: true }
}

export default { checkAccess }
