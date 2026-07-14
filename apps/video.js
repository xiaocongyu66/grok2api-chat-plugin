import Config from "../components/Config.js"
import { checkAccess } from "../lib/access.js"
import { generateVideo } from "../lib/client.js"
import { sendVideoForward } from "../lib/forward.js"
import { buildVideoPrompt } from "../lib/prompt.js"

const CMD = "^[＃#]"

export class GrokVideo extends plugin {
  constructor() {
    super({
      name: "Grok生视频",
      dsc: "文/图生视频，合并转发；NSFW 后台提示",
      event: "message",
      priority: 4400,
      rule: [
        {
          reg: `${CMD}生视频\\s*.*`,
          fnc: "video",
        },
      ],
    })
  }

  async video() {
    const a = checkAccess(this.e)
    if (!a.ok) return this.reply(a.msg)

    let prompt = String(this.e.msg || "")
      .replace(new RegExp(`${CMD}生视频\\s*`, "i"), "")
      .trim()

    let imageUrl = ""
    try {
      const imgs = this.e.img || []
      if (imgs.length) imageUrl = imgs[0]
    } catch {
      /* ignore */
    }

    if (!prompt && !imageUrl) {
      return this.reply("用法：#生视频 描述\n或先发图再 #生视频 镜头说明")
    }

    const c = Config.get()
    const finalPrompt = buildVideoPrompt(prompt || "cinematic motion")

    await this.reply(
      `视频任务提交中（${c.videoModel}，${c.videoDuration}s，最长等 ${c.videoPollMaxSec}s` +
        `${c.videoNsfwEnable ? " · NSFW提示已叠加" : ""}）…`,
      true,
      { recallMsg: 60 },
    ).catch(() => {})

    try {
      const result = await generateVideo({
        prompt: finalPrompt,
        imageUrl: imageUrl || undefined,
        duration: c.videoDuration,
        aspectRatio: c.videoAspectRatio,
        resolution: c.videoResolution,
      })
      await sendVideoForward(this.e, result.url, {
        prompt: prompt || "(图生视频)",
        duration: result.duration,
      })
    } catch (err) {
      logger.error(`[grok2api-chat-plugin] video: ${err.stack || err}`)
      return this.reply(`生视频失败：${err.message}`)
    }
    return true
  }
}
