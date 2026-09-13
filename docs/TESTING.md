# 测试

测试体系分为确定性的 mock 门禁和明确隔离的真实 Codex 冒烟。日常开发保持零模型额度：服务端集成使用 fake stdio app-server，Playwright 使用 `scripts/mock-server.js`。

## 必跑门禁

会话设置聚焦用例：`test/permission-settings.test.mjs` 与 `e2e/session-settings.spec.js` 覆盖预设字段、granular 清洗和持久化、outbox、主机默认恢复、失败不污染运行时、外部设置通知及移动端确认操作。

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
```

- `npm test` 以 `--test-concurrency=1` 运行 `node:test`，覆盖单元、集成、协议、安全、UI 和文档契约。
- `npm run protocol:check` 要求本机 Codex 版本等于 `.codex-version`，版本不匹配就是失败，不能跳过后宣称门禁通过。它查三层：**上游漂移**（`.protocol/stable/` 与现场生成的输出全文比对，字段增删改都会报）、**方法覆盖**（我们调用的方法必须存在于协议）、**通知字段用法**（`handleNotification` 读的每个 `params.X` 必须在该通知的 params 类型里声明）。第三层补的是这样一个洞：方法名对得上不代表字段对得上，上游把字段改个名，我们读到的是 `undefined` —— 不抛异常、没有失败用例，功能静默失效，而单元测试用的是我们自己写的、同样假设错误的 fixture，两层一起说谎。有意保留的兼容回退写进 `LEGACY_FIELD_ALLOWLIST` 并注明理由，而不是只留在源码的 `??` 里让人猜。
- `npm run test:e2e` 用 Playwright mobile Chrome 连接 mock gateway，不启动真实 Codex。
- `npm run test:ci` 串联 lint、协议门禁、单测、覆盖率退化门禁和 E2E，四道门都在里面。协议门禁必须在门禁内，否则枚举值一类的漂移能直接合入——`on-failure` 审批档就是这么进来的。
- `.coverage-baseline.json` 在 2026-09-01 从 95.79/87.88/97.84/95.79 重置为实测值。旧值陈旧了 80 个提交：退化门禁（相对基线 ≤2pp）设计是对的，但它只挂在 `pull_request` 上，而 CI 矩阵默认的 fail-fast 又让 Node 22 的抖动连坐取消 Node 20 那条腿——这道门结构上从来没跑成过，于是分支覆盖在 80 个提交里从 87.88 掉到 76.89 而没有任何东西变红。
- 随后补测把基线抬到 **91.12/79.89/95.09/91.12**：排除 `public/vendor/**`（第三方压缩代码不该计进我们的覆盖率，`.c8rc.json`）拿回 1.62pp 分支，为工作区允许列表、git 工作区、Push SSRF、断连恢复缓冲、结构化输入的错误路径补测拿回 1.38pp。
- **剩下的 8pp 没有补，而且不该用碎测试去凑。** 要回到 87.88% 需再覆盖约 354 条分支，其中 `server.js` 占 296 条、`agent-appserver.js` 占 122 条 —— 两个文件就超过了缺口总量，其余所有文件加起来才 471 条。这 8pp 实质是一项针对两个最大模块（3055 行 / 2000 行）错误路径的独立工作，不是清理。当年的 87.88 是在这两个文件还小得多的时候定的。
- 与数字同样要紧的是：退化门禁现在真的会跑了。从下一个提交起掉超过 2pp 就红，所以不会再出现「悄悄滑走 11pp」。
- `npm test` 曾间歇报 `Unable to deserialize cloned data` 并把整个 `test/server-integration.test.mjs` 判为 uncaughtException。此处一度记为「Node 25 特有的 test runner 回归、与被测代码无关」，两条都不成立：CI 的 Node 22 腿上是同一个错误（连续四次 CI 失败里就有一次），触发源也在我们这一侧。`node --test` 的 child-v8 通道把控制帧和子进程 stdout 复用在同一条流上，而这个文件为每个用例 import 一份新的 `server.js`（约 60 次），启动横幅、逐连接日志、以及 dotenv 每次随机换文案的推广横幅全部写进那条流。两处改动后，同会话配对测量的失败率从 4/7 降到 0/10：`dotenv.config({ quiet: true })`，以及在起 server 的两个测试文件里把 `console.log` 改道到 `console.error`。0/10 不等于证明为零，但机制清楚且失败率单调下降。
- `app-server-transport.test.mjs` 的 4 个测试曾在**每一次**运行里被标记 cancelled——不是间歇，是确定性的。请求超时定时器在生产代码里是 unref 的（服务器有 HTTP listener 吊着事件循环，线上无影响），测试等它时事件循环已排空，`node --test` 判定「promise 仍挂起而事件循环已结束」，把该用例连同其后三个一并取消。汇总显示 `fail 0`（cancelled 不计入 fail），极易被当成通过，于是超时、子进程退出、子进程错误和 dispose 这四条错误路径长期未被验证。看到 `cancelled` 不为 0 时不要放过——那是没跑，不是跑过了。

## 判据必须是用户看得见的东西

两条从真机验证里换来的教训，写在这里免得再犯：

- **不要用 `dispatchEvent` 代替 `click`。** 它把事件直接派发到元素上，绕过 Playwright 的可见性检查。`e2e/native-controls.spec.js` 曾这样点击工具按钮，于是 `drawer-tools` 整块带着 `hidden` 的那段时间里，Files / Account / 诊断 / 设备全部对用户不可达，而 e2e 一直是绿的。
- **「HTML 里有这个 id」不等于「用户点得到」。** 单元测试断言元素存在、e2e 用绕过可见性的方式点击，两层都在验证存在性，没有一层验证可达性。新增功能如果只有一个入口，必须有一条 `toBeVisible` 的用例守着那个入口。

### 「不会崩」和「读得了」是两个维度

2026-09-12 实测：`e2e/markdown-typography.spec.js` 的宽表格用例四条断言全绿（单元格 `word-break` 已复位、`scrollWidth > clientWidth`、`overflow-x: auto`、`#messages` 没被撑破），而同一张表格的「说明」列被压到 **49px 宽**——减掉 padding 只剩两个汉字，21 个字的中文排成一根竖条，把整行撑到 **286px**。前三列下方那片巨大空白，就是这根看不见的竖条撑出来的。

四条断言一条都没红，因为它们问的全是**会不会崩**：没撑破容器、能横向滚动、overflow 值对。没有一条问**读不读得了**。这两个维度的交集比直觉小得多，用户能一眼看出的缺陷可以完整地躲在结构性契约的盲区里。

根因是 `display: block` 让 `<table>` 一个元素同时当滚动容器和表格，`max-width: 100%` 夹住的是**内部表格算法的可用宽度**：表格不知道外面能滚，于是在 361px 里硬分 4 列，不可断行的 ASCII 路径 min-content 很大、抢光空间，而 CJK 的 min-content 是一个字，于是中文列被饿死。拆成 `.table-scroll` + `table` 两个元素后各管各的（`public/js/markdown.js` 的 `wrapTables`），表格取回 1095px 的 max-content 宽度。

补的绊线是 `e2e/lib/layout-audit.js` + `e2e/layout-sanity.spec.js`，判据是绝对的（多窄算窄、多挤算挤），**不是 pixel diff**：截图对比只能发现「和上次不一样」，发现不了「从第一天起就是错的」——这张表如果当时做了基线快照，49px 会被固化成「正确的样子」，修好了反而变红。

体检挂在 `shotArea()` 里，因此覆盖面自动跟着 `ui-shots.spec.js` 的 29 个截图区域长，新增一张图就自动多守一块区域，不依赖谁记得补一条对应的体检用例。注入验收：把 CSS 改回旧形态，09 和 **22（深色模式）** 两张同时变红——后者是意外收获，说明覆盖面比设计时预期的广。

写这道闸时踩的两个坑，都属于「门禁死于误报比死于漏报更常见」：

1. **扫描面塌陷的判据不能是「scanned 必须 > 0」。** 纯图片区域（`#attach-preview-img`）本来就没有文本叶子，拿 >0 当判据会让每张新增的图标截图莫名变红，然后下一个人把这条断言删掉。真正的失明是**有文本却一个都没扫到**，判据因此是 `root.textContent` 非空而 `scanned === 0`。
2. **「文本元素」的判据是「直接挂着文本节点」，不是「没有元素子节点」。** 后者漏掉混合内容——`<button><span class=icon></span>已归档</button>` 的文字直接挂在 button 上，而 button 有元素子节点，按叶子判会被整个跳过（实测漏掉了归档栏和系统消息两处）。

**可发现性**（2026-09-13 补）由 `e2e/markdown-typography.spec.js` 的「宽表格溢出时右侧有横滑提示」守：溢出时右侧渐隐、滑到尽头消失、窄表不出现、深色同样成立。几何体检仍然抓不到「像不像提示」，所以判据是像素——把那条边上的 20×28 截下来，和取消提示后再拍的一张对比，两张必须不一样。

**对照态是「换成全不透明的 mask」，不是「清掉 mask」。** 这条差别决定这个仪器能不能用。第一版写的是 `el.style.maskImage = 'none'`，于是元素退出离屏合成、文字从灰度抗锯齿切回子像素抗锯齿，**任何含文字的区域两张都不一样**：最左端的左边缘本来就没有左侧渐隐，却报出 667/727 字节不同、maxDelta 254；而同一方法在无文字的边缘（滑到尽头后的右缘）`diffBytes` 是 0——「差异来自文字重绘」的指纹就在这里。正向断言（该有提示时确实不同）照样绿，**只有反向断言（不该有提示时应当相同）系统性假红**。换成全不透明 mask 后两张都带着合成层，唯一变量才真的只剩渐隐与否。

注入验收做了三次，每次只改一处再跑：

1. 把 `.can-scroll-right` 的选择器改成不匹配的名字（等于删掉右侧提示）→ 「表格右侧被截断时，用户应能看出右边还有内容」与深色那条**同时变红**。
2. 让 `can-scroll-left` 无条件挂上 → 红在**前面那条 `not.toHaveClass`** 上，像素断言根本没跑到。**断言顺序决定注入能验到哪一条**，这次的注入没验到想验的那条。
3. 把 `can-scroll-right` 的单侧渐变改成双侧（class 不变，只让左边缘也渐隐）→ 红在「还在最左端时，左侧不应出现『还能往左滑』的假信号」。**这条才证明了反向断言有鉴别力、不是恒 `false`**——修一个假红最容易掉进去的坑，就是把它改成假绿。

### 第二批规则：`occluded-text` 与 `clipped-text`

2026-09-12 把 28 张截图逐张看完后补的，两条都对应看图时发现的真缺陷：代码块的「复制」按钮压在第一行代码上、安全档位说明「只有 ls、cat 等信任命令自动执行；其余一律询问」被 `line-clamp: 2` 吃掉半句。

**遮挡检测必须从遮挡物出发，不能从正文出发。** 第一版反着做：对每个文本元素按 0.25/0.5/0.75 采样去撞遮挡物，结果一条都报不出来——代码块的 `<code>` 是 inline，rect 是所有行的并集（实测 527px 宽），三个采样点落在 x=159/291/423，正好跳过 32px 宽的复制按钮。换成从浮层出发、用 `elementsFromPoint` 取元素栈看自己压着谁：浮层数量少、尺寸小，采样密度天然够。

这个方向还顺带给出了「什么算遮挡物」的准确定义——只有 `absolute/fixed/sticky` 能浮在别人上面。`#header-context`、`<summary>` 这些普通流元素根本不进候选，之前为它们写的两条豁免（「贴视口边缘的固定栏不算」）连同那个判据一起删掉了，误报自然消失。**为误报写豁免之前，先确认判据本身没问反问题。**

踩的三个坑，都属于「几何断言问过了错误的问题」：

1. **`clientWidth` / `clientHeight` 对 inline 元素恒为 0。** 拿它当「视觉隐藏」门槛，会把 `<code>`/`<span>`/`<a>` 里的文字整类排除——连复制按钮压正文这个真缺陷一起压没了。判尺寸要用 `getBoundingClientRect`。
2. **`getBoundingClientRect` 与「是否被祖先裁剪」无关。** 滚出容器的元素照样有合法坐标，拿它做命中测试问到的是「那个坐标上现在是谁」。第一版为此加了祖先可视区检查，换成从浮层出发后这个补丁失去存在理由，而且有害：它把表格里滚动可见的单元格全跳过了，扫描面反而变窄。**补丁要随它修的方案一起删。**
3. **`padding-top: 2rem` 写了但从来没生效。** `.code-block-wrap > pre` 的特异性是 (0,1,1)，而 `.codex .bubble.md pre` 的 `padding` 简写是 (0,3,1)，简写把 `padding-top` 整个覆盖掉，实测始终是 10px。复制按钮压代码的真正原因是这条规则一直是死的——**CSS 里「写了」和「生效了」之间隔着特异性，没有任何东西会报错。**

**`clipped-text` 豁免横向 ellipsis。** 省略号是明确的「后面还有」信号，报它等于禁用一个合法设计手段，规则会被学会忽略。纵向不豁免：`line-clamp` 整行整行吃内容，用户只在最后一行末尾看到一个省略号，损失量级完全不同。代价是路径 `/private/var/folders/b4/_t4qmr…` 和附件名 `apple-touch-icon…` 这类「截断方向错了」的问题它抓不到——那需要判断哪一头的信息更重要，是语义不是几何。

**豁免清单 `OVERLAY_ALLOWLIST` 要求写明理由**（≥40 字，由用例守着），照 `NOT_IN_CHECK` 的形态：默认值落在「遮挡就是缺陷」那一侧。目前只有 `#jump-to-latest` 一条——它显示的前提就是用户没滚到底部，那一刻可视区底部正显示消息流中段，给 `#messages` 加 `padding-bottom` 保护的是内容末尾，**和这个遮挡在不同的坐标系里，实测无效**。浮在内容上是这类控件的通行做法，代价是盖住一行。

### 第三条规则：`tap-target-too-small` 只守高风险操作

实测抽屉一屏 26 个可点击元素里 **22 个低于 44×44**，模式是全局按钮高度就是 28px。那是产品的视觉密度选择，不是 bug——把它们全报出来，这条规则会被整条忽略。所以阈值只对**高风险操作**生效：误触「批准执行命令」「Delete」「允许完全访问」的代价和误触一个普通按钮完全不是一回事。

判据从**语义标记**派生（`.native-danger`、`[data-danger="true"]`、`.approve-btn`、`.deny-btn`），不列举具体元素：新增一个危险按钮只要带上 `.native-danger` 就自动被守住，不依赖谁记得往清单里补一行。实测抓出三处并已修复：审批「批准/拒绝」55×31、「宿主配置」67×28、会话「Delete」。

### 第四条规则：`cjk-font-too-small` 只卡汉字

2026-09-13 重做排版时补的。**判据只对含汉字的文本生效，不是「禁止小字号」**：同样 10px，`26ms` 认得出，「延迟」认不出。汉字笔画密度远高于拉丁字母，一撇一捺在那个尺寸下不足半个像素，抗锯齿糊成一团灰；拉丁字母只有 26 个字形、笔画少，靠轮廓就能辨认。一刀切会把 token 计数、延迟毫秒这类纯数字标签全报掉——那是产品的信息密度选择，不是缺陷，报了这条规则就会被整条忽略（和 `tap-target-too-small` 同一个教训）。

下限 12px：Material Design 的 caption 档是 12sp，iOS HIG 最小可用字号 11pt。实测抓出 **35 处**，全部落在 10px 与 11px 两档，其中包括会话设置里「只有 ls、cat 等信任命令自动执行；其余一律询问」——必须读懂才能安全操作的文字，排在 10px。

**抬字号是连锁的，不是逐点修。** 原 scale 是 8/10/11/12/13/14/15/16px，8 个档挤在 8px 区间内。`--font-xs` 从 11 抬到 13 就超过了 `--font-sm` 的 12，命名与值倒挂，所以必须一路推上去。档位密到 1px 一级本身就是缺陷的一部分：定了等于没定，而低端三档承载着大量中文。

两个例外档，都是「拉丁内容不吃这个下限」的直接后果：

- `--font-terminal: 11px` 给 `.tool-output` / `.tool-exit`。终端输出的可读性取决于**一行放得下多少列**，不是字号——抬到 13px 让 393px 视口从 46 列掉到 42 列，命令输出的对齐结构被多折的行毁掉，比字小更难读（`layout-sanity.spec.js` 的列数断言会红）。
- `#header-project` 留在 12px。顶栏 393px 里塞着五个元素，抬到 14px 实测把项目名可显示长度从 14 字符压到 11，`ccm-e2e-USgARH` 被截成 `ccm-e2e-Y1K…`。那是用户区分工作区的信息，换 2px 不划算。

**踩的坑：`.tool-cmd` 看着像纯命令，其实不是。** 第一版把它一起划进终端档，`cjk-font-too-small` 立刻在文件变更卡（「新增: src/example.js」）和 Raw 卡上报了回来——前者是中文标签行，后者是协议原样回传的 JSON，字段值里有中文是常态（mock 的 `note` 就是）。Raw 卡的 JSON 因此单独拆出 `.tool-json`：**JSON 的可读性靠缩进层级，不靠列数**，没有留在终端档的理由。规则比划分更早发现了划分是错的。

`#slash-popup` 进了 `OVERLAY_ALLOWLIST`：字号抬升后面板变高，第一次盖到空状态的建议卡片。理由写在清单里——用户敲 `/` 那一刻的任务就是挑命令，被盖住的内容不属于当前任务，且面板消失后完整恢复；不遮挡的做法是推挤布局，那会让每敲一个字符界面上下跳动，比遮挡更糟。

### 排版体系本身：`typography-system.spec.js`

两条，判据都跨屏幕区域通用，不绑定某种内容：

**字体栈必须显式覆盖 CJK。** 判据落在**声明**上而不是实际渲染，因为浏览器不暴露「这个字形来自哪个 family」。可用的间接手段是比较中文串在当前栈与 `sans-serif` 下的测量宽度，但在开发机（macOS）两者都解析到 PingFang SC，宽度恒等——那个判据在这里测不出任何东西。而这条要防的后果恰恰发生在跑不到的平台上：Android 落到 `Roboto`、Windows 落到 `Segoe UI`，两者都没有 CJK 字形，只能交给 UA 兜底。**限制要说清楚**：它保证「我们声明了」，不保证「目标设备上装了」，真机渲染只能人眼验。

位置判据里，通用兜底只算 `sans-serif` / `serif`，**不算 `system-ui`**。字体 fallback 是逐字形的，不是「第一个存在的家族接管全部」：`system-ui` 在 Android 上解析到 Roboto，中文照样继续往后找。第一版把 `system-ui` 也算成兜底，于是把一个正确的栈判成了红。

**相邻标题级别必须真的分得出来。** 判据不是「h1 比 h2 大」（0.5px 也算大），而是**字号比 ≥1.15 或字重差 ≥50，二选一**。只卡字号不够：中文是等宽方块字，没有 x-height 和升降部可以参照尺寸，改动前 h1 19.5px / h2 17.25px（差 13%）在深色模式截图上看着一模一样。字重是第二个维度，拉开它同样解决问题，所以判据写成二选一而不是钉死字号。

### 入口收编：可达性覆盖必须跟着搬

2026-09-13 把账号 / 主机状态那 7 个入口从抽屉收进「设置与状态」sheet 时，
`native-controls.spec.js` 那条「名单从 DOM 派生」的可达性用例只扫 `#drawer-tools`——
照原样留着的话它**照样是绿的**，而搬走的 7 个入口从此一个都没有覆盖。这正是那条用例
当初要防的事，换了个形态又出现了一次。

改法是扫两处并断言**总数**：`inDrawer + inSettings >= 11`。只断言各自「有按钮」的话，
搬家途中漏掉一个入口不会有任何东西变红——那是这类改动最容易犯的错。

E2E 的点击 helper 同样跟着走：判据是「抽屉里看不见就往下一层找」，不在 helper 里
硬编码哪几个按钮搬了家。名单以后还会变，这条规则不会。

**`.native-danger` 被通用类覆盖掉，第二次栽在特异性上。** `.settings-action-btn` 定义在
`.native-danger` 之后，两者特异性同为 (0,1,0)，于是 `color` / `border-color` 一起被覆盖，
「宿主配置」在截图里和「Account」长得一模一样，CSS 不会为此报任何错。上一次是
`padding-top` 写了从没生效（见上文第 3 条坑），同一个机理。绊线补在
`feature-flags.spec.js`：判据取「和同组普通按钮的配色不同」而不是某个具体色值——
深浅两套主题色值不同，钉死一个会让另一套恒红，而「危险的要能一眼认出来」两套都成立。

### fixture 停在已经迁移走的格式，等于这条用例在守一个不存在的东西

2026-09-13 实测：`node scripts/device.js list` 把受信任设备打印成 `ID: [object Object]`。
数据没坏，纯显示层——`trusted-devices.json` 的条目在 R-SEC-1 时从扁平字符串数组改成了
对象（要保留 IP / UA / 批准时间，那是判断「要不要撤销这台」的依据），读取侧跟着改了，
CLI 的打印没跟上。

**已经有一条 spawnSync 跑 `device.js list` 的用例，它一直是绿的。** 因为它的 fixture 写的是
`JSON.stringify([deviceToken])` —— 旧的字符串数组。那个形态下 `${entry}` 恰好打印出 token，
断言当然过。于是这条用例守的是一个现实中不再产生的形态，真实格式下的缺陷它一个字都看不见，
最后靠人眼在终端里发现。

**改数据格式时，要连带审一遍所有硬编码该格式的 fixture**，否则它们会静静地退化成
「测试通过 ≠ 功能正确」。这次的分工：spawnSync 那条改用真实的对象形态（端到端 + 真实格式），
旧格式的向后兼容由 `test/device-cli.test.mjs` 在纯函数层覆盖——两种形态都测得到，
而且不需要准备数据文件和子进程。

CLI 要能被 import 才测得了格式化逻辑，照 `scripts/doctor.js` 的形态加了入口守卫
（`process.argv[1].endsWith('device.js')`）；没有它的话，测试 import 会顺带执行一遍 switch。

注入验收：把打印改回 `${entry}`，42 条里红 3 条（新单测两条 + spawnSync 那条）；
改回来全绿。**这一步才证明了新 fixture 真的有鉴别力**——上一版的 fixture 在同样的注入下
不会红，那正是它失效的证据。

### 噪音与告警要分开，别共用一个开关

MCP 启动状态实测一次对话产生 8 条系统消息（4 个 server × starting/ready），把回答整个
挤出首屏。默认静默之后，判据的关键不是「静默」而是**静默什么**：`error` 非空、
状态是 `failed` / `error` / `crashed` 时一律照报，不受偏好开关影响。把告警一起关掉，
用户就再也不知道某个 MCP 起不来了，那比刷屏严重得多。

未知状态**归入告警侧**：上游随时可能加新状态值，按「不是已知失败词就静默」处理会漏掉
真故障，按「一律报」处理最多多一条消息。两种错法的代价不对称，选代价小的那边。

判定逻辑抽到 `public/js/ui-preferences.js` 做纯函数，由 `test/ui-preferences.test.mjs`
覆盖——mock app-server 不发 `mcpServer/startupStatus/updated`，这条路径在 E2E 里根本
走不到，只靠 E2E 的话它会一直是零覆盖。

### 消息流的视觉语言：左边框是唯一的语义编码位

卡片按「用户需要做什么」分四档（`data-card`），不按技术类型分：`decision`（审批/提问）、`outcome`（结果/计划/变更摘要）、`action`（命令/MCP/搜索/文件变更）、`meta`（reasoning/Raw）。色值全部复用现有 token，深色模式自动成立——`--warn-text` 还是 `color-mix()` 动态生成的、按对比度校准过的值，decision 色带因此白拿了这份保证（深色实测约 9.1:1）。

**2026-09-13 起，`action` 和 `meta` 这两档不再有色带。** 工具活动（命令、MCP、搜索、文件变更、Raw）压成了一行灰字的「活动行」（`.activity-row`），整个过程层统一无边框、无底色——这是抄 ChatGPT 桌面端的过程降权做法，目的就是把视觉权重让给最终回复。给某一类活动行单独描个边，等于把刚降下去的权重又提回来。

于是**真正带色带的只剩 `decision` 和 `outcome` 两档**。`data-card` 四档仍然全员保留，因为它编码的是语义而不只是颜色：活动行照样要标 `action` / `meta`，漏标一样红。

**整圈边框只做轮廓，类型和状态都编码在左边那一条。** 此前命令卡用整圈变绿表示成功，而成功是常态、不该被高亮，结果是滚动时满屏绿框、真正要注意的反而不突出。现在成功刻意不改色（`exit` code 已经用绿字标过一次），只有 `data-ok="false"` 把左边框变红——需要在滚动中一眼找到的是失败。

绊线在 `layout-sanity.spec.js`，三条：每张 `.tool-card` 必须有 `data-card`（新增卡片忘了分档就红，**含活动行**）；带边框的各档左边框色**两两不同**；`.activity-row` 的左边框宽度必须是 0（有人给活动行加回色带就红）。只断言「属性值不同」是不够的——CSS 没写时属性齐全而颜色全一样，那正是第二条要防的状态，实测第一版就是这么红的。

颜色两两不同的档位数阈值从 `>2` 降到 `>=2`：过程层不再分色之后，有边框的就只剩两档。这是档位总数真的变少了，不是放松判据——第三条绊线接管了原来由颜色差异间接守住的那部分。

深色模式另出一张 `22b-dark-card-accents`：22 那张只有 Markdown 正文，分档色带一度只有探针数据、没有能用肉眼核对的图。补图之后确认了一件探针说不出来的事——**`meta` 档色带在深色下完全不可见**（`--border-light: #262626` 对卡片底 `#1c1c1c` 只差 10 个灰度单位）。探针只会报「对比度 1.13，太淡了」，而看到实物才能判断这可以接受：用户不需要知道「这是 meta 档」，只需要知道「这个可以跳过」，没有色带恰好传达了「没什么特别的」，分档系统对这一档退化成「无标记」在语义上是自洽的。

这张图本身也踩了三个坑，都属于「等待判据选错了」：审批挂起时再发消息会中断当前 turn，审批卡随即变成「已超时失效」，所以工具卡必须先发；`#state-label` 在 turn 中途会短暂回到 idle，用它当判据会让下一条消息打断上一个 turn（实测只渲染出两张卡就「已中断」），判据要落在最后一张卡真正出现上；卡片会先以加载态出现在视口边缘，等 `toBeVisible` 就截图只能拍到顶部一条色带，要等决策按钮出现。

### 三条从「看起来咋样」倒推出来的实现缺陷

- **`.tool-output` 被三层 padding 连续吃掉宽度**：`#messages` 16px + `.tool-card` 14px + 自身 12px = 84px，393px 视口下终端内容只剩 307px。负边距贴到卡片边缘拿回 28px（46 → 50 列）。**但这不解决根本问题**——393px 下 11px 等宽最多约 53 列，达不到终端惯用的 80 列，那是物理限制。
  改成活动行之后卡片那层 14px padding 没有了，`.activity-detail .tool-output` 因此把负边距复位成 0——再负出去就直接溢出容器。宽度不亏，终端块本来就贴着活动行的边。
  这条绊线现在要先把折叠层摊开才量得到，并且**必须等本轮产物出现再量**：只等 `#state-label` 变 idle 不够，发送后它还没转成 busy 时断言就立即通过了，测量会跑在一个空页面上（实测 `.tool-output` 一个都扫不到，用例平凡地失败在可见性而不是宽度上）。判据改成等「用时 N 秒」那条分隔线。另外 `.msg` 带 `content-visibility: auto`，视口外的子树跳过渲染、量出来是 0，量之前要先解冻。
- **自然语言套用了代码样式**：计划步骤用 `.tool-cmd`、搜索摘要借 `.tool-output` 再用内联 style 把背景/颜色/padding 逐个盖掉（只为拿字号，等宽是顺带继承的副作用）。除字体外还带来 `word-break: break-all`——对路径必需，对句子会把英文单词从中间劈开。新增 `.tool-note` 承载「卡片里给人读的句子」。
- **原判断「等宽字体 13 处声明，用得过宽」是错的方向。** 实测消息流里只有 `.tool-cmd` / `.tool-output` 两个类在用，而且这个字体栈**不覆盖中文**——纯中文元素设等宽视觉上没区别。这同时解释了此前标为「存疑」的现象：搜索两条摘要字体不一致，`cjkRatio` 分别是 0.38 和 0.89，同一个类、只有 ASCII 部分变等宽。**问题不是"用得多"，是两处语义误用**，修法和改字体声明完全不同。

### 本轮踩的三个坑

1. **同特异性时源码顺序决定胜负。** `.tool-note` 和 `.tool-cmd` 都是 (0,1,0)，我把新类写在了前面，`font-family: inherit` 整个失效——和上一节 `padding-top: 2rem` 那个坑同源，只是这次换成了顺序维度。
2. **几何断言要钉在改动的直接结果上。** 「每行能显示几列」受字体渲染影响，实测 chromium 50 列、webkit 48 列（Menlo 字符更宽），钉死 50 会让 webkit 恒红而那不是缺陷。改成守「不退回改动前的 46 列」，而「终端块宽度 ≈ 卡片宽度」这个直接结果跨浏览器稳定。
3. **新测试留下未处理的审批，污染了后面的 spec。** 整轮 e2e 共享一个 mock server，挂着不管的审批会堆进「需要你」，`needs-you-recovery` 因此在全量跑里稳定变红、单独跑却是绿的。审批类用例必须就地 deny 掉。

### 同批修掉的两处交互缺陷

**危险确认看起来不危险。**「允许完全访问？」——本应用权限最大的一次确认——的 OK 按钮是黑色实心主按钮，视觉上最突出、在鼓励点击，和「取消」的层级正好反了。`#confirm-ok[data-danger="true"]` 这套红色危险态**早就写好了**，调用处只是没传 `danger: true`。同时调用处传的 `confirmText: '允许完全访问'` 从来没被 `open()` 读过，按钮文字一直是泛化的「确定」——**传了一个不存在的参数，静默失效，没有任何东西会报错**。泛化的确认文案让用户在点下去的瞬间不知道自己在确认什么。

**「需要你」面板显示内部 threadId。**`mock_thread_1789224943799` 对用户没有任何意义，而这里正是用户最需要快速判断「是哪个会话在等我」的地方。改的时候撞上一个耦合：`needs-you-recovery.spec.js` 从这个元素的**显示文本**里读 threadId 去构造深链 URL。把给机器读的数据放在给人看的位置，"对用户友好"和"测试稳定"就直接冲突——解法是加 `data-thread-id` 属性，机器读属性、人读文本，两者各自演化。

这一处**只修好了一半**：`appThreads` 来自 `thread/list`，刚创建的 thread 还没进去，此时仍然只能显示 id 片段（加了「会话」前缀，至少不像渲染出错）。当前活跃 thread 的标题没有独立来源，要拿到它得改数据流。

**弱断言的教训**：第一版断言写的是「显示文本 ≠ 完整 threadId」，它在显示 `mock_thr` 时**照样通过**——功能没达到目的而断言全绿。判据要咬住想要的结果，不能只咬住不想要的那一个特例。

同类的还有「测试里出现一份和生产代码平行的清单」：那是在复述数据而不是验证行为。审批档、沙箱档、图标名都曾各自被抄成字面量清单，协议删掉 `on-failure` 时三处同时说谎。正确形态是从唯一来源派生。可达性用例本身也踩过这一条：它曾硬编码三个工具按钮，于是另外九个入口没有任何覆盖，新加一个工具也不会自动被守住——现在名单从 `#drawer-tools button` 派生。

### `public/js/app.js` 是这几条教训的共同来源

它有约 4000 行装在一个 IIFE 里（`app.js:72` 到文件末尾），里面的东西**一个都导不出来，因此一个都没法单元测试**。于是 `test/public-ui.test.mjs` 只能 `readFileSync('app.js')` 之后对源码文本做正则匹配——1807 行、90 个 test，验证的是「代码写了」而不是「功能能用」。

那个文件已经删掉了，实测代价有三条：

1. **1028–1401 与 1402–1775 是逐字相同的 374 行**，15 个 test 跑了两遍（`fc2ad4a` 粘重了）。879 个测试全绿，没有任何东西发现它。文件大到没人能通读，就是它失去审阅价值的那一刻。
2. **两条断言互相打架而同时绿**：一条要求源码里必须出现 `crypto.randomUUID()`，另一条禁止裸调它。前者会拦住「把 `createDeviceToken` 改用统一的 `randomId()`」这个明确的改进——门禁在阻止修 bug。
3. **删掉后覆盖率一点没掉**（91.30 → 91.33）。因为它只 `readFileSync` 而从不 `import`，对被测代码的执行覆盖始终是 0。1800 行测试连覆盖率这个最宽松的指标都没骗到，只骗过了人。

替代形态是三层，不再有第四层：

- **结构性绊线** → `test/public-shell-guard.test.mjs`（7 条）。不描述实现长什么样，只在越过边界时红：无内联 script、资源引用完整性、样式表顺序、不裸调 `randomUUID`、不用 `Math.random` 生成凭证、不重新引入账号登录。
- **可提取的纯逻辑** → 抽成 `public/js/` 下的模块 + 真 `import` 的单测。已抽出 32 个；`outboxRequestMatchesView`（`view-routing.js`）和 `compactPath`/`parentPath`（`display-path.js`）是最近两个。
- **真实行为** → e2e，用真实 `click` 和 `toBeVisible`。

在 `app.js` 拆完之前，涉及它的功能必须有一条 e2e 守住入口。**不要再往回加源码文本断言**：它抓不到逻辑错误，却会在重命名时变红，净效果是拖慢重构、制造虚假的绿。

## 绿的一侧不算验证

一条测试要同时满足两侧：正常代码下绿，**注入对应缺陷后红**。只做前者的话，「断言咬住了行为」和「断言什么都没咬住」在输出上完全一样。做法就是手改源码跑一次再改回来，不需要工具。

`npm run mutate:docker -- <生产文件>` 把这件事自动化：改坏一行源码，看断言会不会开口。存活的变异 = 那条断言没咬住行为。**它只能在容器里跑**（`scripts/mutate.js` 有硬闸，不在容器直接拒绝）——变异会改写源码，而改坏的可能正是算路径或算删除目标的代码：姊妹项目就是这么被 `rmSync(join(真实根, getProjectDir()))` 删掉过一整棵 `~/.claude/projects`（70 个项目 / 2990 transcript，靠 APFS 快照恢复）。

### 变异测试抓不到的三类

变异改的是**我们自己的源码**，所以下面三类它全都免疫，只能靠人想到：

1. **fixture 编错外部契约。** mock 与被测代码一起偏离真实协议，两边自洽，没有任何一侧会红。`protocol:check` 的第三层就是为这个存在的（见「必跑门禁」）。
2. **扫描面塌了。** 凡是「遍历一遍然后说没问题」的脚本，扫到 0 个和全部合规在输出上无法区分。2026-09-08 实测：把 params 类型声明从 `export type X = {` 换成 `export interface X {`，71 个类型的字段一个都读不出，而 `protocol:check` 照样打印 `Notification field usage: OK` 并返回退出码 0——方法覆盖那侧走的是另一个正则，兜不住它。这类脚本都该有一行「扫到的数量 > 0」断言，本仓的图片链接、文档链接、脚本引用、门禁清单四处都有。
3. **门禁根本没被执行。** 覆盖率退化门禁只挂在 `pull_request` 上、又被 CI 矩阵的 fail-fast 连坐取消，结构上从来没跑成过，分支覆盖于是在 80 个提交里滑走 11pp 而没有任何东西变红（见「必跑门禁」第 18 条）。`test/gate-wiring.test.mjs` 守这一条：`scripts/gates/` 下每个门禁要么出现在展开后的 `test:ci` 链里，要么在 `NOT_IN_CHECK` 白名单里写明为什么不在——默认值落在「新门禁必须接线」这一侧，不依赖谁记得加断言。

### 验证证据写进 commit

没有留痕位置的规则，只约束得住诚实的人。写「已做双向验收」零成本；写「注入 X 到 `file:line` → 精确红 1 条，消息是 Y」写不出来就是没做。`Tested:` / `Not-tested:` trailer 按后者的标准写。

## 自动化覆盖

当前自动化覆盖以下关键边界：

- **共享 app-server**：Transport 单进程/单 request-id 空间、Host single-flight initialize、多 runtime 交错通知、ThreadRegistry 对 thread/turn/request 的一致性校验、无法路由的 server request fail-closed、共享进程退出通知与恢复。
- **原生 thread 事实源**：`thread/list/read/resume` 跨 Codex App/Web 读取续接，`thread/status/changed` 驱动活动状态，契约测试禁止恢复 `sessions.js`、`history.js` 和旧 session history/list 事件。
- **可靠投递**：稳定 `clientRequestId`、payload fingerprint、single-flight、重复 ACK 回放、id 冲突、ledger 容量、`clientUserMessageId` 透传；浏览器 IndexedDB outbox 的先持久化、FIFO、ACK timeout 隔离、gateway epoch、无 thread 的 ledger reconciliation、`thread/read` fallback、provisional instance 恢复、从未尝试记录原 id 重绑、已尝试记录 fresh-id 确认重试，以及 reconcile/retry 互斥防旧 id 复活；fresh-gateway 集成测试断言核对期间 `turn/start` 总计仍为一次。
- **断线恢复**：同 epoch 连续 buffer 增量补发，buffer gap/epoch mismatch 触发精确 `thread/read` snapshot，客户端按 `throughSeq` watermark 缓冲并去重恢复期间的 live events。
- **结构化输入**：attachments 类型、10/20 MiB 业务限制、32 MiB Socket wire cap、0700 上传目录/0600 文件，图片→`localImage`、文件→`mention`，workspace mention、enabled skill、显式门控的 HTTPS image URL 与完整 IPv4/IPv6 DNS/SSRF 拒绝路径。
- **审批与 needs-you**：approval/question 分类、精确 target、snapshot/revision、进程内幂等重放与 conflict/stale/unknown、resolved/expired/revoked 广播和脱敏深链。
- **自托管安全**：HTTPS fail-closed、Origin allowlist、可信代理、HttpOnly device-bound session、query token 拒绝、配对/撤销、外部 trusted-file 原子变更、认证/Push 容量限制、rate-limit 审计聚合、O_APPEND + bounded rotation、宿主配置审计 sink 脱敏，以及 Push DNS pin/总超时/响应上限与持久化失败。
- **产品门控**：宿主配置的逐动作确认与缺确认拒绝。
- **门禁自身**：CI 矩阵关闭 fail-fast、没有 `continue-on-error` 吞掉失败、生产依赖 audit 阻断、覆盖率退化门禁不限于 PR（`test/ci-workflow.test.mjs`）；E2E 必须走 mock 且跑用例前先探测后端版本（`test/zero-quota-guard.test.mjs` + `e2e/assert-mock-backend.js`）；落盘文件不超出 A2 允许的例外（`test/zero-persistence-guard.test.mjs`）；`public/` 外壳的结构性边界——无内联 script、资源引用完整性、样式表顺序、不裸调 `randomUUID`、不用 `Math.random` 生成凭证、不重新引入账号登录（`test/public-shell-guard.test.mjs`）。这几类守的是「规则被违反时会不会有东西变红」，此前全靠文档约定。

  这些是**绊线**，不是实现的镜像：它们从源码里抽事实，只写死「允许什么」。所以重构不会误伤，越界一定变红。新增门禁请照这个形态写——凡是需要复述当前代码长什么样才能通过的断言，重命名一次就会红，而逻辑写反时不会红，净效果是负的。
- **移动端**：流式气泡、thinking、命令/工具/diff/审批/提问卡片、状态栏、PWA/Service Worker、needs-you 恢复、outbox 存储与多实例/多视图隔离。

主要证据分布在 `test/app-server-{transport,host}.test.mjs`、`test/thread-{registry,runtime,source-of-truth,status}.test.mjs`、`test/message-{receipt-ledger,outbox,request}.test.mjs`、`test/recovery-state.test.mjs`、`test/{user-inputs,input-parts}.test.mjs`、`test/server-{integration,security,push}.test.mjs`、`test/service-worker.test.mjs` 和 `e2e/*recovery*.spec.js`。

## 验收矩阵

每个产品场景都按四个维度判断：**功能等价**、**状态可见**、**失败可恢复**、**权限可控**。矩阵的「代码入口」同时是当前功能盘点；文件被删除后必须从这里移除，不能把历史方案继续写成事实。

| 案例 | 场景 | 代码入口 | 主要证据 |
|---|---|---|---|
| 案例 1 | 创建任务 + 流式输出 + ACK/outbox + provisional orphan/fresh-id 恢复 + gap 后恢复会话 + 部署或审核结果 | `server.js`、`message-receipt-ledger.js`、`public/js/message-{request,outbox}.js`、`public/js/{indexeddb-outbox,outbox-recovery,recovery-state}.js` | receipt/dedup 集成测试、outbox 与 recovery 单测、关键流程和 outbox recovery E2E |
| 案例 2 | 执行命令 + 触发权限 + 审批/提问跨 thread 聚合 + exit code 可见 | `approval-broker.js`、`needs-you-registry.js`、`agent-appserver.js` | broker/needs 幂等与冲突测试、关键审批与 needs-you recovery E2E |
| 案例 3 | 产生失败 + 重试恢复（同 id 只读核对 / fresh-id 确认重试）+ backpressure + 长日志移动体验 | `agent-appserver.js`、`message-receipt-ledger.js`、`public/index.html`、`public/js/app.js` | 协议错误/结果未知测试、retry/copy UI 契约、移动视口 E2E |
| 案例 4 | 文件上传 + 结构化附件输入（替代路径字符串“附件注入”）+ transport/business 双层上限 + 0700/0600 安全落盘 | `uploads.js`、`file-security.js`、`user-inputs.js`、`input-parts.js` | user-inputs/input-parts/file-security 单测、>1 MiB wire 集成、附件 E2E |
| 案例 5 | 状态栏 + `thread/status/changed` + git/token/context 状态 | `statusline.js`、`agent-appserver.js` | statusline、thread_status 与 public UI 测试 |
| 案例 6 | 历史浏览 + 工具/变更卡重建 + app-server thread 唯一事实源 + Codex App/Web 双向续接 | `thread-history.js`、`app-server-host.js`、`agent-appserver.js`、`server.js` 的 `thread:*` | thread-history 单测、native thread 集成、workspace-and-composer E2E |
| 案例 7 | 多工作目录 + 实例切换 + 双设备/双 thread 零串流 + 共享单进程 | `app-server-host.js`、`thread-registry.js`、`agent-appserver.js`、`public/js/view-routing.js` | shared-host spawn/initialize、stale target、route/workdir、多实例 E2E |
| 案例 8 | Web Push + DNS/address pinning + bounded response + needs-you 脱敏深链 + device revoke | `server.js`、`push-sender.js`、`network-address.js`、`needs-you-registry.js`、`public/js/sw.js` | Push DNS/mixed-IP/timeout/body-cap 单测、authenticated persist/prune、service worker 和 needs-you E2E |
| 案例 9 | 模型切换 + 权限档切换 | `agent-appserver.js`、`server.js`、`public/index.html`、`public/js/app.js` | model/permission UI、宿主配置逐动作确认测试 |
| 案例 10 | PWA 安装 + HTTPS/auth session + 全屏/移动体验 | `server-security.js`、`public/manifest.webmanifest`、`public/js/sw.js` | transport security/session/SW 测试、响应式和 PWA E2E |

## 手工冒烟清单

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

## 无头 Linux 验收

官方 Codex Remote 要求 host 运行 ChatGPT 桌面 app（仅 macOS / Windows），并明确要求「Keep your computer awake and online」。无图形界面的 Linux 服务器不在其支持名单里，而服务器不会休眠——**在无头 Linux 上跑通，是本项目唯一一条官方结构上给不出的承诺**，所以它是验收项而不是加分项。

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

## 真实 Codex 冒烟边界

真实 Codex CLI 不属于默认 E2E。只有在验证本地集成、审批或协议升级且用户明确授权时才运行；使用一次性工作区、受限 sandbox/approval policy，并单独记录它与 mock 门禁的结果。版本与 `.codex-version` 不一致时先走 [PROTOCOL_UPGRADE.md](PROTOCOL_UPGRADE.md)，不要用当前安装版本覆盖基线。
