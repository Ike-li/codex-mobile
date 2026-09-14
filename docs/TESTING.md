# 测试

本仓所有测试规则从两条硬约束推出：

1. **日常回归零模型额度** —— [AGENTS.md](../AGENTS.md) 的项目规则，由 `test/zero-quota-guard.test.mjs` 守（三道：mock 探测挂在 globalSetup、E2E 的 webServer 指向 mock 脚本、mock 脚本真把 `CODEX_BIN` 指向假二进制）。
2. **不产生第二份真相** —— 架构决定 A2，由 `test/zero-persistence-guard.test.mjs` 守。thread / turn / item / 配置 / 模型列表全部向 app-server 现问，落盘的例外只有设备表、审计与推送订阅三类，逐条写明理由。

**这份文档回答「怎么做」**：一条测试该写在哪一层、怎么知道自己没写出假绿、增删改功能时分别做什么。

规则都带锚点（日期 / 文件 / 数字），过程细节留在 git log 里。抽象原则会被「我这次是例外」绕过，带日期的事故不会。

---

## 0. 动手前的三个判断

### 判断一：这条测试进哪个槽

| 槽 | 住哪 | 跑什么 | 命令 |
|---|---|---|---|
| **G** 静态门禁 | `scripts/gates/` | 读源码与配置文本，零 IO | `npm run lint`、`npm run protocol:check` |
| **U** 纯函数单测 | `test/*.test.mjs` | import 真模块，不碰磁盘 | `npm test` |
| **I** 带 IO 的单测 | `test/*.test.mjs`（同一条命令） | `mkdtemp` 真磁盘 / spawn 子进程 / 起 server | `npm test` |
| **E** 浏览器行为 | `e2e/*.spec.js` | Playwright + mock 后端 | `npm run test:e2e` |
| **M** 变异 | 只在容器 | 改坏源码，看断言开不开口 | `npm run mutate:docker` |
| **S** 真 Codex 冒烟 | `scripts/smoke-*.js` | 真 CLI，烧额度 | 手敲，需授权 |

按顺序问，第一个「是」就停：

1. **判据能从源码静态看穿吗？** → G。接线、白名单、契约形状、「允许什么」这类都属于这里，而且**能被静态看穿的东西通常单测也能覆盖**，别升到 E。
2. **能抽成纯函数吗？** → U。抽不出来时先问「为什么抽不出来」——`public/js/app.js` 约 4000 行装在一个 IIFE 里，里面的东西一个都导不出来，是本仓最大的测试债（见第 5 节）。`public/js/` 下那 37 个模块就是历次「抽出来」的产物。
3. **判据是「用户点得到 / 读得懂」吗？** → E。
4. 其余 → I。

**不新增槽。** 不要建 `security/` `reliability/` `performance/` 这类顶层类别——那些是「会怎么伤人」的问法，填进第 4 节那张表，不是新目录。门禁例外：它们必须住在 `scripts/gates/`，因为 `test/gate-wiring.test.mjs` 的判据就是「这个目录里放的都是门禁」。混在 `scripts/` 里时白名单要列 12 条例外，而「新增一个 mock 脚本要记得加一条例外」又回到了靠记性。

### 判断二：观察点在哪一层

同一个缺陷可以在三层观察，成本差一个数量级，**而它们抓到的东西并不相同**：

- **源码文本**（`readFileSync` + 正则）—— 只证明「代码写了」，不证明「功能能用」。见第 5 节：`test/public-ui.test.mjs` 曾用 1807 行做这件事，删掉后覆盖率一点没掉（91.30 → 91.33），因为它从不 `import`，对被测代码的执行覆盖始终是 0。**不要再往回加这一层**，唯一的合法用法是结构性绊线（`test/public-shell-guard.test.mjs`：无内联 script、不裸调 `randomUUID`、不用 `Math.random` 生成凭证）——那些是「越过边界就红」，不是「复述实现长什么样」。
- **单元 / 契约**（真 import）—— 默认落点。
- **浏览器行为**（真 `click`、真 `toBeVisible`）—— 判据是可达性与可读性。

选最低的那一层，但要确认它真的看得见你要守的东西。`test/ui-preferences.test.mjs` 是反向例子：MCP 启动状态的静默判定抽成纯函数放在 U，**因为 mock app-server 不发 `mcpServer/startupStatus/updated`，这条路径在 E 里根本走不到**，只靠 E2E 的话它会一直是零覆盖。

### 判断三：失败方向是哪一侧

**本仓的 fail-closed 是逐条选过的，不是「所有异常都该拒绝」。** 按后者写会把下面这些测反：

| 场景 | 正确方向 | 为什么 |
|---|---|---|
| 读不到 `node --test` 的汇总行 | **失败** | 报告格式变了而我们读不懂时，沉默放行等于把这道门拆了 |
| MCP 报了一个未知的启动状态 | **照报，归告警侧** | 上游随时会加新状态值。「不是已知失败词就静默」会漏真故障，「一律报」最多多一条消息——两种错法代价不对称，选代价小的那边 |
| MCP 正常的 starting / ready 刷屏 | **静默** | 实测一次对话 8 条系统消息（4 server × 2 态），把回答挤出首屏。但静默只针对噪音：`error` 非空或状态是 `failed`/`error`/`crashed` 时不受偏好开关影响 |
| devDependencies 有高危漏洞 | **不阻断** | 不上生产。但报告必须留成 artifact，否则等于没跑 |
| 运行时依赖有高危漏洞 | **阻断** | 传输层就是 socket.io，直接暴露在网络边界上 |

写新测试前先回答：这条路径失败时，产品**应该**拒绝还是放行？答案不总是拒绝。

**噪音与告警不共用一个开关**，这是上表第 2、3 行的一般形式：把告警连同噪音一起关掉，用户就再也不知道某个 MCP 起不来了，那比刷屏严重得多。

---

## 1. 跑在哪：宿主机与容器

当前形态：**lint / protocol:check / `npm test` / test:e2e 在宿主机，变异只在容器**（[docker/docker-compose.test.yml](../docker/docker-compose.test.yml) 的两个 service：`test` 源码读写挂载，`mutate` 源码**只读**挂载 + 容器内复制到可写层）。

**变异无例外进容器。** [scripts/mutate.js](../scripts/mutate.js) 有硬闸，没有 `CCM_IN_CONTAINER` 直接拒绝。理由不是谨慎：变异会故意改坏源码，而**改坏的可能恰恰是算路径或算删除目标的那段代码**。姊妹项目就是这么删掉过一整棵 `~/.claude/projects`（70 个项目 / 2990 transcript）——`getProjectDir` 被改成恒返回 `''`，`join(真实根, '')` 塌成真实根本身，测试的 `rmSync` 打了上去。真正挡住它的是 [docker/Dockerfile.test](../docker/Dockerfile.test) 里那行 `ENV HOME=/home/ccm-test`，**不依赖任何代码正确性**；`mutate.js` 自带的恢复逻辑挡不住——容器被 kill 或变异中断时它根本不会执行。

这是白名单不是黑名单。黑名单要求「每遇到一个新命令都正确归类」，而那正是会失败的一步；白名单反过来，判断错了顶多多跑一次容器，代价不对称地小。

> ⚠ **`npm test` 目前在宿主机上跑，而它没有全局落盘隔离。**
>
> `server.js:87` 的 `DATA_DIR = process.env.CODEX_DATA_DIR || join(HERE, 'data')` 是模块级常量、import 时求值，`devices.js:10` 的 `DEFAULT_DATA_DIR` 同样。而 `npm test` 的命令行里没有 `--import` 预加载，79 个测试文件里**只有 7 个设了 `CODEX_DATA_DIR`**。也就是说隔离靠每个文件自己记得，而「记得」正是会漏的那一步。仓库根的 `data/` 里现在躺着真实的 `trusted-devices.json`、`pending-devices.json` 与 `security-audit.jsonl`。
>
> 修法（姊妹项目 2026-09-11 做过）：把隔离下沉成一次预加载，`node --import ./test/setup/preload-env.mjs`，在里面**目录级**兜底把 `CODEX_DATA_DIR` 指向一次性目录。必须是目录级而不是逐个文件点名——后者在新增落盘文件时会静默漏掉（那边曾只点名 6 个文件，`sessions.json`、`uploads/` 等 9 项全裸）。
>
> 在那之前：**任何 import `server.js` / `devices.js` / `audit-log.js` 的新测试，第一行就设 `CODEX_DATA_DIR`。**

**什么时候该把一条测试挪进容器**：它会写 `HOME` 下的路径、会递归删目录、或者它验证的正是「算路径的那段代码」。

---

## 2. 必跑门禁

```bash
npm run lint            # eslint .
npm run protocol:check  # 协议三层，要求本机 codex 版本 == .codex-version
npm test                # 79 个文件，--test-concurrency=1，经 check-test-summary 包装
npm run test:e2e        # Playwright，mock 后端
```

一条抵四条：**`npm run test:ci`**（lint → protocol:check → `npm test` → check-coverage-delta → test:e2e）。

**不在链里的门禁等于不存在。** [test/gate-wiring.test.mjs](../test/gate-wiring.test.mjs) 守这一条：`scripts/gates/` 下每个文件要么出现在**展开后**的 `test:ci` 里（要展开，`check-test-summary.js` 就是通过 `npm test` 间接接线的），要么在 `NOT_IN_CHECK` 里写明为什么不接。默认值落在「新门禁必须接线」那一侧，不依赖谁记得补一条断言。

其余命令，知道它们存在即可：

| 命令 | 用途 |
|---|---|
| `npm run test:local` | `--test-isolation=none`，开发时快速跑；**不经 check-test-summary 包装**，不能用它判断门禁是否通过 |
| `npm run coverage` | c8 插桩全量，产出 `coverage/` |
| `npm run test:docker` | 在容器里跑 `npm test` |
| `npm run mutate:docker -- <生产文件>` | 变异，见第 3 节 |
| `npm run doctor` | 启动自检 |

### `protocol:check` 查三层

版本不匹配就是失败，不能跳过后宣称门禁通过。三层是：

1. **上游漂移** —— `.protocol/stable/` 与现场生成的输出全文比对，字段增删改都报。
2. **方法覆盖** —— 我们调用的方法必须存在于协议。
3. **通知字段用法** —— `handleNotification` 读的每个 `params.X` 必须在该通知的 params 类型里声明。

第三层补的洞是：方法名对得上不代表字段对得上。上游把字段改个名，我们读到的是 `undefined`——不抛异常、没有失败用例，功能静默失效，**而单元测试用的是我们自己写的、同样假设错误的 fixture，两层一起说谎**。有意保留的兼容回退写进 `LEGACY_FIELD_ALLOWLIST` 并注明理由，不要只留在源码的 `??` 里让人猜。

协议门禁必须在 `test:ci` 内，否则枚举值一类的漂移能直接合入——`on-failure` 审批档就是这么进来的。

### `npm test` 被包装过：cancelled / skipped 也会红

`node --test` 把 cancelled 和 skipped 与 fail **分开计数，而退出码不一定反映它们**。于是一次「fail 0」的运行可能实际上有整片用例根本没跑——症状是全绿，是最贵的失败模式。

[scripts/gates/check-test-summary.js](../scripts/gates/check-test-summary.js) 就是这道防线。它解析不到汇总行时也判失败（fail-closed）。

锚点：`app-server-transport.test.mjs` 的 4 个用例曾在**每一次**运行里被标记 cancelled——不是间歇，是确定性的。请求超时定时器在生产代码里是 unref 的（服务器有 HTTP listener 吊着事件循环，线上无影响），测试等它时事件循环已排空，`node --test` 判定「promise 仍挂起而事件循环已结束」，把该用例连同其后三个一并取消。汇总显示 `fail 0`，超时、子进程退出、子进程错误和 dispose 四条错误路径因此长期未被验证。**看到 `cancelled` 不为 0 时不要放过——那是没跑，不是跑过了。**

### CI 上额外要盯的

[.github/workflows/test.yml](../.github/workflows/test.yml) 里两条来自真实事故的配置，改它之前先读注释：

- **`fail-fast: false` 不能删。** lint / protocol:check / 覆盖率 / E2E 只在 Node 20 那条腿上跑，默认的 fail-fast 会让 Node 22 的任何抖动顺手取消 Node 20——红叉背后是所有真门禁一条没跑。
- **`playwright install` 的 `--with-deps` 不能省。** runner 镜像自带 chromium 要的系统库，但没有 webkit 要的 libgtk-4 / libgraphene / libevent / libopus / libgst\*。缺它们时浏览器二进制装得上、启动即失败，每条用例 3-4ms 就红——**看起来像用例写坏了，其实一次都没跑起来**。webkit 自加进矩阵后整条腿从未真正执行过，而这一直被前面单测的红挡着，直到 2026-09-13 才显形。

> **一般化：红会挡住红。** CI 变红时先数 steps 里有多少 skipped——第一道门禁红之后，它后面所有步骤都不会跑，而界面上「有覆盖」的印象照旧。

---

## 3. 假绿：怎么知道自己写的测试在守东西

这一节是本文档的核心。**看着漂亮却永不变红的测试比没有更坏**——它占着「这里测过了」的位置。

### 两侧验收：绿的一侧不算验证

一条测试要同时满足：**正常代码下绿**，**注入对应缺陷后红**。只做前者的话，「断言咬住了行为」和「断言什么都没咬住」在输出上完全一样。

做法就是手改源码跑一次再改回来，不需要工具。三个要点：

- **注入的必须是这条断言声称能抓的那个缺陷。** 文件头写的和文件里有的是两回事，而没人会去核对文件头。
- **断言顺序决定注入能验到哪一条。** 2026-09-13 实测：为了验像素断言而让 `can-scroll-left` 无条件挂上，结果红在**前面那条** `not.toHaveClass` 上，像素断言根本没跑到——那次注入没验到想验的那条。
- **修一个假红最容易掉进去的坑，是把它改成假绿。** 反向断言（「不该有 X 时应当没有 X」）必须单独验一次鉴别力：构造一个「不该有却真的有」的状态，确认它会红，否则你无法区分「判据正确」和「判据恒 false」。

### 变异检查：把两侧验收自动化

```bash
npm run mutate:docker -- <生产文件>
```

改坏一行源码，看断言会不会开口。**存活的变异 = 那条断言没咬住行为。**

唯一可靠的假绿判据是变异，不是阅读——本仓已知的两处假绿（`public-ui.test.mjs` 的 683 条源码文本断言、`app-server-transport` 那 4 个每次都被 cancelled 却显示 fail 0 的用例）全都躲得过人眼审查。

### 变异抓不到的三类

变异改的是**我们自己的源码**，所以下面三类它全免疫，只能靠人想到：

1. **fixture 编错外部契约。** mock 与被测代码一起偏离真实协议，两边自洽，没有任何一侧会红。`protocol:check` 的第三层就是为这个存在的。
2. **扫描面塌了。** 凡是「遍历一遍然后说没问题」的脚本，扫到 0 个和全部合规在输出上无法区分。2026-09-08 实测：把 params 类型声明从 `export type X = {` 换成 `export interface X {`，71 个类型的字段一个都读不出，而 `protocol:check` 照样打印 `Notification field usage: OK` 并返回退出码 0。**这类脚本都该有一行「扫到的数量 > 0」断言。**
3. **门禁根本没被执行。** 见第 2 节的 `gate-wiring`，以及第 6 节覆盖率那个滑走 11pp 的例子。

### 反复出现的假绿形态

- **给既有代码补的测试默认空过** —— 它是照着现有实现写的，实现错了它跟着错。补完必须注入验红。
- **fixture 停在已经迁移走的格式** —— 2026-09-13 实测：`node scripts/device.js list` 把受信任设备打成 `ID: [object Object]`，而**已经有一条 spawnSync 跑它的用例，一直是绿的**。因为 fixture 写的是 `JSON.stringify([deviceToken])`——旧的字符串数组，那个形态下 `${entry}` 恰好打印出 token。条目在 R-SEC-1 时已改成对象，这条用例于是守着一个现实中不再产生的形态。**改数据格式时要连带审一遍所有硬编码该格式的 fixture。**
- **弱断言只咬住了不想要的那一个特例** —— 「显示文本 ≠ 完整 threadId」在显示 `mock_thr` 时照样通过，功能没达到目的而断言全绿。判据要咬住**想要的结果**。
- **测试里出现一份和生产代码平行的清单** —— 那是在复述数据而不是验证行为。审批档、沙箱档、图标名都曾各自被抄成字面量清单，协议删掉 `on-failure` 时三处同时说谎。正确形态是**从唯一来源派生**：可达性用例的名单现在从 `#drawer-tools button` 派生，新加一个工具自动被守住。
- **用 `dispatchEvent` 代替 `click`** —— 它把事件直接派发到元素上，绕过 Playwright 的可见性检查。`e2e/native-controls.spec.js` 曾这样点工具按钮，于是 `drawer-tools` 整块带着 `hidden` 的那段时间里 Files / Account / 诊断 / 设备全部对用户不可达，而 E2E 一直是绿的。
- **「HTML 里有这个 id」不等于「用户点得到」** —— 单测断言元素存在、E2E 用绕过可见性的方式点击，两层都在验证存在性，没有一层验证可达性。新增功能如果只有一个入口，必须有一条 `toBeVisible` 守着那个入口。
- **传了一个不存在的参数** —— 调用处传的 `confirmText: '允许完全访问'` 从来没被 `open()` 读过，按钮文字一直是泛化的「确定」。**静默失效，没有任何东西会报错。**
- **CSS 里「写了」和「生效了」之间隔着特异性** —— `.code-block-wrap > pre` 的 (0,1,1) 打不过 `.codex .bubble.md pre` 的 `padding` 简写 (0,3,1)，那条 `padding-top: 2rem` 实测始终是 10px、从来没生效。同特异性时**源码顺序**决定胜负：`.tool-note` 写在 `.tool-cmd` 前面，`font-family: inherit` 整个失效。这个坑在本仓栽过三次（第三次是 `.native-danger` 被后定义的 `.settings-action-btn` 覆盖，「宿主配置」和普通按钮长得一模一样）。**CSS 不会为此报任何错**，要绊线守。
- **测试留下未处理的副作用，污染后面的 spec** —— 整轮 E2E 共享一个 mock server 进程（`fullyParallel: false`, `workers: 1`），挂着不管的审批会堆进「需要你」，`needs-you-recovery` 因此在全量跑里稳定变红、单独跑却是绿的。**审批类用例必须就地 deny 掉。**
- **给机器读的数据放在给人看的位置** —— `needs-you-recovery.spec.js` 曾从元素的**显示文本**里读 threadId 去构造深链，于是「对用户友好」和「测试稳定」直接冲突。解法是加 `data-thread-id`：机器读属性、人读文本，两者各自演化。

---

## 4. 增 / 改 / 删功能时做什么

### 加功能

列一张表，行是「这个功能会怎么伤人」，列是槽。不适用的格子写「—」和原因。

**例：结构化附件输入**

| 会怎么伤人 | 槽 |
|---|---|
| 附件类型判错、10/20 MiB 业务限制前后端不一致 | U（`input-parts` / `user-inputs`） |
| 真写盘、0700 目录 / 0600 文件、越界文件名 | I（`file-security`） |
| 32 MiB wire cap、>1 MiB 真穿一次 socket | I（集成） |
| 远程图片 URL 打到内网（SSRF） | U（完整 IPv4/IPv6 DNS 拒绝路径）+ 默认关闭的门控 |
| 用户选了文件却看不到反馈 | E |
| Codex 真的读到了附件 | S（授权后） |

完成判据：

- 该红的格子有一条**外部可观察**的断言（用户看得见的行为、公开契约、失败方向），不是私有方法名。
- 更便宜的槽能抓住的，**没有升到 E / S**。
- 路径 / 删除 / 鉴权相关的，至少对改动文件跑过一次变异。

### 改行为

**先改断言，再改实现。** 反过来做的话，你是在让测试追认实现，而不是让测试约束实现。

### 改数据格式

连带审一遍所有硬编码该格式的 fixture（见第 3 节 `device.js` 那条）。分工可以照抄那次：端到端用例改用**真实**格式，旧格式的向后兼容由纯函数层单独覆盖——两种形态都测得到，而且不需要准备数据文件和子进程。

顺带一条：CLI 要能被 `import` 才测得了格式化逻辑，照 `scripts/doctor.js` 的形态加入口守卫（`process.argv[1].endsWith('device.js')`），否则测试 import 会顺带执行一遍 switch。

### 搬家：入口换了位置时，可达性覆盖必须跟着搬

2026-09-13 把账号 / 主机状态 7 个入口从抽屉收进「设置与状态」sheet 时，`native-controls.spec.js` 那条「名单从 DOM 派生」的用例只扫 `#drawer-tools`——照原样留着的话它**照样是绿的**，而搬走的 7 个入口从此一个都没有覆盖。

改法是扫两处并断言**总数**（`inDrawer + inSettings >= 11`）。只断言各自「有按钮」的话，搬家途中漏掉一个不会有任何东西变红。E2E 的点击 helper 同样跟着走：判据是「抽屉里看不见就往下一层找」，不在 helper 里硬编码哪几个按钮搬了家。

### 删功能 / 退役测试

删测试比删生产代码更需要证据——**生产代码删错了会有测试红，测试删错了什么都不会红**。流程：

1. 逐条读旧测试的独占断言，为每一条构造对应缺陷，看新测试会不会红。
2. 真独占的能力先搬进新文件，每条搬入的断言各自过一遍两侧验收。
3. 删除后核对数字：test 总数的减少量必须**正好等于**被删文件的 test 数，对不上说明有附带影响。
4. 在新文件头写清**哪些没搬、为什么**，否则下一个人会以为是漏了。

### 交付前：把验证过程写进 commit

**没有留痕位置的规则，只约束得住诚实的人。** 写「已做双向验收」零成本；写「注入 X 到 `file:line` → 精确红 1 条，消息是 Y」写不出来就是没做。`Tested:` / `Not-tested:` trailer 按后者的标准写，有未验证项时 `Not-tested:` 必须写，不能省。

照这个粒度：

```
Tested: 把 .can-scroll-right 选择器改成不匹配的名字 → 横滑提示两条（含深色）同时红
Tested: 把 can-scroll-right 改成双侧渐变 → 「最左端不应出现左侧假信号」红，证明反向断言有鉴别力
Not-tested: webkit 未跑——本次只动了 server 侧分支，与浏览器引擎无关
```

---

## 5. UI 层：把「一眼看上去不对」变成断言

### 「不会崩」和「读得了」是两个维度

2026-09-12 实测：宽表格用例四条断言全绿（单元格 `word-break` 已复位、`scrollWidth > clientWidth`、`overflow-x: auto`、`#messages` 没被撑破），而同一张表的「说明」列被压到 **49px 宽**——减掉 padding 只剩两个汉字，21 个字的中文排成一根竖条，把整行撑到 286px。

四条断言问的全是**会不会崩**，没有一条问**读不读得了**。这两个维度的交集比直觉小得多，用户能一眼看出的缺陷可以完整地躲在结构性契约的盲区里。

（根因也值得记：`display: block` 让 `<table>` 一个元素同时当滚动容器和表格，`max-width: 100%` 夹住的是**内部表格算法的可用宽度**。表格不知道外面能滚，于是在 361px 里硬分 4 列，不可断行的 ASCII 路径 min-content 很大、抢光空间，而 CJK 的 min-content 是一个字，中文列被饿死。拆成 `.table-scroll` + `table` 两个元素后各管各的。）

### 为什么不是 pixel diff

[e2e/lib/layout-audit.js](../e2e/lib/layout-audit.js) 的判据是**绝对的**（多窄算窄、多挤算挤），不是截图对比。

截图对比只能发现「和上次不一样」，发现不了「从第一天起就是错的」。上面那张表如果当时做了基线快照，49px 会被固化成「正确的样子」，**修好了反而变红**。

体检现在只挂在 [e2e/layout-sanity.spec.js](../e2e/layout-sanity.spec.js) 一处，扫的是富文本气泡（`.msg.codex .bubble.md`）。

> ⚠ **覆盖面就是这一块，别按「四条规则在守着整个界面」理解。**
>
> 2026-09-14 之前，体检还挂在 `ui-shots.spec.js` 的 `shotArea()` 里。那个文件把界面驱动到 29 个状态、顺带对 32 个区域各跑一次 `auditLayout`——顶栏、抽屉、设置面板、审批卡、输入区、深色模式都在内。下面那些「实测抓出 35 处 10-11px 的汉字」「抓出三处触控目标过小」的数字，全是那 32 个区域的产出。
>
> 它随 `docs/UI_SURFACE.md` 与 `docs/assets/ui/` 一起退役了：截图的消费方没了，文件只剩体检这一半，于是整个删掉。**代价是覆盖面从 32 个区域收缩到 1 个**——新写一个设置面板、把某个按钮的字号改到 10px，现在没有任何东西会红。
>
> 要补回来不需要截图：在 `layout-sanity.spec.js` 里加用例，每条把界面驱动到一个状态，然后对那块区域调一次 `auditLayout(page, sel)` 并断言 `issues` 为空。成本主要在「驱动到那个状态」的那几行，体检本身是一行。

### 四条规则，各有明确边界

| 规则 | 卡什么 | 边界 |
|---|---|---|
| `squeezed-text` | 文本被挤成竖条 | 宽度 < 140px、字符数 ≥ 4 才判；宽元素即使很高也只是长段落 |
| `occluded-text` | 浮层压住正文 | **从遮挡物出发**，不是从正文出发 |
| `clipped-text` | 内容被裁掉 | **豁免横向 ellipsis**，纵向不豁免 |
| `tap-target-too-small` | 触控目标 < 44×44 | **只对高风险操作**生效 |
| `cjk-font-too-small` | 汉字 < 12px | **只卡含汉字的文本**，不是禁止小字号 |

每条边界背后都是一次「差点让规则被整条忽略」：

- **遮挡检测必须从遮挡物出发。** 第一版反着做：对每个文本元素按 0.25/0.5/0.75 采样去撞遮挡物，一条都报不出来——代码块的 `<code>` 是 inline，rect 是所有行的并集（实测 527px 宽），三个采样点落在 x=159/291/423，正好跳过 32px 宽的复制按钮。换成从浮层出发、用 `elementsFromPoint` 看自己压着谁：浮层数量少、尺寸小，采样密度天然够。这个方向还顺带给出了「什么算遮挡物」的准确定义——只有 `absolute/fixed/sticky` 能浮在别人上面，普通流元素根本不进候选，之前为它们写的两条豁免连同判据一起删掉了。
- **`clipped-text` 豁免横向 ellipsis**：省略号是明确的「后面还有」信号，报它等于禁用一个合法设计手段。纵向不豁免——`line-clamp` 整行整行吃内容，用户只在最后一行末尾看到一个省略号，损失量级完全不同（实测吃掉过「只有 ls、cat 等信任命令自动执行；其余一律询问」的半句）。代价是「截断方向错了」这类问题（路径 `/private/var/folders/b4/_t4qmr…`）它抓不到，那需要判断哪一头的信息更重要，是语义不是几何。
- **`tap-target-too-small` 只守高风险操作**：实测抽屉一屏 26 个可点击元素里 **22 个低于 44×44**，模式是全局按钮高度就是 28px——那是产品的视觉密度选择，不是 bug。判据从**语义标记**派生（`.native-danger`、`[data-danger="true"]`、`.approve-btn`、`.deny-btn`），不列举具体元素：新增一个危险按钮只要带上标记就自动被守住。
- **`cjk-font-too-small` 只卡汉字**：同样 10px，`26ms` 认得出，「延迟」认不出。汉字笔画密度远高于拉丁字母，一撇一捺在那个尺寸下不足半个像素；拉丁字母只有 26 个字形，靠轮廓就能辨认。一刀切会把 token 计数、延迟毫秒这类纯数字标签全报掉。下限 12px 的依据是 Material caption 12sp / iOS HIG 11pt。

### 写新规则时的三条元规则

1. **门禁死于误报比死于漏报更常见。** 一条规则如果在正常代码上报出一片，它会被整条忽略、然后被删掉。上面四条边界全部服务于这一点。
2. **扫描面塌陷的判据不能是「scanned 必须 > 0」。** 纯图标区域本来就没有文本叶子，拿 >0 当判据会让每个新增的无字区域莫名变红。真正的失明是**有文本却一个都没扫到**，判据是 `root.textContent` 非空而 `scanned === 0`。
3. **为误报写豁免之前，先确认判据本身没问反问题。** 换成从浮层出发之后，两条豁免连同它们要修的问题一起消失了。**补丁要随它修的方案一起删**——那两条留着反而有害：祖先可视区检查把表格里滚动可见的单元格全跳过了，扫描面反而变窄。

豁免清单 `OVERLAY_ALLOWLIST` **要求写明理由**（≥40 字，由用例守着）：默认值落在「遮挡就是缺陷」那一侧。目前两条——`#jump-to-latest`（它显示的前提就是用户没滚到底部，给 `#messages` 加 `padding-bottom` 和这个遮挡在不同的坐标系里，实测无效）与 `#slash-popup`（敲 `/` 那一刻的任务就是挑命令，被盖住的内容不属于当前任务；不遮挡的做法是推挤布局，那会让每敲一个字符界面上下跳动）。

### 几何断言的三个坑

1. **`clientWidth` / `clientHeight` 对 inline 元素恒为 0。** 拿它当「视觉隐藏」门槛，会把 `<code>` / `<span>` / `<a>` 里的文字整类排除——连复制按钮压正文这个真缺陷一起压没了。判尺寸要用 `getBoundingClientRect`。
2. **`getBoundingClientRect` 与「是否被祖先裁剪」无关。** 滚出容器的元素照样有合法坐标，拿它做命中测试问到的是「那个坐标上现在是谁」。
3. **几何断言要钉在改动的直接结果上。** 「每行能显示几列」受字体渲染影响，实测 chromium 50 列、webkit 48 列（Menlo 字符更宽），钉死 50 会让 webkit 恒红而那不是缺陷。改成守「不退回改动前的 46 列」。

另外**测量前要先让页面进入可测状态**：`.msg` 带 `content-visibility: auto`，视口外的子树跳过渲染、量出来是 0；折叠层要先摊开；而且**必须等本轮产物真的出现**——只等 `#state-label` 变 idle 不够，发送后它还没转成 busy 时断言就立即通过了，测量会跑在一个空页面上（实测一个元素都扫不到，用例平凡地失败在可见性而不是宽度上）。判据要落在「用时 N 秒」那条分隔线，或最后一张卡真正出现上。

### 像素断言：对照态要选对

「可发现性」这类问题几何体检抓不到（它说不出「像不像提示」），只能用像素——把边缘 20×28 截下来，和取消提示后再拍的一张对比，两张必须不一样。

**对照态是「换成全不透明的 mask」，不是「清掉 mask」。** 第一版写 `el.style.maskImage = 'none'`，元素退出离屏合成、文字从灰度抗锯齿切回子像素抗锯齿，于是**任何含文字的区域两张都不一样**：最左端本来就没有左侧渐隐，却报出 667/727 字节不同、maxDelta 254；而同一方法在无文字的边缘 `diffBytes` 是 0——「差异来自文字重绘」的指纹就在这里。正向断言照样绿，**只有反向断言系统性假红**。换成全不透明 mask 后两张都带着合成层，唯一变量才真的只剩渐隐与否。

### 排版体系：`typography-system.spec.js`

**字体栈必须显式覆盖 CJK。** 判据落在**声明**上而不是实际渲染，因为浏览器不暴露「这个字形来自哪个 family」。可用的间接手段是比较中文串在当前栈与 `sans-serif` 下的测量宽度，但在开发机（macOS）两者都解析到 PingFang SC，宽度恒等——那个判据在这里测不出任何东西。而这条要防的后果恰恰发生在跑不到的平台上（Android 落到 Roboto、Windows 落到 Segoe UI，都没有 CJK 字形）。**限制要说清楚**：它保证「我们声明了」，不保证「目标设备上装了」。

位置判据里，通用兜底只算 `sans-serif` / `serif`，**不算 `system-ui`**。字体 fallback 是逐字形的：`system-ui` 在 Android 上解析到 Roboto，中文照样继续往后找。第一版把它算成兜底，于是把一个正确的栈判成了红。

**相邻标题级别必须真的分得出来**：判据不是「h1 比 h2 大」（0.5px 也算大），而是**字号比 ≥1.15 或字重差 ≥50，二选一**。中文是等宽方块字，没有 x-height 和升降部可以参照尺寸，h1 19.5px / h2 17.25px（差 13%）在深色截图上看着一模一样；字重是第二个维度，拉开它同样解决问题。

**行距判据是绝对增量，不是比值**（`calc(font-size + 6px)`）。倍数行高在字号变化时行距等比放大，大字号被推散、小字号又挤。改这条时撞上一个反直觉的地方：**比值会随字号反向变化**——6px 在小字号里占比更大，于是用户气泡（16→22px，1.375）反而高于助手正文（17→23px，1.353）。原来那条「紧凑气泡的行高比应低于长文阅读态」在新公式下**恒假**，它不是回归，是判据本身过期了。

**字号 scale 的抬升是连锁的，不是逐点修。** 原 scale 是 8/10/11/12/13/14/15/16px，8 个档挤在 8px 区间内——`--font-xs` 从 11 抬到 13 就超过了 `--font-sm` 的 12，命名与值倒挂，必须一路推上去。两个例外档都是「拉丁内容不吃这个下限」的直接后果：`--font-terminal: 11px`（终端输出的可读性取决于**一行放得下多少列**，抬到 13px 让 393px 视口从 46 列掉到 42 列，对齐结构被多折的行毁掉）、`#header-project` 留 12px（顶栏 393px 塞着五个元素，抬到 14px 把项目名从 14 字符压到 11）。

**踩的坑：`.tool-cmd` 看着像纯命令，其实不是。** 第一版把它划进终端档，`cjk-font-too-small` 立刻在文件变更卡（「新增: src/example.js」）和 Raw 卡上报了回来——后者是协议原样回传的 JSON，字段值里有中文是常态。Raw 卡因此单独拆出 `.tool-json`：**JSON 的可读性靠缩进层级，不靠列数**。规则比划分更早发现了划分是错的。

同源的一条：**自然语言不要套用代码样式**。计划步骤曾用 `.tool-cmd`、搜索摘要借 `.tool-output` 再用内联 style 逐个盖掉背景/颜色/padding（只为拿字号）。除字体外还带来 `word-break: break-all`——对路径必需，对句子会把英文单词从中间劈开。新增 `.tool-note` 承载「卡片里给人读的句子」。（原判断「等宽字体 13 处声明，用得过宽」是**错的方向**：实测消息流里只有两个类在用，而且这个字体栈不覆盖中文——纯中文元素设等宽视觉上没区别。问题不是用得多，是两处语义误用，修法完全不同。）

### 消息流的视觉语言：左边框是唯一的语义编码位

卡片按「用户需要做什么」分四档（`data-card`），不按技术类型分：`decision`（审批/提问）、`outcome`（结果/计划/变更摘要）、`action`（命令/MCP/搜索/文件变更）、`meta`（reasoning/Raw）。

**`action` 和 `meta` 不再有色带**——工具活动压成了一行灰字的活动行（`.activity-row`），整个过程层统一无边框无底色，目的是把视觉权重让给最终回复。给某一类活动行单独描个边，等于把刚降下去的权重又提回来。四档仍然全员保留，因为它编码的是**语义而不只是颜色**：活动行照样要标 `action` / `meta`，漏标一样红。

**整圈边框只做轮廓，类型和状态都编码在左边那一条。** 此前命令卡用整圈变绿表示成功，而成功是常态、不该被高亮，结果是滚动时满屏绿框、真正要注意的反而不突出。现在只有 `data-ok="false"` 把左边框变红——需要在滚动中一眼找到的是失败。

绊线在 `layout-sanity.spec.js` 三条：每张 `.tool-card` 必须有 `data-card`（**含活动行**）；带边框的各档左边框色**两两不同**；`.activity-row` 的左边框宽度必须是 0。只断言「属性值不同」不够——CSS 没写时属性齐全而颜色全一样，那正是第二条要防的状态，实测第一版就是这么红的。

**探针说不出的事，只有看实物能判。** `meta` 档色带在深色下完全不可见（`--border-light: #262626` 对卡片底 `#1c1c1c` 只差 10 个灰度单位）。探针只会报「对比度 1.13，太淡了」，而看到实物才判得出这可以接受：用户不需要知道「这是 meta 档」，只需要知道「这个可以跳过」，没有色带恰好传达了「没什么特别的」。

这类「探针报了、但实际可接受」的判断，现在只能手动开页面看——截图机制已随 `ui-shots.spec.js` 退役。所以**对比度类的探针不要直接写成断言**，写成断言就等于把「可接受」这个判断交给了一个做不出这个判断的东西。

---

## 6. 覆盖率门禁：它守什么，不守什么

基线在 `.coverage-baseline.json`（当前 **91.27 / 80.12 / 95.09 / 91.27**），门禁是**相对基线跌幅 ≤2pp**，由 `scripts/gates/check-coverage-delta.js` 执行。排除项在 [.c8rc.json](../.c8rc.json)——`public/vendor/**` 是第三方压缩代码，不该计进我们的覆盖率。

**这道门禁的价值不在数字，在于它真的会跑。** 2026-09-01 之前它挂在 `pull_request` 上，而 CI 矩阵默认的 fail-fast 又让 Node 22 的抖动连坐取消 Node 20 那条腿——**结构上从来没跑成过**，于是分支覆盖在 80 个提交里从 87.88 掉到 76.89 而没有任何东西变红。现在它挂在 push 路径上（fast-forward 合并走的正是 push，只在 PR 上跑等于给自己留后门）。

**不要用碎测试去凑数字。** 分支覆盖离历史高点还差约 8pp，回到 87.88% 需再覆盖约 354 条分支，其中 `server.js` 占 296 条、`agent-appserver.js` 占 122 条——**两个文件就超过了缺口总量**，其余所有文件加起来才 471 条。这 8pp 实质是一项针对两个最大模块（3055 行 / 2000 行）错误路径的独立工作，不是清理。当年的 87.88 是在这两个文件还小得多的时候定的。

**别提议加绝对覆盖率门槛。** 退化门禁已经包含绝对阈值（80/60/80/80），后者是它的真子集。覆盖率是一个容易被凑、且凑了不产生保护的指标——第 3 节那 1807 行源码文本断言删掉后覆盖率只动了 0.03pp，它连这个最宽松的指标都没骗到，只骗过了人。

---

## 7. 当前自动化覆盖

- **共享 app-server**：Transport 单进程/单 request-id 空间、Host single-flight initialize、多 runtime 交错通知、ThreadRegistry 对 thread/turn/request 的一致性校验、无法路由的 server request fail-closed、共享进程退出通知与恢复。
- **原生 thread 事实源**：`thread/list/read/resume` 跨 Codex App/Web 读取续接，`thread/status/changed` 驱动活动状态，契约测试禁止恢复 `sessions.js`、`history.js` 和旧 session history/list 事件。
- **可靠投递**：稳定 `clientRequestId`、payload fingerprint、single-flight、重复 ACK 回放、id 冲突、ledger 容量、`clientUserMessageId` 透传；浏览器 IndexedDB outbox 的先持久化、FIFO、ACK timeout 隔离、gateway epoch、无 thread 的 ledger reconciliation、`thread/read` fallback、provisional instance 恢复、从未尝试记录原 id 重绑、已尝试记录 fresh-id 确认重试，以及 reconcile/retry 互斥防旧 id 复活。
- **断线恢复**：同 epoch 连续 buffer 增量补发，buffer gap/epoch mismatch 触发精确 `thread/read` snapshot，客户端按 `throughSeq` watermark 缓冲并去重恢复期间的 live events。
- **结构化输入**：attachments 类型、10/20 MiB 业务限制、32 MiB Socket wire cap、0700 上传目录/0600 文件，图片→`localImage`、文件→`mention`，workspace mention、enabled skill、显式门控的 HTTPS image URL 与完整 IPv4/IPv6 DNS/SSRF 拒绝路径。
- **审批与 needs-you**：approval/question 分类、精确 target、snapshot/revision、进程内幂等重放与 conflict/stale/unknown、resolved/expired/revoked 广播和脱敏深链。
- **自托管安全**：HTTPS fail-closed、Origin allowlist、可信代理、HttpOnly device-bound session、query token 拒绝、配对/撤销、外部 trusted-file 原子变更、认证/Push 容量限制、rate-limit 审计聚合、O_APPEND + bounded rotation、宿主配置审计 sink 脱敏，以及 Push DNS pin/总超时/响应上限与持久化失败。
- **门禁自身**：CI 矩阵关闭 fail-fast、没有 `continue-on-error` 吞掉失败、生产依赖 audit 阻断、覆盖率退化门禁不限于 PR（`test/ci-workflow.test.mjs`）；E2E 必须走 mock 且跑用例前先探测后端版本（`test/zero-quota-guard.test.mjs` + `e2e/assert-mock-backend.js`）；落盘文件不超出 A2 允许的例外（`test/zero-persistence-guard.test.mjs`）；`public/` 外壳的结构性边界（`test/public-shell-guard.test.mjs`）。
- **移动端**：流式气泡、thinking、命令/工具/diff/审批/提问卡片、状态栏、PWA/Service Worker、needs-you 恢复、outbox 存储与多实例/多视图隔离。

这几类守的是「规则被违反时会不会有东西变红」，此前全靠文档约定。**它们是绊线，不是实现的镜像**：从源码里抽事实，只写死「允许什么」。所以重构不会误伤，越界一定变红。新增门禁照这个形态写——凡是需要复述当前代码长什么样才能通过的断言，重命名一次就会红，而逻辑写反时不会红，净效果是负的。

主要证据分布在 `test/app-server-{transport,host}.test.mjs`、`test/thread-{registry,source-of-truth,status}.test.mjs`、`test/message-{receipt-ledger,outbox,request}.test.mjs`、`test/recovery-state.test.mjs`、`test/{user-inputs,input-parts}.test.mjs`、`test/server-{integration,security,push}.test.mjs`、`test/service-worker.test.mjs` 和 `e2e/*recovery*.spec.js`。

### 已知的测试债

`public/js/app.js` 约 4000 行装在一个 IIFE 里，**里面的东西一个都导不出来，因此一个都没法单元测试**。前一版的应对是 `test/public-ui.test.mjs`——1807 行、90 个 test，对源码文本做正则匹配。它已被删除，实测代价有三条：

1. **1028–1401 与 1402–1775 是逐字相同的 374 行**，15 个 test 跑了两遍（粘贴重复）。879 个测试全绿，没有任何东西发现它。文件大到没人能通读，就是它失去审阅价值的那一刻。
2. **两条断言互相打架而同时绿**：一条要求源码里必须出现 `crypto.randomUUID()`，另一条禁止裸调它。前者会拦住「改用统一的 `randomId()`」这个明确的改进——**门禁在阻止修 bug**。
3. **删掉后覆盖率一点没掉**（91.30 → 91.33）。

替代形态是三层，不再有第四层：结构性绊线（`test/public-shell-guard.test.mjs`）、可提取的纯逻辑（抽成 `public/js/` 下的模块 + 真 `import` 的单测，已抽出 37 个）、真实行为（E2E，真 `click` 和 `toBeVisible`）。

**在 `app.js` 拆完之前，涉及它的功能必须有一条 E2E 守住入口。**

---

## 8. 验收矩阵

每个产品场景按四个维度判断：**功能等价**、**状态可见**、**失败可恢复**、**权限可控**。

矩阵的「代码入口」同时是当前功能盘点；**文件被删除后必须从这里移除**，不能把历史方案继续写成事实。

| 案例 | 场景 | 代码入口 | 主要证据 |
|---|---|---|---|
| 案例 1 | 创建任务 + 流式输出 + ACK/outbox + provisional orphan/fresh-id 恢复 + gap 后恢复会话 | `server.js`、`message-receipt-ledger.js`、`public/js/message-{request,outbox}.js`、`public/js/{indexeddb-outbox,outbox-recovery,recovery-state}.js` | receipt/dedup 集成测试、outbox 与 recovery 单测、关键流程和 outbox recovery E2E |
| 案例 2 | 执行命令 + 触发权限 + 审批/提问跨 thread 聚合 + exit code 可见 | `approval-broker.js`、`needs-you-registry.js`、`agent-appserver.js` | broker/needs 幂等与冲突测试、关键审批与 needs-you recovery E2E |
| 案例 3 | 产生失败 + 重试恢复（同 id 只读核对 / fresh-id 确认重试）+ backpressure + 长日志移动体验 | `agent-appserver.js`、`message-receipt-ledger.js`、`public/index.html`、`public/js/app.js` | 协议错误/结果未知测试、retry/copy UI 契约、移动视口 E2E |
| 案例 4 | 文件上传 + 结构化附件输入 + transport/business 双层上限 + 0700/0600 安全落盘 | `uploads.js`、`file-security.js`、`user-inputs.js`、`input-parts.js` | user-inputs/input-parts/file-security 单测、>1 MiB wire 集成、附件 E2E |
| 案例 5 | 状态栏 + `thread/status/changed` + git/token/context 状态 | `statusline.js`、`agent-appserver.js` | statusline、thread_status 与 public UI 测试 |
| 案例 6 | 历史浏览 + 工具/变更卡重建 + app-server thread 唯一事实源 + Codex App/Web 双向续接 | `thread-history.js`、`app-server-host.js`、`agent-appserver.js`、`server.js` 的 `thread:*` | thread-history 单测、native thread 集成、workspace-and-composer E2E |
| 案例 7 | 多工作目录 + 实例切换 + 双设备/双 thread 零串流 + 共享单进程 | `app-server-host.js`、`thread-registry.js`、`agent-appserver.js`、`public/js/view-routing.js` | shared-host spawn/initialize、stale target、route/workdir、多实例 E2E |
| 案例 8 | Web Push + DNS/address pinning + bounded response + needs-you 脱敏深链 + device revoke | `server.js`、`push-sender.js`、`network-address.js`、`needs-you-registry.js`、`public/js/sw.js` | Push DNS/mixed-IP/timeout/body-cap 单测、authenticated persist/prune、service worker 和 needs-you E2E |
| 案例 9 | 模型切换 + 权限档切换 | `agent-appserver.js`、`server.js`、`public/index.html`、`public/js/app.js` | model/permission UI、宿主配置逐动作确认测试 |
| 案例 10 | PWA 安装 + HTTPS/auth session + 全屏/移动体验 | `server-security.js`、`public/manifest.webmanifest`、`public/js/sw.js` | transport security/session/SW 测试、响应式和 PWA E2E |

会话设置是聚焦用例：`test/permission-settings.test.mjs` 与 `e2e/session-settings.spec.js` 覆盖预设字段、granular 清洗与持久化、outbox、主机默认恢复、失败不污染运行时、外部设置通知及移动端确认操作。

---

## 9. 手工冒烟清单

只在确定性门禁通过后使用。涉及真实 Codex 的项必须由维护者明确授权。

- TC-1：基础对话生成一个稳定 request id，收到 ACK 后流式显示完整响应。
- TC-2：斜杠命令 `/status`、`/diff`、`/review`、`/permissions` 可用。
- TC-3：停止按钮只中断目标 thread 的活跃 turn。
- TC-4：busy turn 期间输入按协议能力进入队列或 steer，其他 thread 不受影响。
- TC-5：审批批准只决议一次，并显示真实命令退出码。
- TC-6：审批拒绝不执行请求；另一个设备上的同一 need 同步撤销。
- TC-7：文件/图片显示附件元数据，并分别以 `mention` / `localImage` 发送，不向 text 拼路径。
- TC-8：顶栏显示工作区名、连接点和往返延迟；git 改动数出现在工作区胶囊；`thread/status/changed` 能跨设备更新忙闲状态。
- TC-9：历史抽屉使用 `thread/list/read` 浏览，并能双向续接 Codex App 与 Web 创建的 thread。
- TC-10：多工作区切换只接受 `WORK_DIR` / `WORK_DIRS` allowlist。
- TC-11：两个设备分别查看两个活跃 thread 时，文本、工具、审批和状态均不串流。
- TC-12：模型控件显示可用模型，或显示明确且可恢复的空/错误状态。
- TC-13：权限控件只更新目标 runtime 的 model/sandbox/approval 状态。
- TC-14：普通刷新以 seq/epoch catch up，不重复已应用事件。
- TC-15：人为丢 ACK 后，以相同 `clientRequestId`/payload 重试只执行一次；冲突 payload 被拒绝。
- TC-16：VAPID 配齐、HTTPS、有效 session 且设备已批准时才能订阅 Web Push；通知不含命令/问题正文并打开精确 need 深链。
- TC-17：安全上下文中的 PWA manifest 支持 standalone 安装。
- TC-18：移动端竖屏、横屏和软键盘布局都保持 composer 控件可见。
- TC-19：离线发送后关闭/重开页面，IndexedDB outbox 保留并在重连后按 FIFO 发送一次。
- TC-20：强制 event buffer gap 或 epoch mismatch 后由 `thread/read` 重建；恢复期间 live event 不丢不重。
- TC-21：新设备登录后保持 pending；批准后解锁，deny 后 cookie/socket/Push 同时失效。
- TC-22：远程 HTTP、错误 Origin、缺失可信 `X-Forwarded-Proto` 和撤销后的 session 均 fail-closed。
- TC-23：宿主配置入口常驻，但缺 `confirmAction` 会被拒绝。
- TC-24：workspace mention、enabled skill 可发送；越界路径、未启用 skill 和默认关闭的远程图片被拒绝。
- TC-25：ACK 丢失后重启 gateway，客户端只调用 `message:reconcile`；无 thread 时仍先查 receipt ledger，有 thread 时 `thread/read` 命中 `clientRequestId` 后清除 outbox 且 `turn/start` 总计一次。消失 instance 的未尝试记录保留原 id 重绑；已尝试且无法核对时保持 `needs_reconcile`，用户确认后使用新 id，旧 id 不得复活。

**iOS 真机只能人工验。** [playwright.config.js](../playwright.config.js) 的 `mobile-webkit` 比 Firefox 更接近 iPhone，但它验不了 PWA 安装（iOS 的路径是分享→添加到主屏幕）、真实 Web Push（要 16.4+ 且已添加主屏）、软键盘几何、Safari 的存储驱逐。别把那条 project 当成它们的替代。

---

## 无头 Linux 验收

官方 Codex Remote 要求 host 运行 ChatGPT 桌面 app（仅 macOS / Windows），并明确要求「Keep your computer awake and online」。无图形界面的 Linux 服务器不在它的支持名单里，而服务器不会休眠——**在无头 Linux 上跑通，是本项目唯一一条官方结构上给不出的承诺**，所以它是验收项而不是加分项。

验收目标：一台无图形界面的 Linux 主机，从全新部署到手机上完成一次审批，全程不需要任何 Mac / Windows 桌面 app 参与。

```bash
npm run doctor      # 自检：codex 可执行、工作区有效、data/ 可写、远程绑定的 token 强度
npm start
```

判据（逐条可见，不看日志也能判断）：

1. `npm run doctor` 全绿，其中「无图形界面」一项确认 `DISPLAY` / `WAYLAND_DISPLAY` 缺失也不影响启动。
2. 服务默认只监听 `127.0.0.1`；绑定到非 loopback 时 `AUTH_TOKEN` 必须 ≥32 字符，否则拒绝启动。
3. 手机浏览器经私有网络打开控制台，填入 token 后可见会话列表。
4. 在手机上发起一条会触发审批的指令，审批卡片出现，点击批准后宿主机按该决定执行。
5. 全程没有安装或运行 ChatGPT 桌面 app。

第 4 条做不到，产品不成立——手机只是个只读看板，不是控制面。

---

## 真实 Codex 冒烟边界

真实 Codex CLI **不属于默认 E2E**。只有在验证本地集成、审批或协议升级且用户明确授权时才运行；使用一次性工作区、受限 sandbox/approval policy，并单独记录它与 mock 门禁的结果。

入口是 `scripts/smoke-server.js`（全栈 Socket.IO 契约 + ThreadRuntime 协同）与 `scripts/smoke-approval.js`（审批闭环：read-only 沙箱 + on-failure 触发 → 自动批准 → 执行 → 完成），两者都会消耗少量额度。

日常回归的 mock 家族与它们对应：`scripts/mock-server.js`（设好环境变量起 `server.js`，E2E 的 webServer 就是它）→ `scripts/mock-codex.sh`（假二进制）→ `scripts/mock-codex-app-server.js`（stdio 上的 JSON-RPC 2.0 模拟）。另有 `scripts/scenario-server.js` 提供确定性事件流，用于场景核对。

版本与 `.codex-version` 不一致时，先按协议升级流程重新生成 `.protocol/stable/` 基线并逐条核对差异，**不要用当前安装版本直接覆盖基线**——那等于把上游漂移当成既成事实接受，`protocol:check` 的第一层就是为了拦住这个。
