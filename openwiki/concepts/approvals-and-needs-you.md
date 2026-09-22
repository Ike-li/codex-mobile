---
type: subsystem
title: 审批闭环与「需要你」登记
description: 审批请求从 app-server 到手机再回到协议的完整路径——ApprovalBroker 如何同时兜住两代审批方法，NeedsYouRegistry 如何跨会话汇总待办并区分重复、冲突与结果未知，以及审计与推送如何保证「需要人时叫得到人」。
tags: [approvals, needs-you, delivery, safety, registry, audit]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-ab20e425850d1053b7bde1be
    resource: repo://public/js/session/needs-you-view.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-8fd476cdf49ee5b22e0603bf
    resource: repo://src/agent/approval-broker.js
  - id: openwiki-source-abd487e35ad1447db22d97c0
    resource: repo://src/sessions/needs-you-registry.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 审批闭环与「需要你」登记

审批是这个产品存在的理由：把 agent 的「要不要执行这条命令」带到你手机上。它也是最容易出错的一屏——审批停在那里没人看见，等同于任务卡死；审批被重复执行，等同于绕过了安全边界。

这条链路由两个组件分工：

- **ApprovalBroker**（[src/agent/approval-broker.js](../../src/agent/approval-broker.js)）—— 贴着协议：把 app-server 的服务端请求翻成前端 payload，再把决策翻回协议 result。
- **NeedsYouRegistry**（[src/sessions/needs-you-registry.js](../../src/sessions/needs-you-registry.js)）—— 贴着人：跨会话汇总待办，回答「有几件事等你」，并保证同一件事不会被处理两次。

## 两代审批方法

上游改过一次审批协议，网关同时兜住两代：

| 代 | 方法 |
|---|---|
| v2 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` |
| v1 | `applyPatchApproval`、`execCommandApproval` |
| 其他 | `item/permissions/requestApproval`、`item/tool/requestUserInput` |

差异被压在两处：**入站**由 `buildApprovalPayload` 按方法分支，把各代不同的字段（`fileChanges` map vs `changes` 数组、`conversationId`/`callId` vs `threadId`/`turnId`/`itemId`）归一成前端只认一种的 payload；**出站**由 `resultFor` 分支，v1 要的是 `approved` / `approved_for_session` / `denied` / `abort` 这套词，v2 直接回 `{ decision }`。

两个特殊形状：权限审批回 `{ permissions, scope }`，`scope` 由 `accept` 还是 `acceptForSession` 决定；用户输入请求回 `{ answers }`。

文件变更审批还依赖一份 item 缓存：`registerItem()` 在 item 事件到达时记下 `changes`，审批请求来的时候按 `itemId` 取回——协议的审批参数里不一定带完整改动。

## 决策的三道保护

`respondApproval(approvalId, decision, extra)` 在回包之前做三件事：

1. **`pendingApprovals` 里没有就直接返回 false。** 重复点击、旧客户端的补发，都在这里被挡掉。
2. **`approvalTargetMatches` 校验目标。** 前端传来的 `threadId` / `turnId` / `itemId` 只要给了，就必须与当初记下的 params 逐个相等。这防的是「审批卡片停留在旧会话上，用户点了批准，却把另一个会话的操作放行了」。
3. **回包与清理是原子的**：先删 pending 再 respond 再写审计。

### 未决审批必须回包

`declinePending()` 与 `clearPending()` 是两个函数，区别很重要：`clearPending()` 只清集合，`declinePending()` 会**逐个回一个 decline**。

dispose 一个 runtime 时如果不回包，app-server 那侧的 turn 会永久等下去。而且 `declinePending()` 还要额外发一个 `approval_revoked` 事件——否则那条 needs-you 记录永远停在 pending：不参与 prune，还会推给每台重连的手机。

## NeedsYouRegistry：一件事只处理一次

每条待办由 `needId` 标识，它是 `kind + target` 的 SHA-256 前 24 位。`target` 五个字段（`instanceId`、`threadId`、`turnId`、`itemId`、`requestId`）**全部必填**，缺一个直接抛错——不完整的 target 会让两件不同的事算成同一件。

`open()` 遇到已存在的 needId 时不覆盖，而是比对 payload 指纹：一样叫 `duplicate`，不一样叫 `conflict`。两者都不改变状态，但对调用方是完全不同的信息。

`resolve()` 是一个带状态机的异步流程：

```
pending ──→ resolving ──→ resolved      responder 返回 true
                      └─→ revoked       responder 返回 false（目标已失效）
                      └─→ unknown       responder 抛错（结果未知）
```

`resolving` 这个中间态存在的意义是并发保护：第二个请求进来时得到 `in_progress` 而不是重复执行。终态再次 resolve 会按指纹分成 `duplicate` / `conflict`。

`unknown` 是刻意保留的第四态。responder 抛错时**不能**假设没生效——网关不知道 app-server 收没收到，所以据实上报，ack 里带 `resultUnknown: true`。

服务端把这套结果翻成 ack 的 `errorCode`：`conflict` → `already_resolved`，`in_progress` → `resolution_in_progress`，`unknown` → `result_unknown`，其余失败 → `stale_target`。每一次决议都写安全审计，记录 `needKind`、需求引用、操作者引用和原因码。

### 自动关单

三类事件会关掉待办，都在 `trackNeedsYou()` 里：

- `approval_revoked` —— 上游自己解决了，按 `requestId` 精确关一条，状态 `revoked`；
- `result` / `error` / turn 终态 status（`turn_failed`、`turn_interrupted`、`interrupt` 等）—— 按 instance 批量关，状态 `expired`；
- TTL 到期 —— `prune()` 删掉终态记录。

终态记录要短暂保留才能判出 `duplicate` / `conflict`，但不能永久保留，否则每个 result / error 都要扫的这张表会单调增长。默认 TTL 一小时。`prune()` 只挂在 `open()` 上，所以 server 另外每 5 分钟主动调一次——长期没有新审批时它不会自己释放。

`#byInstance` 索引让按 instance 关单不必全表扫描。

## 前端呈现

`bannerNeeds(needs, { inlineNeedIds })` 的判据只有一条：**横幅的唯一职责是把看不见的待办拉到眼前**。审批卡片就在视野里时，横幅是同一件事在一屏内说第二遍，还占掉首屏六分之一的高度。可见性由调用方测量后传进来，这个函数不碰 DOM。

`waitingLabel({ pendingApprovals })` 同理：agent 在等审批时不能说自己在思考。

## 推送：需要人时叫得到人

`pushDecision(envelope)` 决定哪些事件值得打扰用户：

| 事件 | 推送 | 理由 |
|---|---|---|
| `approval_request` / `user_input_request` | 是 | 正是「需要你」 |
| `approval_revoked` | 否 | 已经不需要你了 |
| `policy_change` | 是，推给**全部**设备 | 手机可以调松策略，挡不住就必须看得见；手机被盗时其他设备会收到提醒 |
| `status` 且 reason 是 `process_exit` / `process_error` | 是 | 任务停了而手机上显示的还是「运行中」，不推的话用户会一直等一个不会来的结果 |
| 其他 `status` | 否 | 频繁，全推是噪音 |
| `result` / `error` | 是 | 任务终态 |

needs-you 类推送的 `tag` 是 `need:<needId>`，同一条待办的重复推送会互相覆盖而不是堆叠；`data.url` 带上 `?thread=...&need=...`，点通知直达那一条。

## 相关测试

- [test/unit/approval-broker.test.mjs](../../test/unit/approval-broker.test.mjs) —— 两代方法的 payload 与 result 形状、目标校验
- [test/unit/needs-you-registry.test.mjs](../../test/unit/needs-you-registry.test.mjs) —— 状态机、指纹、索引与 prune
- [test/invariants/delivery-contract.test.mjs](../../test/invariants/delivery-contract.test.mjs) —— 守 `DELIVER-01`，只断言外部可观察行为：处理过的审批再处理一次会发生什么
- [e2e/needs-you-recovery.spec.js](../../e2e/needs-you-recovery.spec.js)、[e2e/approval-card-style.spec.js](../../e2e/approval-card-style.spec.js) —— 浏览器侧的可达性
