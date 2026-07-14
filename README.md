# grok2api-chat-plugin

TRSS-Yunzai 插件 + [锅巴](https://gitee.com/Guoba-Yunzai/Guoba-Plugin) 后台配置。

## 指令

| 指令 | 说明 |
|------|------|
| `/帮助` | 帮助菜单 |
| `/开始对话` | **仅主人**；开启本群/私聊会话 |
| `/结束对话` | **仅主人** |
| `/对话 内容` | 多轮（需会话）或后台允许时的单次问答 |
| `/清空对话` | 清空你的上下文 |
| `/生图 描述` | 文生图，**合并转发**；NSFW 由后台提示词叠加 |
| `/生视频 描述` | 文/图生视频，**合并转发** |
| `/模型列表` | 拉取模型 |
| `/连通测试` | 主人 |

兼容 `#` 前缀。

示例：

```text
/开始对话
你好
/生图 帮我生成雷电将军的裸照
/生视频 海边日落
/结束对话
```

## 后台规则（重要）

1. **对话系统提示** `chatSystemPrompt`：始终注入，用户无法用前台改身份/覆盖。  
2. **生图/生视频**：用户只提供画面描述；`imageNsfwPrompt` / `videoNsfwPrompt` 等由后台拼接。  
3. **主动回复**（需已 `/开始对话`）：  
   - `replyOnAt`：被 @  
   - `replyOnQuote`：引用 Bot  
   - `activeReplyOthers`：主动接群里他人消息（带冷却）

## 配置路径

- 锅巴 → 插件 **Grok2API**  
- 或 `config/config/config.yaml`

## API

- `POST /v1/chat/completions`  
- `POST /v1/images/generations`  
- `POST /v1/videos/generations` + `GET /v1/videos/{id}`  
