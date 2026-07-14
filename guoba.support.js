import path from "node:path"
import Config from "./components/Config.js"
import { Plugin_Path, Plugin_Name } from "./components/path.js"

/**
 * 锅巴：https://gitee.com/Guoba-Yunzai/Guoba-Plugin
 * 提示词全部以后台为准，用户无法从前台覆盖 system / NSFW 策略
 */
export function supportGuoba() {
  return {
    pluginInfo: {
      name: Plugin_Name,
      title: "Grok2API",
      author: "@grok-free-register",
      authorLink: "https://github.com/chenyme/grok2api",
      link: "https://github.com/chenyme/grok2api",
      isV3: true,
      isV2: false,
      description: "对话/生图/生视频；/开始对话仅主人；后台提示词优先；合并转发媒体",
      icon: "mdi:robot-happy-outline",
      iconColor: "#1DA1F2",
    },
    configInfo: {
      schemas: [
        { component: "SOFT_GROUP_BEGIN", label: "连接" },
        { field: "enable", label: "启用插件", component: "Switch" },
        {
          field: "apiBase",
          label: "API 地址",
          component: "Input",
          required: true,
          bottomHelpMessage: "无末尾 / ，如 https://xxx.hf.space",
        },
        {
          field: "apiKey",
          label: "API Key",
          component: "InputPassword",
          required: true,
          bottomHelpMessage: "g2a_... 保存时勿清空",
        },
        {
          field: "timeoutMs",
          label: "超时(ms)",
          component: "InputNumber",
          componentProps: { min: 10000, max: 600000, step: 1000 },
        },

        { component: "SOFT_GROUP_BEGIN", label: "模型" },
        { field: "chatModel", label: "对话模型", component: "Input" },
        { field: "imageModel", label: "图片模型", component: "Input" },
        { field: "videoModel", label: "视频模型", component: "Input" },

        { component: "SOFT_GROUP_BEGIN", label: "对话提示词（强制后台）" },
        {
          field: "chatSystemPrompt",
          label: "系统提示词",
          component: "InputTextArea",
          bottomHelpMessage: "始终注入；用户无法用前台指令覆盖或改身份",
          componentProps: { rows: 6 },
        },
        {
          field: "maxHistory",
          label: "上下文条数",
          component: "InputNumber",
          componentProps: { min: 2, max: 100 },
        },
        {
          field: "chatForwardThreshold",
          label: "长文合并转发阈值",
          component: "InputNumber",
          bottomHelpMessage: "0=关闭",
          componentProps: { min: 0, max: 20000 },
        },

        { component: "SOFT_GROUP_BEGIN", label: "会话与主动回复" },
        {
          field: "allowOneShotWithoutSession",
          label: "未开会话允许/对话单次",
          component: "Switch",
        },
        {
          field: "freeChatInSession",
          label: "会话中自由聊天",
          component: "Switch",
          bottomHelpMessage: "开启后私聊会话直接接话；群需配合下方开关",
        },
        {
          field: "replyOnAt",
          label: "被@时回复",
          component: "Switch",
          bottomHelpMessage: "需已 /开始对话",
        },
        {
          field: "replyOnQuote",
          label: "引用Bot时回复",
          component: "Switch",
        },
        {
          field: "activeReplyOthers",
          label: "主动回复他人消息",
          component: "Switch",
          bottomHelpMessage: "会话开启后，群内普通消息也接话（注意刷屏）",
        },
        {
          field: "activeReplyCooldownSec",
          label: "主动回复冷却(秒)",
          component: "InputNumber",
          componentProps: { min: 0, max: 300 },
        },
        {
          field: "activeReplyAtUser",
          label: "主动回复时@对方",
          component: "Switch",
        },

        { component: "SOFT_GROUP_BEGIN", label: "生图（NSFW）" },
        {
          field: "imageNsfwEnable",
          label: "启用 NSFW 增强提示",
          component: "Switch",
          bottomHelpMessage: "开启后 /生图 自动叠加下方 NSFW 提示词",
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
          bottomHelpMessage: "固定加在用户描述前",
          componentProps: { rows: 2 },
        },
        {
          field: "imagePromptSuffix",
          label: "生图后缀",
          component: "InputTextArea",
          componentProps: { rows: 2 },
        },
        {
          field: "imageN",
          label: "一次张数",
          component: "InputNumber",
          componentProps: { min: 1, max: 10 },
        },
        { field: "imageSize", label: "size", component: "Input" },
        { field: "imageAspectRatio", label: "宽高比", component: "Input" },

        { component: "SOFT_GROUP_BEGIN", label: "生视频（NSFW）" },
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
        {
          field: "videoDuration",
          label: "时长(秒)",
          component: "InputNumber",
          componentProps: { min: 1, max: 15 },
        },
        {
          field: "videoAspectRatio",
          label: "宽高比",
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
          label: "分辨率",
          component: "Select",
          componentProps: {
            options: ["480p", "720p", "1080p"].map(v => ({ label: v, value: v })),
          },
        },
        {
          field: "videoPollIntervalSec",
          label: "轮询间隔(秒)",
          component: "InputNumber",
          componentProps: { min: 2, max: 60 },
        },
        {
          field: "videoPollMaxSec",
          label: "最长等待(秒)",
          component: "InputNumber",
          componentProps: { min: 30, max: 3600 },
        },

        { component: "SOFT_GROUP_BEGIN", label: "权限" },
        {
          field: "masterOnly",
          label: "功能仅主人（不含开始对话，开始对话本身已仅主人）",
          component: "Switch",
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
          bottomHelpMessage: "非空则仅白名单",
          componentProps: {
            allowAdd: true,
            allowDel: true,
            showPrompt: true,
            promptProps: { content: "群号", placeholder: "123456" },
          },
        },
        { field: "forwardNickname", label: "合并转发昵称", component: "Input" },
      ],

      getConfigData() {
        return Config.get()
      },

      setConfigData(data, { Result }) {
        try {
          const clean = { ...data }
          if (clean.apiKey === "" || clean.apiKey == null) {
            delete clean.apiKey
            clean.apiKey = Config.get().apiKey
          }
          if (typeof clean.apiBase === "string") {
            clean.apiBase = clean.apiBase.replace(/\/+$/, "")
          }
          Config.setAll(clean)
          return Result.ok({}, "已保存（提示词以后台为准）")
        } catch (e) {
          return Result.error(`保存失败: ${e.message}`)
        }
      },
    },
  }
}

export const configFile = path.join(Plugin_Path, "config/config/config.yaml")
