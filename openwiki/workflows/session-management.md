---
type: workflow
title: 会话管理：列表、恢复、fork 与生命周期动作
description: 会话从列表到终态的完整路径——thread/list 的分页与归档过滤、select/resume 与多实例并行、fork、重命名、归档、删除、回滚、压缩、代码审查，以及跨工作区分组与状态广播的 revision 语义。
tags: [sessions, threads, workflow, fork, archive, lifecycle]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-b758f48178b15864daac7141
    resource: repo://public/js/session/project-label.js
  - id: openwiki-source-400da018ae043a71692e7884
    resource: repo://public/js/session/thread-actions.js
  - id: openwiki-source-96b587b4fadbc9c82f039d2a
    resource: repo://public/js/session/thread-preferences.js
  - id: openwiki-source-5bc2644f8fb70236fa48af68
    resource: repo://public/js/session/thread-status.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-65306538260d32b79753a83b
    resource: repo://src/agent/agent-appserver.js
  - id: openwiki-source-d2f3f0ed8d5d6b92bb2386d8
    resource: repo://src/sessions/thread-history.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 会话管理：列表、恢复、fork 与生命周期动作

所有会话操作都向 app-server 现问，网关不缓存 thread 数据（[A2](../architecture/state-ownership.md)）。这一页讲这些操作在网关这一侧要额外做什么。

## 列表

`thread:list` 把 cwd、归档过滤、分页游标、搜索词透传给 `thread/list`，并做三件本地的事：

1. **limit clamp 到 1..200**。只用 `Number.isInteger` 放行会把负数和巨值原样送进 app-server。
2. **用 host 缓存的最新状态覆盖列表里的 status**，并带上 `statusRevision`。列表是一次快照，而状态是持续推的。
3. **附上本页 thread 的未读位点**（`readStateForThreads`），见[未读位点](../concepts/unread-and-notifications.md)。

### modelProviders 必须显式传空数组

这一条是整个产品立意的落点：

```js
modelProviders: []   // 空数组 = 不按 provider 过滤
```

省略或传 `null` 都会退回 app-server 的默认——**只列 `model_provider=openai` 的会话**，于是自定义 `base_url` 网关跑的会话会整体从抽屉里消失。而那正是这个项目存在的理由。

### 归一化

`normalizeThread` 把协议字段折成前端形状：时间从秒转毫秒、标题取 `name` → `preview` → 「未命名」、`lastUsedAt` 取 `recencyAt` → `updatedAt` → `createdAt`，并打上 `source: 'app-server'`。

## 选中与恢复

`thread:select` 用 `createAgent(threadId, cwd)`，而它会**先查 registry**：同一条 thread 已经有活的 runtime 就复用，没有才新建。随后把 socket 的 viewing 指向这个实例、广播实例列表、发一条 `init` 事件并推一次活动状态。

真正的 `thread/resume` 发生在 runtime 的 `ensureReady()` 里，不在选中这一刻——选中只是绑定视图。

`thread:history` 走 `thread/read` 拿全部 turn，再由 `normalizeThreadHistoryMessages` 折成前端能直接渲染的消息数组：用户消息、助手消息、命令执行、文件变更、MCP 调用各有形状。上限 200 条，理由写在文件头：**前端只渲染最后 30 条，网关没必要把整条 thread 都序列化推给手机**。

## 多实例并行

一个 `instanceId` 对应一个 `ThreadRuntime`。`session:new` 建一个空实例（还没有 thread），`session:switch` 只切视图指针，`session:fork` 走 `thread/fork` 拿到新 threadId 后为它建实例。

fork 的目标解析比较宽容：显式 `threadId` > 显式 `instanceId` > socket 当前 viewing。解析不出来时给一句明确的「当前没有可分叉的会话」而不是抛。

`ensureControlAgent` 负责「只读面板需要连接但用户没选会话」的情况，见 [Socket.IO 契约层](../architecture/socket-contract.md)。

## 生命周期动作

| 事件 | 协议调用 | 网关额外做什么 |
|---|---|---|
| `thread:archive` / `thread:unarchive` | `thread/archive(d)` | 无 |
| `thread:rename` | `thread/name/set` | 空名拒绝，回显 trim 后的名字 |
| `thread:delete` | `thread/delete` | **dispose 所有指向该 thread 的 runtime**、从 registry 释放、清掉 socket 上的引用、广播实例列表 |
| `thread:compact` | `thread/compact/start` | 无 |
| `thread:rollback` | `thread/rollback` | 额外发一条 `rollback` 服务端信封给前端 |
| `thread:review` | `review/start` | 回 `reviewThreadId` |
| `thread:collaborationMode` | `thread/settings/update` | 没有 threadId 时降级成 turn override 并回 `deferred: true` |

删除那条的额外清理是必要的：thread 已经从 Codex 历史里没了，留着一个指向它的 runtime 只会在下次操作时报出令人困惑的错误。

**审查走 inline**：`delivery: 'inline'` 固定不变，结果作为当前 thread 的一个 turn 流回来，和普通回复同一条路径，所以前端不用为一条 review thread 单独订阅和切换。

它有两个容易漏的细节：用 `ensureReady()` 而不是 `ensureInitialized()`——审的是工作区改动，空会话里也该能发起，而 thread 是懒建的；以及**必须手动置 busy 并发一次 `turn_started`**，因为 inline review 就是当前 thread 上的一个 turn，少了这一步前端不进 busy，随后的 delta 没有 turn 容器可落，**审查结果会凭空消失**。参数先构造再广播，这样 `requireThreadId` 抛错时前端还没被推进 busy。

`thread/settings/update` 在协议里是 experimental，没有 threadId 或上游不支持时会降级，见[协议基线](../integrations/codex-app-server-protocol.md)的 experimental 白名单。

## 确认框只拦两个动作

`threadActionConfirm` 只对 **archive** 与 **delete** 返回确认内容。判据是「会不会拿走东西」：`unarchive` 是把会话加回来，`rename` 走 prompt 自带输入确认，都不该再拦一道。

archive 那条有来历：它此前是静默执行的——点完会话立刻从列表消失，而列表默认只拉未归档，于是**用户看到的就是「会话没了」，和删除毫无区别**。它其实可逆，但这份可逆必须先有「显示已归档」入口才成立，所以文案**指名那个入口**，而不是空口说「可恢复」。

## 错误翻译：只翻译认得出的那一类

`threadActionErrorMessage` 把 app-server 的错误翻成人话，但**只翻译真正认得出的那一类，其余原样透出——猜错比不猜更糟**。

app-server 的错误是给开发者看的：前半截 Rust 的 anyhow 链，后半截 SQLite 原文。原样糊进聊天区，用户读到的是 `no such table: agent_jobs`——既答不了「到底删掉了没有」，也给不出下一步。

认得出的那一类是 `SCHEMA_MISMATCH`（`no such table|column`）。翻译的写法有三条讲究：

- **先答最急的那个问题**：这类失败是原子的，所以先说「会话未被删除 / 保持原样」。
- **文案给的是「多半」加一个最可能奏效的动作，不是断言**——缺表最常见的成因是跑着的 codex 比 `~/.codex` 里的状态库旧，但库损坏、`CODEX_HOME` 指错也会落到同一句报错上。
- **不给「稍后再试」这种假出路**：重试肯定没用。

`SCHEMA_MISMATCH` 这个常量被 `src/ops/doctor-checks.js` 复用——启动前自检和运行时兜底必须认同一个形态，否则 doctor 报绿而手机上弹 `no such table`。它是[三个前后端共享模块](../architecture/module-boundaries.md)之一。

文案长度是照着 393px 宽的手机视口实测调的。

## 状态广播的 revision

`thread/status/changed` 由 host 打上单调递增的 `revision` 后广播。前端的 `applyThreadStatus` 与 `mergeThreadList` 都用它做**乱序保护**：收到的 revision 小于本地已有的就丢弃；列表刷新回来时，如果本地状态更新，保留本地的。

这两个函数配合起来解决的是同一个竞态：`thread:list` 的响应可能比某条 `thread/status/changed` 更早发出、更晚到达。

`needsYouSessionLabel` 处理另一个边界：顶栏标题取自「当前渲染的这份会话列表」，但列表并不总是包含当前会话（切到已归档视图时整份列表都被换掉）。它返回空串表示「这份列表答不上来，别动标题」——**回落成「新会话」会让顶栏和正文里仍挂着的对话互相打脸**。

## 跨工作区分组

`groupThreadsByProject` 按 `cwd` 的最后一段分组（`projectLabel`），保持首次出现的顺序，取不到就归「未分类」。

当前 thread 指针存在 `localStorage` 的 `codex_current_thread_by_cwd` 里——**按 cwd 分别记**，所以在多个工作区之间切换时各自回到上次的会话。

## 相关测试

[test/unit/thread-status.test.mjs](../../test/unit/thread-status.test.mjs)、[test/unit/thread-actions.test.mjs](../../test/unit/thread-actions.test.mjs)、[test/unit/thread-history.test.mjs](../../test/unit/thread-history.test.mjs)、[test/unit/thread-preferences.test.mjs](../../test/unit/thread-preferences.test.mjs)、[test/invariants/thread-source-of-truth.test.mjs](../../test/invariants/thread-source-of-truth.test.mjs)、[e2e/drawer-thread-actions.spec.js](../../e2e/drawer-thread-actions.spec.js)、[e2e/instances.spec.js](../../e2e/instances.spec.js)
