---
type: architecture-decision
title: 状态归属：不产生第二份真相
description: 架构决定 A2 的判据与落地——thread/turn/item/配置/模型列表一律向 app-server 现问，网关落盘的七个文件各自凭什么不算第二份真相，以及守这条红线的两个不变量测试如何双向闭合。
tags: [architecture, invariant, state, persistence, source-of-truth, A2]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-65306538260d32b79753a83b
    resource: repo://src/agent/agent-appserver.js
  - id: openwiki-source-b9a03ebc92a7896b0b8b440d
    resource: repo://src/sessions/read-state.js
  - id: openwiki-source-00e8958e9ea2ad8b6948dfb2
    resource: repo://src/shared/data-dir.js
  - id: openwiki-source-b08db528553c2bc6133ba9e3
    resource: repo://test/invariants/thread-source-of-truth.test.mjs
  - id: openwiki-source-f2747ed522b30a1feb5985b8
    resource: repo://test/invariants/zero-persistence-guard.test.mjs
  - id: openwiki-source-2d58f6a6fcc12e1b2934dec9
    resource: repo://test/README.md
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 状态归属：不产生第二份真相

这是本仓最有约束力的一条架构决定，编号 `A2`。

**判据不是「有没有写文件」，而是「同一个事实会不会既在 codex 的宿主机状态里、又被我们独立存一份」。** 两边迟早漂移，而用户没有办法知道该信哪个。

推论很硬：thread、turn、item、配置、模型列表**全部向 app-server 现问**。列表要分页就发 `thread/list`，历史要回放就发 `thread/read`，不缓存、不镜像、不建索引。

## 状态住在哪

| 事实 | 归属 | 网关怎么拿 |
|---|---|---|
| thread / turn / item | app-server（`~/.codex`） | `thread/list`、`thread/read`，每次现问 |
| 配置、模型列表、MCP 状态、skills | app-server | 对应 RPC，每次现问 |
| 活跃 runtime、投递账本、needs-you 登记、thread 注册表 | 网关内存 | 重启即失 |
| 设备信任关系、推送订阅、未读位点 | 网关磁盘（`data/`） | 逐条写明例外理由 |
| 审计流水 | 网关磁盘，append-only | 不作为任何读路径的数据源 |

内存态的「重启即失」是一个**被写进测试的承诺**，不是实现细节：`message-receipt-ledger.js`、`needs-you-registry.js`、`thread-registry.js` 三个文件里不允许出现任何写盘调用。

## 七个落盘例外

`data/` 下允许存在的文件是一张显式清单，每一项都要回答「codex 侧有没有对应事实」：

| 文件 | 凭什么不算第二份真相 |
|---|---|
| `enrollment-token` | 本网关自己的凭证，codex 侧不存在对应事实 |
| `trusted-devices.json` | 设备信任关系是网关独有的，codex 不知道有哪些浏览器 |
| `pending-devices.json` | 同上，等待人工批准的队列 |
| `push-subscriptions.json` | 浏览器 Push endpoint，属于设备表的一部分 |
| `security-audit.jsonl` | append-only 审计，只增不改 |
| `host-config-audit.jsonl` | 同上，宿主机配置操作的审计 |
| `read-state.json` | 未读位点，见下节 |

RPC 日志不在这张表里，因为它不落在 `data/` —— 默认写到工作区的 `.codex-chat-rpc.jsonl`。

### 未读位点凭什么是例外

`read-state.json` 是清单里最需要论证的一条，理由有三层：

1. **codex 侧没有这个概念。** `thread/list` 只给 `createdAt` / `updatedAt` / `recencyAt`，全是 agent 侧的活动时间。「用户在手机上看过某个 thread 到什么时刻」记录的是**人的浏览行为**，不是 agent 的行为，无法从 thread 历史重建。
2. **它是缓存类。** 损坏、不存在、形状不对一律当作没有——`load()` 用一个空的 `catch` 兜住，让 server 起不来是错的方向。删掉最多让所有会话按新基线重来一次。
3. **它不进任何读路径的判定。** 判定发生在前端 `public/js/session/unread.js`，这个文件只是那份判定的跨设备位点。

前后端各有一份合并实现，而且**方向相反**：服务端谁都不权威、逐 key 取较晚；客户端远端权威覆盖本地。同向的话客户端的旧 baseline 会往回传染。两份实现之间唯一的连接点是 `test/invariants/read-state.test.mjs` 里那条「两侧判定同义」的断言。详见[未读位点与通知](../concepts/unread-and-notifications.md)。

基线时间戳有一条容易忽略的设计：它**刻意不在构造时写盘**，而是钉在「第一个客户端真正用到」的时刻。两者可能差着一次长达数天的空转。

## 状态根只有一个解析点

`src/shared/data-dir.js` 是 `data/` 的唯一解析点，里面有一条承重规则：**env 必须在函数体内读，不能提到模块顶层**。

静态 import 在模块链接阶段求值，早于任何 import 它的文件的顶层语句——也就是早于 server 的配置加载。把 `CODEX_DATA_DIR` 读成模块级常量，`.env` 里那一行就永远读不到，状态目录静默回落到仓库里的 `data/`，而**没有任何报错**：server 正常起、设备能批、审计照写，只是全写错了地方。

同样安静的还有 `PROJECT_ROOT` 上溯层数：本文件住在 `src/shared/`，少写一层会让 `data/` 解析到 `src/data/`。两条都由 `test/unit/data-dir.test.mjs` 钉着。

## 两道闸，两个方向

A2 由两个不变量测试守，分工是对称的：

**[zero-persistence-guard](../../test/invariants/zero-persistence-guard.test.mjs)** 扫「有没有往 `data/` 写新东西」。它从源码里正则抽取落盘点文件名，对照允许清单。三条断言：

- 抽出的文件名不得超出清单；
- **清单里的每一项都仍在被使用**（反向断言，防止清单本身过期后被当成现状）；
- 三个内存态模块不得出现写盘调用。

两个方向都必须有扫描面塌陷的保护：`found.size >= 5`。扫到 0 个与「没有新增持久化」在断言上完全一样——读取列表漏一个文件、正则失配、文件改名，症状都是「全绿」。

抽取器认两种写法：`join(DATA_DIR, 'x')` 与 `dataFile('x')`。不补第二支的话，任何走新分层的落盘点对这道闸完全不可见。

**[thread-source-of-truth](../../test/invariants/thread-source-of-truth.test.mjs)** 扫反方向：「有没有把已经退役的第二份真相读回来」。它断言 `server.js` 不再 import `sessions.js` / `history.js`、不再调 `listCodexSessions` 之类，并且正面要求 `.listThreads(` 与 `.readThread(` 仍在；还断言 `sessions.js` / `history.js` / `push.js` 三个文件已从仓库消失，以及契约层只有 `thread:*` 而没有 `session:list|select|history` 这些 legacy 别名（mock/scenario server 同样要对齐）。

两个方向都堵上，A2 才是闭合的。

## 新增落盘时怎么办

门禁会变红，这是设计好的——它逼一次显式判断：

1. 这个事实 codex CLI 是否已经有了？有的话应当现问而不是自己存一份。
2. 确实是网关独有的状态，再把它加进 `ALLOWED_STATE_FILES` 并**写明理由**。理由要能回答「codex 侧为什么没有这个事实」。
