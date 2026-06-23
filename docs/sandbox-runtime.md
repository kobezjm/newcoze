# NewBolt Sandbox Runtime 接入规范

本文档用于把当前沙箱沉淀成可复用的后端智能体运行时。其他平台可以把自己的前端或中间层接到该 Runtime，不需要绑定 NewBolt 当前前端。

## 定位

`newbolt-sandbox` 是一个 Agent Runtime 服务，负责：

- 工作区文件读写
- 终端命令执行
- Claude Code 兼容 Agent 对话执行
- 前端工程预览服务启动与代理
- 部署快照生成

平台前端不应直接依赖容器内部路径、端口或进程。平台只依赖 HTTP/NDJSON/WebSocket 协议。

## 推荐架构

生产环境建议分三层：

```text
业务前端 -> 平台 Gateway/API -> Sandbox Runtime
```

当前 MVP 的 `gateway` 已经实现了前端静态资源、业务 API 和 Runtime 代理。其他平台接入时有两种方式：

- 直接调用 Sandbox Runtime：`http://sandbox:7070/v1/...`
- 通过平台 Gateway 调用：`/api/runtime/v1/...`

直接调用适合内部服务间通信。浏览器前端建议通过 Gateway 同源代理，避免 CORS、PNA、WebSocket 和预览路径问题。

## 鉴权

默认本地开发不启用鉴权。生产环境配置：

```env
SANDBOX_API_TOKEN=replace-with-a-random-secret
```

调用 Sandbox Runtime 时传：

```http
Authorization: Bearer replace-with-a-random-secret
```

或：

```http
X-Sandbox-Token: replace-with-a-random-secret
```

如果使用当前 `gateway`，只需要在 gateway 和 sandbox 两边配置相同的 `SANDBOX_API_TOKEN`，gateway 会自动带 token 访问 sandbox。

## API

### 健康检查

```http
GET /v1/health
```

响应：

```json
{
  "ok": true,
  "runtime": "newbolt-sandbox",
  "version": "v1",
  "root": "/workspace/workspaces",
  "auth": "token"
}
```

通过当前 gateway：

```http
GET /api/runtime/v1/health
```

### 能力查询

```http
GET /v1/capabilities
```

用于接入平台启动时探测 Runtime 能力。

### 创建工作区

```http
POST /v1/workspaces
Content-Type: application/json

{}
```

响应：

```json
{
  "id": "806099f6",
  "name": "Workspace 806099f6",
  "runtime": "newbolt-sandbox",
  "version": "v1"
}
```

### 确保指定工作区存在

```http
POST /v1/workspaces/{workspaceId}
```

适合业务平台已经有自己的会话 ID、项目 ID、租户工作区 ID 时使用。

### 文件列表

```http
GET /v1/workspaces/{workspaceId}/files
```

响应：

```json
{
  "files": ["package.json", "src/main.js"]
}
```

### 读取文件

```http
GET /v1/workspaces/{workspaceId}/file?path=src/main.js
```

响应：

```json
{
  "path": "src/main.js",
  "content": "..."
}
```

### 写入文件

```http
PUT /v1/workspaces/{workspaceId}/file
Content-Type: application/json

{
  "path": "src/main.js",
  "content": "..."
}
```

### 执行终端命令

```http
POST /v1/workspaces/{workspaceId}/commands
Content-Type: application/json

{
  "command": "npm run build"
}
```

返回 `application/x-ndjson`，每行一个事件。

常见事件：

```json
{"type":"status","message":"沙箱已就绪"}
{"type":"stdout","data":"..."}
{"type":"stderr","data":"..."}
{"type":"cwd","cwd":"/src"}
{"type":"exit","code":0}
```

### Agent 对话

```http
POST /v1/workspaces/{workspaceId}/chat
Content-Type: application/json

{
  "message": "帮我创建一个 Vue 音乐播放器"
}
```

返回 `application/x-ndjson`。当前事件由 `newbolt-claude-presenter` 结构化输出，前端可以按 `type` 展示：

- `stdout`：普通文本
- `tool`：工具调用
- `command`：命令执行
- `tool_result`：工具结果
- `system`：系统状态
- `error`：错误信息
- `exit`：本轮完成

### 启动预览

```http
POST /v1/workspaces/{workspaceId}/preview/start
Content-Type: application/json

{
  "publicBasePath": "/api/runtime/v1/workspaces/806099f6/preview/"
}
```

响应：

```json
{
  "port": 6219,
  "url": "/api/runtime/v1/workspaces/806099f6/preview/",
  "internalUrl": "http://127.0.0.1:6219/",
  "projectRoot": "qq-music-player"
}
```

`publicBasePath` 很重要。它决定 Vite HMR 和静态资源引用在浏览器里应该走哪个代理路径。不同平台的 gateway 路径不一样时，必须传自己的公开路径。

如果通过当前 gateway 调用：

```http
POST /api/runtime/v1/workspaces/{workspaceId}/preview/start
```

gateway 会自动注入：

```text
/api/runtime/v1/workspaces/{workspaceId}/preview/
```

### 预览代理

浏览器 iframe 使用：

```text
/api/runtime/v1/workspaces/{workspaceId}/preview/
```

或直接 sandbox 内部服务路径：

```text
/v1/workspaces/{workspaceId}/preview/
```

生产环境推荐通过 gateway 暴露，避免浏览器直接访问 sandbox。

### 部署快照

```http
POST /v1/workspaces/{workspaceId}/deploy
```

响应：

```json
{
  "deployId": "20260602173000",
  "url": "/v1/workspaces/806099f6/deployments/20260602173000/"
}
```

通过当前 gateway 调用 `/api/runtime/v1/.../deploy` 时，返回的 `url` 会被改写为：

```text
/api/runtime/v1/workspaces/{workspaceId}/deployments/{deployId}/
```

## 其他平台接入步骤

1. 部署 `newbolt-sandbox:mvp`，并给它挂载持久化工作区卷。
2. 配置模型环境变量，例如 DashScope Claude Code 兼容配置。
3. 配置 `SANDBOX_API_TOKEN`。
4. 平台后端增加一个 Runtime Adapter，封装 `/v1` API。
5. 前端对话区消费 NDJSON 事件流，按 `type` 渲染工具调用、命令、文本和错误。
6. 文件树从 `/files` 拉取，编辑器通过 `/file` 读写。
7. 预览区先调用 `/preview/start`，再把返回的 `url` 放到 iframe。
8. 部署按钮调用 `/deploy`，展示返回的 `url`。

## 最小 Node Adapter 示例

```js
const SANDBOX_BASE_URL = process.env.SANDBOX_BASE_URL || 'http://sandbox:7070';
const SANDBOX_API_TOKEN = process.env.SANDBOX_API_TOKEN || '';

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(SANDBOX_API_TOKEN ? { Authorization: `Bearer ${SANDBOX_API_TOKEN}` } : {}),
    ...extra
  };
}

export async function createWorkspace() {
  const response = await fetch(`${SANDBOX_BASE_URL}/v1/workspaces`, {
    method: 'POST',
    headers: headers(),
    body: '{}'
  });
  return response.json();
}

export async function startPreview(workspaceId, publicBasePath) {
  const response = await fetch(`${SANDBOX_BASE_URL}/v1/workspaces/${workspaceId}/preview/start`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ publicBasePath })
  });
  return response.json();
}

export async function streamChat(workspaceId, message, onEvent) {
  const response = await fetch(`${SANDBOX_BASE_URL}/v1/workspaces/${workspaceId}/chat`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ message })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
}
```

## 后续生产化清单

- 每个租户或工作区独立 sandbox 容器或 K8s Pod。
- 增加租户 ID、用户 ID、会话 ID 和审计日志。
- 增加资源配额：CPU、内存、磁盘、并发命令、最大执行时间。
- 给外网访问、GitLab、模型 API 做网络策略白名单。
- 工作区持久化到 GitLab 或对象存储，容器只作为运行态。
- 事件协议继续稳定化，例如统一成 `assistant.delta`、`tool.call`、`tool.result`、`file.changed`、`preview.ready`、`deploy.ready`。
