---
type: subsystem
title: 未读位点、注意力与推送通知
description: 三条正交的注意力轴为什么不能合并，未读判定的纯函数与跨设备归并的方向差异（READ-01），以及 Web Push 的订阅、VAPID、DNS pin 与 SSRF 防护，还有 Service Worker 的实际职责范围。
tags: [unread, notifications, web-push, ssrf, service-worker, invariant]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-b0bf8762bd1a9c5663d7eb6d
    resource: repo://public/js/outbox/indexeddb-outbox.js
  - id: openwiki-source-4623e4579076be96270f152d
    resource: repo://public/js/session/unread-tracker.js
  - id: openwiki-source-6162e3960d225021161ade4d
    resource: repo://public/js/session/unread.js
  - id: openwiki-source-924e2ba9411551b72f57a243
    resource: repo://public/js/sw.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-ae032da71ef23cab723f8179
    resource: repo://src/ops/push-sender.js
  - id: openwiki-source-b9a03ebc92a7896b0b8b440d
    resource: repo://src/sessions/read-state.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 未读位点、注意力与推送通知

## 三条轴，不合并

手机上有三种「这里有东西」的信号，它们的**清除条件完全不同**：

| 轴 | 含义 | 什么时候清 |
|---|---|---|
| 需要你 | 阻塞等你 | **答过才清** |
| 服务告警 | 服务本身出过岔子 | 时效窗自动退场 |
| 未读 | 有没有看过新内容 | **看过即清** |

挤进同一个指示器的后果很具体：让「扫一眼」解除一条本该钉到「答过」的警报，那比没有指示器更糟。

「需要你」见[审批闭环](approvals-and-needs-you.md)，这一页讲另外两条中的未读，以及把它们送到锁屏上的推送。

## 未读判定：纯函数

[public/js/session/unread.js](../../public/js/session/unread.js) 是纯函数层：数据进、数据出，禁碰 DOM / storage / socket。

核心判据 `isSessionUnread` 有两条短路，**顺序不能反**：

```js
if (manual) return true;      // ① 用户显式标记
if (isViewing) return false;  // ② 正在看
```

`isViewing` 否定的是**时间判据的可信度**（你正看着它，`lastUsedAt` 比 `seenAt` 新不说明有没看过的东西），它的管辖面到此为止；而 `manual` 是用户显式输入的待办标记，`isViewing` 对它没有管辖权。用户最常标「稍后再看」的时刻，恰恰是正读着这个会话的那一刻——顺序反了那一刻就点不亮，而确认框刚刚承诺过这一行会一直显示未读。

时间比较用严格大于：恰好相等不亮，因为同一时刻的两件事没有先后。

### manual 比的是时间戳，不是「有没有条目」

这是整个跨设备方案的承重点。旧语义下「标为已读」是**删除条目**，而删除在 LWW 归并里会被别的设备的旧条目复活。改成 `manual[id] > seen[id]` 之后，归并退化成纯 `max()`——幂等、与顺序无关。

### 失败方向

`resolveDirUnreadBadge` 的三态（`pending` / `none` / `unread`）也是从失败方向推出来的：脏输入一律按 `pending`，不按 0。两态实现里 `null` 和 `0` 会一起走隐藏分支，于是刷新后用户看到的不是一个加载中的界面，而是一个明确宣称「都没有未读」的界面。

`parseUnreadState` 同理：任何解析失败一律回落且**绝不抛**，但已有的合法 `baselineTs` 必须保留——被 `now` 覆盖等于每次启动重置基线，于是点永远不亮，而这个故障看起来就是「未读功能没做」。

## markSeen 与 markEntered

[unread-tracker.js](../../public/js/session/unread-tracker.js) 是持有层：读写 `localStorage`（key `codex_unread_v1`）、与服务端同步、把「该不该亮」答给渲染层。

两个入口刻意分开：

- `markSeen(id)` —— 离场 / 切后台。只记「看到此刻」，**不动手动标记**，而且当前处于手动未读态时整个跳过。
- `markEntered(id)` —— 进入会话。看过 + 手动标记作废，是手动未读**唯一的自动清除点**。

合成一个的后果：用户正看着一个会话时长按「标为未读」，离开那一瞬间就被清掉了。

`setManualUnread(id, false)`（取消手动未读）必须**同时记 seen**——只删标记会被别的设备的旧条目复活。

`localStorage` 的读写都包在 try/catch 里：无痕模式下不落盘也要能用。

## 跨设备归并的方向差异

前后端各有一份合并实现，方向**相反**，这不是冗余：

| 侧 | 语义 | baselineTs |
|---|---|---|
| 服务端 `applyClientState` | 多客户端增量归并，谁都不权威，逐 key 取较晚 | 客户端上报的**不参与** |
| 客户端 `mergeReadState` | 远端权威覆盖本地 | 无条件取 remote 的 |

两侧同向的话，客户端的旧 baseline 会往回传染。`mergeReadState` 还有一条保护：remote 无效时**原样返回 local，绝不清空**——清空的后果是一屏假未读，而原样返回只是降级回「每台设备各算各的」，那是个能用的状态。

服务端为什么可以存这份位点（A2 的例外论证），见[状态归属](../architecture/state-ownership.md)。

不变量 `READ-01` 由 [test/invariants/read-state.test.mjs](../../test/invariants/read-state.test.mjs) 守，四条：`markRead` 单调；「标为已读」路径的 seen 同样单调；取消手动未读必须同时记 seen；被更晚 seen 盖过的 manual 条目要清掉。每一条的失败形态都一样——**一屏已经看过的会话重新亮起来**，而那看起来像「未读功能不准」，不像数据被改坏了。

服务端 `thread:list` 只回本页 thread 的位点，这是安全的裁剪：前端 hydrate 逐 key 取 max、只增不减，少回的 key 不会抹掉本地已有位点。

## Web Push

订阅走 `POST /push/subscribe`（需要已批准设备，body 上限 4KB），公钥从 `GET /push/vapid-public-key` 取。哪些事件值得推见[审批闭环](approvals-and-needs-you.md)里的 `pushDecision` 表。

### 推送发送是一条 SSRF 防护路径

Push endpoint 由**浏览器**提供，属于不可信输入——它可以指向内网。`createPushSender` 因此是一条被仔细加固的出站路径：

1. **endpoint 必须是公网 HTTPS**：协议是 `https:`、不带 username/password、hostname 过 `isPublicEndpointHostname`。
2. **DNS 解析结果逐条校验**：任何一条解析到非公网地址就整体拒绝。
3. **地址 pin**：把第一个解析结果钉死在自定义 `lookup` 里，并校验 hostname 一致。这挡的是 DNS rebinding——校验和发起之间重新解析一次就能绕过前两步。
4. **web-push 生成的 endpoint 必须与校验过的那个逐字相等**，且不允许 `proxy` / `agent` 选项。
5. **超时与响应体上限**：超时销毁请求，响应超过上限（默认 64KB）立即中断。

### Service Worker 只做推送

[public/js/sw.js](../../public/js/sw.js) 只有 34 行，文件头写得很清楚：**没有缓存，没有离线支持**。它监听两个事件：

- `push` —— 显示通知，`tag` 来自 payload（needs-you 类是 `need:<needId>`，所以同一条待办的重复推送互相覆盖），`renotify: true`。
- `notificationclick` —— 关通知并导航。目标 URL 经同源校验，非同源一律回落到 `/`；优先复用已有窗口（`navigate` + `focus`），没有才 `openWindow`。

所以「离线能力」在这个产品里指的是 [IndexedDB outbox](message-delivery.md)，不是 Service Worker 缓存。sw.js 必须留在 `public/js/` 直属而不能挪进子目录——Service Worker 的作用域由它自己的 URL 决定，靠 server 为 `/js/sw.js` 发的 `Service-Worker-Allowed: /` 头才管得住整站。

## 相关测试

- [test/invariants/read-state.test.mjs](../../test/invariants/read-state.test.mjs) —— `READ-01`。它是未读这一族**唯一**的自动化覆盖：`public/js/session/unread.js` 与 `unread-tracker.js` 没有同名单测文件，两侧判定同义的断言就写在这里。
- [test/unit/push-sender.test.mjs](../../test/unit/push-sender.test.mjs) —— SSRF 各条防线
- [e2e/pwa-sw.spec.js](../../e2e/pwa-sw.spec.js) —— Service Worker 注册
