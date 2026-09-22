---
type: architecture
title: 系统总览：手机控制面到 codex app-server
description: codex-mobile 的三段链路、进程模型、两个组装根与启动/关闭顺序，以及它为什么是「你本机那个 codex 的手机控制面」而不是另一个 agent。
tags: [architecture, overview, process-model, startup, socketio, app-server]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-d85db9feecf57beff619c54b
    resource: repo://public/index.html
  - id: openwiki-source-e7089a43d0d745673d4e1809
    resource: repo://public/js/app.js
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-47ca446328fb5ed8edaf9009
    resource: repo://src/auth/server-security.js
  - id: openwiki-source-52b8b2c58b731c544c0dec17
    resource: repo://src/ops/doctor-runtime.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 系统总览：手机控制面到 codex app-server

## 它是什么，不是什么

这个项目**不做另一个 agent**。它是你开发机上已经在跑的 `codex app-server` 的手机控制面：会话是 Codex 原生 thread，存在 `~/.codex` 里，和终端 `codex resume` 看到的是同一批数据；手机上开的会话回到终端能接着聊。

存在的理由是一个具体的缺口：官方 ChatGPT 的远程控制要求主机用官方账号登录。当你的 Codex CLI 配的是自定义 `base_url` 和 API key（第三方网关、自建代理、企业内网中转），官方远控无法与这台主机配对——你就没有手机端了。

由此推出两条贯穿全仓的约束：

- **不产生第二份真相**（架构决定 A2）。thread / turn / item / 配置 / 模型列表一律向 app-server 现问，详见[状态归属](state-ownership.md)。
- **审批与沙箱策略由 Codex 自己执行**，网关原样透传、不绕过。

## 三段链路

```
手机浏览器 ──Socket.IO── Node 网关 ──stdio / JSON-RPC 2.0── codex app-server
   PWA                   server.js                            （你本机那个）
```

| 段 | 承担什么 | 主要代码 |
|---|---|---|
| 浏览器 | 渲染、输入组装、离线队列、未读判定 | [public/index.html](../../public/index.html) + [public/js/app.js](../../public/js/app.js) + 8 个功能域 |
| 网关 | 鉴权、契约路由、会话编排、作用域闸门、审计 | [server.js](../../server.js) + `src/` 六个域 |
| app-server | 真正的 agent 能力与状态 | 外部进程，协议基线 vendored 在 `.protocol/stable/` |

前端由 `index.html` 引三个 vendored 库（marked / DOMPurify / highlight.js）、Socket.IO 客户端（由服务端在 `/socket.io/socket.io.js` 提供），再以 `type="module"` 加载 `app.js`。客户端只走 WebSocket transport，握手时带 `deviceToken`。

## 进程模型

关键的一条：**会话数与进程数解耦**。

- 一个 Node 进程。
- 一个 `codex app-server` 子进程，由单个 `AppServerHost` 持有；所有会话复用它。
- N 个 `ThreadRuntime`，每个对应一个 `instanceId`，最多绑一条 thread。

会话与 socket 也是解耦的：`ThreadRuntime` 挂在服务端，事件按 `instance:<id>` 房间广播，所以**多设备可以同看一个会话**，某台手机断开不影响 turn 继续跑。

入站帧怎么找回正确的 runtime，是[桥接层](app-server-bridge.md)的主题；网关对手机暴露的事件表在[Socket.IO 契约层](socket-contract.md)。

## 两个组装根

`server.js`（约 3200 行）是顶层组装根：加载配置、装 Express 中间件、装 Socket.IO 鉴权、注册约 55 个契约事件、管理 `agents` / `threadRegistry` / `messageReceiptLedger` / `needsYouRegistry` 四张核心表。

`src/agent/agent-appserver.js` 是第二组装根：`ThreadRuntime` 把 transport、审批经纪、输入组装、RPC 日志组装成一个会话语义层。

两者都不许被反向 import，由[边界门禁](module-boundaries.md)守着。

## 启动顺序

1. **加载配置并校验**。`loadRuntimeConfig()` 同时支持 `codex.config.json` 与 `.env`；有错误直接 `process.exit(1)`，不带着一份「看起来配了、实际没生效」的配置继续跑。
2. **解析监听地址**。`resolveListenHost()` 在没有 `AUTH_TOKEN` 时拒绝非 loopback 绑定。
3. **preflight**：解析工作区白名单（一个都没有就 fail-loud，**刻意不回落到家目录**），再探测 codex 二进制。
4. **listen**，然后挂上四类维护定时器：附件清理（每小时）、认证会话清理、限流窗口清理、空闲实例回收 + needs-you 终态回收（各 5 分钟）。全部 `unref()`，不吊住进程。

工作区那条拒绝值得单独记：早期是 `process.env.WORK_DIR || homedir()`，不配工作区时**整个家目录**进入 agent 的文件作用域——`~/.ssh`、`~/.aws`、浏览器配置、其他项目的 `.env` 全在里面，而启动日志只会印一条看起来正常的路径。

codex 二进制的探测与判定与 doctor 共用同一份实现（`probeCodexBin` + `codexBinDiagnostic`）。分开写的代价不是重复，是**两边给出不同的话**：同一个故障两种描述，人会以为是两个问题。

## 关闭顺序

`SIGTERM` / `SIGINT` 都走 `shutdown()` → `stopServer()`：清全部定时器、同步 flush 未读位点、dispose 所有 runtime 并从 registry 释放、清空四张表、dispose `AppServerHost`。

dispose host 会给 codex 子进程发 `SIGTERM`。这一步不能省：信号本身到不了子进程（`SIGTERM` 不像终端 Ctrl-C 的 `SIGINT` 会发给整个前台进程组），它此前只能靠 stdin 读到 EOF 自行退出——那是观察到的行为、不是协议保证，也不给它保存状态的机会。

`httpServer.close` 是异步的，`shutdown()` 刻意不等：Socket.IO 的长连接会让它迟迟不回调，而需要的清理在 close 之前已经同步做完了。

## 状态在哪

| 东西 | 住哪 | 生命周期 |
|---|---|---|
| thread / turn / item / 配置 / 模型 | app-server（`~/.codex`） | 网关不存 |
| 活跃 runtime、投递账本、需要你登记 | 网关内存 | 重启清零 |
| 受信设备表、推送订阅、未读位点 | `data/` 下的文件 | 持久，且逐条写明了为什么不算第二份真相 |
| 安全审计、审批审计、RPC 日志 | `data/` 下的 JSONL，owner-only + 轮转 | 持久 |
| 展开的目录、当前 thread 指针 | 浏览器 `localStorage` | per 设备 |
| 未发出的消息 | 浏览器 IndexedDB | 直到确认送达 |

## 从这里往下读

- 协议怎么锁版本、怎么防漂移 → [codex app-server 协议基线](../integrations/codex-app-server-protocol.md)
- 一条消息从输入框到 turn → [输入组装](../workflows/compose-and-input.md)、[消息投递](../concepts/message-delivery.md)
- 审批为什么是这个产品的核心 → [审批闭环](../concepts/approvals-and-needs-you.md)
- 怎么装、怎么配、连不上怎么查 → [配置与装机](../operations/setup-and-configuration.md)、[自检与可观测](../operations/diagnostics-and-observability.md)
- 安全边界到底守住了什么 → [安全模型](../operations/security-model.md)
