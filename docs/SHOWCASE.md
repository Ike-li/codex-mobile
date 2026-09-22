# 功能巡览

[English README](../README.md) · [中文 README](../README.zh-CN.md)

**codex-mobile 是什么**：Codex CLI 跑在你的开发机上，这个项目让你从手机上像用终端一样驱动它——同一个工作区、同一套审批边界、同样的流式 agent 事件。下面用截图过一遍它到底能干什么。

> 所有截图取自确定性 mock app-server（`npm run test:e2e` 用的 harness），不调用真实 Codex、不消耗任何模型额度。真实使用步骤见 [GUIDE.md](GUIDE.md)。

## 流式对话

发一条提示词，助手回复以流式增量逐字出现，和终端里的体验一致。

![流式对话](assets/showcase/01-chat.png)

## 命令审批

当 Codex 要执行命令或改文件时，手机上弹出审批卡片，显示将执行的命令和原因，由你决定批准还是拒绝——把终端里的 y/n 审批搬到锁屏可达的地方。

![命令审批卡片](assets/showcase/02-approval.png)

## 命令执行结果

批准后命令真正执行，结果以终端卡片呈现，带状态和退出码（`exit: 0`）；拒绝则不执行。

![命令执行结果](assets/showcase/03-command-result.png)

## 斜杠命令

输入 `/` 弹出命令建议，`/status`、`/diff`、`/review`、`/permissions` 等一应俱全，每条带说明，不用记。

![斜杠命令建议](assets/showcase/04-slash.png)

## 模型与思考强度

底栏「会话设置」sheet 切换本机 `model/list` 返回的模型、该模型支持的思考强度（`low` / `medium` / `high` / `xhigh` / `max` 等）以及速度档，随时调整下一轮的算力投入。

![模型与思考强度切换](assets/showcase/05-model.png)

## 审批策略与沙箱

同一张会话设置 sheet 里切换 CLI 审批策略（`untrusted` / `on-failure` / `on-request` / `never`）和沙箱（`read-only` / `workspace-write` / `danger-full-access`），控制 Codex 能碰什么——安全边界始终握在你手里。

![审批策略切换](assets/showcase/06-permissions.png)

## 多实例标签

顶栏新建会话，侧栏按工作区折叠列出历史会话；切换、归档、续聊都在抽屉里完成（多 runtime 实例标签尚未进主 chrome，当前以抽屉多会话承担并行入口）。

![多实例标签](assets/showcase/07-instances.png)

## 状态栏

工作区胶囊、往返延迟芯片和连接横幅一起回答「现在在哪、链路是否健康」；更细的沙箱/审批/队列信息在会话设置与抽屉里。

![状态栏](assets/showcase/08-statusbar.png)

## 还有

native 控制面板（Threads / Models / Files / Account / MCP / Skills / 导入外部 agent 配置）、文件附件、会话历史抽屉、reasoning 分区渲染、Web Push、可安装 PWA。完整能力清单见 [../README.zh-CN.md](../README.zh-CN.md)，已交付/进行中/候选见 [../ROADMAP.md](../ROADMAP.md)。
