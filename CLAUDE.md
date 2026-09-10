# AGENTS.md

## 项目规则

- 分支固定为 `master`（主分支）和 `dev`（开发分支）。所有开发、修复及文档修改只在 `dev` 上进行，不再创建功能开发分支，也不直接在 `master` 上修改。
- 开始修改前运行 `git branch --show-current`；不在 `dev` 时先安全切换并保留未提交改动。验证通过后由 `dev` 合并到 `master`；合并、推送按用户授权执行。
- 和软件相关的修改默认遵循 TDD：先写能表达预期的失败测试，再做最小实现或文档修复，最后运行真实验证。
- 先读现有代码、测试和文档；不要凭项目名或旧方案稿猜架构。
- 生产基线是通过 stdio 运行的 `codex app-server`，不再使用旧的 `codex exec --json` 方案。
- 默认不要调用真实 Codex CLI 或消耗模型额度；E2E 日常回归必须走 mock server。
- 不要提交本地状态、密钥、运行日志、Playwright 报告、`.playwright-mcp/` 或 `data/`。

## 常用命令

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
```

## 维护文档

自用工具，文档只留事实来源。2026-09-10 删掉了面向外部读者的那一层（入门教程、任务配方、故障排查、功能巡览、能力矩阵、UI 地图、概念解释、71 条人工冒烟清单、CONTRIBUTING、SECURITY、英文 README），共约 3500 行——验收由 `npm test` 和 `npm run test:e2e` 承担，那些文档没有读者。

- `README.md`：项目概览、配置项、本地运行（中文）。
- `LICENSE`：AGPL-3.0 全文，与 package.json 的 `license` 字段保持一致。
- `ROADMAP.md`：已完成 / 进行中 / 候选。
- `docs/FEATURES.md`：功能清单（按最小单位拆分，每条带代码出处）。改功能时同步这里。
- `docs/ARCHITECTURE.md`：当前架构和安全模型。
- `docs/PROTOCOL.md`：Codex app-server 协议参考。
- `docs/API.md`：接口参考（HTTP + Socket.IO 事件签名）。
- `docs/TESTING.md`：测试门禁与验收矩阵。
- `docs/REMOTE_ACCESS.md`：从手机连接的 HTTPS/PWA/Push 硬限制与方案。
- `docs/PROTOCOL_UPGRADE.md`：Codex app-server 协议升级流程。

新增文档前先问：它是事实来源，还是给不存在的读者写的教程？

`test/acceptance-doc.test.mjs` 守两类东西：**客观缺陷**（死链、引用了不存在的图片/文档/脚本、许可证与 package.json 不一致、文档里的 npm script 不存在）和**具体教训**（每条注释里写明是哪一次踩坑）。它的扫描面是**递归遍历** `.md` 而不是手写清单——手写清单在这次删文档时有 6 个条目直接 ENOENT。

它**不**冻结文档的标题和措辞——上一版那样做过，401 行里六成在断言标题字面存在，结果是改一次措辞就红，而正文写错一条都抓不到，那个文件因此被追着改了 12 次。新增文档约束前先问：违反了，读者会被坑吗？答案是「只是不好看」就不要加。

## 门禁脚本放哪

新写的门禁一律放 `scripts/gates/`，不要放 `scripts/` 根——那里是 mock、smoke 和运维脚本。`test/gate-wiring.test.mjs` 守着 `scripts/gates/` 下每个文件：要么出现在展开后的 `test:ci` 链里，要么在 `NOT_IN_CHECK` 白名单里写明为什么不在。默认值因此落在「新门禁必须接线」那一侧，不依赖谁记得补一条「我被接线了」的断言。

**它守不住放错目录**：门禁写在 `scripts/` 根、又没接线，gate-wiring 根本扫不到它，`npm run test:ci` 照样全绿（2026-09-08 实测）。这是结构性的——「某个脚本算不算门禁」没有可靠的语法特征，按 `check-` 前缀猜会漏掉 `protocol-check.mjs`。所以这一条只能靠人记得，而代价是那道闸从来没被执行过、却占着「这块有人守」的位置：覆盖率退化门禁只挂在 `pull_request` 上又被 fail-fast 连坐取消，结构上从没跑成过，分支覆盖在 80 个提交里滑走 11pp 而没有任何东西变红。

写门禁本身的注意事项（扫描面塌陷断言、两侧验收、变异测试抓不到的三类）在 `docs/TESTING.md`。
