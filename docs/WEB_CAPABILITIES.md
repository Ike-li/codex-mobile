# Web 端能力参考

本文面向 codex-chat-mobile 的自托管用户和维护者，回答四个问题：Web 页面能看到什么、能点击什么、能输入什么，以及操作后会返回什么。

Web 端是本机 Codex app-server 的移动控制面，不是另一个独立聊天后端。每个网关进程共享一个 app-server 子进程，并通过原生 thread、精确路由和浏览器可靠投递机制提供接近 Codex CLI 的交互体验。

## 能力总览

默认核心能力包括：

- 流式对话（助手 GFM Markdown）、thinking/reasoning、命令、工具、MCP、搜索、diff 和计划卡片；
- 命令、文件修改、权限和用户问题的移动审批；
- 原生 thread 历史、续接、重命名、归档、删除、压缩、回退和分叉；
- 多工作区、多 runtime 标签和多设备视图隔离；
- IndexedDB outbox、稳定请求 ID、ACK、核对和断线重建；
- 结构化附件、workspace mention 和已启用 skill；
- 账号、模型、文件、MCP、Skills 和外部配置只读控制面；
- HTTPS 下的 PWA 安装和设备绑定 Web Push。

Labs 和远程图片默认关闭，需要服务端显式启用。宿主配置没有开关，靠逐动作确认约束。

## 登录与设备配对

### 能看到什么

- `AUTH_TOKEN` 输入框；
- 当前浏览器生成的设备 ID；
- offline、connecting、pending、running 等连接状态；
- 已批准设备上显示的新设备待批准列表。

### 能做什么

- 输入 `AUTH_TOKEN` 并点击“连接”；
- 在已批准设备上批准或拒绝新设备；
- 注销当前浏览器 session。

### 返回什么

- 登录成功后，服务端签发绑定当前设备的 HttpOnly session cookie；
- 新远程设备先进入 pending，批准前不能调用 Codex；
- Token、HTTPS、Origin、可信代理或设备状态不符合要求时，页面显示明确错误；
- 拒绝或撤销设备会断开其远程 Socket，并撤销绑定的 session 和 Push。

浏览器不会把 `AUTH_TOKEN` 保存到 localStorage。localStorage 只保存随机设备 ID、当前 thread 指针和 UI 偏好。

## 主界面与状态栏

主界面会显示：

- 顶栏会话按钮和连接状态点；
- 测到后显示的手机到主机延迟芯片；
- 中间工作区胶囊（项目名，以及 git 未提交改动数）；
- 回空会话和新建会话按钮；
- 当前模型、审批/沙箱、思考强度（输入区摘要胶囊）；
- 消息区和底部输入区。

`thread/status/changed` 会更新 running、needs-you、error、not-loaded 等状态。未在当前页面加载的 thread 也能通过 host-scope 状态更新显示活动情况。

## 对话输入与流式返回

### 可以输入什么

- 普通问题或开发任务；
- 最长 50,000 字符的文本；
- `/help`：查看命令说明；
- `/status`：查看会话、目录和上下文状态；
- `/plan`：切换计划模式，单独发送不进入对话；`/plan 做X` 先切模式再发送「做X」；
- `/chat`：切回对话模式，规则同 `/plan`；
- `/diff`：查看工作区差异；
- `/review`：发起代码审查；
- `/compact`：压缩上下文；
- `/permissions`：查看或调整权限。

空状态页是一句「我们来构建什么？」和四张任务卡（探索 / 构建 / 审查 / 修复）；点卡会发出对应提示词。斜杠命令仍通过输入 `/` 出现。

### 可以点击什么

- 主按钮：空闲且有内容时发送；turn 进行中变成停止，精确中断当前目标 turn；进行中再输入时旁边出现第二颗发送钮，把内容 `steer` 进当前 turn 或排进该 runtime FIFO；停止会丢掉未执行的队列；
- Chat / Plan：稳定协议尚无已验证的模式写入能力，Plan 入口禁用；输入不支持的 `/plan` 时提示原因并保留草稿，不会把余下任务按 Chat 静默发送。本地历史选中态不视为上游已生效；
- 模型选择：读取本机 `model/list`，对应 CLI `-m/--model`；
- 思考强度：使用该模型的 `supportedReasoningEfforts`（`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`），对应 `model_reasoning_effort`；
- 速度（服务档位）：仅当模型返回 `serviceTiers` 时显示，是一组普通单选。上游通常只列加速档，此时「标准」会补成显式一项排在首位并默认选中，选它等于不下发 `serviceTier`；
- 权限：请求批准使用 `on-request + user + workspace-write`；帮我批准只把审批者改为 `auto_review`；完全访问使用 `never + user + danger-full-access`，选择时需要确认。跟随主机配置每轮按 cwd 读取权限默认值。高级设置保留原始审批策略、审批者、细粒度审批与沙箱；`untrusted` 仅为旧协议兼容值。

这些选择更新下一条新 turn 的设置；当前运行中的追加指令不会修改已有 turn 的权限。页面区分下一轮选择和已生效配置。设置保存在版本 2 的浏览器记录中，兼容旧记录并保留模型、思考和速度；细粒度对象可经刷新和可靠投递完整恢复。新选择默认请求批准，只有明确选择跟随主机配置才重新读取主机默认。

模型最终是否可用，以本机 app-server 返回的模型列表和账号权限为准，而不是只看页面上的标签。

### 发送后返回什么

浏览器在首次网络发送前生成稳定 `clientRequestId`，并把消息写入 IndexedDB outbox。网关 ACK 可能返回：

- `queued`：消息仍在 runtime 队列，outbox 继续保留；
- `submitted`：已提交为新 turn；
- `steered`：已发送到当前活跃 turn；
- `duplicate:true`：相同请求的原 ACK 被安全重放；
- `request_id_conflict`：相同 ID 被用于不同内容或目标；
- 其他带 `errorCode`、`error` 和 `retryable` 的明确失败。

turn 运行期间再发送时，有活跃 turn id 则 `steer` 当前 turn（页面出现用户气泡和「已向当前运行任务追加指令」），否则进入该 runtime 的 FIFO 队列并标 Queued；不影响其他 thread。停止当前 turn 会清空未执行队列。

## 页面能渲染的返回内容

消息区支持：

- 用户消息和排队状态；
- 助手正文增量（GFM Markdown，代码块可复制并在可用时高亮）；
- summary/full reasoning；
- 命令开始、实时 stdout/stderr、exit code 和终态；
- 动态工具调用与结果；
- MCP 调用与结果；
- Web Search 结果；
- 文件修改列表和 diff；
- turn plan；
- 审批和用户提问卡片；
- compact、rollback、usage、rate limit 和账号状态；
- `result`、`error` 和系统提示；
- 未识别 app-server item 的 `raw_item` 可见兜底。

runtime 输出按 instance、thread、turn 和 item 路由，只发送到正在查看对应 runtime 的设备视图。设备列表、实例列表、needs-you 聚合和 host-scope thread 状态只广播给已批准设备。

## 附件与结构化输入

点击输入框旁的 `+` 可以选择多个文件。

限制如下：

- 最多 10 个附件；
- 单文件最大 10 MiB；
- 合计最大 20 MiB；
- Socket wire 上限 32 MiB，只用于容纳 base64 和 JSON 开销。

服务端验证并 owner-only 落盘后：

- 经内容签名验证的 PNG 发送为 app-server `localImage`；
- 其他文件发送为 `mention`；
- 文件路径不会拼接进文本提示词。

结构化输入还支持：

- 当前 runtime cwd 内的 workspace mention（输入 `@` 搜索，或从顶栏工作区 sheet 点「引用」）；
- `skills/list` 返回的已启用 skill；
- 显式启用后的 HTTPS `imageUrl`。

远程图片默认关闭。设置 `CODEX_ALLOW_REMOTE_IMAGES=1` 后仍会校验 URL、DNS 和公网地址，拒绝凭证 URL、私网、loopback、link-local、site-local、保留地址和公私混合解析。

## 审批与用户提问

Codex 请求执行命令、修改文件、提升权限或向用户提问时，页面会生成 needs-you 卡片。

卡片可能提供：

- 批准；
- 拒绝；
- 单选或多选答案；
- 自由文本回答；
- 提交或取消回答。

每张卡片精确绑定 `instanceId + threadId + turnId + itemId + requestId`。提交后可能返回：

- 成功决议和新的 needs-you revision；
- `duplicate:true`：相同决议已经提交；
- `already_resolved`：另一台设备已处理或提交了冲突决议；
- `stale_target`：目标 runtime、turn 或 item 已失效；
- `resultUnknown`：无法确认上游是否收到；
- revoked/expired：上游撤销，或 turn 已终止。

页面顶部会聚合所有 thread 的待办，条子和消息区同一栏宽。点击某项会切换到对应 thread 并定位具体卡片。另一台设备处理后，本设备会通过 revision 更新撤销旧操作入口。

系统不会自动批准或拒绝 app-server server request。未处理的请求会继续让对应 turn 等待。

## 可靠投递与断线恢复

打开历史或 gap 重建时，`thread/read` snapshot 会还原用户/助手文本，以及命令、文件变更、MCP、搜索、计划和未知 raw 卡片，而不只是最近 30 条纯文本。

页面刷新、网络断开或 ACK 丢失时：

- 未确认消息保留在 IndexedDB outbox；
- 普通短断线按 runtime `seq + epoch` 补发事件；
- buffer gap 或 epoch 变化时，通过 `thread/read` snapshot 重建；
- snapshot 读取期间到达的实时事件先缓冲，再按 watermark 顺序应用；
- 页面先使用相同 `clientRequestId` 做只读 reconciliation，不会盲目重发未知请求。

核对顺序为：

1. 在当前 gateway receipt ledger 中按设备和请求 ID 查找；
2. 有稳定 thread 时，通过 `thread/read` 查找 `clientUserMessageId`；
3. 无法确认时，继续保留 `needs_reconcile` 状态。

如果 provisional instance 已消失：

- 从未尝试的 pending 请求可以保留原 ID，安全重绑到当前精确视图；
- 已尝试且无法确认的请求不会自动重发；
- 用户点击“确认后重试”时，页面先警告可能重复执行工具或修改；
- 确认后创建新的 `clientRequestId`，并保存 `retryOfClientRequestId`。

receipt ledger 是 gateway 进程内状态，因此项目不保证 gateway 重启后的端到端 exactly-once。保证的是：未知写请求不会被浏览器盲目重放。

## Thread、历史与多实例

打开左侧抽屉，可以：

- 点项目行的 `＋` 在该工作区新建会话；
- 刷新原生 thread 列表；
- 打开历史 thread 并查看完整消息；
- 续接 Codex App 或 Web 创建的 thread；
- 重命名、Archive、Unarchive 或删除 thread；
- Compact 当前上下文；
- Rollback 指定数量的 turn；
- Fork 当前 thread；
- 在多个活跃 runtime 标签间切换。

历史和元数据的唯一事实源是：

- `thread/list`；
- `thread/read`；
- `thread/resume`；
- `thread/status/changed`。

项目不再维护 `sessions.json` 元数据副本，也没有本地 JSONL history fallback。Codex App 创建的 thread 可在 Web 查看和续接；Web 创建的 thread 也进入同一原生历史。

多个 `ThreadRuntime` 共享一个 app-server 进程，但 registry 和每个 Socket 的视图指针保持隔离。两个设备可以同时查看不同 thread，不应串文本、工具、审批或状态。

## 工作区、模型和权限

工作区只能在 `.env` 配置的 `WORK_DIR` 和 `WORK_DIRS` allowlist 中切换，不能从页面任意跳到其他目录。`WORK_DIRS` 可以是逗号分隔的目录，也可以是一个 JSON 数组文件（例如 `workdirs.json`）。

模型、思考强度和权限作为目标 runtime 的 `turn/start` 覆盖项（`model`、`effort`、`approvalPolicy`、`approvalsReviewer`、`sandboxPolicy`、`serviceTier`）。服务端按权限预设生成字段，并检查 `configRequirements/read` 的限制。要求使用命名权限配置的主机目前显示不支持，读取限制失败时不能启用权限选项。跟随主机配置会保留工作区额外可写目录和网络配置，不修改主机配置文件。

## 原生控制面板

左侧抽屉提供以下入口：

| 入口 | 可以做什么 | 返回内容 |
|---|---|---|
| Threads | 刷新原生 thread | thread 列表、标题、cwd、时间和状态 |
| Compact | 压缩当前上下文 | 成功 ACK 和 compact 事件 |
| Rollback | 回退当前 thread 的若干 turn | 更新后的 thread |
| Models | 读取模型能力并选择模型 | models、capabilities、分页指针 |
| Files | 只读浏览 workspace 目录和文件 | entries 或 base64 文件内容 |
| Account | 查看账号、usage 和 rate limits | account、usage、rateLimits |
| MCP | 查看 MCP servers | servers 和分页指针 |
| Skills | 查看已启用 Skills，并加入下一条消息 | skill entries |
| Import | 检测并导入 AGENTS/CLAUDE 配置 | migration items 和 importId |

Web 不提供 ChatGPT / Codex 账号登录。凭证只在本机 CLI 配置，页面只中转会话。

## PWA 与 Web Push

在可信 HTTPS 安全上下文中，可以把页面安装到手机主屏幕。standalone 模式支持竖屏、横屏和软键盘布局。

Push 订阅要求：

- HTTPS；
- 完整 VAPID 配置；
- 有效的设备绑定 session；
- 当前设备已批准；
- 浏览器通知权限允许。

Push 可以通知：

- 有审批或问题需要处理；
- turn result；
- turn error。

needs-you 通知只使用泛化正文，不包含命令、问题或回答内容。点击后通过 `thread + need` 深链打开具体待办。result/error 通知没有 needs-you 深链，其正文可能包含经过截断的实际 status/message。

## 默认关闭的能力

### Labs

设置 `CODEX_P3_EXPERIMENTAL=1` 后，Labs 面板可以：

- 读取实验 capabilities；
- spawn、write、resize 和 terminate 终端进程；
- 读取 thread turns；
- 搜索 threads。

默认关闭时按钮隐藏，服务端返回 `feature_disabled`。

### 宿主配置

入口常驻在抽屉的工具面板里，不需要解锁；每个动作需要独立确认并写审计。支持：

- 写配置和批量写配置；
- 安装或卸载插件；
- 管理 marketplace；
- 写入、删除和复制文件；
- 调用 MCP tool；
- 账号 logout。

操作结果和「缺确认」被拒都会写入 owner-only 脱敏审计（`host-config-audit.jsonl`）。

## 操作速查表

| 页面操作 | 输入 | 主要返回或可见结果 |
|---|---|---|
| 登录 | `AUTH_TOKEN` | HttpOnly session、pending 或鉴权错误 |
| 发送消息 | 文本、附件、mention、skill | queued/submitted/steered ACK，随后流式事件 |
| 停止 | 当前 instance/thread/turn | 中断 ACK，随后 result/error/status |
| 审批 | 批准或拒绝 | resolved、duplicate、stale 或 conflict |
| 回答问题 | 选择项或文本 | 决议 ACK，其他设备同步撤销卡片 |
| 切换标签 | instance | 该 Socket 的精确视图和 scoped init |
| 打开历史 | thread | `thread/read` 消息 snapshot |
| 新建/Fork | cwd 或当前 thread | 新 instance/thread 和对应标签 |
| Compact/Rollback | 当前 thread | compact/rollback 结果与刷新后的历史 |
| 选择附件 | 本地文件 | 附件 chip，发送后映射为 localImage/mention |
| Models/Account/MCP/Skills | 当前 cwd | 对应 app-server 原生只读数据 |
| 订阅 Push | 浏览器 PushSubscription | 成功、未批准、配置缺失或容量错误 |
| 确认未知重试 | 用户风险确认 | 新请求 ID、重试来源和新的发送状态 |

## 当前能力边界

- 当前版本不持久化输入草稿；刷新前未发送的纯文本草稿可能丢失。
- IndexedDB outbox 会持久化待发送请求，但 gateway receipt ledger 和 needs-you registry 不跨进程持久化。
- Web 能查看和续接原生 Codex thread，但不是 Codex App 全部 UI 的复制品。
- 宿主配置、Labs 和远程图片不是核心聊天的默认能力。
- 真正可用的模型、账号、权限和工具取决于本机 Codex 登录状态、固定协议版本、工作区配置和服务端 feature flags。

接口字段和事件签名见 [API.md](API.md)，端到端操作步骤见 [GUIDE.md](GUIDE.md)，远程部署要求见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。
