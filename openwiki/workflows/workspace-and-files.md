---
type: workflow
title: 工作区、文件浏览与 git 视图
description: 多工作目录白名单如何解析与路由、fs/* 操作的作用域闸门与安全审计、文件搜索的候选缓存与限额、git status/diff 的解析与体量上限，以及文件预览与 diff 摘要在手机上的取舍。
tags: [workspace, files, git, scope, search, diff]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-37541c38bd7b18aab964a806
    resource: repo://public/js/files/display-path.js
  - id: openwiki-source-37c3f64c9430458ace999e6c
    resource: repo://public/js/files/file-diff-summary.js
  - id: openwiki-source-f811ecb74185759349e8bdbe
    resource: repo://public/js/files/file-preview.js
  - id: openwiki-source-a16ce17a4dfcdb501a4b4d11
    resource: repo://public/js/files/workspace-panel.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-78dc77cd4869bcff785b17e7
    resource: repo://src/files/file-search.js
  - id: openwiki-source-4d5d622b88cfcfb5d3698afb
    resource: repo://src/files/git-workspace.js
  - id: openwiki-source-3a71eac13c36908c44e03f7d
    resource: repo://src/files/workdir-allowlist.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 工作区、文件浏览与 git 视图

## 工作区白名单

两条入口，判据是配置里有没有 `WORKDIRS`：

| 入口 | 形态 | 主工作目录 |
|---|---|---|
| `resolveWorkdirsFromEntries` | `codex.config.json` 的 `WORKDIRS` 数组 | **首项** |
| `resolveWorkdirAllowlist` | `.env` 时代的 `WORK_DIR` + `WORK_DIRS` | `WORK_DIR` |

**不把数组 `join(',')` 喂回旧入口**：含逗号的目录名会被重新拆坏，而拆坏之后看起来仍像是配好了。

两条入口都对「一个工作区都没有」**fail-loud**。空白名单的后果不是「没有工作区」，而是**范围判定失去参照**。旧入口还把「没配」与「配错了」分成两条不同的消息——前者说「不配时不会回落到家目录」，后者说「路径不存在」，而这两件事的下一步动作完全不同。

新入口对相对路径直接抛错：相对路径会让允许列表**取决于进程从哪个目录启动**，而那是权限边界不该依赖的东西。

所有路径都过 `realpath` 归一并去重。不可用的附加目录**跳过并告警**，不影响启动。

## 作用域闸门

`resolveWithinWorkdirs` 是 `fs/*` 的唯一判据。为什么必须在这一侧：

> app-server 的 `fs/*` 只校验「是不是绝对路径」——它假定 client 与自己同机、物理接触即可信。**我们的 client 是远程手机，那个假定不成立。**

目的写得很清楚：**防误操作，不是防攻击者**。能发消息的设备照样可以让 agent 去读同一个文件。它挡住的是「随手翻文件翻到 `~/.ssh/id_rsa`」，以及把工作区外的凭据挡在默认视野之外——**凭据外泄是唯一撤销设备也收不回的破坏**。

两个实现细节：

- **目标可以尚不存在**（新建文件场景）。做法是对最近的已存在祖先做 `realpath`，再把不存在的尾巴接回去——不存在的组件不可能是软链接，所以拼回去不会重新打开逃逸口。
- **必须比到分隔符**：只用 `startsWith` 的话 `/srv/work` 会顺带放行 `/srv/work-other`。

越界时 `requireWorkspacePath` 写一条 `workspace_scope / denied` 安全审计并抛错。**只记拒绝**：那是安全事件，而放行的读取太频繁（文件浏览器持续列目录），逐条记会把审计淹掉。

多工作目录的路由很简单：`routeCwd(cwd)` 只在传入值确实在 `workDirs` 里时采用，否则回落到主工作目录。

## 文件搜索

`searchFiles(cwd, query)` 分两步。

**候选来源**优先 `git ls-files --cached --others --exclude-standard`（一次子进程，3 秒超时）。不是 git 仓库或失败时退回自己走目录树：最大深度 6、最多 5000 个候选、跳过 `node_modules` / `.git` / `.worktrees` 与所有点开头的条目。

遍历用**异步 `readdir`**：最坏要走 5000 个候选 × 深度 6，同步版本会把整个事件循环钉住——而这条路径正是非 git 工作区里打 `@` 时走的。

候选列表按 cwd 缓存 5 秒。`@` 提及是逐字符触发的，没有缓存等于每个字符一次 `git ls-files`。

**匹配**是四档的子序列打分：basename 子串 → 全路径子串 → basename 子序列 → 全路径子序列，同档按路径长度、再按字典序。上限 50 条。空 query 时按字典序返回前 50。

## git 视图

`listGitChanges` 用 `git status --porcelain=v1 -z` 并自己解析：`-z` 的记录以 NUL 分隔，而重命名/复制（`R` / `C`）**占两条记录**（新路径 + 旧路径），解析器要据此跳两格。

分类成四组：`staged`（X 位是 `MADRC`）、`unstaged`（Y 位是 `MDT`）、`untracked`（`??`）、`conflicted`（七种双字母组合）。同一个文件可以同时出现在 staged 与 unstaged 里，这是 git 的真实语义。

分支名先试 `symbolic-ref --short HEAD`，失败（detached HEAD）退回 `rev-parse --short HEAD`。两次都失败且错误文本像「不是 git 仓库」，就回 `not_git`——这是一个**正常状态**而不是错误，工作区本来就不必是仓库。

上限 500 条，超出时截断并置 `truncated`；status 超时 2 秒、diff 超时 3 秒、缓冲 1MB。

`readGitDiff` 的路径校验 `assertSafeRelPath` 除了常规的「相对路径且不逃逸」，还**拒绝含 glob 与特殊字符的路径**（`*?[]\:` 与 NUL）——它们会被 git 当成 pathspec 展开。

diff 上限 256KB，超出截断；检出二进制（`Binary files ... differ` 或含 NUL）时直接回一句说明，不把字节糊到手机上。

## 手机上的取舍

**文件预览** `buildPreview` 的核心是**告诉用户内容被截了**。抽出来之前同一条规则有两个调用点、两套参数、两种解码实现（一处截 8000 字符用 `decodeURIComponent(escape(atob()))`，一处截 2000 字符用 `TextDecoder`），而**两边都不说被截了**——于是「看到文件末尾」与「被切在这里」在界面上长得一模一样，而预览的用途恰恰是让人判断要不要引用这个文件。

二进制判据是「出现 NUL，或 U+FFFD 替换字符占比超过 10%」。按比例判而不是「出现即二进制」，因为正常文本里偶尔出现一两个是可能的。判为二进制时 body 是一句说明而不是内容——**渲染乱码没有任何信息量，而用户会以为是编码坏了，转而去查一个不存在的问题**。

截断提示语与 body 分开返回，让调用方决定放哪、用什么样式。

**写入前的 diff 摘要** `summarizeTextChange` 不做完整 LCS：文件编辑的实际形态几乎总是「中间某一段变了，头尾原样」，剪掉公共前缀和公共后缀之后剩下的就是变化区间。代价是相邻的多处改动会被并成一段——**确认框本来也不适合逐处审阅，那是桌面端的事**。hunk 上限 20 行。

存在理由：写入前的确认要能看出「改了什么」，不能只问「要覆盖吗」——**手机误触代价太高**。

**路径显示** `compactPath` 只保留最后两段。界面上出现宿主机绝对路径是一条横切的失败判据：`/Users/<用户名>/…` 会把网关运行者的身份和目录结构一起送到浏览器里，而**浏览器可能正跑在另一台设备上、由别人拿着**。两段以内不缩——本来就不含身份信息，缩了反而更难读。

`parentPath` 在根目录时返回 `null`，让调用方据此禁用「向上」入口。

展开的目录列表存在 `localStorage`，按当前 cwd 维护。

## 解码只留一份

`workspace-panel.js` 原先自带一个 `decodeURIComponent(escape(atob()))` 版本，与 `app.js` 用的 `TextDecoder` 版**行为不同**（多字节 UTF-8 与非字符串输入都不一样），于是同一个文件在两个面板里可能显示成两个样子。现在只留一份。

## 文件安全工具

`src/files/file-security.js` 提供跨模块复用的几件事：`rejectableSymlinkComponent`（检查路径中用户可写目录里的可疑符号链接）、`isOwnerOnly` / `fixPermissions`（owner-only 权限检查与修复）、`writeOwnerOnlyFile` / `appendOwnerOnlyFile`（安全写入）。上传落盘、配置写入、审计日志、doctor 的权限检查都用它。

## 相关测试

[test/unit/workdir-allowlist.test.mjs](../../test/unit/workdir-allowlist.test.mjs)、[test/unit/file-search.test.mjs](../../test/unit/file-search.test.mjs)、[test/unit/git-workspace.test.mjs](../../test/unit/git-workspace.test.mjs)、[test/unit/file-security.test.mjs](../../test/unit/file-security.test.mjs)、[test/unit/logic-file-preview.test.mjs](../../test/unit/logic-file-preview.test.mjs)、[test/unit/file-diff-summary.test.mjs](../../test/unit/file-diff-summary.test.mjs)、[e2e/workspace-and-composer.spec.js](../../e2e/workspace-and-composer.spec.js)、[e2e/code-surface.spec.js](../../e2e/code-surface.spec.js)
