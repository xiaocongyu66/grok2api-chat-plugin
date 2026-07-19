import Config from "../components/Config.js"
import { checkAccess } from "../lib/access.js"
import { generateImages, editImages } from "../lib/client.js"
import { sendImagesForward } from "../lib/forward.js"
import { buildImagePrompt } from "../lib/prompt.js"

const CMD = "^[＃#]"

export class GrokImage extends plugin {
  constructor() {
    super({
      name: "Grok生图",
      dsc: "文生图 / 图编辑，合并转发；走 /v1/images/*",
      event: "message",
      priority: 4400,
      rule: [
        {
          reg: `${CMD}(改图|编辑图|图编辑)\\s*.*`,
          fnc: "edit",
        },
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
    if (!prompt) return this.reply("用法：#生图 描述\n例：#生图 赛博朋克城市夜景")

    const c = Config.get()
    // 后台 NSFW + 前后缀；用户描述只作内容，不能关掉后台 nsfw
    const finalPrompt = buildImagePrompt(prompt)

    // 若用户同时带了图，自动走 edits（更符合「基于这张图生成」）
    let imageUrl = ""
    try {
      const imgs = this.e.img || []
      if (imgs.length) imageUrl = imgs[0]
    } catch {
      /* ignore */
    }

    await this.reply(
      imageUrl
        ? `图编辑中…（${c.imageEditModel}${c.imageNsfwEnable ? " · NSFW" : ""}）`
        : `生图中…（${c.imageModel}${c.imageNsfwEnable ? " · NSFW提示已叠加" : ""}）`,
      true,
      { recallMsg: 30 },
    ).catch(() => {})

    try {
      let urls
      if (imageUrl) {
        ;({ urls } = await editImages({
          prompt: finalPrompt,
          imageUrl,
          n: c.imageN,
        }))
      } else {
        ;({ urls } = await generateImages({ prompt: finalPrompt, n: c.imageN }))
      }
      await sendImagesForward(this.e, urls, `提示词（用户）：${prompt}`)
    } catch (err) {
      logger.error(`[grok2api-chat-plugin] image: ${err.stack || err}`)
      return this.reply(`生图失败：${err.message}`)
    }
    return true
  }

  /** #改图 / #编辑图 — POST /v1/images/edits */
  async edit() {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)

    const prompt = String(this.e.msg || "")
      .replace(new RegExp(`${CMD}(改图|编辑图|图编辑)\\s*`, "i"), "")
      .trim()

    let imageUrl = ""
    try {
      const imgs = this.e.img || []
      if (imgs.length) imageUrl = imgs[0]
    } catch {
      /* ignore */
    }

    if (!imageUrl) {
      return this.reply("用法：先发图，再 #改图 把背景换成海边\n或 引用图片后 #改图 …")
    }
    if (!prompt) {
      return this.reply("用法：#改图 修改说明（需带原图）")
    }

    const c = Config.get()
    const finalPrompt = buildImagePrompt(prompt)

    await this.reply(
      `图编辑中…（${c.imageEditModel} · /v1/images/edits）`,
      true,
      { recallMsg: 30 },
    ).catch(() => {})

    try {
      const { urls } = await editImages({
        prompt: finalPrompt,
        imageUrl,
        n: c.imageN,
      })
      await sendImagesForward(this.e, urls, `改图（用户）：${prompt}`)
    } catch (err) {
      logger.error(`[grok2api-chat-plugin] edit: ${err.stack || err}`)
      return this.reply(`改图失败：${err.message}`)
    }
    return true
  }
}
