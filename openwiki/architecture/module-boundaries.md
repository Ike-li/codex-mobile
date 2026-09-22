---
type: architecture
title: 模块分层与 import 边界
description: 后端 src/ 六个域与前端 public/js/ 八个功能域的层序约定、组装根不可被反向 import、前后端三个具名共享模块的白名单，以及 check-import-boundaries 如何把这些约定变成会红的静态闸。
tags: [architecture, module-boundaries, layering, static-gate, dependency-graph]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-e7089a43d0d745673d4e1809
    resource: repo://public/js/app.js
  - id: openwiki-source-8400d7042e637d8d7fef5a4a
    resource: repo://public/js/session/token-usage.js
  - id: openwiki-source-d0b5454aa7eb58bcea1b977b
    resource: repo://scripts/gates/check-import-boundaries.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-45e030fb0723518e3fb8221d
    resource: repo://src/ops/statusline.js
  - id: openwiki-source-ca3898ec78cc8b2fe247d047
    resource: repo://test/infra/check-import-boundaries.test.mjs
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 模块分层与 import 边界

这个仓库的目录结构不是审美偏好，是一道**会红的闸**。[scripts/gates/check-import-boundaries.js](../../scripts/gates/check-import-boundaries.js) 静态解析项目内的相对 import，构出依赖图，然后对每条边逐条判规则。

存在的理由写在文件头：结构缠死是**渐进**的。没有任何一次改动会让它当场变红，于是「下次再整理」可以无限推迟。门禁把「脑子里的约定」变成机器可读的判据。

## 域的划分

**后端 `src/`**（36 个模块）：

| 域 | 层序 | 装什么 |
|---|---|---|
| `src/shared` | 0 | 零 IO 零跨域叶子：脱敏、文本工具、数据目录解析、网络地址判定、QR/PNG 编码、串行落盘 |
| `src/files` | 1 | 路径归一与文件安全，被上面各域共用 |
| `src/auth` | 2 | 设备表与传输安全判定 |
| `src/ops` | 2 | 配置 schema、自检、指标、审计、推送、状态栏 |
| `src/sessions` | 2 | thread 注册表、投递账本、需要你登记、未读位点、输入组装 |
| `src/agent` | 3 | app-server 运行时，组装 sessions 与 files |

**前端 `public/js/`**（48 个模块 + 2 个入口）：`compose` / `files` / `net` / `outbox` / `render` / `session` / `ui` / `util`。直属一层只允许 `app.js` 与 `sw.js`。

## 六条边界规则

| 规则 | 判据 |
|---|---|
| `frontend-no-backend` | 前端不得 import `src/` 或根目录模块 |
| `backend-no-frontend` | 后端不得 import 前端，三个具名共享模块除外 |
| `layer-order` | 后端域只能引层序不高于自己的域（`src/shared` 因此是叶子） |
| `roots-are-sinks` | 组装根只能被明确许可的一方 import |
| `runtime-no-tooling` | 运行时代码不得 import `scripts/` `test/` `e2e/` |
| `frontend-util-is-leaf` | `public/js/util` 只能 import 同层 |

再叠三条结构性判据：`no-cycles`（图上找环）、`no-new-root-modules`、`no-new-flat-frontend`。

### 层序是量出来的

`DOMAIN_RANK` 的注释把这件事说得很明白：搬家当天把 `src/` 的全部跨域边打出来统计，得到的就是这个顺序，一条反例都没有。所以它不是对未来的设计，是把**已经成立的事实**钉住——从第一天起就是绿的，任何一次方向反转会当场红。凭空设计一套理想层序的下场是落地当天红一片，然后被人加豁免加到失效。

`frontend-util-is-leaf` 同理。它的前身是 `logic-is-leaf`，守 `public/js/logic/`；前端拆成八个域后那个目录不复存在，规则会变成没有靶子的空转——**比没有规则更糟，因为它占着「有人管」这个位置**。换成 `util/` 的依据是量出来的：它是前端唯一零出边的域。其余域之间只有 5 条零散边，给 `session`、`net` 这种零出边的域编层序等于凭空发明约束。

### 组装根是汇点

`ASSEMBLY_ROOTS` 只有两条：`server.js`（任何人不得 import）与 `src/agent/agent-appserver.js`（只有 `server.js` 能引）。

这张表的键必须是仓库相对路径，而这正是搬家时最容易腐烂的地方：文件从根目录进了 `src/agent/` 之后，`'agent-appserver.js'` 这个键再也匹配不到任何一条边，规则一个目标都没有——照样遍历、照样比对、照样报绿。**「规则失效」与「全部合规」在输出上完全一样**，这是清单型门禁的典型死法。

同一个失明风险在 `analyze()` 顶部也被显式挡了一次：解析出 0 条边时直接报 `scan-collapsed`，而不是当成「全部合规」。

## 前后端共享：三个具名文件

`SHARED_ALLOWLIST` 是**唯一**允许后端 import 前端的口子，而且是文件粒度，不开 `public/js/shared/` 这类目录级后门——那会让「再共享一个」变成零成本，而每多一个共享模块，前后端的耦合面就多一处，方向还是反的。

| 共享文件 | 后端消费者 | 为什么不能各写一份 |
|---|---|---|
| `public/js/util/cli-settings.js` | `server.js`、`src/agent/agent-appserver.js` | 权限预设与 turn overrides 的归一化。两份实现必然分叉成「面板显示的策略 ≠ 实际下发的策略」 |
| `public/js/session/token-usage.js` | `src/ops/statusline.js` | token 用量字段归一。曾因 statusline 侧独立写成 snake_case 而三个字段全落到 `undefined \|\| 0`，静默显示 0 很久 |
| `public/js/session/thread-actions.js` | `src/ops/doctor-checks.js` | `SCHEMA_MISMATCH` 正则。运行时兜底与启动自检必须认同一个形态，否则 doctor 报绿而手机上弹 `no such table` |

第三条还有一段值得记的历史：它曾被删过一次——当时唯一消费者是 `scripts/doctor.js`，而 `scripts/` 不在扫描面内，于是这条豁免对应不到任何真实的边、成了死配置。判定层搬进 `src/ops/` 之后它才真正承重。

## 提取器本身的坑

门禁的准确性取决于它能不能看见每一条边，这里踩过三次：

1. **动态 import 必须单列一条正则。** 只认静态 import 的话，边界规则可以被 `await import()` 整个绕过，而绕过之后一切照常绿。
2. **动态那条必须认反引号。** 上一版只认 `['"]`，于是 `` await import(`./x.js`) `` 对这道闸完全不可见——而加动态分支的全部理由就是防这个绕过口。
3. **提取前必须去掉整行注释。** 提取器工作在裸文本上，而解释性散文最爱引用调用形状本身：`src/ops/config.js` 的注释里写过一句 `import('../../server.js?t=…')` 来解释为什么不能缓存，门禁立刻报出一条不存在的循环依赖，而报错信息看起来和真的一模一样。

还有一条与浏览器语义相关的：前端两种写法混用，多数文件写 `./x.js`，而 `app.js` 与 `workspace-panel.js` 写 `/js/x.js`（相对站点根）。`resolveSpecifier` 必须认 `/js/` 与 `/vendor/` 前缀，否则本仓最大的那个前端文件的所有 import 边对门禁不可见。

## 接线

这道闸在 `npm run test:ci` 链里，也在 GitHub Actions 的独立 step 里——两处都要改，详见[门禁链路与 CI 接线](../testing/gates-and-ci.md)。门禁自身的测试住在 [test/infra/check-import-boundaries.test.mjs](../../test/infra/check-import-boundaries.test.mjs)。它里面有两条**反向断言**，专门抓清单腐烂：`ASSEMBLY_ROOTS` 的键与许可的 importer 必须仍然是磁盘上真实存在的文件；`SHARED_ALLOWLIST` 里的每个条目必须仍然有后端文件在 import 它，否则那是一条没人再用的死豁免。这两条都是 `scan-collapsed` 抓不到的形态——边一条不少，只是规则对应不到任何目标。
