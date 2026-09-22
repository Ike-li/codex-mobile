---
type: subsystem
title: 消息投递：不丢不重与断线恢复
description: 端到端的投递不变量 DELIVER-01 如何落地——clientRequestId 幂等、服务端回执账本、浏览器 IndexedDB outbox 的排队与补发、message:reconcile 的二次核对、catch-up 的增量重放与快照重建，以及 gatewayEpoch 的作用。
tags: [delivery, idempotency, outbox, indexeddb, reconnect, invariant]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-b0bf8762bd1a9c5663d7eb6d
    resource: repo://public/js/outbox/indexeddb-outbox.js
  - id: openwiki-source-13c4e941f66c160677e26362
    resource: repo://public/js/outbox/message-outbox.js
  - id: openwiki-source-9ad8eaa2c2543b1de811c6d4
    resource: repo://public/js/outbox/outbox-recovery.js
  - id: openwiki-source-0cbb14c948cda1bbdeed475f
    resource: repo://public/js/outbox/recovery-state.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-71d5fbd3a96e2e43f6be8544
    resource: repo://src/sessions/message-receipt-ledger.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 消息投递：不丢不重与断线恢复

手机网络会断。断在「已发出、还没收到 ack」那一刻时，客户端**不知道服务端收没收到**——这是整条链路最难的一个状态，而两种错法的代价都很实：重发会让 agent 执行两次，不发会让用户的消息凭空消失。

不变量 `DELIVER-01` 把这件事定死：**投递不丢不重，且需要人时叫得到人**。它只断言外部可观察行为（同一请求发两次会怎样、断线重连后查得到什么），刻意不碰内部形态。

四个组件分担这件事：

| 组件 | 在哪 | 职责 |
|---|---|---|
| `clientRequestId` + 指纹 | 契约 | 幂等键 |
| `MessageReceiptLedger` | 服务端内存 | 回执账本，重复请求回放同一个结果 |
| outbox（IndexedDB） | 浏览器 | 未确认的消息不消失 |
| `catch-up` / `message:reconcile` | 契约 | 重连后补齐与核对 |

## 幂等键：clientRequestId + 请求指纹

客户端为每条消息生成一个 `clientRequestId`（格式由服务端正则校验，且必须配合稳定的 `deviceToken`——没有稳定身份就没有幂等可言，服务端会直接回 `client_identity_required`）。

服务端再算一个**请求指纹**：文本、附件规范化指纹、input parts、turn overrides、投递目标（threadId，或 instanceId + 是否新建 thread）一起哈希。

账本按 `identity + requestId` 认领：

| 认领结果 | 含义 | ack |
|---|---|---|
| `owner` | 第一次见，继续派发 | 正常结果 |
| `duplicate` | 同 id 同指纹 | **回放**上一次的结果，`duplicate: true` |
| `conflict` | 同 id 不同指纹 | `request_id_conflict` |
| `full` | 账本满 | `receipt_ledger_full`，retryable |

指纹存在的意义是分清「同一条消息重发」和「同一个 id 被复用到别的消息上」。后者必须报错，否则用户会以为发出去的是新内容。

## 回执账本的三个 phase

条目落在三个 phase 之一，这决定它什么时候被回收：

- `pending` —— 还在派发，**prune 绝不能碰**（有人 `await` 着它的 `ready` promise，删了会把 replay 永久挂住）。
- `waiting` —— 回执停在 `queued`，即消息还排在 runtime 队列里没执行。
- `settled` —— 其余一切已结算的。

`waiting` 的宽限期单独设（默认是 TTL 的 7 倍，约一周），这条是一次事故的修法。终态回执由 agent 的事件驱动，实例被空闲回收、codex 退出或 thread 被关掉时它**永远不会到来**，条目就此卡死。原先无条件跳过 `waiting`，于是这些条目永不回收：攒够上限之后所有带 `clientRequestId` 的消息一律收到 `receipt_ledger_full`，而文案是「请稍后重试」——一句永远不会兑现的话，只有重启进程才能恢复。

`settled` 的回收依据是 `settledAt`（结算过没有）而**不是**「是不是终态」。按终态回收会让 `dispatch_failed` 形状（`retryable` + `resultUnknown`）的条目永不回收，重现同一次事故。源码里那行注释写得很直白：别改回去。

### 回执只能前进

`canAdvanceReceipt` 定义了回执状态的偏序：`queued`（rank 1）→ `submitted` / `steered` / `rejected`（rank 2）。低 rank 不能覆盖高 rank，两个不同的 rank-2 状态之间也不能互相覆盖。这保证乱序到达的事件不会把回执拨回去。

`bindRuntime` 把账本条目与 `instanceId + clientRequestId` 关联，之后 runtime 发出的 `message_receipt` 事件就能通过 `advanceRuntime` 推进同一条记录。

## 浏览器 outbox

`createIndexedDbMessageStore` 用一个以 `clientRequestId` 为 keyPath 的对象存储；`createMessageOutbox` 在它上面跑一个串行状态机（`runExclusive` 保证所有操作排队，`drain` 的并发调用会合并谓词而不是并行跑两遍）。

请求状态：

```
pending ──sending──→ ┌ submitted/steered → 删除（送达）
                     ├ queued            → 保留，等终态回执
                     ├ retryable         → 下次 drain 重试
                     ├ needs_reconcile   → 结果未知，不自动重发
                     └ rejected          → 停住，要用户处理
```

三条关键规则：

1. **`drain` 遇到 `rejected` 或 `needs_reconcile` 就 `break`，不是 `continue`。** 顺序必须保持——前一条状态不明时就发后一条，会让对话顺序错乱。
2. **ack 里的 receipt 必须与请求匹配才算数**：`clientRequestId` 相等且 `state` 属于三个合法值，否则一律降级成 `needs_reconcile`（`invalid_receipt`）。
3. **`resultUnknown` → `needs_reconcile`，`retryable` → `retryable`。** 这个分叉是整套机制的核心：超时和断线都属于前者，不能自动重发。

用户确认后的重试走 `retryAfterConfirmation`，它**强制换一个新的 `clientRequestId`**（旧 id 会被账本判成 duplicate 并回放旧结果，等于什么都没发生），并记下 `retryOfClientRequestId` 与确认时间。

## message:reconcile：结果未知时怎么办

`reconcile` 只处理 `needs_reconcile` 与 `queued` 两种状态，查询里带上 `clientRequestId`、`threadId` 和当初尝试时的 `attemptedGatewayEpoch`。

服务端分两级回答：

1. **先查回执账本**（`replayByRequest`）。命中就是权威答案，`source: 'receipt_ledger'`。
2. **账本没有就查 thread**：`thread/read` 拿全部 turn，在 items 里找 `type === 'userMessage'` 且 `clientId === clientRequestId` 的那一条。找到就合成一个 `state: 'submitted'` 的回执，`source: 'thread/read'`。

两级都没有时，ack 是 `resolved: false` + `resultUnknown: true` + 一个错误码（`client_request_not_found` 或 `thread_required`）——**据实说不知道**，让请求停在 `needs_reconcile`，由用户决定丢弃还是确认重发。

`gatewayEpoch` 在这里承重：网关每次启动生成一个随机 epoch，客户端记下发送时的那个。账本是内存态，重启即空——epoch 不同就说明「查不到」可能只是因为账本没了，而不是消息没送到。

## catch-up：重连后的两条路

重连时客户端带 `lastSeq` 与 `lastEpoch` 发 `catch-up`，服务端有两条路：

**增量重放** —— 缓冲里有从 `lastSeq + 1` 开始的完整序列且 epoch 相同，逐条重发，ack 里带 `replayed` 计数。

**快照重建** —— 缓冲有缺口（`bufferTrimmed` 且最旧的 seq 超过了 `lastSeq + 1`）或 epoch 不匹配，就走 `thread/read` 重建整个视图。

重建路径有一个容易错的时序细节：**快照水位线必须在 `thread/read` 之前冻结**。代码先记下 `snapshotThroughSeq = ai.seq`，读快照期间到达的任何 runtime 事件都会在重建之后被重放——哪怕它的内容与 app-server 的快照存在竞争。ack 把 `throughSeq` 回给客户端，`completeRecovery` 据此丢掉 `seq <= throughSeq` 的缓冲事件，剩下的去重排序后应用。

客户端在等 catch-up 结果期间用 `createRecoveryState` / `bufferRecoveryEvent` 缓冲实时事件，并且只收目标匹配的那些。`completeRecovery` 还要求 `snapshot.source === 'thread/read'` 才接受重建结果——形状不对宁可不接受。

`thread/read` 本身失败时 ack 会带 `rebuilt: false` 和 `recoveryError`，客户端知道这趟没补上。

## 孤儿与手工处置

离线期间发的消息可能只带 `instanceId`（还没拿到 thread）。服务端重启后那个实例不存在了，这条记录就成了**孤儿**。

`outbox-recovery.js` 的几个纯函数处理这一族判断：

- `isDefinitelyUnattempted` —— 从没尝试过（`attempts` 为 0 且没有 `attemptedGatewayEpoch`）。只有这种才能被 `rebindUnattempted` 安全地改绑到当前会话。
- `isProvisionalInstanceOrphan` —— 只有 `instanceId`、不在当前活跃实例列表里，且**实例快照已经到达**（没到达就判不出来）。
- `requiresManualDisposal` —— `rejected`、`needs_reconcile`，或者已尝试过的孤儿。这些要用户点一下才能继续。
- `shouldSurfaceInOutboxView` —— 补了一个会静默吞消息的缺口：记录带 `threadId` 而那个 thread 已经不在了（典型触发是离线发送后服务端重启），它既不匹配当前视图也不是 provisional 孤儿，于是永远不渲染——用户不知道消息没发出去，也没有任何入口清掉它。

文案由 `outboxDeliveryLabel` 统一给，每一句都说清两件事：现在是什么状态，会不会自动重发。

## 相关测试

- [test/invariants/delivery-contract.test.mjs](../../test/invariants/delivery-contract.test.mjs) —— 守 `DELIVER-01`
- [test/unit/message-receipt-ledger.test.mjs](../../test/unit/message-receipt-ledger.test.mjs) —— 认领、回放、phase 与回收
- [test/unit/message-outbox.test.mjs](../../test/unit/message-outbox.test.mjs)、[test/unit/outbox-recovery.test.mjs](../../test/unit/outbox-recovery.test.mjs)
- [e2e/outbox-recovery.spec.js](../../e2e/outbox-recovery.spec.js)、[e2e/outbox-storage.spec.js](../../e2e/outbox-storage.spec.js) —— 浏览器侧真跑一遍
