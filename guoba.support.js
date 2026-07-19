/**
 * 锅巴 Guoba-Plugin 配置对接
 * 规范：https://github.com/guoba-yunzai/guoba-plugin
 * 发现：plugins/<本插件目录>/guoba.support.js → export function supportGuoba()
 * 必备：configInfo.schemas + getConfigData + setConfigData
 */
import path from "node:path"
import Config from "./components/Config.js"
import { Plugin_Path, Plugin_Name } from "./components/path.js"

const BOOL_KEYS = [
  "enable",
  "autoUpdateCheck",
  "autoUpdatePull",
  "masterOnly",
  "tlsInsecure",
  "responsesSticky",
  "sessionPersist",
  "privateChatEnable",
  "privateSessionSelfStart",
  "allowOneShotWithoutSession",
  "freeChatInSession",
  "replyOnAt",
  "atReplyRequireQuestion",
  "atReplyAtUser",
  "replyOnQuote",
  "activeReplyOthers",
  "activeReplyAtUser",
  "passImages",
  "chatToolsEnable",
  "chatToolImage",
  "chatToolVideo",
  "imageNsfwEnable",
  "videoNsfwEnable",
  "adultContentEnable",
  "chatJailbreakEnable",
  "outboundReviewEnable",
  "outboundReviewAi",
  "chatNsfwForward",
  "chatNsfwAiReview",
]

const NUM_KEYS = [
  "timeoutMs",
  "requestRetries",
  "autoUpdateBootDelaySec",
  "passImagesMax",
  "chatToolMaxRounds",
  "maxHistory",
  "contextCompressMaxChars",
  "chatForwardThreshold",
  "activeReplyCooldownSec",
  "imageN",
  "videoDuration",
  "videoPollIntervalSec",
  "videoPollMaxSec",
]

/** 锅巴可能传 "true"/"false"/1/0 */
function toBool(v) {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true
    if (s === "false" || s === "0" || s === "no" || s === "off" || s === "") return false
  }
  return !!v
}

function toNum(v) {
  if (v === "" || v == null) return v
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}

/**
 * 锅巴 req.body 可能是：
 * 1) 扁平 { field: value }
 * 2) 点路径 { "a.b": value }（少数表单）
 */
function flattenBody(data) {
  if (!data || typeof data !== "object") return {}
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    if (k.includes(".")) {
      // 只取最后一级作为本插件扁平字段（我们 schemas 全是顶层 field）
      const leaf = k.split(".").pop()
      out[leaf] = v
    } else {
      out[k] = v
    }
  }
  return out
}

export function supportGuoba() {
  return {
    pluginInfo: {
      // 须与 plugins 目录名一致（锅巴以目录名 toLowerCase 注册）
      name: Plugin_Name,
      title: "Grok2API Chat",
      author: ["@xiaocongyu66", "@grok-free-register"],
      authorLink: [
        "https://github.com/xiaocongyu66",
        "https://github.com/xiaocongyu66/grok2api-chat-plugin",
      ],
      link: "https://github.com/xiaocongyu66/grok2api-chat-plugin",
      isV3: true,
      isV2: false,
      // auto：schemas≥3 时显示在左侧菜单
      showInMenu: "auto",
      description:
        "OpenAI 兼容全量 /v1（chat·responses·images·edits·videos）；支持 grok2api-sing / NewAPI 等",
      icon: "mdi:robot-happy-outline",
      iconColor: "#1DA1F2",
    },
    configInfo: {
      schemas: [
        // ---------- 自动更新 ----------
        { label: "自动更新（官方仓库）", component: "SOFT_GROUP_BEGIN" },
        {
          field: "autoUpdateCheck",
          label: "自动检查更新",
          component: "Switch",
          bottomHelpMessage:
            "启动后与定时任务检查 https://github.com/xiaocongyu66/grok2api-chat-plugin ；指令 #Grok检查更新 / #Grok更新",
        },
        {
          field: "autoUpdatePull",
          label: "发现更新后自动拉取",
          component: "Switch",
          bottomHelpMessage:
            "关=仅通知主人（推荐）；开=自动 git pull（仍建议重启 Bot）",
        },
        {
          field: "autoUpdateCron",
          label: "检查更新定时",
          component: "Input",
          bottomHelpMessage: "Yunzai quartz，默认 0 30 4 * * ?（每天 4:30）",
          componentProps: { placeholder: "0 30 4 * * ?" },
        },
        {
          field: "autoUpdateBootDelaySec",
          label: "启动延迟检查(秒)",
          component: "InputNumber",
          componentProps: { min: 5, max: 600 },
        },
        {
          field: "updateRepo",
          label: "更新仓库地址",
          component: "Input",
          bottomHelpMessage: "默认官方仓库，一般无需改",
        },
        {
          field: "updateBranch",
          label: "更新分支",
          component: "Input",
          bottomHelpMessage: "默认 main",
        },

        // ---------- 连接 ----------
        { label: "连接（OpenAI 兼容）", component: "SOFT_GROUP_BEGIN" },
        {
          field: "enable",
          label: "启用插件",
          component: "Switch",
          bottomHelpMessage: "总开关；关闭后指令不响应",
        },
        {
          field: "apiBase",
          label: "API 地址",
          component: "Input",
          required: true,
          bottomHelpMessage:
            "服务根地址，不要带 /v1。例：https://api.openai.com 或 http://127.0.0.1:8000（grok2api-sing）",
          componentProps: {
            placeholder: "http://127.0.0.1:8000",
          },
        },
        {
          field: "apiKey",
          label: "API Key",
          component: "InputPassword",
          required: true,
          bottomHelpMessage:
            "OpenAI sk-... / 网关 g2a_... / 其它兼容 Key。保存时留空则保留原 Key",
          componentProps: {
            placeholder: "sk-... 或 g2a_...",
          },
        },
        {
          field: "authHeaderMode",
          label: "鉴权头模式",
          component: "Select",
          bottomHelpMessage:
            "both=Bearer+X-API-Key（兼容 grok2api-sing）；bearer=纯 OpenAI 标准",
          componentProps: {
            options: [
              { label: "both（Bearer + X-API-Key，推荐）", value: "both" },
              { label: "bearer（仅 Authorization）", value: "bearer" },
              { label: "x-api-key（仅 X-API-Key）", value: "x-api-key" },
            ],
          },
        },
        {
          field: "apiOrganization",
          label: "OpenAI-Organization",
          component: "Input",
          bottomHelpMessage: "可选；官方 OpenAI 组织 ID",
        },
        {
          field: "apiProject",
          label: "OpenAI-Project",
          component: "Input",
          bottomHelpMessage: "可选；官方 OpenAI 项目 ID",
        },
        {
          field: "extraHeaders",
          label: "额外请求头",
          component: "InputTextArea",
          bottomHelpMessage: "每行 Header-Name: value；一般留空",
          componentProps: { rows: 2, placeholder: "X-Custom: value" },
        },
        {
          field: "tlsInsecure",
          label: "跳过 TLS 校验",
          component: "Switch",
          bottomHelpMessage: "仅自签/内网 HTTPS；公网正规证书请关闭",
        },
        {
          field: "requestRetries",
          label: "网络重试次数",
          component: "InputNumber",
          bottomHelpMessage: "瞬时网络错误额外重试（不含首次），默认 2",
          componentProps: { min: 0, max: 5 },
        },
        {
          field: "timeoutMs",
          label: "超时(ms)",
          component: "InputNumber",
          componentProps: { min: 10000, max: 600000, step: 1000 },
        },

        // ---------- 模型 / 对话接口 ----------
        { label: "模型与对话接口", component: "SOFT_GROUP_BEGIN" },
        {
          field: "chatModel",
          label: "对话模型",
          component: "Input",
          bottomHelpMessage: "填 #模型列表 里的 id；auto=自动选第一个对话模型",
          componentProps: { placeholder: "auto 或 grok-chat-auto / gpt-4o" },
        },
        {
          field: "chatApiMode",
          label: "对话接口",
          component: "Select",
          bottomHelpMessage:
            "chat=严格 OpenAI /v1/chat/completions（推荐）；responses=/v1/responses；auto=先 chat，协议失败再 responses",
          componentProps: {
            options: [
              { label: "chat（/v1/chat/completions，推荐）", value: "chat" },
              { label: "auto（Chat → Responses）", value: "auto" },
              { label: "responses（/v1/responses）", value: "responses" },
            ],
          },
        },
        {
          field: "responsesSticky",
          label: "Responses 粘滞 ID",
          component: "Switch",
          bottomHelpMessage:
            "chatApiMode 为 responses/auto 时自动传 previous_response_id",
        },
        {
          field: "temperature",
          label: "temperature",
          component: "Input",
          bottomHelpMessage: "OpenAI 采样温度；空=不传该字段",
          componentProps: { placeholder: "留空不传" },
        },
        {
          field: "maxTokens",
          label: "max_tokens",
          component: "Input",
          bottomHelpMessage: "OpenAI max_tokens；空=不传",
          componentProps: { placeholder: "留空不传" },
        },
        {
          field: "topP",
          label: "top_p",
          component: "Input",
          bottomHelpMessage: "OpenAI top_p；空=不传",
          componentProps: { placeholder: "留空不传" },
        },
        {
          field: "presencePenalty",
          label: "presence_penalty",
          component: "Input",
          bottomHelpMessage: "空=不传",
        },
        {
          field: "frequencyPenalty",
          label: "frequency_penalty",
          component: "Input",
          bottomHelpMessage: "空=不传",
        },
        {
          field: "passImages",
          label: "对话传递图片",
          component: "Switch",
          bottomHelpMessage: "开=用户发图一并给模型看图（需上游支持视觉）",
        },
        {
          field: "passImagesMax",
          label: "单次最多传图数",
          component: "InputNumber",
          componentProps: { min: 1, max: 8 },
        },
        {
          field: "chatToolsEnable",
          label: "对话内工具调用",
          component: "Switch",
          bottomHelpMessage:
            "开=仅当用户明确要画/生成图视频时挂 tools；「描述」只用文字",
        },
        {
          field: "chatToolImage",
          label: "工具：生图",
          component: "Switch",
        },
        {
          field: "chatToolVideo",
          label: "工具：生视频",
          component: "Switch",
        },
        {
          field: "chatToolMaxRounds",
          label: "工具最大往返轮数",
          component: "InputNumber",
          bottomHelpMessage: "1–10，默认 3",
          componentProps: { min: 1, max: 10 },
        },

        // ---------- 图片 / 视频模型 ----------
        { label: "图片 / 视频模型", component: "SOFT_GROUP_BEGIN" },
        {
          field: "imageModel",
          label: "图片模型",
          component: "Input",
          bottomHelpMessage: "POST /v1/images/generations",
          componentProps: { placeholder: "grok-imagine-image" },
        },
        {
          field: "imageEditModel",
          label: "图编辑模型",
          component: "Input",
          bottomHelpMessage: "POST /v1/images/edits；#改图",
          componentProps: { placeholder: "grok-imagine-image-edit" },
        },
        {
          field: "imageN",
          label: "一次张数",
          component: "InputNumber",
          componentProps: { min: 1, max: 10 },
        },
        {
          field: "imageSize",
          label: "图片 size",
          component: "Input",
          bottomHelpMessage: "OpenAI 兼容，如 1024x1024；空=不传",
        },
        {
          field: "imageAspectRatio",
          label: "图片宽高比",
          component: "Select",
          bottomHelpMessage: "xAI/grok2api；空=不传",
          componentProps: {
            allowClear: true,
            options: ["", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"].map(
              v => ({ label: v || "（不传）", value: v }),
            ),
          },
        },
        {
          field: "imageResolution",
          label: "图片分辨率",
          component: "Input",
          bottomHelpMessage: "如 1k / 2k；空=不传",
        },
        {
          field: "imageResponseFormat",
          label: "图片返回格式",
          component: "Select",
          componentProps: {
            options: [
              { label: "url", value: "url" },
              { label: "b64_json", value: "b64_json" },
            ],
          },
        },
        {
          field: "videoModel",
          label: "视频模型",
          component: "Input",
          bottomHelpMessage: "POST /v1/videos/generations",
          componentProps: { placeholder: "grok-imagine-video" },
        },
        {
          field: "videoDuration",
          label: "视频时长(秒)",
          component: "InputNumber",
          componentProps: { min: 1, max: 15 },
        },
        {
          field: "videoAspectRatio",
          label: "视频宽高比",
          component: "Select",
          componentProps: {
            options: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"].map(v => ({
              label: v,
              value: v,
            })),
          },
        },
        {
          field: "videoResolution",
          label: "视频分辨率",
          component: "Select",
          componentProps: {
            options: ["480p", "720p", "1080p"].map(v => ({ label: v, value: v })),
          },
        },
        {
          field: "videoPollIntervalSec",
          label: "视频轮询间隔(秒)",
          component: "InputNumber",
          componentProps: { min: 2, max: 60 },
        },
        {
          field: "videoPollMaxSec",
          label: "视频最长等待(秒)",
          component: "InputNumber",
          componentProps: { min: 30, max: 3600 },
        },

        // ---------- 提示词 ----------
        { label: "对话提示词（强制后台）", component: "SOFT_GROUP_BEGIN" },
        {
          field: "chatSystemPrompt",
          label: "系统提示词",
          component: "InputTextArea",
          bottomHelpMessage: "始终注入；用户无法用前台指令覆盖身份",
          componentProps: { rows: 6 },
        },
        {
          field: "maxHistory",
          label: "近期完整上下文条数",
          component: "InputNumber",
          bottomHelpMessage: "超出后压缩旧轮；仅 #清理会话 清空",
          componentProps: { min: 4, max: 200 },
        },
        {
          field: "contextCompressMaxChars",
          label: "压缩摘要最大字数",
          component: "InputNumber",
          componentProps: { min: 400, max: 8000, step: 100 },
        },
        {
          field: "sessionPersist",
          label: "会话磁盘持久化",
          component: "Switch",
          bottomHelpMessage: "开=写入 data/sessions.json，重启可续聊",
        },
        {
          field: "chatForwardThreshold",
          label: "长文合并转发阈值",
          component: "InputNumber",
          bottomHelpMessage: "0=关闭",
          componentProps: { min: 0, max: 20000 },
        },
        {
          field: "forwardNickname",
          label: "合并转发昵称",
          component: "Input",
        },

        // ---------- 成年内容 ----------
        { label: "成年内容（SillyTavern 风格）", component: "SOFT_GROUP_BEGIN" },
        {
          field: "adultContentEnable",
          label: "启用 ST 成年内容增强",
          component: "Switch",
          bottomHelpMessage:
            "对话注入 NSFW 辅助+破甲；生图/生视频叠加成人向增强。与出站审查独立",
        },

        // ---------- 出站审查 ----------
        { label: "出站内容审查", component: "SOFT_GROUP_BEGIN" },
        {
          field: "outboundReviewEnable",
          label: "启用出站审查",
          component: "Switch",
          bottomHelpMessage: "发送前审查；NSFW 用合并转发发送",
        },
        {
          field: "outboundReviewScope",
          label: "审查作用范围",
          component: "Select",
          componentProps: {
            options: [
              { label: "all（群+私聊）", value: "all" },
              { label: "group（仅群聊）", value: "group" },
              { label: "private（仅私聊）", value: "private" },
            ],
          },
        },
        {
          field: "outboundReviewAi",
          label: "AI 审查（失败回退关键词）",
          component: "Switch",
        },
        {
          field: "outboundReviewModel",
          label: "审查模型",
          component: "Input",
          bottomHelpMessage: "空或 auto=与对话模型相同",
        },
        {
          field: "outboundReviewExtraKeywords",
          label: "审查额外关键词",
          component: "InputTextArea",
          bottomHelpMessage: "逗号/换行分隔",
          componentProps: { rows: 3 },
        },

        // ---------- 会话 / 私聊 ----------
        { label: "会话与私聊开关", component: "SOFT_GROUP_BEGIN" },
        {
          field: "privateChatEnable",
          label: "是否支持私聊",
          component: "Switch",
          bottomHelpMessage: "关=私聊不响应对话/生图/生视频",
        },
        {
          field: "privateSessionSelfStart",
          label: "私聊用户可自己开/关对话",
          component: "Switch",
          bottomHelpMessage: "需先开「支持私聊」；群内始终仅主人",
        },
        {
          field: "allowOneShotWithoutSession",
          label: "未开会话允许#对话单次",
          component: "Switch",
        },
        {
          field: "freeChatInSession",
          label: "私聊会话中直接接话",
          component: "Switch",
        },
        {
          field: "replyOnAt",
          label: "仅艾特才回复",
          component: "Switch",
          bottomHelpMessage:
            "开=群里必须@才回；关=本群已#开始对话后有内容都回",
        },
        {
          field: "atReplyRequireQuestion",
          label: "艾特须带问题",
          component: "Switch",
        },
        {
          field: "atReplyAtUser",
          label: "艾特回复时@对方",
          component: "Switch",
        },
        {
          field: "replyOnQuote",
          label: "引用Bot时回复",
          component: "Switch",
        },
        {
          field: "activeReplyOthers",
          label: "仅艾特模式下也回闲聊",
          component: "Switch",
          bottomHelpMessage: "仅 replyOnAt=开 时生效；易刷屏",
        },
        {
          field: "activeReplyCooldownSec",
          label: "自动回复冷却(秒)",
          component: "InputNumber",
          componentProps: { min: 0, max: 300 },
        },
        {
          field: "activeReplyAtUser",
          label: "非艾特回复时@对方",
          component: "Switch",
        },

        // ---------- 生图 NSFW ----------
        { label: "生图提示（NSFW）", component: "SOFT_GROUP_BEGIN" },
        {
          field: "imageNsfwEnable",
          label: "启用 NSFW 增强提示",
          component: "Switch",
        },
        {
          field: "imageNsfwPrompt",
          label: "NSFW 提示词",
          component: "InputTextArea",
          componentProps: { rows: 4 },
        },
        {
          field: "imagePromptPrefix",
          label: "生图前缀",
          component: "InputTextArea",
          componentProps: { rows: 2 },
        },
        {
          field: "imagePromptSuffix",
          label: "生图后缀",
          component: "InputTextArea",
          componentProps: { rows: 2 },
        },

        // ---------- 生视频 NSFW ----------
        { label: "生视频提示（NSFW）", component: "SOFT_GROUP_BEGIN" },
        {
          field: "videoNsfwEnable",
          label: "启用 NSFW 增强提示",
          component: "Switch",
        },
        {
          field: "videoNsfwPrompt",
          label: "NSFW 提示词",
          component: "InputTextArea",
          componentProps: { rows: 4 },
        },
        {
          field: "videoPromptPrefix",
          label: "视频前缀",
          component: "InputTextArea",
          componentProps: { rows: 2 },
        },
        {
          field: "videoPromptSuffix",
          label: "视频后缀",
          component: "InputTextArea",
          componentProps: { rows: 2 },
        },

        // ---------- 权限 ----------
        { label: "权限", component: "SOFT_GROUP_BEGIN" },
        {
          field: "masterOnly",
          label: "其它功能仅主人",
          component: "Switch",
          bottomHelpMessage:
            "生图/生视频等；群内开始对话始终仅主人；私聊见「私聊用户可自己开/关」",
        },
        {
          field: "groupBlacklist",
          label: "群黑名单",
          component: "GTags",
          componentProps: {
            allowAdd: true,
            allowDel: true,
            showPrompt: true,
            promptProps: { content: "群号", placeholder: "123456" },
          },
        },
        {
          field: "groupWhitelist",
          label: "群白名单",
          component: "GTags",
          bottomHelpMessage: "非空则仅白名单群可用",
          componentProps: {
            allowAdd: true,
            allowDel: true,
            showPrompt: true,
            promptProps: { content: "群号", placeholder: "123456" },
          },
        },
      ],

      // 前端填充
      getConfigData() {
        return Config.getForGuoba()
      },

      // 前端点保存
      setConfigData(data, { Result }) {
        try {
          const clean = flattenBody(data)

          // apiKey 留空 → 保留原值（锅巴 InputPassword 重载时常为空）
          if (clean.apiKey === "" || clean.apiKey == null) {
            clean.apiKey = Config.get().apiKey
          }

          if (typeof clean.apiBase === "string") {
            clean.apiBase = clean.apiBase
              .trim()
              .replace(/\/+$/, "")
              .replace(/\/v1$/i, "")
              .replace(/\/+$/, "")
          }

          for (const k of BOOL_KEYS) {
            if (k in clean) clean[k] = toBool(clean[k])
          }
          for (const k of NUM_KEYS) {
            if (k in clean) clean[k] = toNum(clean[k])
          }

          // 可选采样：空串写回空，运行时不传上游
          for (const k of [
            "temperature",
            "maxTokens",
            "topP",
            "presencePenalty",
            "frequencyPenalty",
          ]) {
            if (k in clean && (clean[k] === "" || clean[k] == null)) {
              clean[k] = ""
            }
          }

          // 数组字段
          for (const k of ["groupBlacklist", "groupWhitelist"]) {
            if (k in clean) {
              if (!Array.isArray(clean[k])) {
                clean[k] = clean[k]
                  ? String(clean[k])
                      .split(/[,，\s]+/)
                      .map(s => s.trim())
                      .filter(Boolean)
                  : []
              } else {
                clean[k] = clean[k].map(String)
              }
            }
          }

          Config.setAll(clean)
          return Result.ok({}, "已保存到 config/config/config.yaml")
        } catch (e) {
          return Result.error(`保存失败: ${e.message}`)
        }
      },
    },
  }
}

/** 部分锅巴/文档会读此路径 */
export const configFile = path.join(Plugin_Path, "config/config/config.yaml")
