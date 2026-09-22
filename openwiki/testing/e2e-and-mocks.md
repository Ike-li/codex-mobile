---
type: testing
title: E2E 与 mock 后端
description: 日常回归零模型额度 QUOTA-01 的四道闸、mock codex app-server 模拟了协议的哪些部分、Playwright 的双设备矩阵与 WebKit 的能力边界，以及布局、对比度、滚动三个 E2E 审计库补的是哪个维度。
tags: [testing, e2e, playwright, mock, quota, invariant]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T12:48:39.204Z
sources:
  - id: openwiki-source-4f2678f93d3fd3835f9f2909
    resource: repo://.github/workflows/test.yml
  - id: openwiki-source-801836a699ce852ad1dbc12e
    resource: repo://e2e/assert-mock-backend.js
  - id: openwiki-source-3179653358d9c6f980629507
    resource: repo://e2e/lib/contrast.js
  - id: openwiki-source-ed77fc047730462e2bfd6a00
    resource: repo://e2e/lib/layout-audit.js
  - id: openwiki-source-37d03f2b7289ca64c59f5745
    resource: repo://e2e/lib/scroll-audit.js
  - id: openwiki-source-ebee4a6bd315dc1dfbba354d
    resource: repo://playwright.config.js
  - id: openwiki-source-ecfe6085f82e676d7db71651
    resource: repo://scripts/mock-codex-app-server.js
  - id: openwiki-source-3c84808303bf2a238b1283f7
    resource: repo://scripts/mock-codex.sh
  - id: openwiki-source-a7ae56b78655b85bd45173ee
    resource: repo://scripts/mock-server.js
  - id: openwiki-source-89996081763cb1f55ab5e3fc
    resource: repo://test/invariants/zero-quota-guard.test.mjs
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# E2E 与 mock 后端

## QUOTA-01：日常回归零模型额度

项目规则写着「默认不要调用真实 Codex CLI 或消耗模型额度；E2E 日常回归必须走 mock server」。这条规则此前只是一句文档——违反了不会有任何东西变红，代价却是静默烧额度。

[test/invariants/zero-quota-guard.test.mjs](../../test/invariants/zero-quota-guard.test.mjs) 补了四道断言：

1. **`globalSetup` 必须挂着 mock 探测**。摘掉它之后 `reuseExistingServer` 复用真 CLI 实例就没有任何拦截。
2. **`webServer.command` 必须是 `node scripts/mock-server.js`**。直接起 `server.js` 会接上宿主机真实的 `CODEX_BIN`。
3. **`mock-server.js` 必须显式覆盖 `CODEX_BIN`**，并且 `mock-codex.sh` 的 `--version` 必须自报 `mock-codex`——后者是运行时探测的判据。
4. **测试不得把 `codexBin` 写成字面量 `'codex'`**。

第四条守的是另一件事：字面量 `'codex'` 要靠 PATH 解析，缺失时进程会**静默消失**——没有 TAP 输出、没有 `not ok`、没有错误，只剩一份没有汇总行的日志。CI 的 Node 22 腿因此连续失败五次以上：它跳过「安装 pinned Codex」这一步，而开发机装了 codex 所以永远复现不出来。改用 `process.execPath` 就没有这层依赖。

扫描器是递归的，并配一条 `files.length >= 50` 的地板断言——测试按执行槽分目录之后，扁平扫描会扫到 0 个文件，而「扫到 0 个」与「一个违规都没有」在断言上完全一样。

## 运行时探测：为什么静态检查不够

`playwright.config.js` 里 `reuseExistingServer: !process.env.CI` 在本地是 `true`。如果 E2E 端口上恰好已经跑着一个接了真 Codex CLI 的 server（自己开着调试实例，或 `PORT` 被设成了同一个值），Playwright 会直接复用它。**配置文件本身是对的，错的是运行环境**，只有向正在监听的后端问一句才拦得住。

`assert-mock-backend.js` 读 `/health` 的 `versions.codex`：mock 报 `mock-codex 0.1.0`，真 CLI 报 `codex-cli <版本>`。这个值来自 server 启动时对 `CODEX_BIN` 执行 `--version`，是后端真实接了谁的直接证据。

三种结果：端口空着就放行（Playwright 接下来会自己起 mock）；`/health` 需要鉴权说明这不是 mock（mock 的 `AUTH_TOKEN` 是空的）；版本前缀不对就报错并给出 `lsof -ti :<port> | xargs kill`。

探测带重试（6 次 × 250ms），避免把「mock 还在启动」误判成「没有 server」。

同一个复用机制也解释了一类容易误判的现象：端口 3232 上已经有别的实例时，这一轮 E2E 跑的是那个实例，本地改动根本没被测到。

## mock 后端的两层

**`scripts/mock-server.js`** 是 E2E 的服务入口。它做三件事：

1. 在临时目录里搭一个数据目录并初始化设备表文件；
2. 把工作区做成一个**带三种改动状态的 git 仓库**（未暂存、已暂存、未跟踪），分支名固定成 `work`；
3. 覆盖一批环境变量（`CODEX_BIN` 指向 `mock-codex.sh`、端口 3232、空 `AUTH_TOKEN`、`read-only` sandbox），然后 `import` 真正的 `server.js`。

第二件事有来历：在这之前临时目录不是仓库，工作区面板的「改动」标签渲染出来是一个完全空的框，那条 `expect(#git-changes-body).toBeVisible()` 在空 body 上也是绿的，验不到分组渲染。分支名固定是为了让截图和断言不受 `init.defaultBranch` 的本机配置影响。`.gitignore` 挡掉服务器自己的运行时产物，否则它们会混进「未跟踪」分组并出现在截图上。

git 不可用时退回非仓库工作区——其余 E2E 不依赖仓库状态，只有「改动」标签会退化成空框。

**`scripts/mock-codex-app-server.js`**（约 870 行）在 stdio 上模拟 JSON-RPC 协议，覆盖 `initialize`、`thread/*`（start / resume / read / list / archive / unarchive / settings update）、`turn/*`（start / steer / interrupt）、`review/start`、`account/*`、`skills/list`、`config/read`、`configRequirements/read`、`model/list`、`modelProvider/capabilities/read`、`mcpServerStatus/list`，并会主动发起审批请求。

它刻意保留了一些真实语义，例如**归档态**：`thread/list` 若忽略 `archived` 参数，前端「显示已归档」这条往返链路就无法回归——两份视图会永远返回同一批会话，任何过滤 bug 都测不出来。fixture 的 markdown 也刻意覆盖表格、标题、引用、分隔线，因为 marked 开着 `gfm: true`，真实回复里这些都会出现。

## 浏览器矩阵

两个 project：`mobile-chrome`（Pixel 5）与 `mobile-webkit`（iPhone 13）。

加 WebKit 的理由：产品主设备是手机，而此前浏览器侧只覆盖 Chrome，iOS Safari 是零。WebKit 比 Firefox 更接近 iPhone。

**但它验不了 iOS 真机上最容易挂的那几件事**：PWA 安装（iOS 的路径是分享→添加到主屏幕）、真实 Web Push（要 16.4+ 且已添加主屏）、软键盘几何、Safari 的存储驱逐。那些只能在 iOS 真机上人工验证，别把这条 project 当成它们的替代。

`remote-origin-handshake.spec.js` 在 WebKit 上被排除：它靠 Chromium 的 `--host-resolver-rules` 把一个非 loopback 主机名映射到 127.0.0.1（那是不要 root 权限就能走到「远程」分支的唯一办法），WebKit 没有等价参数。**排除不是妥协**：那两条测的是服务端的 Origin 判定分支，与浏览器引擎无关，在 WebKit 上重跑一遍不产生新信息。

CI 安装浏览器时 `--with-deps` 不能省：runner 镜像自带 chromium 要的系统库，但没有 webkit 要的 libgtk-4 / libgraphene / libevent / libopus / libgst*。缺它们时浏览器二进制装得上、启动即失败，每条用例 3-4ms 就红——看起来像用例写坏了，其实一次都没跑起来。这条腿加进矩阵后曾长期从未真正执行，而这一直被前面单测的红挡着。

其余配置：`fullyParallel: false`、单 worker、CI 上重试 1 次、失败时截图、首次重试时录 trace。

## 三个审计库

`e2e/lib/` 下的三个库补的都是同一类缺口：**已有断言全绿，而用户一眼就看出不对**。

| 库 | 已有断言问什么 | 它问什么 |
|---|---|---|
| `layout-audit.js` | 会不会崩（没撑破容器、能横向滚动、overflow 值对） | **读不读得了** |
| `scroll-audit.js` | 滚没滚到位（贴底、不抢回、能跳到最新） | **滚得连不连贯** |
| `contrast.js` | —— | 这个前景色在这个背景上读不读得了（WCAG 绝对判据） |

`layout-audit` 的动机是一个具体案例：宽表格的第 4 列被挤到 49px 宽，21 个字的中文压成一根竖条把整行撑到 286px，而四条结构性断言一条都没红。

**为什么不做 pixel diff**：截图对比只能发现「和上次不一样」，发现不了「从第一天起就是错的」。上面那个表格如果现在做基线，49px 会被固化成「正确的样子」，修好了反而变红。

`scroll-audit` 的判据是**静止帧占比**而不是跳变幅度：瞬时 `scrollTop` 赋值下实测 92% 的帧纹丝不动、剩下 8% 整齐跳 46px，而跳变幅度取决于行高和内容到达速率，换个 fixture 就不成立。

`contrast.js` 与语义色那份 spec 的分工也值得记：后者用 `toEqual` 锁住「观感不变」，适合纯重构；前者守的是可读性，在颜色**有意改变**时仍然成立。

## E2E 用例分布

约 30 个 spec 文件，按关注点分成几族：审批与「需要你」、投递与 outbox 恢复、会话与抽屉操作、工作区与输入框、渲染与消毒、排版与布局、配色与指针可供性、PWA/SW、连接与握手、原生控件、功能开关。

日常跑 `npm run test:e2e`；完整门禁链见[门禁链路与 CI 接线](gates-and-ci.md)。
