---
type: operations
title: 自检、指标与运行日志
description: doctor 的判定层与探测层为何分开、它凭什么等同于 server 启动时看到的配置、指标契约 OPS-01 的双向闭合、/health 与 /metrics 的出口，以及审计日志与 RPC 日志的轮转与权限策略。
tags: [operations, doctor, metrics, logging, audit, observability]
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
  - id: openwiki-source-e07cb1d2158822d75e78c767
    resource: repo://src/ops/audit-log.js
  - id: openwiki-source-d6b41cc608d913d6efab09df
    resource: repo://src/ops/doctor-checks.js
  - id: openwiki-source-52b8b2c58b731c544c0dec17
    resource: repo://src/ops/doctor-runtime.js
  - id: openwiki-source-9025679464c80cb3ae7d806a
    resource: repo://src/ops/metrics.js
  - id: openwiki-source-45e030fb0723518e3fb8221d
    resource: repo://src/ops/statusline.js
  - id: openwiki-source-807666062e185fd48283e650
    resource: repo://test/invariants/metrics-contract.test.mjs
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 自检、指标与运行日志

自托管产品的第一个门槛是「装不起来 / 连不上」，而这类故障最贵的形态是**自检自己报绿**。这一页讲的三件事都围绕同一个原则：不知道就说不知道，不要用一个 ok 把它盖过去。

## doctor：三层

| 层 | 文件 | 特性 |
|---|---|---|
| 判定 | [src/ops/doctor-checks.js](../../src/ops/doctor-checks.js) | 纯函数，零 IO |
| 探测 | [src/ops/doctor-runtime.js](../../src/ops/doctor-runtime.js) | spawn 进程、stat 磁盘、试绑端口 |
| CLI 宿主 | [scripts/doctor.js](../../scripts/doctor.js) | 参数、取数、打印、退出码 |

分层的理由：探测在宿主机上跑一次就是秒级，而「拿到这些事实之后该说什么」是纯逻辑，本该毫秒级跑完并被大量覆盖。混在一起的后果是判定逻辑只能靠端到端验证，于是实际上没人测它——**而自检本身出错的症状恰恰是「它说没问题」**。

每个探测器都接受注入。姊妹项目实测过：不注入的话单文件耗时从 1.5s 涨到 56.8s，多出来的 55s 全是等超时。

### 「它看到的 == server 会看到的」

doctor 的全部价值在这一句。落到三处具体约束：

1. **配置必须走同一个 `loadRuntimeConfig`**。各读各的话，最典型的故障——配置文件放错位置、被环境变量压过、格式不对——恰恰是 doctor 看不见的那一类。
2. **工作区解析的判据与 `server.js#initializeWorkDirs` 逐字相同**。解析不出来时返回空数组而不是抛：「一个工作区都没有」本身就是 `workdirsDiagnostic` 要报的那条 fail，自检不该因为被检对象有问题而自己崩掉。
3. **schema 探测必须用调用方给的 `codexBin` 与 `cwd`**，不能去跑 PATH 上另一个 codex——否则报出来的结论与实际那个二进制无关。

`runDoctor` 本身不读配置，全部由 ctx 喂入，因为「各读各的」正是 doctor 报绿但 server 起不来的经典成因。

### 每项检查的三个字段

每条诊断给 `status`（ok / warn / fail）、一段人话 `detail`、一个 `safe` 对象。`safe` 只出布尔、计数或枚举字面量——它会被贴进 issue 和截图，**绝不出明文令牌、绝对路径、URL 值**，那些正是人贴 doctor 输出时最容易连带泄露的东西。

十二项常规检查：配置格式、令牌、绑定、codex 二进制、版本 pin、工作区、数据目录、配置权限、端口、无头环境、日志开关、环境变量覆盖。

### schema 探测与 ENV-02

第十三项 `SCHEMA_PROBE` 要起一条真 app-server 连接，所以不在 `npm test` 里跑（会打真 `~/.codex`），只在 `npm run doctor` 里跑，`--skip-probe` 可以跳过。

**没探测就不出这一项，而不是出一个 ok**——后者是假绿。探测成功但不是 schema 问题时走 warn 而非静默通过，理由同上：静默当成通过等于这道检查不存在。

不变量 `ENV-02` 说的就是这件事：`~/.codex` 是全局共享的，库文件名自带版本后缀；同机器上的 Codex 桌面版一升级就把新迁移写进去，pin 住旧版的本项目再去读自己那版才有的表就会撞上。要求是「拿到这个错误之后能判断出下一步」，不是「去 spawn 真 codex 探测」——所以 `schemaVerdict` 是一个纯函数，输入是错误文本。

判据正则 `SCHEMA_MISMATCH` 来自 `public/js/session/thread-actions.js`，是[三个前后端共享模块](../architecture/module-boundaries.md)之一：运行时兜底与启动自检必须认同一个形态，否则 doctor 报绿而手机上弹 `no such table`。

### 探测通道的两个坑

`createProbeChannel` 用 `AppServerTransport` 而不是 `AppServerHost`。后者的职责是按 runtime 路由（`request(runtime, method, params)`），而探测没有 runtime——拿它当入口会写成 `host.request('thread/list', {…})`，参数错位成 `runtime='thread/list'`、`method={…}`，app-server 收到一个对象当方法名，**永远不回**。

握手懒到第一次 request 才做：构造即 spawn 的话，连 `--skip-probe` 都躲不掉那个子进程。

`src/agent/` 那一支用动态 import，这样即使它导入失败（缺依赖、语法错），其余十二项检查仍然能跑完——「因为一项探测挂了就什么都看不到」是最差的自检体验。

探测发的是 `thread/list` 且 `pageSize: 1`：只读、零额度。发 turn 那类会真的调用模型，与「日常回归不消耗额度」冲突。

## 指标：记了就要有出口

[src/ops/metrics.js](../../src/ops/metrics.js) 是纯内存的进程内指标：重启清零，不落盘，不主动上报。三张表分开且**不合并**：

- `counters` 答「发生过几次」（只增）
- `gauges` 答「最近一次是什么时候 / 当前是多少」（覆盖式）
- `labels` 答「是谁 / 为什么」（字符串）

`labels` 刻意不并进 `gauges`：塞字符串进去会让消费方拿到类型不一致的字段，而那种不一致要到序列化之后才显形。`getLabel` 缺省返回 `null` 而不是 `undefined`，因为 `undefined` 会被 `JSON.stringify` 整个吃掉，于是前端分不清「这件事没发生过」和「这个字段还没实现」。

没有上限、没有淘汰，安全性靠一条约束：**key 集合是编译期固定的常量串**。引入用户可控的 key（把路径或设备 id 拼进 key 名）就会变成内存泄漏面。

### OPS-01 的双向闭合

`inc()` 记下的计数器如果不在 `/metrics` 的输出映射里列一行，就永远不会出现在响应里，而且**没有任何报错**。症状是「这个指标一直是 0」——人会去查埋点为什么没触发，而真正的原因在另一头。

[test/invariants/metrics-contract.test.mjs](../../test/invariants/metrics-contract.test.mjs) 因此做双向断言：源码里每个 `metrics.inc('x')` / `gauge('x')` / `label('x')` 的**字面量**都要在 `KNOWN_METRICS` 与 `/metrics` 白名单里查得到；反向，登记了却没人再埋点的死条目也要红。

「必须是紧跟括号的字面量」（三元、模板串都扫不到）既是扫描判据，也正是那条内存安全约束。

`/metrics` 的 `rpc` 分项有一个需要留意的口径：它是**当前存活 runtime 的累计**，不是进程累计。空闲 runtime 被回收时它的计数一起消失。两个数不是一回事，别混着看。

`/health` 给的是极简状态：`status`、是否有 runtime 在忙、版本、时间戳。分层的连通性诊断在前端（见[前端外壳](../frontend/app-shell-and-rendering.md)的 `diagnoseHealth`）。

## 三种日志

| 日志 | 位置 | 轮转 | fsync |
|---|---|---|---|
| 安全审计 `security-audit.jsonl` | `data/` | 多代（默认 5 代） | 每条 |
| 宿主机配置审计 `host-config-audit.jsonl` | `data/` | 同上 | 每条 |
| RPC 日志 `.codex-chat-rpc.jsonl` | **工作区 cwd** | 单代（`.1`） | 不 fsync |

### 审计：多代轮转

`appendJsonlAuditRecord` 的轮转是多代的，代号越大越旧：先丢掉超出保留代数的那一代，再整体后移一位，最后把活动文件挪到 `.1`。只留一代的话保留窗口太短，而**审计里最有价值的往往是旧记录——入侵通常事后才发现**。

单条记录超过上限直接抛错，不写一条被截断的伪记录。

### RPC 日志：可观测数据，不是审计

它与审计的三处差别都有理由：

- **轮转前用 `fstatSync` 看已打开 fd 的真实大小**，不用本实例的计数器。默认路径是 `join(cwd, ...)`，同一个 cwd 上的多个 runtime 共写一个文件却各记各的账，谁先到上限谁就轮转，`rmSync(path.1)` 顺手删掉别人刚存下的那一代。用 fd 还避免了 TOCTOU。
- **轮转失败就放弃这一次，继续往当前文件追加**。否则文件仍然超限，下一帧再次尝试轮转、再次抛错，日志就此永久静默。
- **每帧显式 `O_CREAT 0600 | O_NOFOLLOW`，但不每条 fsync**。不 fsync 是因为流式回复的每个 delta 都是一帧，逐帧 fsync 会直接阻塞事件循环；每帧 `O_CREAT` 是因为日志文件可能在运行中消失（Codex agent 在自己的 cwd 里有 shell，`rm` / `git clean -xfd` 都会删它），裸 `appendFileSync` 会按 umask 的默认模式重建，把 RPC 流量暴露给同机其他用户。
- **`O_NOFOLLOW` 触发 `ELOOP` 时直接停用日志**：路径是符号链接说明有人把日志指向了别处，既不写穿过去、也不用每帧重试一次注定失败的 open。

日志内容本身的脱敏见[安全模型](security-model.md)。`CODEX_RPC_LOG=0` 可以整体关掉。

## 状态栏

`buildStatusLine` 组装 git 状态 + context 用量，经 `status_line` 事件推给前端，网关每 4 秒对每个已批准 socket 推一次。

git 状态有 5 秒 per-cwd 缓存**和单飞**。单飞不是优化：缓存写在 5 次 `await execGit` 之后，所以并发调用会全部 miss 并各自 spawn 5 个 git 子进程，多设备下放大成进程风暴。

context 用量的字段名从 `public/js/session/token-usage.js` 取，与浏览器共用同一份——上一版两边各写一遍，statusline 这侧漂到 snake_case 后静默显示了很久的 0。

## 相关测试

- [test/invariants/doctor.test.mjs](../../test/invariants/doctor.test.mjs) —— `ENV-02`，含「doctor 的握手参数与 `buildInitializeParams()` 逐字段相等」
- [test/invariants/metrics-contract.test.mjs](../../test/invariants/metrics-contract.test.mjs) —— `OPS-01`
- [test/unit/audit-log.test.mjs](../../test/unit/audit-log.test.mjs)、[test/unit/audit-vocabulary.test.mjs](../../test/unit/audit-vocabulary.test.mjs)
