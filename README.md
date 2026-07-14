# grok2api-chat-plugin

TRSS-Yunzai 插件：对接 [grok2api](https://github.com/chenyme/grok2api) 文本对话 / 生图 / 生视频。  
图片与视频以**合并聊天记录**发送；支持 [锅巴 Guoba-Plugin](https://gitee.com/Guoba-Yunzai/Guoba-Plugin) 后台配置全部开关。

## 安装

```bash
cd Yunzai/plugins   # 或 Miao-Yunzai/plugins
git clone https://github.com/xiaocongyu66/grok2api-chat-plugin.git
# 重启 Bot
```

依赖：Yunzai 本体 + 锅巴插件 + 已部署的 grok2api（客户端密钥 `g2a_...`）。

## 指令（`#` 前缀）

| 指令 | 说明 |
|------|------|
| `#帮助` | 帮助菜单 |
| `#开始对话` | **仅主人**，只开启**本群/本私聊** |
| `#停止对话` | **仅主人**，只关闭**本群/本私聊**（其它群不受影响） |
| `#对话 内容` | 多轮或单次（见后台） |
| `#清空对话` | 清空你在本会话的上下文 |
| `#生图 描述` | 文生图 → 合并转发 |
| `#生视频 描述` | 文/图生视频 → 合并转发 |
| `#模型列表` | `GET /v1/models` |
| `#连通测试` | 主人 |

也支持全角 `＃`。

## 锅巴后台可开关项

打开 **锅巴 → 插件 Grok2API**，分组说明：

### 连接 / 模型

| 项 | 说明 |
|----|------|
| 启用插件 | 总开关 |
| API 地址 / API Key | grok2api 根地址与 `g2a_...` |
| 对话/图片/视频模型 | 可用 `auto` 自动选 `/v1/models` 中的对话模型 |
| **对话接口 chatApiMode** | `auto` / `chat`（Completions）/ `responses`（Responses） |
| 系统提示词 | **始终注入**，用户无法覆盖 |

#### 对话接口说明

| 模式 | 行为 |
|------|------|
| **auto**（默认） | 先 `POST /v1/responses`，失败再 `POST /v1/chat/completions` |
| **chat** | 只用 Chat Completions |
| **responses** | 只用 Responses API |

### 会话与回复开关

| 开关 | 默认 | 说明 |
|------|------|------|
| 未开会话允许#对话单次 | 开 | 未 `#开始对话` 时能否单次问答 |
| 私聊会话中直接接话 | 开 | 仅私聊 |
| **艾特询问回复** | **开** | 本群已开始会话后，`@机器人 + 问题` 才回 |
| 艾特须带问题 | 开 | 只@不说话会提示说明问题 |
| 艾特回复时@对方 | 开 | 回消息时@提问者 |
| 引用Bot时回复 | 开 | 引用机器人消息时接话 |
| 不@也回他人消息 | **关** | 群闲聊也回（易刷屏/费额度） |
| 主动回复冷却(秒) | 8 | 防刷 |

### 生图 / 生视频

| 开关 | 说明 |
|------|------|
| 启用 NSFW 增强提示 | 后台拼接 NSFW 提示词 |
| NSFW / 前缀 / 后缀 | 用户描述前后固定文本 |
| 时长、宽高比、分辨率、轮询 | 视频参数 |

### 权限

| 项 | 说明 |
|----|------|
| 功能仅主人 | 除开始/停止外是否仅主人 |
| 群黑/白名单 | 群号字符串 |

配置文件路径（可手改）：

```text
plugins/grok2api-chat-plugin/config/config/config.yaml
```

首次运行会从 `config/default_config/config.yaml` 复制；缺键会自动合并。

## 会话隔离

- 每个群 / 私聊独立 session  
- A 群 `#停止对话` **不会**关掉 B 群  

## API

| 功能 | 接口 |
|------|------|
| 对话 | `POST /v1/chat/completions` 与/或 `POST /v1/responses`（锅巴可选） |
| 图片 | `POST /v1/images/generations` |
| 视频 | `POST /v1/videos/generations` + `GET /v1/videos/{id}` |

## License

MIT
