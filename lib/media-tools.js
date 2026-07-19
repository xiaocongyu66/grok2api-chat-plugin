/**
 * 对话内媒体工具（OpenAI tools / function calling）
 * 规范见 docs/TOOLS.md
 *
 * 原则：
 * - 仅当用户明确要「生成/画出/做成图或视频」时才挂载 tools
 * - 「描述 / 说说 / 文字」不得触发工具
 * - 单轮最多成功 1 次生图、1 次生视频；限流后不再重试
 */

import Config from "../components/Config.js"
import { buildImagePrompt, buildVideoPrompt } from "./prompt.js"

async function mediaApi() {
  return import("./client.js")
}

/**
 * 用户是否明确要求生成图片（非「用文字描述」）
 */
export function userWantsImageGen(text) {
  const t = String(text || "").trim()
  if (!t) return false
  // 明确只要文字描述 → 不生图
  if (
    /(?:用文字|文字描述|文字版|只描述|只说|说说|讲讲|描写一下|描述一下|口述|别画|不要图|不用图|别生成图|不要生成图|别出图|不要出图)/i.test(
      t,
    )
  ) {
    // 若同时有「画一张」等强意图，仍可能要图；但「描述」优先当文字
    if (!/(?:画一张|生成一张|出一张图|做一张图|画个|画张)/i.test(t)) {
      return false
    }
  }
  return /(?:生图|#生图|画一[张幅个]|画张|画个|画只|画个|来一[张幅]图|出一[张幅]图|生成图|生成一[张幅]|做一[张幅]图|做个图|做张图|画图|绘图|作图|出图|配图|插画|插图|壁纸|封面图|海报|截图风格|imagine|draw\b|paint\b|generate\s+(an?\s+)?image|create\s+(an?\s+)?image|make\s+(an?\s+)?image|text[\s-]?to[\s-]?image)/i.test(
    t,
  )
}

/**
 * 用户是否明确要求生成视频
 */
export function userWantsVideoGen(text) {
  const t = String(text || "").trim()
  if (!t) return false
  if (
    /(?:用文字|文字描述|只描述|别做视频|不要视频|不用视频|别生成视频)/i.test(t) &&
    !/(?:做个视频|生成视频|出个视频)/i.test(t)
  ) {
    return false
  }
  return /(?:生视频|#生视频|做个视频|做段视频|生成视频|出个视频|来段视频|动画|短片|视频片段|cinematic|generate\s+(a\s+)?video|create\s+(a\s+)?video|make\s+(a\s+)?video|text[\s-]?to[\s-]?video)/i.test(
    t,
  )
}

/** 是否应为本轮挂载任意媒体工具 */
export function userWantsAnyMediaTool(text) {
  return userWantsImageGen(text) || userWantsVideoGen(text)
}

/**
 * 注入给模型的工具使用规范（仅当本轮挂载了 tools）
 */
export function mediaToolPolicyText() {
  return `
[媒体工具使用规范 — 必须遵守]
你拥有可选工具 generate_image / generate_video，但默认用文字回答。

【禁止调用工具】
- 用户只要「描述、描写、说说、讲讲、文字版、用文字、角色设定、剧情」→ 只输出文字，禁止 tool_calls。
- 用户没有明确说「画/生成图/做视频」→ 禁止调用工具。
- 同一用户请求：generate_image 最多成功 1 次，generate_video 最多成功 1 次；禁止连环重试。
- 工具返回 ok:false 或 429/限流 → 立刻停止再调同类工具，用简短中文说明失败原因，可提供文字描述代替。

【允许调用工具】（仅当用户明确要求产出媒体）
- 图片：画一张、生成图、出图、#生图、draw/generate image 等。
- 视频：做个视频、生成视频、#生视频 等。
- 调用时 prompt 用英文或中英混合的画面描述，一次写清主体/风格/构图；n 默认 1。

【调用后】
- 图片/视频会由系统以「合并聊天记录」发给用户，你只需简短确认（一两句），不要假装已嵌入图片链接长文。
- 不要为了「效果更好」连续多次 generate_image。
`.trim()
}

/** OpenAI tools 定义（严格文案，减少误触） */
export function buildMediaToolDefs(cfg, { userText } = {}) {
  const c = cfg || Config.get()
  const tools = []
  const wantImg =
    c.chatToolImage !== false &&
    (userText == null || userWantsImageGen(userText))
  const wantVid =
    c.chatToolVideo !== false &&
    (userText == null || userWantsVideoGen(userText))

  if (wantImg) {
    tools.push({
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Render a real image file for the user. ONLY call when the user explicitly wants a picture generated " +
          "(e.g. 画一张/生成图/出图/draw/generate image). " +
          "NEVER call for: 描述/描写/说说/文字版/explain/describe in words only. " +
          "Call at most ONCE per user message. On error/rate-limit do not retry.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "Single detailed visual prompt (subject, style, lighting, composition). One shot only.",
            },
            n: {
              type: "integer",
              description: "Number of images, default 1, max 2.",
              minimum: 1,
              maximum: 2,
            },
            image_url: {
              type: "string",
              description:
                "Optional source image URL. When set, uses /v1/images/edits instead of generations.",
            },
          },
          required: ["prompt"],
        },
      },
    })
  }
  if (wantVid) {
    tools.push({
      type: "function",
      function: {
        name: "generate_video",
        description:
          "Render a short video. ONLY when user explicitly wants a video (做个视频/生成视频/generate video). " +
          "NEVER for text-only description requests. Call at most ONCE per user message.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Motion/scene description for the video.",
            },
            duration: {
              type: "integer",
              description: "Seconds 1-15, optional.",
              minimum: 1,
              maximum: 15,
            },
            image_url: {
              type: "string",
              description: "Optional still image URL for image-to-video.",
            },
          },
          required: ["prompt"],
        },
      },
    })
  }
  return tools
}

function isRateLimited(errMsg) {
  return /429|rate\s*limit|速率|限流|too many/i.test(String(errMsg || ""))
}

/**
 * 执行单个工具
 */
export async function executeMediaTool(name, args = {}, { imageUrls = [] } = {}) {
  const c = Config.get()
  const n = String(name || "").trim()

  if (n === "generate_image") {
    const userPrompt = String(args.prompt || "").trim()
    if (!userPrompt) {
      return {
        ok: false,
        name: n,
        summary: "missing prompt",
        error: "prompt required",
        rateLimited: false,
        toolContent: JSON.stringify({
          ok: false,
          error: "prompt required",
          stop_retry: true,
        }),
      }
    }
    const count = Math.min(2, Math.max(1, Number(args.n) || 1))
    const finalPrompt = buildImagePrompt(userPrompt)
    const editUrl =
      String(args.image_url || "").trim() ||
      (Array.isArray(imageUrls) && imageUrls[0] ? String(imageUrls[0]) : "")
    try {
      const api = await mediaApi()
      const { urls } = editUrl
        ? await api.editImages({
            prompt: finalPrompt,
            imageUrl: editUrl,
            n: count,
          })
        : await api.generateImages({ prompt: finalPrompt, n: count })
      return {
        ok: true,
        name: n,
        summary: `${editUrl ? "edited" : "generated"} ${urls.length} image(s)`,
        media: { type: "image", urls, userPrompt },
        rateLimited: false,
        toolContent: JSON.stringify({
          ok: true,
          count: urls.length,
          edited: !!editUrl,
          delivered_by_system: true,
          note: "Image already sent via merge-forward. Reply in one short Chinese sentence. Do NOT call generate_image again.",
        }),
      }
    } catch (e) {
      const msg = e.message || String(e)
      const rl = isRateLimited(msg)
      return {
        ok: false,
        name: n,
        summary: msg,
        error: msg,
        rateLimited: rl,
        toolContent: JSON.stringify({
          ok: false,
          error: msg,
          rate_limited: rl,
          stop_retry: true,
          note: "Do not call generate_image again this turn. Apologize briefly and offer a text description if useful.",
        }),
      }
    }
  }

  if (n === "generate_video") {
    const userPrompt = String(args.prompt || "").trim()
    if (!userPrompt) {
      return {
        ok: false,
        name: n,
        summary: "missing prompt",
        error: "prompt required",
        rateLimited: false,
        toolContent: JSON.stringify({
          ok: false,
          error: "prompt required",
          stop_retry: true,
        }),
      }
    }
    const finalPrompt = buildVideoPrompt(userPrompt)
    const imageUrl =
      String(args.image_url || "").trim() ||
      (Array.isArray(imageUrls) && imageUrls[0] ? String(imageUrls[0]) : "")
    const duration = args.duration != null ? Number(args.duration) : undefined
    try {
      const { generateVideo } = await mediaApi()
      const result = await generateVideo({
        prompt: finalPrompt,
        imageUrl: imageUrl || undefined,
        duration,
      })
      return {
        ok: true,
        name: n,
        summary: `generated video ${result.url ? "ok" : "no-url"}`,
        media: {
          type: "video",
          url: result.url,
          duration: result.duration,
          userPrompt,
        },
        rateLimited: false,
        toolContent: JSON.stringify({
          ok: true,
          url: result.url,
          duration: result.duration,
          delivered_by_system: true,
          note: "Video already sent via merge-forward. One short Chinese confirm only. Do NOT call generate_video again.",
        }),
      }
    } catch (e) {
      const msg = e.message || String(e)
      const rl = isRateLimited(msg)
      return {
        ok: false,
        name: n,
        summary: msg,
        error: msg,
        rateLimited: rl,
        toolContent: JSON.stringify({
          ok: false,
          error: msg,
          rate_limited: rl,
          stop_retry: true,
          note: "Do not call generate_video again this turn.",
        }),
      }
    }
  }

  return {
    ok: false,
    name: n,
    summary: "unknown tool",
    error: `unknown tool: ${n}`,
    rateLimited: false,
    toolContent: JSON.stringify({ ok: false, error: `unknown tool: ${n}` }),
  }
}

export function parseToolArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === "object") return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return { prompt: String(raw) }
  }
}

export function extractToolCalls(message) {
  if (!message || typeof message !== "object") return []
  const list = message.tool_calls
  if (!Array.isArray(list) || !list.length) return []
  return list
    .map(tc => {
      const fn = tc.function || tc
      return {
        id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: tc.type || "function",
        name: fn.name || tc.name || "",
        arguments: parseToolArgs(fn.arguments ?? tc.arguments),
      }
    })
    .filter(t => t.name)
}

export default {
  userWantsImageGen,
  userWantsVideoGen,
  userWantsAnyMediaTool,
  mediaToolPolicyText,
  buildMediaToolDefs,
  executeMediaTool,
  parseToolArgs,
  extractToolCalls,
}
