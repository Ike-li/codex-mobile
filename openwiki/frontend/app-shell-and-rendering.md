---
type: subsystem
title: 前端外壳与消息流渲染
description: public/ 外壳的结构性边界 SHELL-01、app.js 与八个功能域的分工、agent:event 的四向准入分流、流式 markdown 的增量切分与消毒顺序、ANSI 渲染，以及连接横幅与分层健康诊断。
tags: [frontend, rendering, markdown, sanitization, streaming, invariant]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-a7d435908d0721e4eb6a0989
    resource: repo://docs/TESTING.md
  - id: openwiki-source-d85db9feecf57beff619c54b
    resource: repo://public/index.html
  - id: openwiki-source-9a046adaa509d42f9f907997
    resource: repo://public/js/net/connection-banner.js
  - id: openwiki-source-11130a73e910522229c89197
    resource: repo://public/js/net/health-diagnosis.js
  - id: openwiki-source-f35e3e9c71d5f85ec3402239
    resource: repo://public/js/render/ansi-html.js
  - id: openwiki-source-022b5962ce850262fb5acb53
    resource: repo://public/js/render/event-presentation.js
  - id: openwiki-source-5ea2eb9a269ac6426871b68f
    resource: repo://public/js/render/markdown-stream.js
  - id: openwiki-source-fe42b857cd0131cde879d9a7
    resource: repo://public/js/render/markdown.js
  - id: openwiki-source-f4591175bef110446ba5c03e
    resource: repo://public/js/render/transcript-stream.js
  - id: openwiki-source-513c38891778d5ae1a9c736a
    resource: repo://public/js/render/turn-outcome.js
  - id: openwiki-source-29a3d953ca6700fa49f25322
    resource: repo://public/js/ui/ui-preferences.js
  - id: openwiki-source-afe060508807c5adf2aba90a
    resource: repo://test/invariants/public-shell-guard.test.mjs
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 前端外壳与消息流渲染

前端是一个没有构建步骤的原生 ESM 应用：`index.html` 引三个 vendored 库和 Socket.IO 客户端，再以 `type="module"` 加载 `app.js`；`app.js` 约 4400 行，从八个功能域 import 48 个模块。

那 4400 行是本仓公开承认的最大测试债。抽不出来的东西留在 `app.js` 里，抽得出来的纯逻辑一律搬进 `public/js/<域>/` 并配真 import 单测——`public/js/` 下的模块就是历次「抽出来」的产物。

## SHELL-01：外壳的结构性边界

[test/invariants/public-shell-guard.test.mjs](../../test/invariants/public-shell-guard.test.mjs) 守的是**越过边界就红**，不是**复述实现长什么样**。这条区分有来历：它的前身 `public-ui.test.mjs` 有 1807 行、90 个 test，其中 75 个是「切一段 `app.js` 的源码文本，再正则断言它长什么样」。三条实测的代价被记在文件头：

1. 文件里有 **374 行逐字重复**的段落，15 个 test 跑了两遍。879 个测试全绿，没有任何东西发现它——文件大到没人能通读，就是它失去审阅价值的那一刻。
2. 两条断言互相打架而同时绿：一条要求源码里必须出现 `crypto.randomUUID()`，另一条禁止裸调它。**门禁在阻止修 bug**。
3. 样式与布局断言在 e2e 里已有真浏览器 `getComputedStyle` 的版本，文本 grep 是同一件事的弱化重复。

删掉之后覆盖率一点没掉（91.30 → 91.33），因为它从不 `import`，对被测代码的执行覆盖始终是 0。

现在剩下的绊线只有八条，都是客观属性：无内联 `<script>`（可以写进 CSP）、引用的样式表与脚本都能解析到真实文件、应用样式表排在 hljs 主题之后、hljs 双主题按配色互斥加载且与第三方登记一致、不裸调 `crypto.randomUUID`（非 secure context 里它不存在）、不用 `Math.random` 生成凭证或请求 id、不重新引入 ChatGPT 账号登录。

扫描器**递归**遍历 `public/js/`：扁平 `readdirSync` 对子目录里的新文件完全看不见，那样这道闸会静默只守住存量而新代码不受约束，症状还是全绿。每个消费者另有一条扫描面下限断言兜底。扫描时跳过整行注释——注释里提到某个名字通常是在解释为什么不能用它。

## 事件准入：四个去向

每条 `agent:event` 只能落在四个去向之一，由 [event-presentation.js](../../public/js/render/event-presentation.js) 判定：

| 去向 | 含义 |
|---|---|
| `stream` | 进对话：用户消息、助手正文、工具活动、审批、需要人处理的失败 |
| `chrome` | 顶栏、抽屉、设置、用量环——有自己的表面 |
| `silent` | 丢掉：别的表面已经反映了，或只是过程噪音 |
| `debug` | 未识别协议。**禁止自动把 JSON 插进 `#messages`** |

未知类型一律进 `debug` 而不是 `stream`，这是 fail-safe 的方向：上游加一个新事件类型时，用户看到的是什么都没发生，而不是一坨原始 JSON。

`system` 类事件还要看 payload：命中协议泄漏正则（`unsupported server request` 之类）进 `debug`；`willRetry` 或背压码 `-32001` 进 `silent`（重试进度不该刷屏）；`isError` 进 `stream`。

`mcp_status` 单独判：噪音（starting / ready 刷屏，实测一次对话 8 条系统消息会把回答挤出首屏）静默，但 `error` 非空或状态是 `failed`/`error`/`crashed` 时**不受偏好开关影响**——噪音与告警不共用一个开关。

## 流式渲染

三层配合：

**`createTranscriptStream`** —— 节流层。delta 进来先累积，40ms 合并一次 `onText`，避免每个 token 都触发一次渲染。

**`splitStreamingMarkdown`** —— 切分层。把流式文本切成「已定型的前缀」`stable` 和「还在变的尾部」`active`。stable 渲染成 DOM 之后不再重建，每帧只重渲染 active。不这么做的话每 40ms 要把整段文本重新 parse + sanitize + highlight，成本随已生成长度线性增长，长回复必卡。

切点的选择有两条讲究：

- **围栏内的空行不是切点**，它是代码的一部分。闭合围栏要同字符且不短于开启标记，否则三个反引号收不掉四个波浪号。
- **候选切点要等下一个非空行到达才能判定**。空行两侧都是列表/引用延续时，说明它夹在同一个块内部，切开会改变 marked 的松散/紧凑判定。而且只有标记、还没跟内容的半截行（`-`、`1`）一律保守算延续——流式文本的最后一行随时会变长，判定翻转会让切点回退，已画好的 stable DOM 就和文本对不上。代价是晚一帧进 stable，换来**单调性**。

**`renderMarkdown`** —— 渲染层。`marked.parse`（gfm + breaks）→ `DOMPurify.sanitize` → `enhanceCodeBlocks` → `wrapTables`。

## 消毒的顺序是被逼出来的

`enhanceCodeBlocks` 有意跑在 sanitize **之后**。这看着像危险形态（消毒完了又拼 HTML），但它注入的包装层里有一个 `<button class="code-copy-btn">`，而 `button` 在 `FORBID_TAGS` 里——先拼后消毒会把复制按钮自己消掉。

安全性因此不能靠顺序，只能靠 `enhanceCodeBlocks` 自己**只拼固定结构、且不把任何已转义的内容还原成 HTML**。这条性质由 [e2e/markdown-sanitization.spec.js](../../e2e/markdown-sanitization.spec.js) 在真浏览器里守着，判据是「脚本执行了没有」——把这两行对调会让那个文件变红。

消毒配置除了默认规则，额外禁掉表单类标签与 `style` / `for` / `contenteditable` 等属性，并用 `afterSanitizeAttributes` 钩子给所有 `<a>` 强制加 `target="_blank"` + `rel="noopener noreferrer"`。

`wrapTables` 给表格包一层滚动容器。为什么不能让 `<table>` 自己滚：`max-width` 会把**内部表格算法**的可用宽度夹到阅读栏宽度，表格并不知道外面能滚，于是老老实实在 361px 里分配 4 列；不可断行的 ASCII 路径 min-content 很大抢光空间，中文的 min-content 是一个字，于是「说明」列被压到 49px，21 个字压成一根竖条。拆成两个元素后各管各的。

宽表格的边缘渐隐由一个模块级 `MutationObserver` + `ResizeObserver` 维护，不在 `wrapTables` 里做——它只产出 HTML 字符串，真正的 overflow 要等表格进 DOM、完成布局之后才知道。

## ANSI 与工具卡片

`renderAnsi` 把带 ANSI 码的工具输出渲染成 HTML。它被抽出来的理由不是体量（50 行），而是三条同时成立：纯函数、**安全关键**（输出直接进 `innerHTML`，而输入是 agent 执行任意命令产生的），以及在原来的 IIFE 里完全无法单元测试。

它只认少数几个 SGR 码，其余（256 色、真彩色、背景色）一律忽略——不认识的码不该变成 class 名进到 HTML 里。

`tool-cards.js` 负责命令卡片与文件变更卡片，`agent-activity.js` 提供活动文案模型：同一条活动在进行中和完成后用两套时态，两者不共用字符串（「运行命令」既不是正在运行也不是运行过）。

`turn-outcome.js` 的判据值得一提：完成页不能只显示模型的自述，「改了哪些文件、跑过哪些验证、哪些失败了」都能从本轮的聚合 diff 与命令执行记录**客观导出**，不需要相信模型怎么说自己。

## 连接状态与健康诊断

`resolveConnectionBanner` 是一个纯判定：`connecting` 要等 800ms 才显示（短暂重连不该闪横幅），`offline` 等 1000ms，两者在 5 秒后才给「重试」按钮，`online` 只在之前显示过横幅时短暂显示 1.6 秒的「已重新连接」。

`resolveInsecureTransportBanner` 用 `isSecureContext` 判断是否明文连接。局域网模式不强制 TLS——强制自签证书会大幅抬高接入成本；代价是令牌和全部流量在这张网里是明文的，而**用户必须看得见这件事**：家里可以接受，咖啡厅的 WiFi 不行，这个判断只能由用户自己做。拿不到该能力时视为安全，免得在不支持的环境里长期挂一条吓人的横幅。

`diagnoseHealth` 把「连不上」拆成六层（`browser` / `network` / `gateway` / `appServer` / `codex` / `upstream`），按顺序返回**最外层的坏点**：修好它之前，里层是好是坏都无从验证，所以报里层只会误导。自托管产品最高频的求助就是「连不上」，而每层的处理方式完全不同——换网 / 查隧道 / 重启服务 / 看 codex / 换上游。

上游报错被标成 `actionable: false`：问题不在这台机器上，免得用户去重启一堆没关系的东西。

## 相关测试

前端的行为判据主要在 e2e（真浏览器、真 `getComputedStyle`）：`markdown-sanitization`、`markdown-typography`、`semantic-color-tokens`、`pointer-affordances`、`header-layout`、`layout-sanity`、`transcript-hygiene`、`rich-event-rendering` 等。可提取的纯逻辑各有单测。详见[测试策略](../testing/strategy.md)与[E2E 与 mock 后端](../testing/e2e-and-mocks.md)。
