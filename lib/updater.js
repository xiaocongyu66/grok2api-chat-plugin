/**
 * 插件自更新：官方仓库
 * https://github.com/xiaocongyu66/grok2api-chat-plugin
 *
 * - 检查：git fetch + 对比本地/远程 SHA（GitHub API 兜底）
 * - 更新：git pull --ff-only（强制：fetch + reset --hard @{u}）
 * - 用户配置 config/config/ 与 data/ 在 .gitignore 中，不会被覆盖
 */
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { Plugin_Path, Plugin_Name } from "../components/path.js"
import Config from "../components/Config.js"

const execFileAsync = promisify(execFile)

export const OFFICIAL_REPO = "https://github.com/xiaocongyu66/grok2api-chat-plugin.git"
export const OFFICIAL_REPO_HTTPS = "https://github.com/xiaocongyu66/grok2api-chat-plugin"
export const DEFAULT_BRANCH = "main"

const STATUS = {
  FAIL: "FAIL",
  SUCCESS: "SUCCESS",
  NO_UPDATE: "NO_UPDATE",
  HAS_UPDATE: "HAS_UPDATE",
  NOT_GIT: "NOT_GIT",
}

function cfgUpdate() {
  const c = Config.get()
  return {
    repo: String(c.updateRepo || OFFICIAL_REPO).trim() || OFFICIAL_REPO,
    branch: String(c.updateBranch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH,
    autoCheck: c.autoUpdateCheck !== false,
    autoPull: !!c.autoUpdatePull,
  }
}

function pkgVersion() {
  try {
    const p = path.join(Plugin_Path, "package.json")
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    return String(j.version || "0.0.0")
  } catch {
    return "0.0.0"
  }
}

async function runGit(args, { timeout = 120000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: Plugin_Path,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return {
      ok: true,
      stdout: String(stdout || "").trim(),
      stderr: String(stderr || "").trim(),
    }
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || "").trim(),
      stderr: String(e.stderr || e.message || "").trim(),
      code: e.code,
    }
  }
}

export function isGitRepo() {
  return fs.existsSync(path.join(Plugin_Path, ".git"))
}

async function ensureRemote(repo) {
  const remote = await runGit(["remote", "get-url", "origin"])
  if (!remote.ok) {
    const add = await runGit(["remote", "add", "origin", repo])
    if (!add.ok) throw new Error(`添加 origin 失败: ${add.stderr || add.stdout}`)
    return { changed: true, url: repo }
  }
  const cur = remote.stdout.trim()
  // 允许 .git 后缀差异、http/https
  const norm = u =>
    String(u || "")
      .replace(/\.git$/i, "")
      .replace(/^git@github\.com:/i, "https://github.com/")
      .replace(/\/$/, "")
      .toLowerCase()
  if (norm(cur) !== norm(repo) && !norm(cur).includes("xiaocongyu66/grok2api-chat-plugin")) {
    // 非官方 remote：纠正为官方仓库
    const set = await runGit(["remote", "set-url", "origin", repo])
    if (!set.ok) throw new Error(`设置 origin 失败: ${set.stderr}`)
    return { changed: true, url: repo, prev: cur }
  }
  return { changed: false, url: cur }
}

export async function getLocalInfo() {
  const version = pkgVersion()
  if (!isGitRepo()) {
    return { version, git: false, sha: "", branch: "", short: "" }
  }
  const sha = await runGit(["rev-parse", "HEAD"])
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"])
  const full = sha.ok ? sha.stdout : ""
  return {
    version,
    git: true,
    sha: full,
    short: full ? full.slice(0, 7) : "",
    branch: branch.ok ? branch.stdout : "",
  }
}

/** GitHub API 兜底（无 git / fetch 失败时） */
async function fetchGithubTip(branch) {
  const url = `https://api.github.com/repos/xiaocongyu66/grok2api-chat-plugin/commits/${encodeURIComponent(branch)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${Plugin_Name}-updater`,
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
    const data = await res.json()
    return {
      sha: data.sha || "",
      short: String(data.sha || "").slice(0, 7),
      message: data.commit?.message?.split("\n")[0] || "",
      date: data.commit?.committer?.date || data.commit?.author?.date || "",
      htmlUrl: data.html_url || OFFICIAL_REPO_HTTPS,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 检查是否有更新
 * @returns {{ status, local, remote, commits?, message }}
 */
export async function checkUpdate() {
  const { repo, branch } = cfgUpdate()
  const local = await getLocalInfo()

  if (!local.git) {
    // 非 git 安装：仅用 API 对比 package 不够精确，提示用 git 安装
    try {
      const tip = await fetchGithubTip(branch)
      return {
        status: STATUS.NOT_GIT,
        local,
        remote: tip,
        message:
          `当前不是 git 克隆安装，无法自动 pull。\n` +
          `官方最新：${tip.short} ${tip.message}\n` +
          `请重新安装：\ncd plugins && git clone ${OFFICIAL_REPO_HTTPS}.git`,
      }
    } catch (e) {
      return {
        status: STATUS.FAIL,
        local,
        message: `非 git 安装，且拉取远程信息失败：${e.message}`,
      }
    }
  }

  try {
    await ensureRemote(repo)
  } catch (e) {
    return { status: STATUS.FAIL, local, message: e.message }
  }

  const fetchRes = await runGit(
    ["fetch", "origin", branch, "--prune"],
    { timeout: 180000 },
  )
  if (!fetchRes.ok) {
    // fetch 失败 → API 兜底
    try {
      const tip = await fetchGithubTip(branch)
      const has = tip.sha && local.sha && tip.sha !== local.sha
      return {
        status: has ? STATUS.HAS_UPDATE : STATUS.NO_UPDATE,
        local,
        remote: { ...tip, branch, via: "api" },
        message: has
          ? `发现新提交 ${tip.short}（API；git fetch 失败: ${fetchRes.stderr.slice(0, 120)}）`
          : `已是最新（API）${local.short || local.version}`,
        commits: has && tip.message ? [tip.message] : [],
      }
    } catch (e) {
      return {
        status: STATUS.FAIL,
        local,
        message: `git fetch 失败：${fetchRes.stderr || fetchRes.stdout || e.message}`,
      }
    }
  }

  const remoteSha = await runGit(["rev-parse", `origin/${branch}`])
  if (!remoteSha.ok) {
    return {
      status: STATUS.FAIL,
      local,
      message: `无法解析 origin/${branch}：${remoteSha.stderr}`,
    }
  }

  const rsha = remoteSha.stdout
  if (rsha === local.sha) {
    return {
      status: STATUS.NO_UPDATE,
      local,
      remote: { sha: rsha, short: rsha.slice(0, 7), branch },
      message: `已是最新 ${local.version}（${local.short}）`,
    }
  }

  // 提交列表
  const log = await runGit([
    "log",
    "--pretty=format:%h %s",
    `HEAD..origin/${branch}`,
  ])
  const commits = log.ok && log.stdout
    ? log.stdout.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 15)
    : []

  return {
    status: STATUS.HAS_UPDATE,
    local,
    remote: { sha: rsha, short: rsha.slice(0, 7), branch },
    commits,
    message: `发现更新：${local.short} → ${rsha.slice(0, 7)}（共 ${commits.length || "?"} 个提交）`,
  }
}

/**
 * 执行更新
 * @param {{ force?: boolean }} opts
 */
export async function doUpdate({ force = false } = {}) {
  const { repo, branch } = cfgUpdate()
  const local = await getLocalInfo()

  if (!local.git) {
    return {
      status: STATUS.NOT_GIT,
      message:
        `当前目录不是 git 仓库，无法自动更新。\n` +
        `请：\ncd plugins && rm -rf ${Plugin_Name} && git clone ${OFFICIAL_REPO_HTTPS}.git ${Plugin_Name}`,
    }
  }

  try {
    await ensureRemote(repo)
  } catch (e) {
    return { status: STATUS.FAIL, message: e.message }
  }

  // 先检查
  const chk = await checkUpdate()
  if (chk.status === STATUS.NO_UPDATE && !force) {
    return { status: STATUS.NO_UPDATE, message: chk.message, local: chk.local }
  }
  if (chk.status === STATUS.FAIL) {
    return { status: STATUS.FAIL, message: chk.message }
  }

  let pull
  if (force) {
    // 强制：丢弃本地代码改动（配置目录已 ignore）
    await runGit(["fetch", "origin", branch, "--prune"], { timeout: 180000 })
    pull = await runGit(["reset", "--hard", `origin/${branch}`])
  } else {
    // 优先 fast-forward；失败再 pull --rebase
    pull = await runGit(["pull", "--ff-only", "origin", branch], {
      timeout: 180000,
    })
    if (!pull.ok) {
      pull = await runGit(["pull", "--rebase", "origin", branch], {
        timeout: 180000,
      })
    }
  }

  if (!pull.ok) {
    const err = pull.stderr || pull.stdout || "unknown"
    // 本地有未提交改动
    if (/local changes|unmerged|conflict|diverged|would be overwritten/i.test(err)) {
      return {
        status: STATUS.FAIL,
        message:
          `更新失败（本地有代码冲突/改动）：\n${err.slice(0, 300)}\n` +
          `可发送「#Grok强制更新」丢弃本地代码改动（config/config 与 data 不受影响）`,
      }
    }
    return { status: STATUS.FAIL, message: `git 更新失败：${err.slice(0, 400)}` }
  }

  if (/Already up[ -]to[ -]date/i.test(pull.stdout + pull.stderr) && !force) {
    return { status: STATUS.NO_UPDATE, message: "已经是最新版本" }
  }

  const after = await getLocalInfo()
  const commits = chk.commits || []
  const logLines = commits.length
    ? commits.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : pull.stdout.slice(0, 300)

  return {
    status: STATUS.SUCCESS,
    local: after,
    commits,
    message:
      `更新成功：v${after.version}（${after.short}）\n` +
      `${logLines}\n` +
      `请重启 Bot 使插件完全生效（配置 config/config 已保留）`,
  }
}

/** 通知所有主人（兼容 Miao / TRSS） */
export async function notifyMasters(msg) {
  const text = String(msg || "").trim()
  if (!text) return
  try {
    if (typeof Bot?.sendMasterMsg === "function") {
      await Bot.sendMasterMsg(text)
      return
    }
  } catch {
    /* continue */
  }

  const masters = []
  try {
    if (Array.isArray(Bot?.master)) masters.push(...Bot.master)
  } catch {
    /* */
  }
  try {
    const mq = global.cfg?.masterQQ || global.Bot?.config?.masterQQ
    if (Array.isArray(mq)) masters.push(...mq)
  } catch {
    /* */
  }

  const uniq = [...new Set(masters.map(String).filter(Boolean))]
  for (const id of uniq) {
    try {
      const u = Number(id) || id
      if (Bot?.pickFriend) await Bot.pickFriend(u).sendMsg(text)
      else if (Bot?.pickUser) await Bot.pickUser(u).sendMsg(text)
    } catch (e) {
      logger?.warn?.(`[${Plugin_Name}] 通知主人 ${id} 失败: ${e.message}`)
    }
  }
  if (!uniq.length) {
    logger?.info?.(`[${Plugin_Name}] 更新通知（无主人可发）: ${text}`)
  }
}

/**
 * 自动检查（定时/启动）：有更新则通知；配置 autoUpdatePull 时尝试 pull
 */
export async function autoCheckAndMaybePull({ tell = true } = {}) {
  const u = cfgUpdate()
  if (!u.autoCheck) {
    return { status: "CANCEL", message: "已关闭自动检查更新" }
  }

  const chk = await checkUpdate()
  if (chk.status === STATUS.NO_UPDATE) {
    logger?.mark?.(`[${Plugin_Name}] 自动检查更新：已是最新 ${chk.local?.short || ""}`)
    return chk
  }
  if (chk.status === STATUS.FAIL || chk.status === STATUS.NOT_GIT) {
    logger?.warn?.(`[${Plugin_Name}] 自动检查更新：${chk.message}`)
    return chk
  }

  // HAS_UPDATE
  const commitPreview = (chk.commits || []).slice(0, 5).map((c, i) => `${i + 1}. ${c}`).join("\n")
  let msg =
    `[${Plugin_Name}] 发现新版本\n` +
    `${chk.local?.short || "?"} → ${chk.remote?.short || "?"}\n` +
    (commitPreview ? `${commitPreview}\n` : "") +
    `仓库：${OFFICIAL_REPO_HTTPS}\n`

  if (u.autoPull && chk.status === STATUS.HAS_UPDATE && isGitRepo()) {
    const up = await doUpdate({ force: false })
    if (up.status === STATUS.SUCCESS) {
      msg += `已自动更新成功，请重启 Bot\n${up.message}`
    } else if (up.status === STATUS.NO_UPDATE) {
      msg += `检查后已是最新`
    } else {
      msg += `自动 pull 失败：${up.message}\n请手动发送 #Grok更新 或 #Grok强制更新`
    }
  } else {
    msg += `发送 #Grok更新 进行更新（#Grok强制更新 可丢弃本地代码改动）`
  }

  if (tell) await notifyMasters(msg)
  logger?.mark?.(`[${Plugin_Name}] ${msg.replace(/\n/g, " | ")}`)
  return { ...chk, notify: msg }
}

export const UpdateStatus = STATUS

export default {
  checkUpdate,
  doUpdate,
  autoCheckAndMaybePull,
  getLocalInfo,
  notifyMasters,
  isGitRepo,
  OFFICIAL_REPO,
  OFFICIAL_REPO_HTTPS,
  UpdateStatus,
}
