/**
 * 插件更新指令 + 定时/启动自动检查
 * 官方仓库：https://github.com/xiaocongyu66/grok2api-chat-plugin
 */
import Config from "../components/Config.js"
import {
  checkUpdate,
  doUpdate,
  autoCheckAndMaybePull,
  getLocalInfo,
  OFFICIAL_REPO_HTTPS,
  UpdateStatus,
} from "../lib/updater.js"

const CMD = "^[＃#]"
// 防并发
let busy = false
let bootChecked = false

export class GrokUpdate extends plugin {
  constructor() {
    super({
      name: "Grok更新",
      dsc: "检查/拉取官方仓库更新",
      event: "message",
      priority: 4200,
      rule: [
        {
          reg: `${CMD}(Grok|grok|GROK|g2a|G2A)?\\s*(版本|version)$`,
          fnc: "version",
        },
        {
          reg: `${CMD}(Grok|grok|GROK|g2a|G2A)?\\s*(检查更新|更新检查)$`,
          fnc: "check",
        },
        {
          reg: `${CMD}(Grok|grok|GROK|g2a|G2A)?\\s*强制更新$`,
          fnc: "forceUpdate",
          permission: "master",
        },
        {
          reg: `${CMD}(Grok|grok|GROK|g2a|G2A)?\\s*(更新|升级|update)$`,
          fnc: "update",
          permission: "master",
        },
      ],
    })

    // 定时任务：默认每天 4:30（Yunzai quartz）
    const c = safeCfg()
    if (c.autoUpdateCheck !== false) {
      this.task = {
        cron: c.autoUpdateCron || "0 30 4 * * ?",
        name: "Grok2API自动检查更新",
        fnc: () => this.onCron(),
        log: false,
      }
    }

    // 启动后延迟检查一次
    if (!bootChecked) {
      bootChecked = true
      const delay = Math.max(5, Number(c.autoUpdateBootDelaySec) || 45) * 1000
      setTimeout(() => {
        autoCheckAndMaybePull({ tell: true }).catch(e => {
          logger?.warn?.(`[grok2api-chat-plugin] 启动检查更新失败: ${e.message}`)
        })
      }, delay)
    }
  }

  async version() {
    const info = await getLocalInfo()
    const lines = [
      `Grok2API Chat 插件`,
      `版本：v${info.version}`,
      info.git
        ? `Git：${info.branch || "?"} @ ${info.short || "?"}`
        : `Git：非 git 安装（无法自动 pull）`,
      `仓库：${OFFICIAL_REPO_HTTPS}`,
    ]
    return this.reply(lines.join("\n"))
  }

  async check() {
    if (!this.e.isMaster) return this.reply("仅主人可检查更新")
    if (busy) return this.reply("更新任务进行中，请稍候…")
    busy = true
    try {
      await this.reply("正在检查官方仓库更新…", true, { recallMsg: 15 }).catch(
        () => {},
      )
      const r = await checkUpdate()
      if (r.status === UpdateStatus.NO_UPDATE) {
        return this.reply(`已是最新\n${r.message}`)
      }
      if (r.status === UpdateStatus.HAS_UPDATE) {
        const logs = (r.commits || [])
          .slice(0, 10)
          .map((c, i) => `${i + 1}. ${c}`)
          .join("\n")
        return this.reply(
          `${r.message}\n` +
            (logs ? `${logs}\n` : "") +
            `发送 #Grok更新 进行更新`,
        )
      }
      if (r.status === UpdateStatus.NOT_GIT) {
        return this.reply(r.message)
      }
      return this.reply(`检查失败：${r.message}`)
    } catch (e) {
      return this.reply(`检查异常：${e.message}`)
    } finally {
      busy = false
    }
  }

  async update() {
    return this.runUpdate(false)
  }

  async forceUpdate() {
    return this.runUpdate(true)
  }

  async runUpdate(force) {
    if (!this.e.isMaster) return this.reply("仅主人可更新插件")
    if (busy) return this.reply("更新任务进行中，请稍候…")
    busy = true
    try {
      await this.reply(
        force
          ? "正在强制更新（将丢弃本地代码改动，配置保留）…"
          : "正在从官方仓库更新…",
        true,
        { recallMsg: 20 },
      ).catch(() => {})

      const r = await doUpdate({ force })
      if (r.status === UpdateStatus.NO_UPDATE) {
        return this.reply(r.message || "已经是最新版本")
      }
      if (r.status === UpdateStatus.SUCCESS) {
        return this.reply(r.message)
      }
      return this.reply(`更新失败：${r.message}`)
    } catch (e) {
      logger?.error?.(`[grok2api-chat-plugin] update: ${e.stack || e}`)
      return this.reply(`更新异常：${e.message}`)
    } finally {
      busy = false
    }
  }

  async onCron() {
    try {
      await autoCheckAndMaybePull({ tell: true })
    } catch (e) {
      logger?.warn?.(`[grok2api-chat-plugin] 定时检查更新: ${e.message}`)
    }
  }
}

function safeCfg() {
  try {
    return Config.get()
  } catch {
    return {}
  }
}
