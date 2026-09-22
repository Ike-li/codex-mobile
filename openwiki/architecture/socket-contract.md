---
type: architecture
title: Socket.IO 契约层与事件信封
description: 网关对手机端暴露的全部 socket 事件与 HTTP 端点、ack 的成功与失败形状、instance 房间与多设备广播、agent:event 信封的 seq/epoch 语义，以及统一的错误出口与脱敏约束。
tags: [architecture, socketio, contract, api-surface, events, ack]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-21369b7faeb291820df0b948
    resource: repo://public/js/net/socket-ack.js
  - id: openwiki-source-2ff8609f4a04b2c8d71a7646
    resource: repo://public/js/ui/view-routing.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-65306538260d32b79753a83b
    resource: repo://src/agent/agent-appserver.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# Socket.IO 契约层与事件信封

网关对手机暴露两个面：少量 HTTP 端点（鉴权、推送、可观测）和一整套 Socket.IO 事件（所有业务操作）。业务操作走 socket 而不是 REST，是因为它们本来就是双向的——同一条链路既要发命令，也要接 agent 的流式事件。

## HTTP 端点

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /health` | `httpAuth` | 分层健康探测 |
| `GET /metrics` | `httpAuth` | 进程内指标白名单快照 |
| `POST /auth/session` | 令牌/入册 | 用令牌换设备会话 cookie |
| `POST /auth/enrollment/rotate` | 见[安全模型](../operations/security-model.md) | 轮换入册令牌 |
| `DELETE /auth/session` | `httpAuth` | 注销 |
| `GET /push/vapid-public-key` | 无 | 取 VAPID 公钥 |
| `POST /push/subscribe` | `httpAuth` + 已批准设备 | 登记 Web Push 订阅（body 上限 4KB） |
| 静态资源 | `noTokenLocalOnly` | `public/` |

## 契约事件

约 55 个事件，全部经 `on(socket, event, handler)` 注册。按域分组：

| 域 | 事件 |
|---|---|
| 会话生命周期 | `session:new` `session:fork` `session:switch` `catch-up` |
| thread 操作 | `thread:list` `thread:select` `thread:history` `thread:archive` `thread:unarchive` `thread:delete` `thread:rename` `thread:compact` `thread:review` `thread:rollback` `thread:collaborationMode` |
| 对话 | `user:message` `user:interrupt` `user:approval` `message:reconcile` |
| 未读与待办 | `read:mark` `read:sync` `needs-you:snapshot` |
| 文件与 git | `fs:readDirectory` `fs:readFile` `fs:writeFile` `fs:remove` `fs:copy` `files:search` `git:status` `git:diff` |
| 宿主机配置 | `host:configWrite` `host:configBatchWrite` `host:pluginInstall` `host:pluginUninstall` `host:marketplaceAdd` `host:marketplaceRemove` `host:marketplaceUpgrade` `host:mcpToolCall` `host:accountLogout` |
| 只读面板 | `models:read` `session-settings:read` `account:read` `mcp:read` `skills:read` `health:read` `externalAgentConfig:detect` `externalAgentConfig:import` |
| 账号登录 | `account:loginStart` `account:loginCancel` |
| 设备 | `devices:list` `devices:revoke` `user:approveDevice` `user:denyDevice` |
| 杂项 | `policy:changed` `logs:clientError` `conn:ping` |

`logs:clientError` 与 `conn:ping` 直接挂 `socket.on`，不走 `on()` 包装。

## `on()` 包装器：两件事

```
socket.on(event, async (...args) => {
  if (socket.deviceApproved !== true) return;   // fail-closed
  try { await handler(...args); }
  catch (err) { socket.emit('agent:event', { type: 'error', ... }); }
});
```

第一件是**fail-closed 的设备闸**：只有明确批准过的设备才放行，`deviceApproved` 未赋值一律当作未批准。第二件是**统一的异常出口**：处理器抛出的任何错误都变成一条脱敏后的 `error` 事件，而不是让整个连接崩掉或静默吞掉。

## ack 的形状

成功走 `ackOk(ack, payload)` → `{ ok: true, ...payload }`；失败走 `ackError(ack, error)` → `{ ok: false, error: <sanitize 过的消息> }`。

`ackError` 的脱敏不是洁癖。这条失败出口被 `externalAgentConfig:import`（解析带 API key 的外部配置）、`mcp:read`（读带凭证的 MCP 配置）、`account:*`（走认证流程）共用，报错的 `message` 里完全可能带着密钥，而它会显示在手机屏幕上并进入用户的截图。客户端的 `escHtml` 只挡 HTML，不挡 ANSI 转义序列，所以控制字符也必须在服务端剥掉。

两条刻意的克制：**不加 `errorCode`**（客户端目前没有任何一处对这批 ack 做分支判断，加了是没被证明必要的设计）；**不套 `sanitizePath`**（持有设备凭证的就是宿主机主人，把自己机器的路径打码只会让排查变难）。

少数事件有更丰富的 ack 形状，`message:reconcile` 是最典型的一个，见[消息投递](../concepts/message-delivery.md)。

## 写操作的两道额外闸

宿主机配置类事件（`host:*`、`fs:writeFile/remove/copy`）不只靠设备鉴权：

- `requireActionConfirm` 要求 payload 里带 `confirmAction` 且**等于本次动作名**。泛化的「确认过了」标记会被误点带过去，逐动作校验不会。
- 每一次成功、失败、拒绝都写审计：文件变更进安全审计（路径、字节数、结果，**不记内容**——否则审计日志成了代码的第二份副本，回溯内容该用 git），配置变更进宿主机配置审计。

## `agent:event` 信封

所有服务端推送共用一个信封：

```js
{ seq, epoch, sessionId, instanceId, cwd, ts, type, payload }
```

- `seq` 由 `ThreadRuntime` 单调递增，是断线重连时增量重放的游标。
- `epoch` 在 runtime 每次重建时换新，用来识别「对面已经不是同一条 runtime 了」。
- 服务端自己合成的信封（错误、系统消息、设备状态、实例列表）用 `seq: 0` 与 `epoch: 'server'`，表示它们不参与重放。

事件缓冲有上限（`CODEX_EVENT_BUFFER_CAP`）。溢出时从头裁剪并置 `bufferTrimmed`，`eventsSince(lastSeq)` 据此判断是否存在**缺口**——有缺口就不能靠重放补齐，必须走快照重建。

## 房间与多设备

每个 socket 用 `setSocketViewingInstance` 加入 `instance:<id>` 房间；runtime 的事件 `io.to(instanceRoom).emit(...)`，因此同一会话的多台设备同看同一条流。

全局事件不走房间：`view-routing.js` 里的 `GLOBAL_EVENT_TYPES`（`instances`、`pending_devices`、`needs_you_changed`、`status_line`、`account_*`、`rate_limits`、`mcp_status`、`skills_changed` 等）对所有已批准设备广播，前端的 `eventMatchesTarget` 负责判断一条事件是否属于当前视图。

`thread_status` 带 `scope: 'host'` 时也是全局的——它是宿主机层面的状态，不属于某个视图。

`ensureControlAgent` 处理「只读面板需要一条连接但用户没选会话」的情况：优先复用当前 viewing / control 实例，cwd 不匹配就新建一个，并把 socket 加进对应房间。

## 客户端侧的 ack 语义

`emitWithAck` 把 socket 回调包成 promise，默认 10 秒超时，并额外监听 `disconnect`。两个错误类都带语义标记：

- `AckTimeoutError` —— `retryable: true`、`resultUnknown: true`
- `SocketDisconnectedError` —— 同样标记结果未知

`resultUnknown` 是投递层的关键输入：**超时不等于没送到**，outbox 不能据此直接重发，必须走核对。

出站方向的视图匹配 `outboxRequestMatchesView` 有一条易错的顺序约束：`threadId` 必须先于 `instanceId` 判断。一个 instance 上可以先后开多个 thread，反过来先比 `instanceId` 的话，切到同实例的新 thread 后，旧 thread 的排队消息会被当成属于当前视图而发出去，**落进错误的会话**。

## 相关测试

[test/integration/server-integration.test.mjs](../../test/integration/server-integration.test.mjs) 起真进程、连真端口，覆盖握手与主要契约往返；[test/invariants/delivery-contract.test.mjs](../../test/invariants/delivery-contract.test.mjs) 只断言外部可观察行为（同一请求发两次、断线重连后查得到什么），刻意不碰内部形态。
