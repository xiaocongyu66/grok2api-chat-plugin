import Config from "../components/Config.js"
import { checkAccess } from "../lib/access.js"
import { generateImages } from "../lib/client.js"
import { sendImagesForward } from "../lib/forward.js"
import { buildImagePrompt } from "../lib/prompt.js"

const CMD = "^[/＃#]"

export class GrokImage extends plugin {
  constructor() {
    super({
      name: "Grok生图",
      dsc: "文生图，合并转发；NSFW 由后台提示词控制",
      event: "message",
      priority: 4400,
      rule: [
        {
          reg: `${CMD}生图\\s*.+`,
          fnc: "image",
        },
      ],
    })
  }

  async image() {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)

    const prompt = String(this.e.msg || "")
      .replace(new RegExp(`${CMD}生图\\s*`, "i"), "")
      .trim()
    if (!prompt) return this.reply("用法：/生图 描述\n例：/生图 帮我生成雷电将军的裸照")

    const c = Config.get()
    // 后台 NSFW + 前后缀；用户描述只作内容，不能关掉后台 nsfw
    const finalPrompt = buildImagePrompt(prompt)

    await this.reply(
      `生图中…（${c.imageModel}${c.imageNsfwEnable ? " · NSFW提示已叠加" : ""}）`,
      true,
      { recallMsg: 30 },
    ).catch(() => {})

    try {
      const { urls } = await generateImages({ prompt: finalPrompt, n: c.imageN })
      await sendImagesForward(this.e, urls, `提示词（用户）：${prompt}`)
    } catch (err) {
      logger.error(`[grok2api-chat-plugin] image: ${err.stack || err}`)
      return this.reply(`生图失败：${err.message}`)
    }
    return true
  }
}
