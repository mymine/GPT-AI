# GPT AI

一个基于 Node.js 的聚合服务，把多个第三方聊天 API 统一封装成简单的 HTTP 接口，并额外提供 **OpenAI 兼容接口**，让各类 OpenAI 客户端（OpenAI SDK、ChatGPT-Next-Web、LobeChat 等）可以直接接入。

## 📚 目录

- [功能特性](#-功能特性)
- [快速开始](#-快速开始)
- [接口一：原生接口 `/chat/vN`](#-接口一原生接口-chatvn)
- [接口二：OpenAI 兼容接口 `/v1`](#-接口二openai-兼容接口-v1)
- [可用端点](#-可用端点)
- [环境变量](#-环境变量)
- [部署到 Vercel](#-部署到-vercel)
- [技术栈](#-技术栈)
- [参与贡献](#-参与贡献)
- [许可](#-许可)
- [联系方式](#-联系方式)

## 🌟 功能特性

- 统一封装多个第三方聊天 API（v1 ~ v15）
- **新增：OpenAI 兼容接口**（`/v1/chat/completions`、`/v1/models`），支持流式与非流式
- 基于 Express.js，启用 CORS，方便前端直连
- 简单直接的错误处理，便于调试

## 🚀 快速开始

```bash
npm install
npm start          # 默认监听 3000 端口，可用 PORT 环境变量覆盖
```

启动后：

- 原生接口：`http://localhost:3000/chat/v1` … `/chat/v15`
- OpenAI 兼容接口：`http://localhost:3000/v1`

## 🔧 接口一：原生接口 `/chat/vN`

向任意 `/chat/vN`（N = 1 ~ 15）端点发送 POST 请求即可与对应后端对话。

### Endpoint

```
POST http://localhost:3000/chat/v1
```

### Headers

```
Content-Type: application/json
```

### 请求体

```json
{
  "userMessage": "Hello, how are you?"
}
```

> 也支持传入完整的 `messages` 数组（格式同 OpenAI），例如：
> `{"messages":[{"role":"user","content":"你好"}]}`

### cURL 示例

```bash
curl -X POST http://localhost:3000/chat/v1 \
     -H "Content-Type: application/json" \
     -d '{"userMessage": "Hello, how are you?"}'
```

### 响应示例

```json
{
  "reply": "Hello! ... How can I help you today?"
}
```

## 🔌 接口二：OpenAI 兼容接口 `/v1`

适配层把 OpenAI 格式的请求转发到对应的 `/chat/vN` 后端，再把结果包装回 OpenAI 格式。任何 OpenAI 客户端都能直接使用。

### 列出可用模型

```bash
curl http://localhost:3000/v1/models
```

返回 OpenAI 标准的模型列表，`data[].id` 为 `v1` ~ `v15`。

### 对话补全（非流式）

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "v5",
    "messages": [{"role": "user", "content": "你好，介绍一下你自己"}]
  }'
```

响应为标准 OpenAI 结构：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "v5",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 80, "total_tokens": 92 }
}
```

### 对话补全（流式）

把 `"stream": true` 加入请求体即可，服务会以 SSE 返回 `chat.completion.chunk` 事件，并以 `data: [DONE]` 结束：

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "v5",
    "stream": true,
    "messages": [{"role": "user", "content": "讲个笑话"}]
  }'
```

### 使用 OpenAI SDK

**Python**

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="not-needed")

resp = client.chat.completions.create(
    model="v5",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

**Node.js**

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: "not-needed" });

const resp = await client.chat.completions.create({
  model: "v5",
  messages: [{ role: "user", content: "你好" }],
});
console.log(resp.choices[0].message.content);
```

### 模型名如何映射到后端

`model` 字段决定使用哪个 `/chat/vN` 后端，支持以下写法（大小写不敏感）：

| 写法 | 示例 | 说明 |
|------|------|------|
| `vN` | `v5` | 直接指定后端编号（推荐） |
| `gpt-ai-vN` / `gptai/vN` / `gpt-ai/vN` | `gpt-ai-v5` | 带前缀的等价写法 |
| `chat/vN` | `chat/v5` | 与原生路由一致 |
| provider 名称 | `goody2` | 见下表「名称」列 |

- 若 `model` 无法识别（如客户端默认发送的 `gpt-3.5-turbo`），会回退到默认后端（`DEFAULT_PROVIDER`，默认 `v1`）。
- 也可通过查询参数临时指定：`/v1/chat/completions?provider=v5`。
- 需要 Key 的后端（v1/v2/v7/v12）会使用客户端请求头中的 `Authorization`，或在缺失时读取同名环境变量。

### 与原生接口的差异

- 原生 `/chat/vN` 只返回 `{ "reply": "..." }`；`/v1` 会补全为完整的 OpenAI 响应结构。
- 只接受单条 `userMessage` 的后端（v4/v5/v8/v9/v11/v13/v14/v15）会由适配层把整个 `messages` 对话历史折叠为一条提示词后转发。

## 🌐 可用端点

| 端点 | 后端 | 模型 / 说明 | 输入 | 需要 Key |
|------|------|------------|------|---------|
| `/chat/v1` | [pollinations.ai](https://gen.pollinations.ai) | Pollinations Gen AI | messages | 是 |
| `/chat/v2` | [openrouter.ai](https://openrouter.ai) | OpenRouter models | messages | 是 |
| `/chat/v3` | [ai.riple.org](https://ai.riple.org/) | Riple AI / SAANVI | messages | 否 |
| `/chat/v4` | [unlimitedai.chat](https://app.unlimitedai.chat) | Reasoning model | userMessage | 否 |
| `/chat/v5` | [goody2.ai](https://www.goody2.ai) | Goody2 AI | userMessage | 否 |
| `/chat/v6` | Chat Smith | gpt-4o-mini (Vulcan Labs) | messages | 否 |
| `/chat/v7` | [freedomgpt.com](https://chat.freedomgpt.com) | Weaver / FreedomGPT | messages | 是 |
| `/chat/v8` | [chatwithfiction.com](https://www.chatwithfiction.com) | Chat with Fiction | userMessage | 否 |
| `/chat/v9` | [bookai.chat](https://bookai.chat) | GPT-3.5 Turbo | userMessage | 否 |
| `/chat/v10` | [publicai.co](https://publicai.co) | PublicAI | messages | 否 |
| `/chat/v11` | [supabase.co](https://supabase.co) | gpt-5-nano | userMessage | 否 |
| `/chat/v12` | [api.airforce](https://api.airforce) | llama-instant | messages | 是 |
| `/chat/v13` | [supabase.co](https://supabase.co) | gpt-5-mini | userMessage | 否 |
| `/chat/v14` | [chataibot.ru](https://chataibot.ru) | Chataibot | userMessage | 否 |
| `/chat/v15` | [beta.dopple.ai](https://beta.dopple.ai/) | Dopple AI | userMessage | 否 |

> 上表同时列出了每个后端在 OpenAI 兼容层下的输入形态：`messages` 表示可接收完整对话数组，`userMessage` 表示仅接收单条消息（适配层会自动折叠历史）。

## ⚙️ 环境变量

参见 [`.env.example`](./.env.example)。常用项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务监听端口 | `3000` |
| `OPENAI_COMPAT_KEY` | 若设置，则 `/v1/*` 需携带 `Authorization: Bearer <key>` | 空（不校验） |
| `DEFAULT_PROVIDER` | 无法识别 `model` 时使用的后端 | `v1` |
| `UPSTREAM_TIMEOUT_MS` | 上游请求超时（毫秒） | `120000` |
| `STREAM_DELAY_MS` | 流式输出每块之间的延时（毫秒，0 表示不延时） | `0` |
| `POLLINATIONS_API_KEY` | `/chat/v1` 的 Key | — |
| `OPENROUTER_API_KEY` | `/chat/v2` 的 Key | — |
| `FREEDOMGPT_API_KEY` | `/chat/v7` 的 Key | — |
| `AIRFORCE_API_KEY` | `/chat/v12` 的 Key | — |

## ☁️ 部署到 Vercel

项目已内置 Serverless 适配，可直接导入 Vercel 部署：

- `api/index.js` —— 函数入口，重新导出根目录的 Express 应用（`index.js`）。Vercel 零配置会把 `api/` 下的文件识别为函数。
- `vercel.json` —— 将所有路径改写（rewrite）到该函数，并把函数最大执行时长设为 60 秒。

```json
{
  "functions": { "api/index.js": { "maxDuration": 60 } },
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index.js" }]
}
```

部署步骤：

```bash
npm i -g vercel
vercel --prod          # 按提示导入项目即可
```

注意事项：

- **无本地端口**：适配层在进程内直接调用 `/chat/vN` 处理函数，不经过 HTTP、不占用端口，因此在 Serverless 上不会出现 `ECONNREFUSED 127.0.0.1`。
- **执行时长**：`maxDuration` 已设为 `60` 秒（Hobby 计划可用的稳妥上限）；Pro 计划可调高到 `300` 乃至更多，仅当第三方后端响应较慢时才需要调整。
- **上游 Key**：需要 Key 的后端（v1/v2/v7/v12）请在 Vercel 项目 → Settings → Environment Variables 中配置对应变量。
- **出口 IP**：Vercel 使用共享出口 IP，部分第三方站点可能限流或需要 Key。

## 🛠️ 技术栈

- [Node.js](https://nodejs.org/) - JavaScript 运行时
- [Express.js](https://expressjs.com/) - Web 应用框架
- [Axios](https://axios-http.com/) - 基于 Promise 的 HTTP 客户端

## 🤝 参与贡献

欢迎提交贡献、Issue 与功能建议！可从 [issues 页面](https://github.com/OshekharO/GPT-AI/issues) 开始。

## 📝 许可

本项目基于 [GPL-3.0](LICENSE) 开源。

## 📞 联系方式

- GitHub: [@OshekharO](https://github.com/OshekharO)
- Telegram: [@OshekherO](https://t.me/OshekherO)

---

⭐️ 如果这个项目对你有帮助，欢迎在 GitHub 上点个 Star！
