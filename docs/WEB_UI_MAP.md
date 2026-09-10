# Web 界面地图

本文是页面区域参考。它说明每个区域显示什么、可以点击什么，以及操作后影响哪个 thread 或设备视图。

## 页面区域总览

```text
┌ 顶部状态区：会话钮+延迟 / 工作区胶囊 / 首页与新会话 ┐
├ 连接横幅：断线或重连时的可读状态（非阻断）              ┤
├ Needs-you：与消息区同栏的跨 thread 审批/提问条          ┤
├ 消息区：用户、助手、reasoning、工具、diff、审批、结果         ┤
├ 输入区：附件 / 权限 / 模型 / 文本 / @ 引用 / 发送或中断        ┤
└ 左侧抽屉：历史 thread、原生控制、工作区、Push、宿主配置、Labs 条件入口 ┘
```

页面上显示的 session/thread 状态属于当前 Socket 视图；切换标签不会改变另一台设备正在查看的 runtime。

## 顶部状态区

顶部包含：

- 菜单按钮：打开左侧抽屉；右下角叠连接状态点。
- `#conn-rtt`：测到往返延迟后显示「延迟 Nms / Ns」，差网用 warn/bad 着色。
- `#header-context`：中间工作区胶囊，显示 `#header-project`（cwd 最后一段）；`status_line.git.changed` 非零时显示 `#header-changes`。点击打开只读工作区 sheet（文件 / git 改动）。
- `#header-home`：回空会话（清本地视图，不调用 `session:new`）；下一次发送再懒开 runtime。
- `#header-new`：立刻 `session:new` 并清空消息区。
- `#thread-title`：当前 thread 名（对辅助技术可见；没有绑定 thread 时为「新会话」）。
- `#conn-banner`：连接超过阈值后显示「连接中 / 已断开 / 已重新连接」，条子和消息区同一栏宽，可点立即重试。
- 不提供 ChatGPT / Codex 账号登录入口；凭证只在本机配置。
- 不提供 CLI 镜像 / 控制台按钮。

工作区切换在左侧抽屉；Chat/Plan 在输入区。host-scope `thread/status/changed` 能更新未加载 thread 的状态，但不会为它创建 runtime。

## Thread 与实例区

主界面不再展示活跃 runtime 标签条。当前会话由抽屉列表和空状态表示；新建会话可点顶栏 `+`，或抽屉里项目行的 `＋`。

历史 thread 仍在抽屉列表中选择。instance 是网关运行时视图，不是历史事实源。

## 消息区

消息区可能显示：

| 卡片 | 内容 |
|---|---|
| 用户消息 | 右侧浅色胶囊：文本、附件/skill 元数据和发送状态 |
| 助手消息 | 通栏 GFM Markdown（无气泡；历史同样渲染） |
| Reasoning | 通栏可折叠思考（收起为「思考」，展开为「思考过程」；完整推理另标） |
| 命令/工具 | 通栏卡片：标题「命令」、可折起命令行、实时输出、结束时 exit code 与成败色 |
| MCP/Search | 通栏卡片：调用参数摘要和结果 |
| File change/Diff | 通栏卡片：文件列表、change kind 和 diff |
| Plan | 通栏卡片：当前 turn 的步骤计划 |
| Approval | 通栏卡片：批准或拒绝操作 |
| User input | 通栏卡片：选项或自由文本回答 |
| Result/Error/System | turn 终态、错误和网关提示 |
| Raw item | 未识别协议 item 的可见兜底 |

消息只渲染到匹配当前 instance/thread 的视图。切换 thread 后，页面通过原生历史或 runtime buffer 构建对应内容。

## 输入区

输入区包含：

- `+`：选择附件；
- 一颗摘要胶囊显示模型、权限模式和思考强度，点开底部会话设置；常用项依次为权限、模型、思考强度和速度；
- 附件和发送钉在右侧；输入为空时发送钮隐藏，有内容或 turn 进行中才出现；
- 权限入口：请求批准、帮我批准、完全访问、跟随主机配置；完全访问需要确认。高级设置默认折叠，提供原始审批策略、审批者、细粒度审批、沙箱和当前生效配置。不支持的选项禁用并说明原因；Plan 当前禁用；
- 模型/思考强度/速度入口：模型来自 `models:read`，思考强度来自该模型的 `supportedReasoningEfforts`，速度来自该模型的 `serviceTiers`（上游只列加速档时补一个默认选中的「标准」）；
- 文本框：普通内容、`/` 命令和 `@` 文件引用（候选来自 `files:search`，选中后加入结构化 mention，不把路径拼进提示词）；
- 粘贴图片会进入附件托盘；点图片 chip 可预览；
- 主按钮：空闲且有内容时是发送箭头；turn 进行中变成停止方块，停止过程中禁用并显示「正在停止」。进行中再输入时，左侧多一颗发送箭头（`#followup-btn`），把下一条发给当前 turn（`steered`）或排进该 runtime 队列（`queued`，气泡标 Queued #N）。停止会清掉未执行的队列。回车在有草稿时发送，空草稿且进行中才中断。

附件先显示为可删除 chip。Skills 面板选择的 skill 也会作为下一条消息的结构化 chip。发送成功前，消息已进入 IndexedDB outbox；清空输入框不等于服务端已经执行。

## 左侧抽屉

抽屉包含：

- 标题「工作区与会话」（`#drawer-title`）和关闭按钮（`#drawer-close`）；点关闭或点遮罩都会收起抽屉；
- `#drawer-projects`：白名单工作区目录树。点目录名展开/再点收起（可同时展开多个）；点行内 `＋` 才在该目录新建并切 cwd；点会话才打开并切过去；
- 打开抽屉时当前 cwd 默认展开，展开集合记在浏览器 localStorage；
- thread 的打开、重命名、Archive/Unarchive 和删除操作；
- 配置多个工作区时的工作区切换；
- `#push-subscribe-btn`：HTTPS + VAPID 可用时显示「开启推送通知」。

工具面板在抽屉里可见：Threads / Compact / Rollback / Models / Files / Account / MCP / 诊断 / 设备 / 宿主配置 / Skills / Import，Labs 由特性开关另行控制。这些功能只有这一个入口，整块隐藏等于建了却点不到——顶栏保持清爽由「工具行不在顶部」保证，不需要连抽屉里也藏。

只读控制面返回 app-server 原生数据。Files 只允许读取目标 workspace 范围；Import 先检测迁移项，再由用户选择导入。

## 条件入口

以下入口不会默认出现：

- Push：需要 HTTPS、VAPID、有效 session、已批准设备和浏览器权限；
- Labs：需要 `CODEX_P3_EXPERIMENTAL=1`；
- 宿主配置：入口常驻，每个动作需逐动作确认并留审计；
- 远程 image URL：需要 `CODEX_ALLOW_REMOTE_IMAGES=1`，并通过公网 DNS/SSRF 校验。

入口不可见通常表示服务端没有启用对应 feature，不是页面加载失败。完整能力与条件见 [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md)。
