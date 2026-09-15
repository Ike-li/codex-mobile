# test/ 目录地图与不变量登记表

目录怎么分、一条测试该进哪个槽，见 [docs/TESTING.md 判断一](../docs/TESTING.md#判断一这条测试进哪个槽)。这份文件只回答两件事：**有哪些不变量**，以及**「守护」这个词在本仓是什么意思**。

## 不变量登记表

`test/invariants/` 下每个文件的**第二行**必须是 `// 守护：<编号>`，编号必须在下表首列查得到。两个方向都由 [scripts/gates/check-invariant-ids.js](../scripts/gates/check-invariant-ids.js) 硬闸执行：

- **正向**：`invariants/` 下有文件没写守护行、或写了表里没有的编号 → 红。
- **反向**：表里的编号在整棵 `test/` 树里一次都没被提到 → 红。这条挡的是死条目——一条没人再守的红线会继续以「已经有测试了」的身份占着位置。

反向断言故意放宽到整棵树而不是只看 `invariants/`：有两条不变量是由**门禁**守的，而测门禁的文件按判据住在 `test/infra/`。

| 编号 | 红线 | 守它的文件 |
|---|---|---|
| `A2` | **不产生第二份真相。** 判据不是「有没有写文件」，而是「同一个事实会不会既在 codex 的宿主机状态里、又被我们独立存一份」——两边迟早漂移，而用户没有办法知道该信哪个。thread / turn / item / 配置 / 模型列表一律向 app-server 现问。落盘的例外必须逐条写明凭什么不算第二份真相。 | `invariants/zero-persistence-guard.test.mjs`（扫 `DATA_DIR` 下的落盘点）<br>`invariants/thread-source-of-truth.test.mjs`（扫残留的 sessions.json / JSONL 历史读写与 legacy 别名） |
| `QUOTA-01` | **日常回归零模型额度。** E2E 必须走 mock：探测挂在 `globalSetup` 上、`webServer` 指向 mock 脚本、mock 真把 `CODEX_BIN` 指向假二进制。测试也不得靠宿主机 PATH 解析 `codex`——没装的机器上进程会静默死掉，而不是给出一条失败的用例。 | `invariants/zero-quota-guard.test.mjs` |
| `DELIVER-01` | **投递不丢不重，且需要人时叫得到人。** 只断言外部可观察行为：同一请求发两次、断线重连后查得到什么、处理过的审批再处理一次。刻意不碰 phase / revision / handles 这些内部形态——那些是实现细节，重构时会连同测试一起被改掉，安全网也就没了。 | `invariants/delivery-contract.test.mjs` |
| `SHELL-01` | **`public/` 外壳的结构性边界。** 无内联 script（可以写进 CSP 的客观属性）、不裸调 `crypto.randomUUID`（非 secure context 里它不存在）、不用 `Math.random` 生成凭证或请求 id、样式表与脚本都能解析到真实文件、不重新引入 ChatGPT 账号登录。**越过边界就红，不是复述实现长什么样**——后者是被删掉的 `public-ui.test.mjs` 干的事，见 [docs/TESTING.md 第 7 节](../docs/TESTING.md)。 | `invariants/public-shell-guard.test.mjs` |
| `DOC-01` | **文档不坑读者。** 判据只有一条：违反了，读者会被坑吗？因此只收两类断言——客观缺陷（死链、点名了不存在的文件、许可证与 package.json 不一致）与具体教训（每条背后一次真实踩坑）。不咬标题字面、不咬措辞。 | `invariants/acceptance-doc.test.mjs` |
| `READ-01` | **未读位点只增不减，且跨设备归并是幂等的。** 四条：① `markRead` 单调，乱序到达的旧 ack 不把位点拨回过去；② 「标为已读」这条路径的 seen 同样单调（与 ① 是同一不变量的两个入口，两侧必须同向）；③ 取消手动未读时**必须同时记 seen**，只删标记会被别的设备的旧条目复活；④ 被更晚的 seen 盖过的 manual 条目要清掉，否则形成「本地删了、服务端留着、下一趟又合并回来」的长期不对称。每一条的失败形态都一样：一屏已经看过的会话重新亮起来，而那看起来像「未读功能不准」，不像数据被改坏了。 | `invariants/read-state.test.mjs` |
| `OPS-01` | **记了就要有出口。** 源码里每个 `metrics.inc('x')` / `gauge('x')` 的字面量，都要在 `KNOWN_METRICS` 与 `/metrics` 的白名单映射表里查得到；反向，登记了却没人再埋点的死条目也要红。不守的话，一个漏登记的计数器永远不会出现在 `/metrics` 里而**没有任何报错**——症状是「这个指标一直是 0」，人会去查埋点为什么没触发，而真正的原因在另一头。指标名必须是紧跟括号的字面量（三元、模板串都扫不到），这既是扫描判据也是「key 集合必须编译期固定」那条内存安全约束。 | `invariants/metrics-contract.test.mjs` |
| `ENV-02` | **状态库不兼容时，启动即给出可执行提示。** `~/.codex` 是全局共享的，库文件名自带版本后缀；同机器上的 Codex 桌面版一升级就把新迁移写进去，pin 住旧版的本项目再去读自己那版才有的表就会撞上。这条要求的是「拿到这个错误之后能判断出下一步」，不是「去 spawn 真 codex 探测」。 | `invariants/doctor.test.mjs` |
| `GATE-02` | **`cancelled` / `skipped` 不为 0 要红，解析不到汇总行也要红。** `node --test` 把它们与 `fail` 分开计数而退出码不一定反映，于是「fail 0」的一次运行可能整片用例根本没跑——全绿是最贵的失败模式。 | `infra/check-test-summary.test.mjs` |
| `TEST-01` | **测试不得以真实 HOME / 生产数据目录为删除或写入目标。** 变异会故意改坏源码，而改坏的可能恰恰是算路径或算删除目标的那段代码。真正的防线是容器里那行 `ENV HOME=/home/ccm-test`，不依赖任何代码正确性；`mutate.js` 自带的恢复逻辑挡不住——容器被 kill 时它根本不会执行。 | `infra/mutate.test.mjs` |

## 「守护」和「论据锚点」不是一回事

单测注释里还散着另一套编号：`R-7` `R-10` `R-13` `R-16` `R-19` `R-SEC-1..4` `R-ENG-3` `RECOVER-01` `DELIVER-03/04/05/07` `I-7` `D6`。**它们不进上表，也不要求文件搬家。**

区别在于文件是围绕什么组织的：

- 写 `// 守护：X` 的文件，**整个文件**是为了守 X 而存在，通常没有同名源模块——删掉 X 这条红线，这个文件就该一起删。
- 散在注释里的编号是**论据锚点**：某条断言为什么这么写、对应哪次事故或哪条需求。它所在的文件仍然是按模块组织的单测，删掉那条需求也只是删掉文件里的一条用例。

把论据锚点当守护声明会产生一个具体的坏结果：`unit/ansi-html.test.mjs` 因为提到 `I-7` 就得搬进 `invariants/`，而它明明是 `public/js/ansi-html.js` 的模块测试。于是「按模块组织」和「按不变量组织」这条分界线就没了。

## 新增一条不变量时做什么

1. 先确认它真的是「整个文件为它而存在」——否则它只是一条论据锚点，写进注释即可。
2. 在上表加一行：编号、红线正文（**写清违反了会怎样，不要只写规则名**）、守它的文件。
3. 文件第二行写 `// 守护：<编号>`，文件放进 `test/invariants/`。
4. 跑 `npm test`，`check-invariant-ids` 会告诉你四种失效形态里有没有踩中。
