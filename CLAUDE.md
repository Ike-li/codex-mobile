This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> `AGENTS.md` 是指向本文件的符号链接。修改本文件即同时更新两者，不要新建独立的 `AGENTS.md`。

## 项目规则

- 分支固定为 `master`（主分支）和 `dev`（开发分支）。所有开发、修复及文档修改只在 `dev` 上创建功能开发分支，也不直接在 `master` 上修改。
- 合并、推送按用户授权执行。
- 和软件相关的修改默认遵循 TDD：先写能表达预期的失败测试，再做最小实现或文档修复，最后运行真实验证。
- 先读现有代码、测试和文档；不要凭项目名或旧方案稿猜架构。
- 生产基线是通过 stdio 运行的 `codex app-server`，不再使用旧的 `codex exec --json` 方案。
- 默认不要调用真实 Codex CLI 或消耗模型额度；E2E 日常回归必须走 mock server。
- 不要提交本地状态、密钥、运行日志、Playwright 报告、`.playwright-mcp/` 或 `data/`。

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
