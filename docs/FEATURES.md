# 功能清单

本机 `codex app-server` 的手机控制面，当前实现的全部功能，按最小单位拆分。

每条都能在代码里找到出处，出处写在行内。这份文件是**盘点**，不是教程——怎么用看 [../README.md](../README.md)，接口签名看 [API.md](API.md)，协议映射看 [PROTOCOL.md](PROTOCOL.md)。

清点口径：51 个 Socket.IO 事件、6 条 HTTP 路由、12 类服务端信封、34 类 runtime 事件。

---

## 1. 会话与消息

### 1.1 发送

| # | 功能 | 出处 |
|---|---|---|
| 1.1.1 | 发送纯文本消息（上限 50,000 字符） | `user:message` |
| 1.1.2 | 空消息拒绝（文本、附件、parts 全空时） | `invalid_message` |
| 1.1.3 | 流式接收助手回复（逐字增量） | `text_delta` |
| 1.1.4 | turn 进行中追加输入（steer 到当前 turn） | `steerTurnDispatch` |
| 1.1.5 | turn 进行中排队输入（尚无 turnId 时） | `enqueueInputDispatch` |
| 1.1.6 | 队列上限保护（默认 20，`CODEX_INPUT_QUEUE_LIMIT`） | `inputQueueLimit` |
| 1.1.7 | 中断正在执行的 turn | `user:interrupt` |
| 1.1.8 | steer 丢弃 turn 设置时给出可见提示 | `dispatchUserMessage` |

### 1.2 输入形态

| # | 功能 | 出处 |
|---|---|---|
| 1.2.1 | 文本输入 → `{type:"text"}` | `user-inputs.js` |
| 1.2.2 | 本地 PNG（经字节签名验证）→ `{type:"localImage"}` | `uploads.js` |
| 1.2.3 | 上传的其他文件 → `{type:"mention"}` | `uploads.js` |
| 1.2.4 | 工作区内文件引用 → `{type:"mention"}` | `input-parts.js` |
| 1.2.5 | 已启用 skill 引用 → `{type:"skill"}` | `input-parts.js` |
| 1.2.6 | 远程图片 URL → `{type:"image"}`（默认关闭，需 `CODEX_ALLOW_REMOTE_IMAGES=1`） | `input-parts.js` |
| 1.2.7 | `@` 触发工作区文件搜索并插入引用 | `at-mention.js` |
| 1.2.8 | 粘贴图片自动转附件 | `attachments-ui.js` |
| 1.2.9 | 附件上限：单个 10 MiB、最多 10 个、合计 20 MiB | `uploads.js` |
| 1.2.10 | 附件缩略图预览与移除 | `attach-tray` |
| 1.2.11 | parts 数量限制 1–20 | `invalid_input_parts` |

### 1.3 斜杠命令

`/help`、`/status`、`/plan`、`/diff`、`/review`、`/compact`、`/permissions` — `index.html` 的 `data-cmd`

---

## 2. 消息流渲染

| # | 功能 | 出处 |
|---|---|---|
| 2.1 | Markdown 渲染（表格、标题、引用、列表、分隔线） | `markdown.js` |
| 2.2 | 代码块语法高亮 + 复制按钮 | `enhanceCodeBlocks` |
| 2.3 | 宽表格独立横向滚动，不撑破消息；溢出时边缘渐隐提示可横滑 | `wrapTables` / `.table-scroll` |
| 2.4 | XSS 消毒（脚本、事件属性、`javascript:`、iframe 全部剥离） | `sanitizer.js` |
| 2.5 | ANSI 转义序列转 HTML（终端色彩） | `ansi-html.js` |
| 2.6 | thinking / reasoning 折叠块，三态：正在思考 / 已思考 N 秒 / 已完成思考 | `appendReasoning` / `thoughtLabel` |
| 2.7 | 命令活动行（收起时一行，展开看命令、退出码、输出） | `renderCommandCard` / `tool-cards.js` |
| 2.8 | 命令输出流式增量 | `tool_output_delta` |
| 2.9 | 文件变更活动行（单文件显示路径，多文件显示计数，展开看 diff） | `handleFileChange` / `file-diff-summary.js` |
| 2.10 | MCP 工具调用活动行 | `mcp_use` / `mcp_result` |
| 2.11 | Web 搜索活动行（「已搜索网页：<query>」，展开看结果） | `search` |
| 2.12 | 计划（plan）卡片 | `handlePlan` |
| 2.13 | 未识别 item 降级为可见 Raw 活动行，不静默丢弃 | `raw_item` |
| 2.13a | 工具活动用进行时/完成时两套文案（正在运行 X → X） | `agent-activity.js` |
| 2.13b | turn 结束时把相邻活动行折成一句过去时摘要（「已搜索网页、运行了命令」） | `collapseTurnActivities` |
| 2.13c | 整组同一工具时摘要改用计数（`read_file · 3 次调用`） | `groupSummary` |
| 2.13d | 活动区与最终回复之间插入「用时 N 秒」分隔 | `workedForLabel` / `.worked-for` |
| 2.14 | turn 终态摘要（完成/失败/中断） | `turn-outcome.js` |
| 2.15 | 界面不显示宿主机绝对路径（`/Users/xxx` 收敛） | `display-path.js` |
| 2.16 | 上下文占用环（按百分比填充的 18px 圆环，逼近上限变色；点环弹出具体数字） | `token-usage.js` |
| 2.17 | 「有新内容 ↓」跳转按钮 | `jump-to-latest` |
| 2.18 | 空会话引导卡片 | `empty-state` |
| 2.19 | turn 完成的无障碍播报 | `turn-announcer` |
| 2.20 | turn 末尾的复制按钮，复制 markdown 原文而非渲染后的纯文本 | `appendTurnActions` |
| 2.21 | 等待态是「正在思考」+ 微光横扫，与 reasoning 进行时同一套视觉 | `showTyping` / `.loading-shimmer` |
| 2.22 | 用户气泡取 ChatGPT 的蓝底深字、16px 超椭圆圆角、宽度贴合内容，含代码块时撑满 | `.user .bubble` |
| 2.23 | 行距用绝对增量（字号 + 6px）而非倍数，两档字号共用同一条呼吸节奏 | `.bubble` / `.codex .bubble` |

---

## 3. 审批与提问

| # | 功能 | 出处 |
|---|---|---|
| 3.1 | 命令执行审批卡片（批准/拒绝） | `approval-broker.js` |
| 3.2 | 文件改动审批卡片 | `item/fileChange/requestApproval` |
| 3.3 | 权限升级审批 | `item/permissions/requestApproval` |
| 3.4 | agent 提问表单（自由文本 / 选项） | `handleUserInputRequest` |
| 3.5 | 审批被上游撤销时卡片同步关闭 | `approval_revoked` |
| 3.6 | 跨会话「需要你」聚合面板 | `needs-you-registry.js` |
| 3.7 | 「需要你」精确深链（`?thread=&need=`） | `needsYouPush` |
| 3.8 | 同一决议重复提交幂等，冲突决议拒绝 | `already_resolved` |
| 3.9 | turn 终态自动过期未决审批 | `trackNeedsYou` |
| 3.10 | 未知 server request 一律安全回应，不让 agent 挂起 | `handleServerRequest` |

---

## 4. 会话管理

| # | 功能 | 出处 |
|---|---|---|
| 4.1 | 新建会话 | `session:new` |
| 4.2 | 分叉会话 | `session:fork`（仅 API，前端无入口） |
| 4.3 | 切换当前查看的运行实例 | `session:switch` |
| 4.4 | 会话列表（分页、游标） | `thread:list` |
| 4.5 | 会话搜索 | `thread:list` 的 `searchTerm` |
| 4.6 | 选择并恢复历史会话 | `thread:select` → `thread/resume` |
| 4.7 | 历史消息重建（含工具卡与变更卡） | `thread:history` |
| 4.8 | 重命名会话 | `thread:rename` |
| 4.9 | 归档 / 取消归档 | `thread:archive` / `thread:unarchive` |
| 4.10 | 已归档会话独立视图切换 | `drawer-archived-toggle` |
| 4.11 | 删除会话（并回收对应 runtime） | `thread:delete` |
| 4.12 | 压缩上下文 | `thread:compact` |
| 4.13 | 回退 N 轮 | `thread:rollback` |
| 4.14 | 多工作区切换 | `workdir-select` |
| 4.15 | 多实例标签（同时开多个 thread） | `renderInstanceTabs` |
| 4.16 | 按 cwd 记忆当前会话指针 | `thread-preferences.js` |
| 4.17 | 空闲实例自动回收（默认 30 分钟） | `reclaimIdleAgents` |

---

## 5. 模型与权限设置

| # | 功能 | 出处 |
|---|---|---|
| 5.1 | 模型切换（列表来自 `model/list`） | `models:read` |
| 5.2 | 推理强度切换 | `effort-trigger` |
| 5.3 | 服务档位切换（标准/加速） | `speed-list` |
| 5.4 | 权限预设：`ask`（请求批准） | `PERMISSION_PRESETS` |
| 5.5 | 权限预设：`auto-review`（自动审查） | 同上 |
| 5.6 | 权限预设：`full-access`（完全访问，需二次确认） | 同上 |
| 5.7 | 权限模式：`host`（跟随宿主机 config.toml） | `resolveHostPermissions` |
| 5.8 | 权限模式：`custom`（逐项自定义） | `sanitizeTurnOverrides` |
| 5.9 | 细粒度审批开关 | `GRANULAR_APPROVAL_KEYS` |
| 5.10 | 沙箱档位切换（只读/工作区写/完全） | `SANDBOX_OPTIONS` |
| 5.11 | 审批人切换（我审批 / 自动审查） | `reviewer-list` |
| 5.12 | 主机策略限制的模式显示为不可选并说明原因 | `readSessionSettings` |
| 5.13 | 设置在下一轮生效，当前生效值可见 | `permission-state` |
| 5.14 | 设置持久化到 localStorage | `persistComposerSettings` |
| 5.15 | 权限变更推送到全部已注册设备 | `policy_change` |

---

## 6. 工作区浏览

| # | 功能 | 出处 |
|---|---|---|
| 6.1 | 只读目录浏览 | `fs:readDirectory` |
| 6.2 | 只读文件预览（上限 8000 字符） | `fs:readFile` |
| 6.3 | 模糊文件搜索 | `files:search` |
| 6.4 | Git 状态（分支、已暂存/未暂存/未跟踪/冲突） | `git:status` |
| 6.5 | Git diff 查看（按文件、分暂存态） | `git:diff` |
| 6.6 | 顶栏改动数徽标 | `formatWorkspaceChangeBadge` |
| 6.7 | 目录展开状态记忆 | `drawer-dirs.js` |
| 6.8 | 从浏览结果一键引用到输入框 | `data-mention` |

---

## 7. 可靠投递与恢复

| # | 功能 | 出处 |
|---|---|---|
| 7.1 | IndexedDB outbox，跨刷新持久化 | `indexeddb-outbox.js` |
| 7.2 | 客户端稳定 `clientRequestId`，映射到协议 `clientUserMessageId` | `message-request.js` |
| 7.3 | 服务端 receipt ledger 去重（同请求重放原 ACK） | `message-receipt-ledger.js` |
| 7.4 | 同 ID 不同内容拒绝（`request_id_conflict`） | 同上 |
| 7.5 | 单飞派发，并发重试不重复执行 | `claim` / `settle` |
| 7.6 | 离线发送进入队列并显示待发气泡 | `appendOfflineBubble` |
| 7.7 | 重连后自动 drain 队列 | `drainMessageOutbox` |
| 7.8 | 网关重启 epoch 变更检测 | `gatewayEpoch` |
| 7.9 | 结果未知的请求只读核对，不盲目重发 | `message:reconcile` |
| 7.10 | 已尝试且无法核对的请求需用户确认重复副作用后才重试 | `outbox-recovery.js` |
| 7.11 | 从未尝试的请求可原 ID 安全重绑 | `isDefinitelyUnattempted` |
| 7.12 | 断线增量补发（`seq` + `epoch`） | `catch-up` |
| 7.13 | 事件缓冲有 gap 时用 `thread/read` 快照重建 | `requestCatchUp` |
| 7.14 | 重建期间的实时事件暂存，按 watermark 应用 | `recovery-state.js` |
| 7.15 | 连接状态横幅（连接中/断开/重连/重试） | `connection-banner.js` |
| 7.16 | 往返延迟显示 | `formatRttChip` |

---

## 8. 安全

### 8.1 传输与鉴权

| # | 功能 | 出处 |
|---|---|---|
| 8.1.1 | 远程明文 HTTP 默认拒绝（426） | `evaluateTransportSecurity` |
| 8.1.2 | 空 `AUTH_TOKEN` 时只允许 loopback | `isLocalAccess` |
| 8.1.3 | 非 loopback 监听要求 token ≥ 32 字符 | `server-security.js` |
| 8.1.4 | 远程 Socket 精确 Origin 白名单 | `CODEX_ALLOWED_ORIGINS` |
| 8.1.5 | 受信代理白名单校验 `X-Forwarded-Proto` | `CODEX_TRUSTED_PROXY_IPS` |
| 8.1.6 | HttpOnly / SameSite=Strict session cookie | `issueAuthSession` |
| 8.1.7 | URL query token 不参与鉴权（一次性 bootstrap 后立即从地址栏抹除） | `bootstrapAuth` |
| 8.1.8 | 认证失败按来源限流，表有硬上界 | `recordAuthFailure` |
| 8.1.9 | CSP、X-Frame-Options、nosniff、no-referrer 响应头 | `app.use` |

### 8.2 设备信任

| # | 功能 | 出处 |
|---|---|---|
| 8.2.1 | 新设备进入 pending，批准前不能操作 | `addPendingDevice` |
| 8.2.2 | 终端回车一键批准 / `deny` 拒绝 | TTY 分支 |
| 8.2.3 | 命令行批准 `node scripts/device.js approve <ID>` | `scripts/device.js` |
| 8.2.4 | 手机端设备列表与撤销 | `devices:list` / `devices:revoke` |
| 8.2.5 | 撤销即刻断开 socket、撤销 session、删除推送订阅 | `revokeDeviceAccess` |
| 8.2.6 | 外部改 trust 文件即时生效（保留已连的 loopback） | `stopTrustedDevicesWatcher` |
| 8.2.7 | 配对容量上限 | `PENDING_DEVICE_LIMIT` |
| 8.2.8 | 待批准设备只能收设备状态，其余事件丢弃 | `on()` 的 fail-closed |

### 8.3 工作区隔离

| # | 功能 | 出处 |
|---|---|---|
| 8.3.1 | 工作区 allowlist，非白名单 cwd 回落到 `WORK_DIR` | `routeCwd` |
| 8.3.2 | 路径穿越拦截（`..`、绝对路径） | `workdir-allowlist.js` |
| 8.3.3 | 软链接逃逸拦截（realpath 归一） | 同上 |
| 8.3.4 | 前缀碰撞拦截（`/srv/work` 不放行 `/srv/work-other`） | 同上 |
| 8.3.5 | 异大小写路径拒绝 | 同上 |
| 8.3.6 | `fs:copy` 源和目标都过闸 | `runFsMutation` |

### 8.4 审计与脱敏

| # | 功能 | 出处 |
|---|---|---|
| 8.4.1 | 安全审计日志（owner-only、O_APPEND、按代轮转） | `audit-log.js` |
| 8.4.2 | 宿主配置操作审计（递归脱敏 source/error） | `appendHostConfigAudit` |
| 8.4.3 | 审计只记元数据与 hash，不存命令/问答/token/附件正文 | 同上 |
| 8.4.4 | RPC 观察日志脱敏 + 截断 + 轮转 | `rpc-log-redaction.js` |
| 8.4.5 | 送往浏览器的错误统一 sanitize（防密钥泄漏与 ANSI 注入） | `ackError` |
| 8.4.6 | 会话、投递账本、needs-you 注册表一律不落盘 | `zero-persistence-guard` |

### 8.5 宿主机写操作

| # | 功能 | 出处 |
|---|---|---|
| 8.5.1 | 改 config 值 / 批量改 | `host:configWrite` / `host:configBatchWrite` |
| 8.5.2 | 插件安装 / 卸载 | `host:pluginInstall` / `host:pluginUninstall` |
| 8.5.3 | marketplace 增 / 删 / 升级 | `host:marketplace*` |
| 8.5.4 | MCP 工具调用 | `host:mcpToolCall` |
| 8.5.5 | 账号登出 | `host:accountLogout` |
| 8.5.6 | 以上每项需 `confirmAction` 服务端强制确认 | `requireActionConfirm` |
| 8.5.7 | 文件写 / 删 / 拷贝（确认在浏览器侧 confirm sheet） | `runFsMutation` |

---

## 9. 账号与诊断

| # | 功能 | 出处 |
|---|---|---|
| 9.1 | 账号信息、用量、速率限制 | `account:read` |
| 9.2 | ChatGPT 设备码登录 / 取消 | `account:loginStart` / `account:loginCancel` |
| 9.3 | 拒绝转发 ChatGPT auth token 刷新请求 | `handleServerRequest` |
| 9.4 | MCP 服务器状态 | `mcp:read` |
| 9.5 | Skills 列表与启用状态 | `skills:read` |
| 9.6 | 外部 agent 配置探测 / 导入（AGENTS.md、CLAUDE.md） | `externalAgentConfig:*` |
| 9.7 | 分层连接诊断 | `health-diagnosis.js` |
| 9.8 | 状态栏（工作区、沙箱、审批策略、git、上下文占用） | `statusline.js` |
| 9.9 | 「设置与状态」面板：本机偏好 + 账号/主机入口，抽屉底部进入 | `#settings-sheet` |
| 9.10 | 本机 UI 偏好持久化（存储损坏/不可用时回落默认，不抛） | `ui-preferences.js` |
| 9.11 | MCP 启动状态默认不进消息流，出错不受开关影响 | `shouldAnnounceMcpStatus` |

---

## 10. PWA 与推送

| # | 功能 | 出处 |
|---|---|---|
| 10.1 | PWA manifest + Service Worker | `manifest.webmanifest` / `sw.js` |
| 10.2 | 设备绑定 Web Push 订阅 | `POST /push/subscribe` |
| 10.3 | 审批/提问推送（只含泛化提示 + 深链，不含正文） | `needsYouPush` |
| 10.4 | turn 结果 / 错误推送（正文截断 180 字符） | `pushDecision` |
| 10.5 | 权限变更推送 | 同上 |
| 10.6 | codex 进程退出/异常推送 | 同上 |
| 10.7 | 推送 endpoint SSRF 校验（HTTPS、DNS pin、公网校验、10s 超时、64 KiB 上限） | `push-sender.js` |
| 10.8 | 订阅数量上限与过期订阅自动清理 | `CODEX_PUSH_MAX_SUBSCRIPTIONS` |
| 10.9 | 视口自适应（软键盘几何） | `syncVisualViewport` |
| 10.10 | 浅色 / 深色主题跟随系统 | `app.css` |

---

## 11. 协议桥接

| # | 功能 | 出处 |
|---|---|---|
| 11.1 | 单个共享 `codex app-server` 子进程（stdio JSON-RPC） | `app-server-transport.js` |
| 11.2 | 多 thread 精确复用同一进程 | `app-server-host.js` |
| 11.3 | instance/thread/turn/request 四维所有权索引，fail-closed | `thread-registry.js` |
| 11.4 | 子进程退出后懒重建并按 thread 恢复 | `handleTransportExit` |
| 11.5 | 背压重试（`-32001`）指数退避 | `request()` |
| 11.6 | 请求超时与 pending 清理 | 同上 |
| 11.7 | 空闲 turn 看门狗（`IDLE_TIMEOUT_MS`）自动中断 | `checkIdle` |
| 11.8 | 协议漂移门禁（方法集、字段集、类型集三向对比） | `scripts/gates/protocol-check.mjs` |

---

## 12. 配置项

`PORT`、`HOST`、`AUTH_TOKEN`、`WORK_DIR`、`WORK_DIRS`、`CODEX_BIN`、`CODEX_DATA_DIR`、`CODEX_APPROVAL_POLICY`、`CODEX_SANDBOX`、`CODEX_INPUT_QUEUE_LIMIT`、`IDLE_TIMEOUT_MS`、`CODEX_ALLOWED_ORIGINS`、`CODEX_TRUSTED_PROXY_IPS`、`CODEX_SESSION_TTL_MS`、`CODEX_SECURITY_AUDIT_MAX_BYTES`、`CODEX_ALLOW_REMOTE_IMAGES`、`CODEX_P3_EXPERIMENTAL`、`CODEX_AGENT_IDLE_TTL_MS`、`CODEX_AUTH_MAX_FAILURES`、`CODEX_AUTH_WINDOW_MS`、`CODEX_PENDING_DEVICE_LIMIT`、`CODEX_PUSH_MAX_SUBSCRIPTIONS`、`CODEX_BACKPRESSURE_RETRIES`、`CODEX_BACKPRESSURE_BASE_MS`、`CODEX_INTERRUPT_TIMEOUT_MS`、`CODEX_RPC_LOG`、`VAPID_SUBJECT`/`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`、`LOG_STDERR`

含义见 [../README.md](../README.md) 的配置表。

---

## 已移除

| 功能 | 移除时间 | 原因 |
|---|---|---|
| P3 / Labs 实验面板（网页终端、thread 搜索、能力探测） | 2026-09-10 | 原型代码：`prompt()` 收输入、终端输出塞进聊天流、输入空白静默失败 |
| admin 解锁机制 | — | 安全剧场：口令是源码常量，绕行路径至少三条 |
| `sessions.json` 元数据副本与 JSONL history fallback | — | app-server 的 thread API 是唯一事实源 |
| Web 端 ChatGPT 账号登录入口 | — | 会引入第二套身份，与「设备配对 + AUTH_TOKEN」模型冲突 |
