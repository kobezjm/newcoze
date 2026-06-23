# NewCoze MVP

NewCoze MVP 是一个基于浏览器的 AI 编程工作台示例项目。它通过 Gateway 提供前端页面和 API，通过 Sandbox Runtime 提供隔离的工作区、文件读写、终端执行、预览代理、部署快照和 Claude Code/Qwen Agent 调用能力。

## 界面预览

![NewCoze 工作台截图](docs/screenshot.png)

> 请将截图文件保存为 `docs/screenshot.png`，README 会自动显示该图片。

## 功能特性

- 浏览器工作台：聊天、文件列表、代码编辑、预览、终端和部署入口。
- 双服务架构：`gateway` 负责产品/API 层，`sandbox` 负责执行环境。
- 工作区文件读写：支持创建工作区、查看文件、读取文件、保存文件。
- 沙箱终端：在工作区内执行命令，并以 NDJSON 流式返回输出。
- Agent 对话：优先调用沙箱中的 `claude` 命令；可配置本地兜底 Agent。
- 前端预览：支持 Vite 项目预览和 WebSocket/HMR 代理。
- 部署快照：生成可通过 Gateway 访问的静态快照 URL。
- 可复用 Runtime API：`/v1` 沙箱接口和 `/api/runtime/v1` Gateway 代理接口。

## 项目结构

```text
.
├── public/                  # 浏览器工作台静态资源
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── server/
│   └── index.js             # Gateway 服务入口
├── sandbox/
│   ├── Dockerfile           # Sandbox 镜像构建文件
│   └── bin/                 # Sandbox Runtime 和辅助命令
├── docs/
│   └── sandbox-runtime.md   # Sandbox Runtime API 规范
├── Dockerfile               # Gateway 镜像构建文件
├── docker-compose.yml       # 本地双容器编排
├── package.json             # Node 脚本和版本要求
├── .env.example             # 环境变量示例
└── README.md
```

## 环境要求

- Node.js >= 20
- Docker
- Docker Compose

推荐使用 Docker Compose 运行完整项目，因为 Agent、终端、预览和工作区都依赖沙箱服务。

## 快速开始

### 1. 配置环境变量

复制环境变量示例文件：

```bash
cp .env.example .env
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env
```

然后按需填写 `.env`。

常用配置：

```env
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_BASE_URL=
ANTHROPIC_MODEL=
CLAUDE_MODEL=
CLAUDE_FALLBACK=0
CLAUDE_PERMISSION_MODE=bypassPermissions
SANDBOX_EXEC_USER=agent
SANDBOX_API_TOKEN=
```

说明：

- `ANTHROPIC_AUTH_TOKEN`：Claude Code 兼容接口的认证 Token。
- `ANTHROPIC_BASE_URL`：Claude Code 兼容接口地址。
- `ANTHROPIC_MODEL` / `CLAUDE_MODEL`：Agent 调用模型；`CLAUDE_MODEL` 优先级更高。
- `CLAUDE_FALLBACK`：设为 `1` 时，Claude Code 不可用或失败后启用本地兜底 Agent。
- `CLAUDE_PERMISSION_MODE`：传给 Claude Code 的权限模式，默认 `bypassPermissions`。
- `SANDBOX_EXEC_USER`：沙箱内执行命令的用户，默认 `agent`。
- `SANDBOX_API_TOKEN`：沙箱 Runtime 鉴权 Token；本地开发可留空，生产环境建议配置随机密钥。

### 2. 启动服务

```bash
docker compose up --build
```

后台运行：

```bash
docker compose up --build -d
```

启动成功后打开：

```text
http://127.0.0.1:5299
```

### 3. 使用工作台

1. 进入页面后会自动创建工作区。
2. 在聊天框输入需求，让 Agent 创建或修改项目代码。
3. 在「文件」区域查看和编辑工作区文件。
4. 在「终端」区域执行命令，例如：

   ```bash
   npm install
   npm run dev
   npm run build
   ```

5. 点击「启动预览」查看前端项目运行效果。
6. 点击「部署」生成当前工作区的静态快照访问地址。

## 常用命令

### Docker Compose

```bash
# 构建并启动
docker compose up --build

# 后台启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止服务
docker compose down

# 停止服务并删除数据卷
docker compose down -v
```

### Node 本地命令

```bash
# 启动 Gateway
npm start

# 检查 JS 语法
npm run check
```

注意：直接 `npm start` 只启动 Gateway。如果没有配置外部 `SANDBOX_BASE_URL` 或可用的 Docker 沙箱环境，完整工作台能力可能不可用。

## 服务说明

### Gateway

- 镜像：`NewCoze-gateway:mvp`
- 端口：`5299`
- 入口：[server/index.js](file:///d:/工程文件代码/newcoze/server/index.js)
- 职责：
  - 提供浏览器工作台静态资源。
  - 提供 `/api/*` 产品 API。
  - 代理 `/api/runtime/v1/*` 到 Sandbox Runtime。
  - 代理预览、部署快照和 WebSocket 请求。

### Sandbox Runtime

- 镜像：`NewCoze-sandbox:mvp`
- 端口：`7070`，默认仅在 Compose 网络内访问。
- 入口：[sandbox/bin/NewCoze-sandbox-server](file:///d:/工程文件代码/newcoze/sandbox/bin/NewCoze-sandbox-server)
- 工作区目录：`/workspace/workspaces`
- 职责：
  - 创建和管理工作区。
  - 文件读写。
  - 终端命令执行。
  - Agent 对话执行。
  - 预览服务启动和代理。
  - 部署快照生成。

## 主要接口

### Gateway API

```text
GET  /api/health
POST /api/workspaces
GET  /api/workspaces/{workspaceId}/files
GET  /api/workspaces/{workspaceId}/file?path=src/main.js
PUT  /api/workspaces/{workspaceId}/file
POST /api/workspaces/{workspaceId}/commands
POST /api/workspaces/{workspaceId}/chat
POST /api/workspaces/{workspaceId}/preview/start
POST /api/workspaces/{workspaceId}/deploy
```

### Runtime API

Sandbox Runtime 可被其他平台复用：

```text
GET  /v1/health
GET  /v1/capabilities
POST /v1/workspaces
POST /v1/workspaces/{workspaceId}
GET  /v1/workspaces/{workspaceId}/files
GET  /v1/workspaces/{workspaceId}/file?path=src/main.js
PUT  /v1/workspaces/{workspaceId}/file
POST /v1/workspaces/{workspaceId}/commands
POST /v1/workspaces/{workspaceId}/chat
POST /v1/workspaces/{workspaceId}/preview/start
POST /v1/workspaces/{workspaceId}/deploy
```

通过当前 Gateway 访问 Runtime：

```text
/api/runtime/v1/health
/api/runtime/v1/workspaces
/api/runtime/v1/workspaces/{workspaceId}/chat
/api/runtime/v1/workspaces/{workspaceId}/preview/start
```

更完整的 Runtime 接入规范见：[docs/sandbox-runtime.md](file:///d:/工程文件代码/newcoze/docs/sandbox-runtime.md)

## Qwen / DashScope 配置

本项目的 Agent 调用采用 Claude Code 兼容方式。如果使用 DashScope 上的 Qwen Claude Code 兼容接口，请在 `.env` 中配置：

```env
ANTHROPIC_AUTH_TOKEN=你的_API_Key
ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic
ANTHROPIC_MODEL=你的模型名
CLAUDE_MODEL=你的模型名
```

如果使用不同计划或地域，请替换为对应 endpoint，例如：

- Coding Plan：`https://coding.dashscope.aliyuncs.com/apps/anthropic`
- Token Plan：`https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`
- DashScope 按量付费：`https://dashscope.aliyuncs.com/apps/anthropic` 或对应地域 endpoint

如果出现 HTTP 401，通常表示请求已到达服务端但认证失败，请检查：

- `ANTHROPIC_AUTH_TOKEN` 是否为真实 API Key。
- `ANTHROPIC_BASE_URL` 是否和所使用的 Key 类型匹配。
- 模型名是否填写正确。

## 数据持久化

Compose 中定义了两个数据卷：

- `NewCoze_gateway_data`：Gateway 数据。
- `NewCoze_sandbox_workspaces`：沙箱工作区文件。

如果需要彻底清空本地数据：

```bash
docker compose down -v
```

## 生产部署建议

- 为 `SANDBOX_API_TOKEN` 配置强随机密钥。
- 多租户场景下建议一个用户或工作区对应独立沙箱容器/Pod。
- 增加用户鉴权、配额、审计日志和网络访问策略。
- 对沙箱镜像进行签名和安全扫描。
- 将工作区状态接入 Git、对象存储或持久化存储。
- 不要直接向不可信用户暴露无鉴权的 Sandbox Runtime。
