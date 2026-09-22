---
type: integration
title: codex app-server 协议基线与漂移门禁
description: .protocol/stable 里版本化 vendored 的协议定义、.codex-version 的 pin 语义、protocol-check 卡的四类漂移，以及两张方法白名单与一张字段白名单为什么必须写在门禁里。
tags: [protocol, jsonrpc, gate, versioning, drift, codex]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-35dba9b21b6a2c56a6b7daf1
    resource: repo://.codex-version
  - id: openwiki-source-7ed540ec1830a737e65e487b
    resource: repo://scripts/gates/protocol-check.mjs
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# codex app-server 协议基线与漂移门禁

这个网关唯一的外部依赖是宿主机上的 `codex` 二进制，而它们之间的契约是 `codex app-server` 的 JSON-RPC 协议。上游改协议时，症状**不是崩溃**：字段被改名，我们读到 `undefined`，不抛异常也没有失败用例，功能静默失效。

所以协议被当成一等公民对待：定义版本化 vendored 在仓库里，升级要过一道专门的门禁。

## 基线的形态

- `.protocol/stable/` —— `codex app-server generate-ts` 生成的 TypeScript 定义，93 个文件在顶层、627 个在 `v2/`。这些文件**只作为比对基线**存在，运行时代码不 import 它们（本仓是纯 JavaScript）。
- `.codex-version` —— 单行版本号，当前 `0.155.1`。

## 四类检查

`npm run protocol:check`（[scripts/gates/protocol-check.mjs](../../scripts/gates/protocol-check.mjs)）先要求本机装的 codex 版本等于 pin，然后现场 `generate-ts` 到临时目录，跑四项比对：

### ① 导出漂移（文件层）

基线目录与新生成的目录逐文件比：方法集合、类型文件集合、文件内容。任何增删改都算漂移。比对前把 CRLF 归一成 LF，避免平台差异制造假阳性。

这一项回答的是「上游变了没有」。

### ② 方法覆盖

从桥接代码里静态抽出实际用到的方法名，与协议导出的四个集合（`ServerNotification` / `ClientRequest` / `ServerRequest` / `ClientNotification`）比对：

- `handleNotification` 的 `case` 标签 → 服务端通知
- `this.request('...')` → 客户端请求
- `this.notify('...')` → 客户端通知
- `handleServerRequest` 里的 `method === '...'` 比较，加上 `ApprovalBroker` 的 `ALL_REQUEST_METHODS` 常量集合（会递归展开 `...SPREAD`）→ 服务端请求

用了而协议里没有的方法，就是失败。

### ③ 通知字段漂移

方法名对得上不代表字段对得上。这一项从 `handleNotification` 的每个分支里抽出所有 `params.X` 读取，与协议里该 method 的 params 类型声明的顶层字段比对。

**这一项对着新生成的协议比，而不是基线**——这样字段漂移在升级那一刻就报出来，而不是等到下一次同步基线。

### ④ 请求参数形状

同一族的第二种漂移，在请求方向上：方法名与字段名都对得上，但 params 的**形态**不对。协议声明了 params 结构体，调用点却写成 `this.request('m')` 或 `this.request('m', undefined)`。

后果很具体：`JSON.stringify` 会丢掉值为 `undefined` 的键，于是 app-server 收到一个根本没有 `params` 的帧并拒绝它——`-32600 Invalid request: missing field params`。而且**只有真实 app-server 会拒，假 server 一律照答**，所以下游三层测试全是绿的。这一项只认字面量（`this.request(m, someVar)` 里 `someVar` 运行时是不是 undefined 静态看不出来），覆盖的是真正出过事的那一种。

## 三张白名单

白名单写在门禁文件里，不是散在源码的 `??` 回退里。理由被写在注释中：**写在这里是为了让「这是有意的」可被读到**——否则下一个人看到就只能猜，要么当成手滑删掉，要么当成协议还有这个字段。

| 白名单 | 内容 | 理由 |
|---|---|---|
| `LEGACY_METHOD_ALLOWLIST` | `turn/failed` | 保留与该 legacy 通知的双轨兼容，尽管新版协议不再导出它 |
| `EXPERIMENTAL_METHOD_ALLOWLIST` | `thread/settings/update` | 协议未导出这个请求；桥把 `-32601` / experimentalApi 错误当作「推迟到下一次 turn/start」 |
| `LEGACY_FIELD_ALLOWLIST` | `process/exited` 的 `processId`、`thread/name/updated` 的 `name` | 上游改名后保留的兼容回退。**运行时的 codex 版本并不受 `.codex-version` 约束**（那只是 CI 门禁），用户机器上可能装着更老的一版，所以旧字段名要继续兜住 |

最后一条是整个设计里最容易被误解的一点：pin 约束的是 CI 与开发机，不是用户的运行时。

## 两种运行模式

| 命令 | 对谁比 | 文件漂移算失败吗 |
|---|---|---|
| `npm run protocol:check` | 严格等于 pin 的 codex | **算** |
| `npm run protocol:check:installed` | 本机装的任意版本 | 不算 |

对着比 pin 新的 codex 比对时，协议文件必然大面积 diff（注释记录 0.147.0 → 0.153.4 实测 122 个文件）。那是「上游又发了几版」，不是「这个仓库坏了」——算成失败这个模式就没法用。

而②③④说的是另一回事：桥消费或发送的东西在那一版上已经不成立了，升上去就会坏。所以**两种模式下它们都是硬失败**。

升级 CLI 前跑 `protocol:check:installed`，就能先看到会不会撞。

## 扫描面塌陷的保护

这道门禁最危险的失效形态是「什么都没扫到」，因为它的输出与「全部合规」完全一样。代码里因此埋了几处显式保护：

- `readAllNotificationParamsFields` 在「声明了 N 个 params 类型却一个字段都读不出」时**抛错**。上游把 `export type X = { ... }` 改成 `export interface X { ... }` 就是这个形态：下游的 `if (!declaredFields) continue` 会把每个 method 跳过、打印 `Notification field usage: OK` 并返回退出码 0，而 method 名走的是另一个正则不受影响，所以方法覆盖那侧也兜不住。
- `findDefinitionIndex` 跳过 `this.handleNotification(` 这类属性访问调用点，避免把定义之前的调用误认成定义——那会切出一个空函数体，整个覆盖抽取失效。
- `extractFunctionBody` 做了真正的括号配平并跳过字符串字面量，不是简单的正则截取。

## 升级协议的流程

1. 装新版 codex，跑 `npm run protocol:check:installed` 看②③④有没有红。
2. 有红就先改桥接代码（或加一条带理由的白名单条目）。
3. 更新 `.codex-version`，重新生成 `.protocol/stable/`。
4. 跑 `npm run protocol:check` 确认全绿。

CI 在 Node 20 那条腿上装 pin 住的 codex 并跑严格模式，见[门禁链路与 CI 接线](../testing/gates-and-ci.md)。

## 相关测试

[test/infra/protocol-check.test.mjs](../../test/infra/protocol-check.test.mjs) 测门禁自身：各个解析器的正则、白名单的作用、`protocolCheckFailed` 在两种模式下的判定差异。
