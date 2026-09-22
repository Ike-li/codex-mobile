---
type: testing
title: 门禁链路与 CI 接线
description: scripts/gates 下五道静态门禁各卡什么、test:ci 的递归展开、「加进 test:ci」与「CI 上真的会跑」为什么是两件事，以及 GitHub Actions 的矩阵分工与依赖审计的阻断/咨询双轨。
tags: [testing, ci, gates, github-actions, coverage, wiring]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-4f2678f93d3fd3835f9f2909
    resource: repo://.github/workflows/test.yml
  - id: openwiki-source-a7d435908d0721e4eb6a0989
    resource: repo://docs/TESTING.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-313501d09860c2a59a12a7e6
    resource: repo://scripts/gates/check-coverage-delta.js
  - id: openwiki-source-0e4ff78481dd57d3ec2a8d6e
    resource: repo://scripts/gates/check-invariant-ids.js
  - id: openwiki-source-79177030e7b5a190389a9ec0
    resource: repo://scripts/gates/check-test-summary.js
  - id: openwiki-source-51e7f6d025aeb93d5e169e95
    resource: repo://test/infra/ci-workflow.test.mjs
  - id: openwiki-source-945368b941bdc3d4851ca74a
    resource: repo://test/infra/gate-wiring.test.mjs
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 门禁链路与 CI 接线

## 五道静态门禁

`scripts/gates/` 下每个文件都是一道会红的闸。目录本身承载判据——见下文「为什么门禁要独立成目录」。

| 门禁 | 卡什么 |
|---|---|
| `protocol-check.mjs` | 协议漂移四类，见[协议基线](../integrations/codex-app-server-protocol.md) |
| `check-import-boundaries.js` | 分层、循环依赖、平铺区，见[模块边界](../architecture/module-boundaries.md) |
| `check-invariant-ids.js` | 不变量编号双向闭合 |
| `check-test-summary.js` | `node --test` 的 cancelled / skipped |
| `check-coverage-delta.js` | 覆盖率绝对下限 + 相对跌幅 |

### check-test-summary：全绿是最贵的失败模式

`node --test` 把 `cancelled` 与 `skipped` 和 `fail` 分开计数，而**退出码不一定反映它们**。一次「fail 0」的运行可能实际上有整片用例根本没跑。

这不是假想：`app-server-transport.test.mjs` 的 4 个用例曾在每一次运行里被标记 cancelled——请求超时定时器是 `unref` 的，测试等它时事件循环已排空，`node --test` 判定「promise 仍挂起而事件循环已结束」，把该用例连同其后三个一并取消。超时、子进程退出、子进程错误和 dispose 四条错误路径因此长期未被验证，而汇总显示 fail 0。

那个具体问题修了，但没有任何机制防止复发——这个脚本就是那道防线（不变量 `GATE-02`）。

两个实现细节：汇总行的正则要求**整行只有「符号 + 关键字 + 数字」**，免得把测试名或注释里出现的这些词当成汇总；解析不到汇总行一律当失败（fail-closed：报告格式变了而我们读不懂时，沉默放行等于把这道门拆了）。

它还是**落盘隔离的硬编码注入点**：`test/setup/preload-env.mjs` 由这个包装器强制加 `--import`，走这条路的测试不可能忘记。绕过包装器的入口（`test:local` / `coverage`）各自在 `package.json` 里显式写同一份预加载。

### check-coverage-delta：两层阈值

绝对下限 statements 80 / branches 60 / functions 80 / lines 80；相对基线（`.coverage-baseline.json`）最大跌幅 2 个百分点。

数据取自 c8 的 **json-summary** 而不是解析文本表格。早期实现用 `npx c8 … | tail -20` 取输出尾部再正则匹配 `All files`，但那一行位于表头下第一行、后面还跟着每个源文件一行，全量测试的表格远超 20 行，汇总行必然被截掉——门禁于是每次都以「无法解析覆盖率报告」退出 1，静默失效。

### check-invariant-ids：四种失效各自会红

`test/invariants/` 与 `test/unit/` 的执行槽完全相同（同一条 `npm test`、同一份预加载），分的只是组织轴。**没有任何运行时后果的分类，靠人记是守不住的**：放错目录不会红，写错编号不会红，删掉一条红线而留着登记也不会红。

四种失效形态各自单独会红：

1. `invariants/` 下的文件没写守护行 —— 它凭什么在这个目录；
2. 守护行引用了登记表里没有的编号 —— 悬空引用，读者查不到红线正文；
3. 登记表里的编号在整棵 `test/` 树里没人提 —— 死条目，会继续以「已经有测试了」的身份占位；
4. 扫描面塌陷（0 个文件或 0 行登记）—— 与「全部合规」在断言上不可区分。

第 ③ 条的扫描面**故意放宽到整棵 `test/` 树**：有两条不变量（`GATE-02`、`TEST-01`）是由门禁守的，而按判据「测门禁的文件住 `test/infra/`」，它们不在 `invariants/` 下。收窄会把这两条误判成死条目，然后把人逼去删一条真红线。

编号正则也踩过一次：上一版只写 `/\b([A-Z]+-\d+)\b/`，匹配不到 `A2` 与 `D6`，还会把 `R-SEC-1` 切成 `SEC-1`——**半匹配比匹配不到更坏**，它会在报错信息里给出一个看着像真的、其实不存在的编号。

`// 守护：` 后面空着仍然**是**一条守护行，只是没写编号。用 `(.+)` 会把它判成「不是守护行」，报错信息说「第 2 行不是守护行」，而人明明写了那一行，照着提示去加只会加出第二条。

## 「在链里」有两层

**不在链里的门禁等于不存在——而「在链里」有两层，缺一层都是静默失效。**

### 第一层：test:ci

```bash
npm run test:ci
# = lint && protocol:check && check-import-boundaries && check-invariant-ids
#   && npm test && check-coverage-delta && test:e2e
```

[test/infra/gate-wiring.test.mjs](../../test/infra/gate-wiring.test.mjs) 要求 `scripts/gates/` 下每个文件要么出现在**递归展开后**的 `test:ci` 里，要么在 `NOT_IN_CHECK` 里写明为什么不接。

展开必须递归，而且要认 `npm test`（npm 的内置别名，不写 `run`）：`check-test-summary.js` 正是通过 `npm test` 间接接线的，漏掉展开会把它误判成没接线。

**为什么是白名单而不是给每个门禁加一条「我被接线了」断言**：后者是用治理治治理——加一个门禁要记得加一条断言，而「记得」正是失败的那一步。只列例外的话，新增门禁默认就必须接线，忘了就红，**默认值落在了不需要人记性的那一侧**。

**为什么门禁要独立成 `scripts/gates/`**：这道闸的判据就是「这个目录里放的都是门禁」。门禁与 mock/smoke/运维脚本混在 `scripts/` 里时（本仓历史上如此，15 个文件只有 3 个是门禁），白名单要列 12 条例外，而「新增一个 mock 脚本要记得加一条例外」又回到了靠记性。**目录本身就是那句声明。**

### 第二层：workflow

[test/infra/ci-workflow.test.mjs](../../test/infra/ci-workflow.test.mjs) 守的是另一件事：**workflow 不跑 `test:ci`**，它把各段拆成独立 step 逐条写。

于是「加进 `test:ci`」与「CI 上真的会跑」是两件事，而两者看起来完全一样：本地 `npm run test:ci` 全绿，CI 也全绿，但那道闸一次都没执行。加门禁时两处都要改。

这条断言也带扫描面塌陷保护：`test:ci` 里一个门禁都没解析出来就直接报「展开器失配，这条断言已失明」。

断言是关键字层面的，所以直接对 YAML 文本断言、不引入 YAML 解析器——`js-yaml` 在本仓库只是 eslint 的传递依赖，随时可能消失。

## GitHub Actions

给 workflow 写测试的理由很具体：门禁退化是静默的。曾连续四次 CI 失败（含每晚定时任务）都是同一个形状——`test (22)` 挂掉，矩阵默认的 fail-fast 顺手取消了 `test (20)`，而 protocol-check、lint、覆盖率、E2E 全部只在 Node 20 那条腿上跑。GitHub 上看到的是一个红叉，实际情况是**所有真门禁一条都没执行**。同期 security job 常绿，因为它显式吞掉了失败。

现在的形态由六条断言钉住：

| 断言 | 内容 |
|---|---|
| 门禁双层接线 | `test:ci` 里的门禁在 workflow 的 `run:` 步骤里也能找到 |
| 触发面 | `dev` 与 `master` 的 push 都触发 |
| fail-fast | 矩阵必须关掉，一条腿失败不取消另一条腿 |
| 不吞失败 | 没有任何步骤用 `continue-on-error` |
| 依赖审计 | 生产依赖高危漏洞是阻断门禁；全量 audit 即使不阻断，报告也必须留成产物 |
| 覆盖率门禁 | 不只在 `pull_request` 上生效——fast-forward 合并走的是 push 路径，只在 PR 上跑等于给自己留后门 |
| 浏览器 | CI 安装的引擎覆盖 `playwright.config.js` 声明的全部 project |

### 矩阵分工

Node 20 与 22 两条腿，`fail-fast: false`。重的步骤只在 Node 20 上跑：装 pin 住的 codex、protocol-check、lint、两道 import/invariant 门禁、coverage、coverage-delta、Playwright。`npm test` 两条腿都跑。

覆盖率只在 Node 20 上跑的理由写在注释里：产物只从 Node 20 上传，Node 22 那份没有任何步骤消费，却是最重的一步（c8 插桩 + 默认并发的全量测试），跑在一条本来就常被 runner 回收的腿上纯属浪费。

绝对阈值那道门禁不单独跑，因为退化门禁已经包含了它（两处阈值相同，前者是后者的真子集）。

### 依赖审计的双轨

`security` job 独立于测试 job：

- **阻断**：`npm audit --omit=dev --audit-level=high`。本服务的传输层就是 socket.io，运行时依赖里的高危漏洞直接暴露在网络边界上，必须让构建变红。
- **咨询**：全量 `npm audit --json` 写进 artifact，`|| true` 不阻断。devDependencies 的漏洞不上生产，但**报告必须留成 artifact，否则等于没跑**。

## 其余命令

| 命令 | 用途 |
|---|---|
| `npm run test:local` | `--test-isolation=none` 快速跑；**不经 check-test-summary 包装**，不能用它判断门禁是否通过 |
| `npm run coverage` | c8 插桩全量，产出 `coverage/` |
| `npm run test:docker` | 容器里跑 `npm test` |
| `npm run mutate:docker` | 变异测试，只在容器里跑 |
| `npm run protocol:check:installed` | 对着本机装的 codex 跑，升级前预检 |

策略层面的判据（一条测试该进哪个槽、失败方向怎么选）见[测试策略](strategy.md)。
