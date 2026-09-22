# codex-mobile — self-hosted mobile web UI for your local Codex CLI

**Control your local Codex CLI from your phone.** 手机上操作跑在开发机里的 [Codex CLI](https://github.com/openai/codex) —— 同一个工作区、同一套审批边界、同一条原生 thread。

[![CI](https://github.com/Ike-li/codex-mobile/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/Ike-li/codex-mobile/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

---

## 为什么有这个项目

官方 ChatGPT 的远程控制要求这台主机用官方账号登录。**当你的 Codex CLI 配的是自定义 `base_url` 和 API key（第三方网关、自建代理、企业内网中转），官方远控无法与这台主机配对** —— 你就没有手机端了。

本项目不做另一个 agent，它是**你这台机器上已经在跑的 `codex app-server` 的手机控制面**。会话是 Codex 原生 thread，存在 `~/.codex` 里，和你在终端 `codex resume` 看到的是同一批数据。手机上开的会话，回到终端能接着聊。

三种认证都支持，实测于 codex 0.153.4：

| 认证方式 | 会话可用 | 账号用量面板 |
|---|---|---|
| 官方 ChatGPT 账号 | ✅ | ✅ 邮箱 / 套餐 / 限额 |
| API key | ✅ | 说明「没有套餐与限额信息」 |
| 第三方网关（自定义 `base_url`） | ✅ | 说明「模型走自定义 base_url」 |

## 快速开始

需要 Node.js >= 20，以及本机已装好并登录的 `codex`。

```bash
git clone https://github.com/Ike-li/codex-mobile.git
cd codex-mobile
npm install

npm run setup     # 装机向导：选工作区、绑定地址、生成访问令牌
npm start         # 启动服务

npm run qr        # 打印带令牌的二维码，手机扫码即连（含凭据，不进启动日志）
```

装不起来先跑 `npm run doctor` —— 它用和 server 完全相同的配置加载路径自检，所以「配置文件放错位置 / 被环境变量压过」这类最难查的问题它看得见。

## 能做什么

**会话** —— 列表、新建、恢复、fork、重命名、归档、删除、回滚到某一步、压缩上下文、代码审查。跨工作区分组。

**审批** —— `on-request` / `workspace-write` 等策略原样透传。待批准的操作会跨会话汇总成「需要你」入口，卡片在视野里时自动收起，不重复提醒。支持深链直达某一条。

**输入** —— 流式 markdown、`@` 提及文件、图片附件、`/` 命令面板（内置命令 + 从 `skills/list` 动态拉取的本机 skill，上游增删自动跟随）。

**文件** —— 工作区抽屉、目录浏览、文件预览、diff 摘要、全文搜索。

**离线** —— PWA + Service Worker。断线时消息进 IndexedDB 队列，重连后自动补发。Web Push 通知（VAPID）。

**运维** —— MCP 服务器状态、健康自检、token 用量、账号面板。

## 安全边界

默认只监听 `127.0.0.1`。要让手机连上得显式改成 `0.0.0.0` 并配好来源白名单 —— 装机向导会问，不替你决定。

访问靠 64 位令牌 + 设备配对握手，失败次数有窗口限流，会话有 TTL。审批与沙箱策略由 Codex 自己执行，本项目不绕过它们。

`npm run setup` 的主体是一张**拒绝矩阵**：把家目录当工作区、在没有 TTY 的地方走完交互分支、覆盖还在用的配置 —— 这三件都不报错而后果很晚才显形，所以它宁可停下来问。

## 架构

```
手机浏览器 ──Socket.IO── Node 服务 ──stdio/JSON-RPC 2.0── codex app-server
   PWA                   server.js                        （你本机那个）
```

生产基线是通过 stdio 运行的 `codex app-server`，不使用已退役的 `codex exec --json`。

协议定义**版本化 vendored** 在 `.protocol/stable/`（`codex app-server generate-ts` 生成），当前对齐 codex **0.155.1**。`npm run protocol:check` 是门禁，卡三类漂移：方法覆盖、通知字段、请求参数形状。`npm run protocol:check:installed` 对着你本机装的那版跑，升级 CLI 前能先看会不会撞。

## 开发

```bash
npm test                    # 单元 + 集成
npm run test:e2e            # Playwright（走 mock app-server，不消耗额度）
npm run test:ci             # 全量门禁：lint + 协议 + 边界 + 覆盖率增量 + e2e
```

日常回归一律走 mock server，不调真实 Codex CLI。详见 [docs/TESTING.md](docs/TESTING.md)。

## FAQ

**Can I control Codex CLI from my phone without a ChatGPT account?**
Yes. codex-mobile drives the `codex app-server` process on your own machine over stdio, so it inherits whatever auth your local `codex` already uses — ChatGPT account, API key, or a custom `base_url` gateway. The table above shows what each mode gives you.

**Does it work with a custom `base_url` (third-party gateway, self-hosted proxy, corporate relay)?**
Yes — that is the reason this project exists. Official ChatGPT remote control requires the host machine to be signed in with an official account, so a machine configured with a custom `base_url` and an API key cannot be paired at all. Here sessions work normally; only the account-usage panel degrades to "model goes through a custom base_url" instead of showing plan and limits.

**Is this the same as ChatGPT's official remote control, or a hosted Codex service?**
No. It is not another agent and not a cloud service. It is a self-hosted control panel for the `codex app-server` already running on your dev machine. Conversations are native Codex threads stored in `~/.codex` — the same ones `codex resume` lists in your terminal, so a session started on your phone can be continued from the terminal.

**Where does my data live? Does anything pass through a server run by this project?**
Nothing does. The chain is phone browser → your Node server → your `codex app-server`, entirely on hardware you control, and threads stay in `~/.codex`. Model traffic goes wherever your own `codex` config points.

**Can I reach it from outside my local network?**
Not by default — the server binds `127.0.0.1`. Exposing it is an explicit decision: switch to `0.0.0.0` and configure an origin allowlist, which `npm run setup` asks about instead of deciding for you. Access then needs a generated 64-character token plus a device-pairing handshake, with windowed rate limiting on failed attempts and a session TTL. Approval and sandbox policy remain Codex's own; this project does not bypass them.

**Which phones are supported?**
Any modern mobile browser — it is a PWA, installable on both iOS and Android. Web Push on iOS additionally requires iOS 16.4+ with the app added to the Home Screen.

**Is there a build step?**
No. The frontend is native ESM served as-is, so `npm install && npm start` is the whole pipeline. Requires Node.js 20 or newer.

## 许可证

[AGPL-3.0-only](LICENSE)。如果你把修改版作为网络服务运行，AGPL 要求向其用户提供修改后的源码。
