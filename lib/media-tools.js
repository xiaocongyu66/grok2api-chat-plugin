/**
 * 对话内媒体工具（OpenAI tools / function calling）
 * - generate_image → POST /v1/images/generations
 * - generate_video → POST /v1/videos/generations
 * 结果由 chat 层用合并聊天记录转发（不直发普通消息）
 */

import Config from "../components/Config.js"
import { buildImagePrompt, buildVideoPrompt } from "./prompt.js"

// 延迟加载，避免与 client.js 循环依赖
async function mediaApi() {
  return import("./client.js")
}

/** OpenAI Chat Completions tools 定义 */
export function buildMediaToolDefs(cfg) {
  const c = cfg || Config.get()
  const tools = []
  if (c.chatToolImage !== false) {
    tools.push({
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Generate one or more images from a text description (and optional style notes). " +
          "Use when the user asks to draw, paint, generate, or create an image/picture/illustration/photo. " +
          "Do not use for pure text questions.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "Detailed visual description of the image to generate (subject, style, lighting, composition).",
            },
            n: {
              type: "integer",
              description: "Number of images (1-4). Default 1.",
              minimum: 1,
              maximum: 4,
            },
          },
          required: ["prompt"],
        },
      },
    })
  }
  if (c.chatToolVideo !== false) {
    tools.push({
      type: "function",
      function: {
        name: "generate_video",
        description:
          "Generate a short video from a text description (optionally guided by a still image URL). " +
          "Use when the user asks to make a video, animation, clip, or cinematic motion. " +
          "Do not use for pure text questions.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Motion / scene description for the video.",
            },
            duration: {
              type: "integer",
              description: "Duration in seconds (1-15). Optional.",
              minimum: 1,
              maximum: 15,
            },
            image_url: {
              type: "string",
              description: "Optional source image URL for image-to-video.",
            },
          },
          required: ["prompt"],
        },
      },
    })
  }
  return tools
}

/**
 * 执行单个工具调用
 * @returns {{ ok: boolean, name: string, summary: string, media?: object, error?: string }}
 */
export async function executeMediaTool(name, args = {}, { imageUrls = [] } = {}) {
  const c = Config.get()
  const n = String(name || "").trim()

  if (n === "generate_image") {
    const userPrompt = String(args.prompt || "").trim()
    if (!userPrompt) {
      return { ok: false, name: n, summary: "missing prompt", error: "prompt required" }
    }
    const count = Math.min(4, Math.max(1, Number(args.n) || c.imageN || 1))
    const finalPrompt = buildImagePrompt(userPrompt)
    try {
      const { generateImages } = await mediaApi()
      const { urls } = await generateImages({ prompt: finalPrompt, n: count })
      return {
        ok: true,
        name: n,
        summary: `generated ${urls.length} image(s)`,
        media: {
          type: "image",
          urls,
          userPrompt,
        },
        // 给模型看的 tool 结果（不要塞 base64）
        toolContent: JSON.stringify({
          ok: true,
          count: urls.length,
          urls: urls.map((u, i) => (String(u).startsWith("base64://") ? `[image ${i + 1} base64]` : u)),
          note: "Images will be delivered to the user as a merge-forward chat record.",
        }),
      }
    } catch (e) {
      return {
        ok: false,
        name: n,
        summary: e.message,
        error: e.message,
        toolContent: JSON.stringify({ ok: false, error: e.message }),
      }
    }
  }

  if (n === "generate_video") {
    const userPrompt = String(args.prompt || "").trim()
    if (!userPrompt) {
      return { ok: false, name: n, summary: "missing prompt", error: "prompt required" }
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
        toolContent: JSON.stringify({
          ok: true,
          url: result.url,
          duration: result.duration,
          note: "Video will be delivered to the user as a merge-forward chat record.",
        }),
      }
    } catch (e) {
      return {
        ok: false,
        name: n,
        summary: e.message,
        error: e.message,
        toolContent: JSON.stringify({ ok: false, error: e.message }),
      }
    }
  }

  return {
    ok: false,
    name: n,
    summary: "unknown tool",
    error: `unknown tool: ${n}`,
    toolContent: JSON.stringify({ ok: false, error: `unknown tool: ${n}` }),
  }
}

/** 解析 tool_calls 参数 JSON */
export function parseToolArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === "object") return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return { prompt: String(raw) }
  }
}

/**
 * 从 assistant message 提取 tool_calls（OpenAI 格式）
 */
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
  buildMediaToolDefs,
  executeMediaTool,
  parseToolArgs,
  extractToolCalls,
}
