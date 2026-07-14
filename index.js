import fs from "node:fs"
import path from "node:path"
import chalk from "chalk"
import { Plugin_Path, Plugin_Name } from "./components/path.js"
import Config from "./components/Config.js"

const appsPath = path.join(Plugin_Path, "apps")
const files = fs.readdirSync(appsPath).filter(f => f.endsWith(".js"))

let ret = await Promise.allSettled(files.map(f => import(`./apps/${f}`)))

const apps = {}
for (let i = 0; i < files.length; i++) {
  const name = files[i].replace(/\.js$/, "")
  if (ret[i].status !== "fulfilled") {
    logger.error(`[${Plugin_Name}] 载入 ${name} 失败`, ret[i].reason)
    continue
  }
  const mod = ret[i].value
  const key = Object.keys(mod)[0]
  if (key) apps[name] = mod[key]
}

try {
  Config.get()
  logger.info(chalk.cyan(`[${Plugin_Name}] v1.0.0 已加载 · 锅巴可配 api/key/模型`))
} catch (e) {
  logger.warn(`[${Plugin_Name}] 配置初始化: ${e.message}`)
}

export { apps }
