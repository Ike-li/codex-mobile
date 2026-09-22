---
type: architecture
title: app-server 桥接层：传输、宿主与归属路由
description: 网关如何用一条 codex app-server 子进程承载多个并行会话——AppServerTransport 收发 JSON-RPC 帧，AppServerHost 复用连接并把入站帧路由回正确的 runtime，ThreadRegistry 以 fail-closed 的方式回答「这一帧归谁」。
tags: [architecture, jsonrpc, transport, routing, app-server, ipc]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-d536dae7542879b4b37d999f
    resource: repo://scripts/doctor.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-65306538260d32b79753a83b
    resource: repo://src/agent/agent-appserver.js
  - id: openwiki-source-a0dd453cac3332eb635e51fb
    resource: repo://src/agent/app-server-host.js
  - id: openwiki-source-8040abdfb08fe48f57b5f157
    resource: repo://src/agent/app-server-transport.js
  - id: openwiki-source-85f9f87d27133ecb0026b3c8
    resource: repo://src/sessions/thread-registry.js
  - id: openwiki-source-7f27d3c6919ee89a28385ef6
    resource: repo://test/invariants/doctor.test.mjs
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# app-server 桥接层：传输、宿主与归属路由

网关与 Codex 之间只有一条通道：一个 `codex app-server` 子进程，stdio 上跑 JSON-RPC 2.0 的换行分隔帧。而网关这一侧同时存在多个会话（多工作区、多 thread 并行）。桥接层要解决的就是这个不对称：**多个 runtime 共用一条连接，而每一帧回来时必须能判断出它属于谁**。

三个文件各自回答一个问题：

| 文件 | 回答什么 |
|---|---|
| [src/agent/app-server-transport.js](../../src/agent/app-server-transport.js) | 帧怎么进出、子进程活着还是死了 |
| [src/agent/app-server-host.js](../../src/agent/app-server-host.js) | 这一帧归哪个 runtime |
| [src/sessions/thread-registry.js](../../src/sessions/thread-registry.js) | 某个 id 当前被谁持有 |

上层消费者是 [ThreadRuntime](../concepts/thread-runtime.md)，它不直接碰子进程；协议本身的版本约束见 [codex app-server 协议基线](../integrations/codex-app-server-protocol.md)。

## 一条连接，多个 runtime

`server.js` 懒建**一个** `AppServerHost` 并把它传给每一个新建的 `ThreadRuntime`，所以进程数不随会话数增长。runtime 的 `spawnIfNeeded()` 在有 host 时不自己 spawn，而是 `host.attach(this)` 之后拿 `host.start()` 返回的同一个 child 句柄。

`ThreadRuntime` 保留了一条无 host 的旁路（自建 `AppServerTransport`，甚至直接写 `child.stdin`），那是单测用的注入路径；生产装配始终带 host。

握手只做一次。`ensureInitialized(runtime)` 把 `initialize` + `initialized` 这一对包成一个 promise 存在 `host.initialized` 上，后续 runtime 直接 await 同一个 promise；失败时把它清回 `null`，让下一个调用方能重试而不是永久继承一次失败。

`initialize` 的参数形状被单独导出成 `buildInitializeParams()`，因为它有第二个消费者：`scripts/doctor.js` 的 schema 探测也要起一条连接做只读握手。两处各写一份的话，上游改了 capabilities 形状只会有一边跟着改，而 doctor 报出来的兼容性结论就与 server 实际连接的那次不同。

## 传输层：帧、缓冲与子进程生命周期

`AppServerTransport.start()` 以 `codex app-server` 为命令、工作区为 cwd spawn 子进程。环境变量不是原样继承：`NODE_TEST_CONTEXT`、`NODE_TEST_WORKER_ID`、`NODE_CHANNEL_FD`、`NODE_OPTIONS` 被 `childEnv()` 剥掉——它们只在跑测试时存在，泄漏进子进程会让 codex 里的 `node:test` 以为自己是测试子进程、或把预加载脚本一并带进去。

出站有四个入口，都收敛到 `send()`：`request()`（带自增 id，登记进 `pending`）、`notify()`、`respond()`、`respondError()`。`request()` 的 `timeoutMs` 默认 0 即不超时，定时器 `unref()` 掉以免吊住进程。

入站按行解析。`handleStdout` 用 `StringDecoder` 累积，避免多字节字符被 chunk 边界切断；`stdoutBuffer` 只保留最后一段不完整的行。子进程 `close` 时先 `decoder.end()` 把残留字节 flush 出来，能凑成完整一行就再解析一次——最后一帧不会因为进程退出被丢掉。解析失败的行不会让传输层崩溃，只报一个 `Invalid JSON from codex app-server` 错误然后继续。

每一帧进出都先过 `observeFrame()`（供 RPC 日志与归属判定旁观），再做业务处理。响应帧如果命中 `pending`，就地 settle 并清掉定时器，不再往 `onMessage` 传。

**在途请求的定向拒绝**是这里一条不显眼但承重的设计。`rejectPendingFor(runtime, error)` 只拒绝 `context.runtime` 等于目标的条目。少了它，dispose 一个 runtime 时它的在途请求会带着对 runtime 的强引用留在 `pending` 里——runtime 连同事件缓冲一起泄漏，调用方的 promise 永不 settle。

子进程出错或退出时，`child` 置空、缓冲清零、所有 pending 拒绝，然后回调 `onExit` / `onError`。host 接到后清空 `initialized` 与全部归属表，并把事件扇给每一个附着的 runtime。

## 归属路由：入站帧归谁

出站方向归属是已知的（调用方就是 owner），所以 host 在 `handleObservedFrame` 里**顺手记账**，为将来的入站帧建立线索：

- 出站 params 里有 `threadId` → 记 `thread:<id>`；有 `processId`/`processHandle` → 记 `process:<id>`
- 出站方法以 `account/` 开头 → 认领 `account` 频道；`experimentalFeature/list` → 认领 `experimental` 频道
- 响应里带 `loginId` → 记 `login:<id>`
- 响应是 `thread/start` / `thread/resume` → 把 threadId 绑进 registry；`turn/start` / `turn/steer` → 把 turnId 绑进 registry

入站方向由 `resolveInboundOwner()` 按固定优先级问下去：`thread/status/changed` 只认 registry → `loginId` → `account/*` 频道 → `remoteControl/*` 频道 → `processId` → `threadId`（再叠 `turnId`）→ 单独的 `turnId`。

threadId 这一支还有几条兜底，每条都对应一个真实的时序缝隙：registry 里查不到 thread 时退回 `thread:<id>` 操作归属；`thread/realtime/*` 退回 experimental 频道；turnId 查不到时，`thread/compacted` 与「runtime 当前 turn 就是它」直接归 thread owner；`turn/started` 和定向审批请求则在 thread owner 还没有别的 turn 时顺势 `bind` 上去。

**无人认领的帧不会被静默吞掉。** 通知类走 `reportUnrouted()`（server 在 `LOG_STDERR` 时打印）；带 `id` 的服务端请求必须回话，否则 app-server 会一直等：审批与用户输入这类「定向请求」回 `-32602`（有人该管但找不到），其余回 `-32601`（不支持）。区分两个错误码是有意的——它们指向完全不同的排查方向。

`thread/status/changed` 是唯一的例外：即使解析不出 owner 也不算未路由。它先被 `publishThreadStatus()` 克隆进 `threadStatuses` 缓存、带上单调递增的 `revision`、回调 `onThreadStatus` 广播给所有设备。这份缓存的用途是给 `thread:list` 补最新状态，所以设了 512 条上限，并且**先删再插**以保证淘汰的是最久没更新的那条而不是最早见到的那条。

## ThreadRegistry：fail-closed 的归属索引

registry 维护四张索引：`instanceId`、`threadId` 各自一对一，`turnId`、`requestId` 允许多 owner（值可以是 `Set`）。

它的核心承诺是**解析不出唯一 owner 就抛错，绝不猜**。`resolve()` 把传入的多个标识符逐个取候选集并求交集，任何一步为空、或最终候选不唯一，都抛一个 `code = 'stale_target'` 的错误。调用方（如 `catch-up`、`resolveRuntimeTarget`）据此回一个明确的 `stale_target` 而不是把事件发给错误的会话。

`bind()` 先把整个操作校验完再动索引：runtime 已绑到别的 thread、或目标 id 已有别的 owner，都在改任何一张表之前抛出。部分写入会留下半新半旧的索引，而那种状态只会在很久以后以「事件发错会话」的形式显形。

`processId` 的冲突挡得更早——在 `host.request()` 入口就查 `correlationOwners`，两个 runtime 抢同一个进程句柄时直接以 `code = 'process_id_conflict'` 拒绝，请求根本不会发出去。

`release()` / `clearTurn()` / `releaseRequest()` 负责回收，`deleteOwned()` 只删真正属于该 runtime 的条目——多 owner 的 `Set` 空了才删键。

## 相关测试

- [test/unit/app-server-transport.test.mjs](../../test/unit/app-server-transport.test.mjs) —— 帧切分、残帧 flush、pending 定向拒绝
- [test/unit/app-server-host.test.mjs](../../test/unit/app-server-host.test.mjs) —— 归属优先级链、未路由帧的错误码、握手 single-flight
- [test/unit/thread-registry.test.mjs](../../test/unit/thread-registry.test.mjs) —— `stale_target` 的各种触发形态
- [test/invariants/doctor.test.mjs](../../test/invariants/doctor.test.mjs) —— doctor 的握手参数与 `buildInitializeParams()` 逐字段相等
