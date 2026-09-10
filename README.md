# codex-chat-mobile

[![CI](https://github.com/Ike-li/codex-chat-mobile/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/Ike-li/codex-chat-mobile/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

本机 [Codex CLI](https://github.com/openai/codex) 使用自定义 `base_url` 和 API key 时，官方 ChatGPT 远控无法与这台主机配对。本项目是这台开发机上已在运行的 `codex app-server` 的手机控制面：同一个本地工作区、同一套审批边界、同一条原生 thread 和同样的流式 agent 事件。

| 流式对话 | 审批卡片 |
|---|---|
| ![手机上的流式对话](docs/assets/chat.png) | ![手机上的审批卡片](docs/assets/approval.png) |

> 截图取自确定性 mock app-server（`npm run test:e2e` 用的 harness），不消耗任何真实 Codex 额度。

## 当前形态

- 本地 Node.js 服务：Express 5 + Socket.IO。
- Codex 桥接：每个 Node 网关进程通过 stdio 长驻运行一个共享 `codex app-server`；多个原生 thread 精确复用该进程。受支持的部署是一台主机只运行一个网关服务。
- 前端：`public/index.html` 提供移动端 SPA/PWA 的 HTML shell，样式在外部样式表 `public/css/app.css`，`public/js/app.js` 是外部应用模块，并复用 `public/js/` 下的可靠投递与恢复模块。
- 核心能力：流式对话、thinking/工具/diff 卡片、审批与提问、结构化附件、`@` 文件引用、顶栏只读工作区（文件/Git 改动）、连接横幅、确认 sheet、app-server 原生历史（含工具/变更卡重建）、多工作区、多 thread 标签、可靠 ACK/outbox、gap 重建、needs-you 精确深链、result/error 通知、设备绑定 Web Push 和 PWA。IndexedDB 持久化 outbox，服务端内存 receipt ledger 在单次网关生命周期内去重；消失的 provisional instance 只会为从未尝试的请求恢复或安全重绑，已尝试且无法核对的请求必须经重复副作用警告确认，并使用新 ID 重试。
- 事实源：只使用 `thread/list`、`thread/read`、`thread/resume`、`thread/status/changed`；不再维护 `sessions.json` 元数据副本或 JSONL history fallback。
- 安全默认值：空 `AUTH_TOKEN` 只允许 loopback；远程 HTTP 默认拒绝；远程 Socket 可进入 pending，但在 HTTPS、精确 Origin、HttpOnly session 和设备批准全部满足前不能操作；设备 deny 会撤销 session/Push 并断线，外部 trust-file 撤销则保留已连接的 loopback socket；本地状态 owner-only 落盘；远程图片和 Labs 默认关闭；宿主配置无开关，靠逐动作确认加审计约束。

## 本地运行

前置条件：Node.js >= 20；本机已安装并登录 [Codex CLI](https://github.com/openai/codex)（`codex` 在 `PATH` 上，或用 `CODEX_BIN` 指定），协议基线固定在 `.codex-version`。

```bash
npm install
cp .env.example .env
npm test
npm start
```

常用 `.env` 配置：

```bash
PORT=3001
HOST=127.0.0.1
AUTH_TOKEN=
WORK_DIR=/absolute/path/to/workspace
WORK_DIRS=/other/project,/third/project
# 或 WORK_DIRS=workdirs.json  （JSON 数组，每项是绝对路径）
CODEX_BIN=/absolute/path/to/codex
CODEX_APPROVAL_POLICY=on-request
CODEX_SANDBOX=workspace-write
CODEX_INPUT_QUEUE_LIMIT=20
CODEX_ALLOWED_ORIGINS=
CODEX_TRUSTED_PROXY_IPS=
CODEX_P3_EXPERIMENTAL=0
```

完整配置项：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `3001` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 绑定地址；同机 HTTPS 反代通常保持 loopback |
| `AUTH_TOKEN` | 空 | session bootstrap 密钥；非 loopback 监听时至少 32 字符 |
| `WORK_DIR` | — | 主 Codex 工作区 |
| `WORK_DIRS` | 空 | 逗号分隔的额外工作区，或 `workdirs.json` 这类路径数组文件 |
| `CODEX_BIN` | `codex` | Codex CLI 二进制路径 |
| `CODEX_DATA_DIR` | `./data` | 设备、Push 和审计状态目录 |
| `CODEX_APPROVAL_POLICY` | `on-request` | `untrusted` \| `on-failure` \| `on-request` \| `granular` \| `never` |
| `CODEX_SANDBOX` | `workspace-write` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `CODEX_INPUT_QUEUE_LIMIT` | `20` | busy turn 期间最大排队输入数 |
| `IDLE_TIMEOUT_MS` | `600000` | busy turn 静默超时；无 runtime 活动后中断 turn |
| `CODEX_ALLOWED_ORIGINS` | 空 | 远程 Socket.IO 允许的精确 Origin 列表 |
| `CODEX_TRUSTED_PROXY_IPS` | 空 | 可提供 `X-Forwarded-Proto` 的直接对端 IP |
| `CODEX_SESSION_TTL_MS` | `604800000` | 绑定设备的内存 HttpOnly session 有效期 |
| `CODEX_SECURITY_AUDIT_MAX_BYTES` | `1048576` | security audit 活跃文件达到该字节数后保留一份 owner-only 轮转 |
| `CODEX_ALLOW_REMOTE_IMAGES` | `0` | 显式启用经 HTTPS/DNS/SSRF 校验的图片 URL 输入 |
| `CODEX_P3_EXPERIMENTAL` | `0` | 显式启用 Labs；默认不进入核心聊天面 |
| `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 空 | 启用设备绑定 Web Push（三项齐全才生效） |

本机打开 `http://127.0.0.1:3001`。

手机只推荐一条路径：同机 Tailscale Serve，网关继续听 loopback，由 Serve 提供 tailnet 内 HTTPS。

```bash
tailscale serve 3001
```

`AUTH_TOKEN` 至少 32 字符，`CODEX_ALLOWED_ORIGINS` 写成 Serve 打印的精确 `https://<机器名>.<tailnet>.ts.net`，`CODEX_TRUSTED_PROXY_IPS=127.0.0.1,::1`。用 Serve，不要用 Funnel。新设备批准前不能发送。其它 HTTPS 反代见 [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md)，不写在这里。

## 常用命令

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
npm run test:ci
```

`npm run test:e2e` 使用 Playwright 连接 `scripts/mock-server.js`，不应调用真实 Codex CLI，也不应消耗模型额度。

## 核心文件

- `server.js`：HTTP/Socket.IO 网关、鉴权、ACK、路由、恢复、Push 和 needs-you 聚合。
- `app-server-transport.js` / `app-server-host.js`：唯一 stdio 传输和共享 app-server 多路复用。
- `thread-registry.js`：instance/thread/turn/request 的精确 ownership/routing。
- `agent-appserver.js`：`ThreadRuntime`——单 thread 语义和 Codex 事件映射。
- `public/index.html`：移动端 SPA/PWA 的 HTML shell（只有 markup，无内联 `<style>`）。
- `public/css/app.css`：应用样式表，在两个 highlight.js 主题之后加载，确保覆盖生效。
- `public/js/app.js`：外部浏览器应用模块，负责 UI 交互、审批卡片和 native 面板。
- `scripts/mock-codex-app-server.js`：用于 E2E 的确定性 Codex 协议 mock。
- `.protocol/stable/`：用于协议漂移检查的 app-server 协议基线。
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：当前架构和安全模型。
- [docs/PROTOCOL.md](docs/PROTOCOL.md)：Codex app-server 协议参考（方法、事件、覆盖）。
- [docs/API.md](docs/API.md)：接口参考（HTTP 路由 + Socket.IO 事件签名）。
- [docs/TESTING.md](docs/TESTING.md)：测试门禁与验收矩阵。
- [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md)：手机接入以 Tailscale Serve 为推荐路径；其它 HTTPS 反代和 PWA/Push 硬限制在这篇。
- [docs/PROTOCOL_UPGRADE.md](docs/PROTOCOL_UPGRADE.md)：Codex app-server 协议升级流程。
- [ROADMAP.md](ROADMAP.md)：已完成 / 进行中 / 候选。

## 文档规则

自用工具，文档只留事实来源：架构、协议、接口、测试门禁、远程接入。入门教程、任务配方、故障排查、功能巡览、能力矩阵和 71 条人工冒烟清单已删除——它们面向的是外部读者，而实际验收由 `npm test` 和 `npm run test:e2e` 承担。

文档的客观缺陷（死链、引用不存在的文件/脚本、许可证不一致）由 `test/acceptance-doc.test.mjs` 守护；它不冻结标题和措辞。

## 许可证

本项目以 [AGPL-3.0-only](LICENSE) 发布：如果你把修改版作为网络服务运行，AGPL 要求向其用户提供修改后的源码。
