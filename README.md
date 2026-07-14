# grok2api-chat-plugin

TRSS-Yunzai 插件：对接 [grok2api](https://github.com/chenyme/grok2api) 文本对话 / 生图 / 生视频。  
图片与视频以**合并聊天记录**发送；支持 [锅巴 Guoba-Plugin](https://gitee.com/Guoba-Yunzai/Guoba-Plugin) 后台配置。

## 安装

```bash
cd Yunzai/plugins
git clone https://github.com/xiaocongyu66/grok2api-chat-plugin.git
# 重启 Bot
```

依赖：Yunzai 本体 + 锅巴插件 + 已部署的 grok2api（及客户端密钥 `g2a_...`）。

## 指令

| 指令 | 说明 |
|------|------|
| `/帮助` | 帮助菜单 |
| `/开始对话` | **仅主人**开启会话 |
| `/结束对话` | **仅主人**结束会话 |
| `/对话 内容` | 多轮或单次（见后台） |
| `/清空对话` | 清空当前用户上下文 |
| `/生图 描述` | 文生图 → 合并转发（NSFW 后台提示） |
| `/生视频 描述` | 文/图生视频 → 合并转发 |
| `/模型列表` | `GET /v1/models` |
| `/连通测试` | 主人 |

兼容 `#` 前缀。

## 后台规则

- **对话系统提示** `chatSystemPrompt`：始终注入，用户无法覆盖。  
- **生图/生视频**：用户只写描述；NSFW / 前后缀由锅巴配置拼接。  
- **主动回复**（需已 `/开始对话`）：`replyOnAt` / `replyOnQuote` / `activeReplyOthers` 等。

## 配置

锅巴 → 插件 **Grok2API**，或编辑：

```text
plugins/grok2api-chat-plugin/config/config/config.yaml
```

（首次运行会从 `config/default_config/config.yaml` 复制。）

## API

| 功能 | 接口 |
|------|------|
| 对话 | `POST /v1/chat/completions` |
| 图片 | `POST /v1/images/generations` |
| 视频 | `POST /v1/videos/generations` + `GET /v1/videos/{id}` |

## License

MIT
