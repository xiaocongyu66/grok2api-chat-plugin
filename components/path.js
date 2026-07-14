import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const Plugin_Name = "grok2api-chat-plugin"
export const Plugin_Path = path.join(path.dirname(__dirname))
export const Path = process.cwd()
