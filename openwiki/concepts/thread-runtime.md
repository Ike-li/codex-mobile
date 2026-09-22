---
type: subsystem
title: ThreadRuntime：单 thread 语义运行时
description: 一个 instanceId 对应一条 thread 的运行时——start/resume 就绪、turn 启动与转向、输入队列与排空、背压重试、中断的 turnEpoch 保护、idle 回收，以及协议通知到统一事件信封的映射。
tags: [runtime, thread, turn, queue, backpressure, interrupt, lifecycle]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-65306538260d32b79753a83b
    resource: repo://src/agent/agent-appserver.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# ThreadRuntime：单 thread 语义运行时

[src/agent/agent-appserver.js](../../src/agent/agent-appserver.js) 是本仓第二个组装根，也是最大的一个后端文件。它把「一个会话」这件事完整地封在一个对象里：一个 `instanceId`，最多一条 thread，一条正在跑的 turn，一个输入队列。

它不直接管子进程——那是[桥接层](../architecture/app-server-bridge.md)的事。它管的是**语义**：什么时候该 start、什么时候该 steer、什么时候该排队、中断之后状态怎么复位。

## 两级就绪

`ensureInitialized()` 保证 `initialize` + `initialized` 握手做过一次（有 host 时委托给 host 的全局 single-flight）。登录等非 thread 操作只需要这一级。

`ensureReady()` 在它之上再保证 thread 存在：有 `sessionId` 就 `thread/resume`，没有就 `thread/start`，然后发 `init` 与 `ready` 状态。两级都是 promise 缓存 + 失败清空，所以并发调用不会重复握手，而一次失败不会永久毒化后续调用。

`thread/start` 的响应里拿到 threadId 后回调 `onSessionId`，server 据此把 runtime 绑进 [ThreadRegistry](../architecture/app-server-bridge.md)。

## 一条消息的三个去向

`dispatchUserMessage` 按当前状态分三路：

| 状态 | 去向 | 回执 state |
|---|---|---|
| 空闲 | `turn/start` | `submitted` |
| 忙 + 有 `currentTurnId` | `turn/steer`（追加进正在跑的 turn） | `steered` |
| 忙 + 无 `currentTurnId` | 进输入队列 | `queued` |

steer 这一路有一条刻意的克制：**turn overrides 不往下传**。那一轮的权限与模型早已生效，改写一个正在执行的 turn 的权限边界是危险的。但也不静默——用户刚改完设置再发一句，会收到一条系统消息告诉他这一轮不算数。

队列有上限（`CODEX_INPUT_QUEUE_LIMIT`），满了回 `queue_full` 且标记为可重试。turn 终态时 `scheduleDrain()` 用 `queueMicrotask` 排一次排空，`drainQueue()` 每次只取一条并走完整的 `startTurnDispatch`。

## turn 启动：权限校验与两道中断窗口

`startTurnDispatch` 的顺序是：备份当前设置 → 应用 overrides → 发 `user_message` 事件（乐观渲染）→ 校验权限模式 → 解析 host 权限 → `ensureReady` → `turn/start`。

**权限校验不是走过场**：选了某个权限模式时，先 `readSessionSettings()` 拿主机的 `configRequirements`，确认该模式 enabled；`custom` 模式还要逐项核对 sandbox 与 approvalPolicy 在主机允许的集合里。不通过就抛错，turn 根本不发。

`permission.mode === 'host'` 时走 `resolveHostPermissions()`：读 `config/read` 把主机的 `approval_policy` / `sandbox_mode` / `sandbox_workspace_write`（可写根、网络访问、tmpdir 排除）翻成协议形状。解析不出完整策略就报错而不是猜一个默认值。

失败时 `Object.assign(this, previousSettings)` 把设置整体回滚——半生效的权限状态比失败更糟。

### turnEpoch 与两道中断窗口

`abort()` 递增 `turnEpoch`。`startTurnDispatch` 在两个点检查它有没有变：

1. `ensureReady()` 之后、`turn/start` 之前 —— 直接放弃。
2. **`turn/start` 返回之后** —— 这一道是关键：turn 已经在 app-server 上起来了，但既没进 `currentTurnId` 的追踪、也不会被后续任何 interrupt 命中。用户看到「已中断」而命令仍在跑。所以必须就地补发一次 `turn/interrupt`。

为什么用 `turnEpoch` 而不是 `busy`：`busy` 也可能被 `thread/status/changed` 的 idle 通知改写，而 `turnEpoch` 只有 `abort()` 会动，判据更精确。

`abort()` 本身即使 `turn/interrupt` 请求失败也会执行本地复位（清队列、清审批、清 turn、发状态），只是多一条系统消息说明。

## 背压重试

`request()` 在 `-32001` 这类拥塞错误上做指数退避重试，次数与基准延迟来自配置（`CODEX_BACKPRESSURE_RETRIES` / `CODEX_BACKPRESSURE_BASE_MS`）。每次重试都发一条系统消息与一次状态更新，让用户知道**不是卡死了**。超过上限才真正 reject，并额外发一条「仍然拥塞」的错误消息。

在飞的重试登记在 `backpressureRetries` 里，进程退出、出错或 dispose 时统一清掉并拒绝——否则它们会在一个已经没有子进程的 runtime 上继续排队。

## 事件映射

`handleNotification` 是一张大 switch，把约 38 种 app-server 通知翻成统一信封的事件类型。几条值得注意的：

- `item/agentMessage/delta` → `text_delta`（正文流）；`item/completed` 的 agentMessage **不重复发正文**，因为 delta 已经给过。
- `item/commandExecution/outputDelta` → `tool_output_delta`，带 `toolUseId` 与 stream 通道。
- reasoning 的三种 delta（`summaryTextDelta`、`textDelta`、`summaryPartAdded`）各有自己的索引键，用于把分段的推理拼回去。
- `thread/status/changed` 同时维护 `threadStatus` 与 `busy`。
- `serverRequest/resolved` 转给 [ApprovalBroker](approvals-and-needs-you.md) 关掉那条待办。
- `thread/realtime/*` 与 `remoteControl/*` 走 `realtime` 事件，原样透传。

turn 终态分三种：`completed` 发 `result{ok:true}`，`failed` 与 `interrupted` 走 `finishTurnFailure` 发 `error`，其余状态发 `result{ok:false}`。四条路都会清空 `busy`、清未决审批、并 `scheduleDrain()`。

## 事件缓冲与重放

`emit()` 给每条事件编号（`seq` 自增，`epoch` 是 runtime 身份）并压进 `buffer`。超过 `CODEX_EVENT_BUFFER_CAP` 时从头裁剪并置 `bufferTrimmed`。

`eventsSince(lastSeq)` 返回增量事件与一个 `gap` 标志——只有真的裁掉了对方需要的那一段才算缺口。这是 [catch-up](message-delivery.md) 的基础。

## idle 与回收

两个不同的超时，别混：

- **`checkIdle()`**（每 30 秒轮询）—— 只在 `busy` 时生效。任务静默超过 `IDLE_TIMEOUT_MS` 就发错误并 `abort()`，因为一个不再产生任何事件的 turn 通常是上游卡死了。
- **`isReclaimable(idleSince)`** —— server 侧每 5 分钟用它判断能不能回收整个实例。条件严格：没 dispose、不忙、**没有未决审批**、队列为空、最后活动早于阈值。有人在等审批的实例绝不能被回收。

`dispose()` 的顺序有讲究：**趁 child 还在**先 `declinePending()` 把未决审批回掉（否则 app-server 侧那个 turn 永远等不到响应），再清队列、清重试、从 host detach、拒绝所有 pending。

## 权限与设置

审批策略与 sandbox 的默认值来自配置 schema（默认 `on-request` + `workspace-write`）。`applyTurnOverrides` 处理两族互斥的设置：`permission`（预设模式）与 `approvalPolicy`/`sandbox`/`approvalsReviewer`（自定义三件套）——设了一边就清掉另一边，避免两套语义同时生效。

归一化逻辑住在 `public/js/util/cli-settings.js`，是[三个前后端共享模块](../architecture/module-boundaries.md)之一：面板显示的策略必须与实际下发的策略是同一份代码算出来的。

`turn/start` 实际生效的策略会被 `rememberEffectivePermissions` 记下来，随状态一起推给前端——用户看到的是**生效值**，不是他选的值。

## 相关测试

- [test/unit/agent-appserver.test.mjs](../../test/unit/agent-appserver.test.mjs) —— 主路径
- [test/unit/agent-appserver-branches.test.mjs](../../test/unit/agent-appserver-branches.test.mjs) —— 分支与失败态
- [test/unit/cli-settings.test.mjs](../../test/unit/cli-settings.test.mjs) —— 权限归一化
