# grok2api-chat-plugin

TRSS / Miao-Yunzai 插件：以 **标准 OpenAI Chat Completions** 为主路径对接任意 OpenAI 兼容后端。

兼容示例：

| 后端 | 说明 |
|------|------|
| [OpenAI](https://platform.openai.com) | `https://api.openai.com` + `sk-...` |
| [grok2api-sing](https://github.com/xiaocongyu66/grok2api-sing) | 内置 sing-box 出口的 grok2api |
| [grok2api](https://github.com/chenyme/grok2api) | 原版 Grok 网关 |
| NewAPI / OneAPI / LiteLLM / 其它 | 提供 `/v1/chat/completions` 即可 |

图片与视频以**合并聊天记录**发送；支持 [锅巴 Guoba-Plugin](https://gitee.com/Guoba-Yunzai/Guoba-Plugin) 后台配置。

## 设计原则

1. **默认永远走 OpenAI 标准**：`POST /v1/chat/completions`，解析 `choices[0].message.content`
2. **不因接了 grok2api-sing 就丢掉 OpenAI**：同一套客户端、同一请求体
3. **`responses` 仅可选**：`chatApiMode=responses` 或 `auto` 且 **仅协议/路径失败** 时才回退；网络错误（`fetch failed`）**不会**再打一次无用的 responses
4. **鉴权兼容**：默认同时发 `Authorization: Bearer`（OpenAI 标准）与 `X-API-Key`（多数网关）

## 安装

```bash
cd Yunzai/plugins   # 或 Miao-Yunzai/plugins
git clone https://github.com/xiaocongyu66/grok2api-chat-plugin.git
# 重启 Bot
```

> 请用 **git clone** 安装，才能使用自动更新。复制文件夹（非 git）只能手动覆盖。

依赖：Yunzai 本体 + [锅巴 Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin) + 任意已部署的 **OpenAI 兼容** API。

## 自动更新

官方仓库：[xiaocongyu66/grok2api-chat-plugin](https://github.com/xiaocongyu66/grok2api-chat-plugin)

| 指令 | 权限 | 说明 |
|------|------|------|
| `#Grok版本` | 所有人 | 当前版本与 git 提交 |
| `#Grok检查更新` | 主人 | 对比 `origin/main`（失败时用 GitHub API） |
| `#Grok更新` | 主人 | `git pull` 官方仓库 |
| `#Grok强制更新` | 主人 | `fetch` + `reset --hard`（丢弃本地**代码**改动） |

也支持 `#g2a更新`、`#Grok升级` 等写法。

**自动行为（可关）：**

- 启动约 45 秒后检查一次  
- 每天定时检查（默认 4:30，`autoUpdateCron`）  
- 默认**只通知主人**；锅巴打开「发现更新后自动拉取」才会自动 `git pull`  

用户配置 `config/config/` 与 `data/` 已在 `.gitignore`，更新**不会覆盖**。更新后请**重启 Bot**。

## 锅巴配置（推荐）

1. 安装 [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin)（`#锅巴帮助` / `#锅巴登录`）
2. 本插件目录须为 `plugins/grok2api-chat-plugin/`，且存在根级 `guoba.support.js`
3. 打开锅巴后台 → **插件管理 / 左侧 Grok2API Chat** → 填写 API 地址与 Key → 保存

对接实现符合锅巴规范：

| 导出 | 作用 |
|------|------|
| `supportGuoba()` | 注册 `pluginInfo` + `configInfo` |
| `configInfo.schemas` | 表单分组（连接 / 模型 / 图视频 / 会话 / 权限…） |
| `getConfigData()` | 回填当前配置 |
| `setConfigData()` | 保存到 `config/config/config.yaml`（apiKey 留空不覆盖） |

也可手改：

```text
plugins/grok2api-chat-plugin/config/config/config.yaml
```

```yaml
# 服务根地址，不要带 /v1
apiBase: "http://127.0.0.1:8000"   # OpenAI 则填 https://api.openai.com
apiKey: "sk-... 或 g2a_..."
authHeaderMode: "both"             # both | bearer | x-api-key
chatApiMode: "chat"                # 推荐保持 chat
chatModel: "auto"                  # 或固定模型 id
requestRetries: 2
tlsInsecure: false                 # 仅自签证书时再开
```

主人发送 **`#连通测试`** 会依次探测：

- `GET /healthz` / `GET /readyz`（有则测，无则忽略）
- `GET /v1/models`
- `POST /v1/chat/completions`（真实 OpenAI 格式探测）

## 指令（`#` 前缀）

| 指令 | 说明 |
|------|------|
| `#帮助` | 帮助菜单 |
| `#开始对话` | **群：仅主人**；**私聊**：见锅巴「是否支持私聊」+「私聊用户可自己开/关」 |
| `#停止对话` | 同上；私聊只关自己的会话 |
| `#对话 内容` | 多轮或单次（见后台） |
| `#清理会话` | **唯一清空上下文**的指令（`#停止对话` 不清记忆；重启也保留） |
| `#生图 描述` | `POST /v1/images/generations`；带图则走 edits |
| `#改图 说明` | `POST /v1/images/edits`（需原图） |
| `#生视频 描述` | `POST /v1/videos/generations` + 轮询；可带图 |
| `#模型列表` | `GET /v1/models` |
| `#连通测试` | 主人：health + 全量 `/v1/*` 探测 + chat 样例 |
| `#Grok版本` / `#Grok检查更新` / `#Grok更新` | 官方仓库版本与更新（见上文） |

也支持全角 `＃`。

## 对话接口说明

| 模式 | 行为 |
|------|------|
| **chat**（默认，推荐） | 严格 OpenAI：`POST /v1/chat/completions` |
| **auto** | 先 Chat；仅 404/空内容/协议错误时再试 Responses；**网络错误不回退** |
| **responses** | 只用 `POST /v1/responses`（非严格 OpenAI chat；仅后端只提供该接口时用） |

## 锅巴后台可开关项

### 连接 / 模型

| 项 | 说明 |
|----|------|
| 启用插件 | 总开关 |
| API 地址 / API Key | 根地址与 Bearer Key |
| 鉴权头模式 | both / bearer / x-api-key |
| 跳过 TLS / 网络重试 | 自签与瞬时断线 |
| temperature / max_tokens / top_p | 空=不传字段（最大兼容） |
| 对话/图片/视频模型 | 可用 `auto` |
| **对话接口 chatApiMode** | 默认 **`chat`** |
| **对话传递图片 passImages** | 开=用户发图一并给模型看图 |
| **对话内工具 chatToolsEnable** | 开=**仅明确要画/生成图视频**时挂 tools |
| **成年内容 / 出站审查** | 见锅巴分组说明 |

配置路径：

```text
plugins/grok2api-chat-plugin/config/config/config.yaml
```

首次运行会从 `config/default_config/config.yaml` 复制；缺键会自动合并。

## 会话隔离

- 每个群 / 私聊独立 session  
- A 群 `#停止对话` **不会**关掉 B 群  

## API 映射（全量 /v1）

| 功能 | 接口 | 插件用法 |
|------|------|----------|
| 模型 | `GET /v1/models` | `#模型列表` |
| 对话 Chat | `POST /v1/chat/completions` | 默认 `chatApiMode=chat` |
| 对话 Responses | `POST /v1/responses` | `chatApiMode=responses`；支持 sticky `previous_response_id` |
| Responses 查询/删除/压缩 | `GET/DELETE /v1/responses/{id}`、`POST /v1/responses/compact` | 客户端已导出 |
| Anthropic Messages | `POST /v1/messages` | 客户端 `createMessage`（需 anthropic-version） |
| 文生图 | `POST /v1/images/generations` | `#生图` |
| 图编辑 | `POST /v1/images/edits` | `#改图` / 带图 `#生图` |
| 视频 | `POST /v1/videos/generations` + `GET /v1/videos/{id}` | `#生视频`（支持图生视频） |
| 媒体归档 | `GET /v1/media/images/{id}` | 客户端 `getMediaImage` |

Chat 请求体遵循 [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)。  
图片/视频字段同时兼容 OpenAI（`size`/`response_format`）与 xAI/grok2api（`aspect_ratio`/`resolution`/`image.url`）。

## 常见 `fetch failed` 排查

日志里的 `TypeError: fetch failed` 是 **TCP/TLS 层失败**，不是业务 JSON 错误。新版本会展开为可读原因：

| 提示 | 处理 |
|------|------|
| 连接被拒绝 | 后端未启动 / 端口错 / apiBase 写错 |
| DNS 解析失败 | 主机名错误 |
| 连接超时 | 防火墙、容器网络、需代理 |
| TLS 证书校验失败 | 自签则开 `tlsInsecure`，或改正确证书 |
| 鉴权失败 HTTP 401/403 | 检查 apiKey |

确认 apiBase 是**根地址**（`http://127.0.0.1:8000`），不要写成 `.../v1` 或 `.../v1/chat/completions`。

## License

MIT
