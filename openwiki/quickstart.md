---
type: guide
title: 快速上手与文档导航
description: codex-mobile 是什么、怎么跑起来、按任务（改协议桥、改审批、改前端渲染、加门禁、改配置）该先读哪一页。
tags: [quickstart, navigation, onboarding, setup]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T10:31:12.135Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-ebee4a6bd315dc1dfbba354d
    resource: repo://playwright.config.js
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-d536dae7542879b4b37d999f
    resource: repo://scripts/doctor.js
  - id: openwiki-source-d0b5454aa7eb58bcea1b977b
    resource: repo://scripts/gates/check-import-boundaries.js
  - id: openwiki-source-f52b6042255133b34aacf3b7
    resource: repo://scripts/setup.js
  - id: openwiki-source-2d58f6a6fcc12e1b2934dec9
    resource: repo://test/README.md
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 快速上手与文档导航

## 这是什么

**在手机上操作跑在开发机里的 Codex CLI。** 同一个工作区、同一套审批边界、同一条原生 thread。

它不是另一个 agent，而是你本机那个 `codex app-server` 的手机控制面。会话存在 `~/.codex` 里，手机上开的会话回到终端 `codex resume` 能接着聊。

存在的缺口很具体：官方 ChatGPT 的远程控制要求主机用官方账号登录，而配了自定义 `base_url` 的 Codex CLI（第三方网关、自建代理、企业内网中转）无法与官方远控配对——那样就没有手机端了。

技术栈：Node ≥ 20，Express + Socket.IO，无构建步骤的原生 ESM 前端，与 codex 之间走 stdio 上的 JSON-RPC 2.0。

## 跑起来

```bash
npm install
npm run setup     # 装机向导：选工作区、绑定地址、生成访问令牌
npm start         # 启动服务
npm run qr        # 打印带令牌的二维码，手机扫码即连
```

前提：本机已装好并登录的 `codex`。

装不起来先跑 `npm run doctor`——它用和 server **完全相同的配置加载路径**自检，所以「配置文件放错位置 / 被环境变量压过」这类最难查的问题它看得见。

默认只监听 `127.0.0.1`。要让手机连上得显式改成 `0.0.0.0` 并配好来源白名单——向导会问，不替你决定。

## 日常命令

| 命令 | 用途 |
|---|---|
| `npm test` | 单元 + 不变量 + 集成 + 基建 |
| `npm run test:e2e` | Playwright，走 mock app-server，**不消耗额度** |
| `npm run test:ci` | 全量门禁：lint + 协议 + 边界 + 不变量编号 + 测试 + 覆盖率增量 + E2E |
| `npm run doctor` | 启动自检（会起一条真 app-server 做只读探测） |
| `npm run protocol:check:installed` | 对着本机装的 codex 版本预检协议，升级 CLI 前跑 |
| `npm run config <cmd>` | headless 配置读写 |

日常回归一律走 mock server，不调真实 Codex CLI。

## 按任务读哪一页

| 你要做的事 | 先读 |
|---|---|
| 搞清楚整体怎么串起来的 | [系统总览](architecture/overview.md) |
| 改协议桥、排查「事件没到」 | [app-server 桥接层](architecture/app-server-bridge.md) → [ThreadRuntime](concepts/thread-runtime.md) |
| 升级 codex 版本 | [协议基线与漂移门禁](integrations/codex-app-server-protocol.md) |
| 加或改一个 socket 事件 | [Socket.IO 契约层](architecture/socket-contract.md) |
| 改审批相关的任何东西 | [审批闭环与「需要你」](concepts/approvals-and-needs-you.md) |
| 排查「消息发了没反应 / 重复了」 | [消息投递](concepts/message-delivery.md) |
| 改未读点、通知、推送 | [未读位点与通知](concepts/unread-and-notifications.md) |
| 改会话列表、fork、归档 | [会话管理](workflows/session-management.md) |
| 改输入框、@ 提及、斜杠命令、附件 | [输入组装](workflows/compose-and-input.md) |
| 改文件浏览、搜索、git 面板 | [工作区与文件](workflows/workspace-and-files.md) |
| 改渲染、样式、消息流准入 | [前端外壳与渲染](frontend/app-shell-and-rendering.md) |
| 加配置项 | [配置系统与装机](operations/setup-and-configuration.md) |
| 动鉴权、绑定、脱敏 | [安全模型](operations/security-model.md) |
| 加指标、改日志、改 doctor | [自检与可观测](operations/diagnostics-and-observability.md) |
| 写测试 / 不确定测试放哪 | [测试策略](testing/strategy.md) |
| 加一道门禁 | [门禁链路与 CI 接线](testing/gates-and-ci.md) |
| 加一条红线 | [不变量登记表](testing/invariants.md) |
| 改 E2E 或 mock 后端 | [E2E 与 mock 后端](testing/e2e-and-mocks.md) |

## 动手前值得知道的三条

**一、不产生第二份真相。** thread / turn / item / 配置 / 模型列表一律向 app-server 现问。想新增落盘之前先读[状态归属](architecture/state-ownership.md)——门禁会红，而那是设计好的。

**二、目录结构是一道会红的闸。** 后端六个域有层序，前端八个域有基础层约束，组装根不可被反向 import，前后端只允许三个具名文件共享。详见[模块边界](architecture/module-boundaries.md)。

**三、fail-closed 是逐条选过的。** 不是「所有异常都该拒绝」。写新代码前先问：这条路径失败时产品**应该**拒绝还是放行？[测试策略](testing/strategy.md)里有那张表。

## 仓库地图

| 位置 | 内容 |
|---|---|
| `server.js` | 顶层组装根：HTTP、Socket.IO、契约事件、四张核心表 |
| `src/{shared,files,auth,ops,sessions,agent}/` | 后端六个域，36 个模块 |
| `public/js/{compose,files,net,outbox,render,session,ui,util}/` | 前端八个域，48 个模块 + `app.js` / `sw.js` |
| `.protocol/stable/` | vendored 的协议定义，只作比对基线 |
| `scripts/gates/` | 五道静态门禁 |
| `scripts/` | 装机、配置、自检、二维码、mock、冒烟、变异 |
| `test/{unit,invariants,integration,infra}/` | 四个组织目录，同一条 `npm test` |
| `e2e/` | Playwright 用例与三个审计库 |
| `docs/TESTING.md` | 测试策略正文 |

## 项目约定

分支固定 `master`（主）与 `dev`（开发），所有改动在 `dev` 上开功能分支。软件相关改动默认 TDD：先写能表达预期的失败测试，再做最小实现，最后跑真实验证。

不提交本地状态、密钥、运行日志、Playwright 报告或 `data/`。

许可证 [AGPL-3.0-only](../LICENSE)：把修改版作为网络服务运行时，AGPL 要求向其用户提供修改后的源码。
