# 媒体工具调用规范（generate_image / generate_video）

本文说明 grok2api-chat-plugin 在**对话**中如何把生图/生视频当作 OpenAI **tools** 使用，以及模型与用户侧应遵守的规则。

相关代码：

- `lib/media-tools.js` — 意图识别、工具定义、执行
- `lib/client.js` — `chatWithMediaTools` 循环与限流
- `apps/chat.js` — 是否挂载 tools、合并转发结果

---

## 1. 设计目标

| 目标 | 做法 |
|------|------|
| 聊天里能出图/视频 | 模型可 `function.calling` → 调上游 `/v1/images` / `/v1/videos` |
| 用户只要「描述」不误触 | **意图门控**：未匹配生成关键词时**不挂载** tools |
| 不连环刷工具 | 每轮最多 1 次 tool；每种工具成功/失败后不再重试 |
| 交付方式统一 | 图片/视频一律 **合并聊天记录（转发）**，不直发普通消息 |

`#生图` / `#生视频` 指令仍保留，不走 tools，直接调 API。

---

## 2. 何时会挂载工具（意图门控）

由 `userWantsImageGen` / `userWantsVideoGen` 判断**当前用户这句话**（不是整段历史）。

### 2.1 会挂载生图工具

用户话里出现类似意图（示例，非完整列表）：

- 中文：`画一张` `画个` `生成图` `出图` `做一张图` `#生图` `配图` `插画` …
- 英文：`draw` `generate image` `create image` `text-to-image` …

### 2.2 会挂载生视频工具

- 中文：`做个视频` `生成视频` `#生视频` `短片` …
- 英文：`generate video` `make a video` …

### 2.3 绝不挂载（纯文字）

用户只要文字时，**不要**把 tools 放进请求（从根上避免误调）：

- `描述` `描写` `说说` `讲讲` `用文字` `文字版` `只描述` `别画` `不要图` …

> 例：「帮我**描述**雷电将军」→ 无 tools，模型只能写字。  
> 例：「帮我**画一张**雷电将军」→ 挂载 `generate_image`。

### 2.4 锅巴开关

| 配置 | 默认 | 含义 |
|------|------|------|
| `chatToolsEnable` | true | 总开关 |
| `chatToolImage` | true | 允许生图工具 |
| `chatToolVideo` | true | 允许生视频工具 |
| `chatToolMaxRounds` | 2 | 工具往返上限（建议 2） |

---

## 3. 模型侧规范（注入文案）

当本轮挂载了 tools 时，会额外注入 system 片段 `mediaToolPolicyText()`，核心条款：

1. **默认文字回答**；只有用户明确要图/视频才 `tool_calls`。
2. **禁止**因「描述/描写/说说」调用工具。
3. **`generate_image` / `generate_video` 各最多成功 1 次**；禁止为「画得更好」连环调用。
4. 工具返回 `ok:false` 或 429 → **停止再调**，简短说明，可用文字代替。
5. 媒体由系统合并转发；模型只需 **一两句确认**，不要长文假装已出图。

工具 JSON 的 `description` 也写了同样约束，与注入文案双保险。

---

## 4. 调用协议（OpenAI Chat Completions）

### 4.1 请求形态

```http
POST /v1/chat/completions
```

```json
{
  "model": "grok-4.5",
  "stream": false,
  "tool_choice": "auto",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "generate_image",
        "description": "...",
        "parameters": {
          "type": "object",
          "properties": {
            "prompt": { "type": "string" },
            "n": { "type": "integer", "minimum": 1, "maximum": 2 }
          },
          "required": ["prompt"]
        }
      }
    }
  ],
  "messages": [
    { "role": "system", content: "用户人设 + ST 成年块（若开启）" },
    { "role": "system", content: "媒体工具使用规范…" },
    { "role": "user", content: "画一张雷电将军" }
  ]
}
```

### 4.2 期望的模型输出

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_xxx",
        "type": "function",
        "function": {
          "name": "generate_image",
          "arguments": "{\"prompt\":\"Raiden Shogun, anime style, ...\",\"n\":1}"
        }
      }]
    }
  }]
}
```

**参数约定：**

| 工具 | 参数 | 说明 |
|------|------|------|
| `generate_image` | `prompt` | 画面描述，一次写清；优先可执行的视觉英文/中英混合 |
| | `n` | 默认 1，最大 2 |
| `generate_video` | `prompt` | 镜头/动作描述 |
| | `duration` | 可选 1–15 秒 |
| | `image_url` | 可选，图生视频 |

### 4.3 插件执行后回传

```json
{ "role": "tool", "tool_call_id": "call_xxx", "content": "{\"ok\":true,\"delivered_by_system\":true,\"note\":\"...\"}" }
```

失败示例：

```json
{ "ok": false, "error": "HTTP 429: ...", "rate_limited": true, "stop_retry": true }
```

随后插件再请求一轮**不带 tools** 的 completion，让模型用一两句中文收尾。

### 4.4 上游实际 API

| 工具 | 上游 |
|------|------|
| `generate_image` | `POST /v1/images/generations`（会叠加后台 NSFW / ST 成年增强 prompt） |
| `generate_video` | `POST /v1/videos/generations` + 轮询 `GET /v1/videos/{id}` |

---

## 5. 插件循环限流（`chatWithMediaTools`）

```
用户消息
  ├─ 无生成意图 → 纯 chat（无 tools）
  └─ 有生成意图 → 挂对应 tools + 规范 system
        ├─ 模型 tool_calls
        │     ├─ 每轮只执行 1 个 call
        │     ├─ generate_image 成功或失败后 → 本轮不再调 image
        │     └─ 429 → 封锁 image，禁止重试
        ├─ 成功 → 合并转发图片/视频
        └─ 再请求 1 次无 tools 收尾文字
```

| 限制 | 值 |
|------|----|
| 每轮 tool 数 | ≤ 1 |
| 生图成功次数 | ≤ 1 / 用户消息 |
| 生视频成功次数 | ≤ 1 / 用户消息 |
| 失败/429 后 | 同类工具封锁 |
| 「正在生成…」提示 | 每种工具只提示 1 次 |
| maxRounds | 默认 2（生成 + 收尾） |

---

## 6. 用户怎么说（推荐话术）

| 你想要的 | 推荐说法 | 错误说法（易误触或无效） |
|----------|----------|--------------------------|
| 只要文字 | 「用文字描述雷电将军」「描写一下服装」 | （可以） |
| 要出图 | 「画一张雷电将军」「生成一张图：…」 | 「描述一下她长什么样然后你看着办」 |
| 要视频 | 「做个 8 秒视频：樱花树下走路」 | 「说说这个视频该怎么拍」（只会文字） |
| 指令直出 | `#生图 雷电将军` `#生视频 …` | — |

---

## 7. 交付与审查

1. **图片/视频**：`sendImagesForward` / `sendVideoForward` → 合并聊天记录。  
2. **收尾文字**：走普通 `reply`；若出站审查判定 NSFW，则文字也走合并转发。  
3. **历史**：只记文本摘要 + `[生成图片×n]`，不把大图 base64 塞进上下文。

---

## 8. 日志对照

| 日志 | 含义 |
|------|------|
| `media tools armed: generate_image` | 本轮识别到出图意图并挂载工具 |
| `skip media tools (no explicit gen intent)` | 描述类请求，未挂工具 |
| `tool start generate_image` | 真正执行生图（每种最多提示一次） |
| `chat ok … media=1` | 成功 1 份媒体 |
| `tools 失败，回退纯对话` | 上游不支持 tools 或请求异常 |

---

## 9. 故障与排查

| 现象 | 原因 | 处理 |
|------|------|------|
| 说「描述」仍出图 | 旧版本无意图门控 | 升级到含本规范的版本 |
| 一直「正在生成」 | 旧版每轮多次 tool + 多次 tip | 新版每工具只 tip 一次、每轮 1 call |
| 最后只有文字 | 429/503 生图失败 | 查账号池与 Imagine 限流；模型应简短致歉 |
| `auth_unavailable` | CLIProxy 无 xAI 凭证 | 导入/恢复 SSO 账号 |
| `media=0` 长文 NSFW | 工具失败后模型用文字补 | 正常；可再发「画一张」明确出图 |

---

## 10. 变更记录

- **v1.0 工具初版**：对话始终挂 tools，易误触、易连环调用。  
- **现行版**：意图门控 + 单次成功上限 + 失败封锁 + 规范 system + 本文档。
