# 接口参考

本文件是 codex-chat-mobile 浏览器网关的接口参考，覆盖浏览器可调用的 HTTP 路由、Socket.IO 事件和统一的 `agent:event` 信封。Codex app-server 的 JSON-RPC 方法见 [PROTOCOL.md](PROTOCOL.md)，运行链路与安全边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。

接口事实以 `server.js`、`agent-appserver.js` 和对应测试为准。当前线上的 thread 元数据与历史只来自 app-server 的 `thread/list`、`thread/read`、`thread/resume` 和 `thread/status/changed`；网关不维护第二套会话历史。

## HTTP 接口

所有 HTTP 请求先经过传输策略：远程明文默认返回 `426 secure_transport_required`；受信反向代理必须提供有效的转发协议头。未配置 `AUTH_TOKEN` 时，Host 与客户端地址都必须是 loopback。

| 方法 · 路径 | 路由鉴权 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /health` | `httpAuth` | — | `{status, sessionId, busy, sessionState, versions, timestamp}` |
| `POST /auth/session` | `x-auth-token` + 有效 `x-device-token`；失败限流 | 无 body | `201 {ok:true, expiresAt}`，并设置 `codex_session` cookie |
| `DELETE /auth/session` | 有效 `codex_session` cookie | — | `204`，清 cookie 并断开使用该 session 的 Socket |
| `GET /push/vapid-public-key` | 无额外路由鉴权 | — | `{key}`；Push 未配置时 `503` |
| `POST /push/subscribe` | `httpAuth` + 已批准的 `x-device-token` | 标准 PushSubscription JSON，最多 4 KiB | `{ok:true}` |

`/health` 没有浏览器 tab 上下文，因此兼容字段 `sessionId` / `sessionState` 返回 `null`；每个设备的当前 runtime 只存在于 Socket 视图和 `instances` 信封中。

`httpAuth` 接受有效的 HttpOnly session cookie；主机侧调用也可用 `x-auth-token`。HTTP 路由和 Socket 握手都不会把 URL 查询参数当作鉴权凭证。当前页面仍兼容一次性的 `?token=` bootstrap：前端读取它后立即用 `history.replaceState` 从地址栏删除，再通过 `POST /auth/session` 的 header 换取 cookie；它不是可重复使用的 query 鉴权通道。后续 Socket 使用同一 `deviceToken` 与 cookie；cookie 为 `HttpOnly; SameSite=Strict`，安全传输时附加 `Secure`，默认 TTL 为 7 天，可由 `CODEX_SESSION_TTL_MS` 调整。

`POST /push/subscribe` 会校验 HTTPS endpoint、`p256dh`、`auth`，并按设备绑定一条订阅。上限由 `CODEX_PUSH_MAX_SUBSCRIPTIONS` 控制；常见错误为 `invalid_subscription`、`device_not_approved`、`subscription_limit` 和 `subscription_persist_failed`。只有持久化成功后内存订阅才会更新。

## Socket.IO 客户端到服务端

远程 Socket 必须通过允许的 Origin、有效的设备绑定 session cookie 和握手 `auth.deviceToken`。本机 loopback 在配置 `AUTH_TOKEN` 时可用握手 `auth.token`；远程握手不接受 host token。待批准设备只能接收设备状态，其客户端事件会被丢弃。

大多数事件使用 Socket.IO ack。通用成功形态为 `{ok:true, ...}`，失败形态为 `{ok:false, error, errorCode?, retryable?}`；下表只列事件实际读取的字段。

### 核心交互

| 事件 | 参数 | ACK |
|---|---|---|
| `user:message` | `text`、`attachments[]`、`parts[]` 至少一项非空；可选 `turn`：`model`、`effort`、`approvalPolicy`、`sandbox`、`serviceTier`；可靠发送时带 `clientRequestId`、`instanceId` / `threadId` | `{ok, instanceId, threadId, receipt?, duplicate}` |
| `message:reconcile` | `clientRequestId`、可用时带稳定 `threadId`、`attemptedGatewayEpoch`、`cwd` | `{ok, resolved, source, gatewayEpoch, receipt? / outcome?, resultUnknown?}`；只读，不派发消息 |
| `user:interrupt` | `instanceId`、`threadId`、`turnId`；缺省时使用该 Socket 当前视图 | `{ok:true, instanceId, threadId}` 或 `stale_target` |
| `user:approval` | `needId`、`approvalId`、`decision`，以及精确目标 `instanceId`、`threadId`、`turnId`、`itemId`；回答问题时带 `answers` | `{ok, duplicate, errorCode?, resultUnknown?, needId, state, revision, instanceId, threadId}` |
| `needs-you:snapshot` | — | `{ok:true, revision, needs}`，仅含 pending / unknown 项 |
| `conn:ping` | — | `{ok:true, t}`；无业务副作用，待审批设备也可调用 |

`user:message` 的可选 `turn.permission` 使用 `{mode:"ask"|"auto-review"|"full-access"|"host"|"custom", custom?}`。custom 包含 approvalPolicy、approvalsReviewer 和 sandbox。服务端按预设生成协议字段并检查主机限制，无效显式权限返回 `invalid_settings`。语义设置随 outbox 保存并参与 clientRequestId 指纹；旧 flat model、effort、approvalPolicy、sandbox、serviceTier 仍兼容。跟随主机配置每轮重新解析当前 cwd 的权限配置，当前运行中的 steer 不修改权限。上游只列加速档时，页面标准速度对应不发送 serviceTier。

`user:message` 的 `text` 上限为 50,000 字符。`attachments` 只能缺省、为 `null` 或为数组；其他类型立即 ACK `invalid_attachments`。`attachments[]` 每项为 `{name, mimeType, data}`，其中 `data` 是严格 base64；最多 10 个、单个 10 MiB、合计 20 MiB。Socket.IO `maxHttpBufferSize` 为 32 MiB，仅用于容纳最大合法附件的 base64/JSON wire 开销，不改变业务上限。文件先写入 0700 的 `.ccm-uploads/`（文件 0600），再转换为 app-server 结构化 `UserInput`：

- 经字节签名验证的 PNG → `{type:"localImage", path}`；
- 其他上传文件 → `{type:"mention", name, path}`；
- 文本 → `{type:"text", text, text_elements:[]}`。

`parts[]` 出现时必须包含 1–20 项，支持 `mention`、`skill` 和 `imageUrl`。mention 必须解析到 runtime cwd 内的真实文件；skill 必须重新匹配 `skills/list` 返回的已启用项；远程图片默认关闭，启用 `CODEX_ALLOW_REMOTE_IMAGES=1` 后仍只接受解析到公网地址的无凭证 HTTPS URL。它们分别映射为 app-server 的 `mention`、`skill`、`image` 输入，不会把路径拼接进文本提示词。

可靠发送要求 `clientRequestId` 匹配 `[A-Za-z0-9._:-]{1,128}` 且 Socket 有稳定 `deviceToken`。浏览器在第一次发送前写入 IndexedDB outbox；服务端按设备身份 + `clientRequestId` + payload 指纹占位并单飞派发：

- 相同请求重试会等待或重放原 ACK，并返回 `duplicate:true`；
- 相同 ID 搭配不同内容或目标返回 `request_id_conflict`；
- 成功 receipt 的 `state` 为 `queued`、`submitted` 或 `steered`；
- `queued` 只更新 outbox 记录，不能清除它；runtime 后续通过 `message_receipt` 推进到 `submitted` / `steered` 后才确认并删除，`rejected` 则保留为明确失败；
- 同一个 ID 传给 app-server 的 `turn/start.clientUserMessageId` 或 `turn/steer.clientUserMessageId`。

服务端 receipt ledger 是当前 gateway 进程内的有界内存状态；每个进程在 `init.payload.gatewayEpoch` 暴露一个随机启动 epoch。浏览器 IndexedDB outbox 记录实际尝试的 epoch：ACK/派发结果未知、页面中断，或旧 epoch 留下的 `queued` 状态都会进入 `needs_reconcile`，普通 drain 在该 FIFO 头停止。

`message:reconcile` 不会调用 `turn/start` / `turn/steer`：同一 gateway 内先按设备身份和请求 id 回放 receipt，即使没有 thread id 也执行该查询；ledger 不存在且请求带稳定 thread id 时，调用 `thread/read(includeTurns:true)` 查找 `userMessage.clientId === clientRequestId`。命中返回合成的 `submitted` receipt 并删除 outbox；未命中、无稳定 thread 或读取失败时记录继续保持未知。provisional instance 已消失时，`pending` 且从未尝试的记录可以保留原 id 重绑到当前精确 view；已尝试记录继续显示“不会自动重发”，只有用户确认“可能重复执行工具或修改”后才创建新 `clientRequestId`，并保存 `retryOfClientRequestId`。gateway 重启后的端到端去重不由内存 ledger 单独保证，但未知写请求不会盲目重放。

### 运行实例 session:*

这些事件只控制网关内的 runtime 视图，不是历史事实源。

| 事件 | 参数 | ACK |
|---|---|---|
| `session:new` | `cwd` | `{ok:true, instanceId, threadId:null, cwd}` |
| `session:fork` | `instanceId` / `threadId`、`ephemeral` | `{ok:true, sessionId, threadId, instanceId, cwd}` |
| `session:switch` | `instanceId` | `{ok:true, instanceId, threadId}`；未知实例返回 `stale_target` |

`session:switch` 只更新发起 Socket 的 `viewingInstanceId` 和房间订阅，不改变其他设备的当前视图。

### 线程 thread:*

| 事件 | 参数 | ACK |
|---|---|---|
| `thread:list` | `cwd`、`archived`、`limit`（默认 50）、`cursor`、`searchTerm` | `{ok:true, threads, nextCursor, backwardsCursor, archived}` |
| `thread:select` | `threadId`、`cwd` | `{ok:true, sessionId, threadId, instanceId, cwd}`；ACK 后再发送 scoped `init` |
| `thread:history` | `threadId`、`cwd` | `{ok:true, thread, messages, source:"thread/read"}` |
| `thread:archive` / `thread:unarchive` / `thread:delete` | `threadId`、`cwd` | `{ok:true, threadId}` |
| `thread:rename` | `threadId`、`name`、`cwd` | `{ok:true, threadId, name}` |
| `thread:collaborationMode` | `mode`（`default` / `plan`）、`threadId`、`cwd` | 兼容实验适配；`applied:false` / `deferred:true` 不代表下一轮会应用。Web Plan 入口禁用，稳定 `turn/start` 不包含 `collaborationMode` |
| `thread:compact` | `threadId`、`cwd` | `{ok:true, threadId}` |
| `thread:rollback` | `threadId`、`numTurns`、`cwd` | `{ok:true, thread}` |

`thread:select` 复用已有 runtime，或创建一个绑定该 thread 的 runtime；真正恢复在首次使用时调用 app-server `thread/resume`。`thread:history` 和 gap 重建都直接调用 `thread/read(includeTurns:true)`。Host 收到未加载 thread 的 `thread/status/changed` 时不会创建 runtime，而是广播 `scope:"host"` 的 `thread_status` 控制信封；`thread:list` 会用 host 保存的最新 revision 覆盖较旧状态。

### 账号 account:*

| 事件 | 参数 | ACK |
|---|---|---|
| `account:loginStart` | `type`（仅 `chatgptDeviceCode`）、`cwd` | `{ok:true, loginId, verificationUrl, userCode}` |
| `account:loginCancel` | `loginId` | `{ok:true, status}` |
| `account:read` | `cwd` | `{ok:true, account, usage, rateLimits}` |

### 只读资源

| 事件 | 参数 | ACK |
|---|---|---|
| `models:read` | `cwd`、`includeHidden` | `{ok:true, models, nextCursor, capabilities}` |
| `session-settings:read` | `cwd` | `{ok:true, effective, available:{permissionModes:[{id,enabled,reason}], collaborationModes}, restrictions}`；只返回权限相关字段，读取失败时禁用权限选项 |
| `fs:readDirectory` | `cwd`、`path`（默认 WORK_DIR） | `{ok:true, entries, path}`；`path` 必须落在工作区内，否则拒绝 |
| `fs:readFile` | `cwd`、`path` | `{ok:true, dataBase64, path}`；同上 |
| `devices:list` | — | `{ok:true, devices}`，每项含 `deviceRef`（16 位引用）、`ip`、`userAgent`、`approvedAt`、`lastSeenAt`、`pushSubscribed`、`current` |
| `devices:revoke` | `deviceRef` | `{ok:true}`；按列表给出的引用撤销，服务端解析回完整 token。引用无法唯一命中时 `device_ref_unknown` / `device_ref_ambiguous` |
| `files:search` | `cwd`、`query` | `{ok:true, paths, cwd}`；只在 allowlist cwd 内模糊匹配相对路径 |
| `git:status` | `cwd` | `{ok:true, branch, staged, unstaged, untracked, conflicted, truncated}`；非 git 仓返回 `errorCode:"not_git"` |
| `git:diff` | `cwd`、`path`、`side`（`staged`/`unstaged`） | `{ok:true, path, side, patch, binary, truncated, empty}`；越界路径 `errorCode:"bad_path"` |
| `mcp:read` | `cwd`、`limit`（默认 50） | `{ok:true, servers, nextCursor}` |
| `skills:read` | `cwd`、`forceReload` | `{ok:true, entries}` |
| `externalAgentConfig:detect` | `cwd`、`includeHome` | `{ok:true, items}` |
| `externalAgentConfig:import` | `cwd`、`migrationItems[]` | `{ok:true, importId}` |

### 设备审批与断线恢复

| 事件 | 参数 | ACK |
|---|---|---|
| `user:approveDevice` | `deviceId`，且设备必须仍在 pending 列表 | `{ok:true}`；写盘失败为 `{ok:false,error:"device_persist_failed"}` |
| `user:denyDevice` | `deviceId` | `{ok:true}`；写盘失败为 `{ok:false,error:"device_persist_failed"}` |
| `catch-up` | `instanceId`、`sessionId`（其值为 thread id）、`lastSeq`、`lastEpoch` | 见下文 |

批准和拒绝只能由已批准 Socket 发起。拒绝会断开该设备的在线 Socket、撤销其 auth sessions，并移除它绑定的 Push 订阅。外部删除 trusted-device 记录即使设备离线也会撤销 session/Push；远程 Socket 会断开，已经连接的 loopback Socket 则保留。

`catch-up` 必须同时命中同一 runtime 的实例与 thread。无 gap 且 epoch 相同：

```json
{"replayed":3,"gap":false,"epoch":"...","instanceId":"inst_1","threadId":"thr_1"}
```

若环形缓冲已截断或 `lastEpoch` 不同，服务端不补发不完整尾部，而是在执行 `thread/read(includeTurns:true)` 前冻结 `throughSeq` watermark：

```json
{
  "replayed": 0,
  "gap": true,
  "rebuilt": true,
  "epochMismatch": false,
  "epoch": "...",
  "throughSeq": 42,
  "instanceId": "inst_1",
  "threadId": "thr_1",
  "snapshot": {
    "source": "thread/read",
    "title": "...",
    "threadStatus": {"type": "idle"},
    "messages": []
  }
}
```

`thread/read` 进行期间到达的 runtime 事件会获得大于 `throughSeq` 的序号；客户端先暂存，应用 snapshot 后再按序重放。

needs-you 是当前 gateway 进程内跨 thread 的中央聚合视图。每项以 `needId` 和完整的 instance/thread/turn/item/request 目标标识；在同一 registry 生命周期和同一 need 记录内，同一决议重复提交返回成功且 `duplicate:true`，不同决议冲突返回 `already_resolved`，使正常重试具备 effectively-exactly-once 语义。该状态未跨 gateway 进程持久化，进程重启不在此保证内。上游 `serverRequest/resolved` 会撤销待办，turn 终态会使未决项过期。

### 宿主配置 host:*

直接改动宿主机 Codex 配置的操作，入口常驻，无需解锁：

- `host:configWrite`、`host:configBatchWrite`
- `host:pluginInstall`、`host:pluginUninstall`
- `host:marketplaceAdd`、`host:marketplaceRemove`、`host:marketplaceUpgrade`
- `host:mcpToolCall`、`host:accountLogout`

每一项都必须带 `confirmAction: <事件名>`（值与事件名完全相同），否则拒绝执行——那是防手机误触，不是防攻击者。成功返回 `{ok:true, result}`；成功、失败与缺确认均写 owner-only 脱敏审计（`data/host-config-audit.jsonl`），MCP arguments 和账号凭证不落明文。

历史：这些事件曾名为 `admin:*` 并藏在解锁机制后（`admin:unlock` / `admin:lock`、`CODEX_ADMIN_ENABLED`、TTL 与失败限流）。口令是源码常量 `ENABLE ADMIN`，任何能打开页面的设备都能解锁，且至少有三条绕行路径——功能层设限挡不住攻击者，只会让人误以为有保护，因此整套拆除而非加固。安全边界是设备凭证。

### 工作区路径作用域

`fs:*` 的 `path`（`fs:copy` 的源和目标都算）必须落在 allowlist 工作区内，由服务端强制：realpath 归一后比对，挡住软链接逃逸；比到路径分隔符，避免 `/srv/work` 顺带放行 `/srv/work-other`；目标尚不存在时对最近的已存在祖先做 realpath 再接回尾巴，让新建文件可用。越界返回 `路径不在允许的工作区内`，并写 `workspace_scope` 审计（含动作、设备引用、脱敏路径）。

这道闸的目的是**防误操作**而非防攻击者：能发消息的设备照样可以让 agent 去读同一个文件。它挡住的是随手翻文件翻到工作区外的私钥，也把 `~/.codex/auth.json`、`~/.ssh` 挡在默认视野之外——凭据外泄是唯一撤销设备也收不回的破坏。

## Socket.IO 服务端到客户端

浏览器业务事件统一通过 `agent:event` 下发。runtime 事件信封为：

```jsonc
{
  "seq": 17,
  "epoch": "runtime-random-id",
  "sessionId": "thr_...",
  "instanceId": "inst_...",
  "cwd": "/work/repo",
  "ts": 1720000000000,
  "type": "text_delta",
  "payload": {}
}
```

`sessionId` 在当前 wire 格式中承载 app-server thread id。runtime 信封的 `seq` 单调递增并进入该 runtime 的有界缓冲；`epoch` 标识当前 runtime 生命周期。网关控制信封使用 `seq:0`、`epoch:"server"`，不属于可重放增量。消息只发往目标 instance room；设备列表、实例列表、needs-you 聚合变化和 host-scope thread 状态只广播给已批准设备。

## agent:event 信封类型

| type | 用途 |
|---|---|
| `device_status` / `pending_devices` | 当前设备批准状态 / 待批准设备列表 |
| `init` / `instances` | 连接或视图初始化 / runtime 列表及当前 Socket 的视图指针 |
| `needs_you_changed` | 跨 thread 待办的 opened/resolved/revoked/expired 版本变化 |
| `status` / `thread_status` / `status_line` | runtime 状态、原生 `thread/status/changed`、git/context 状态栏；host-scope 状态带 `payload.scope:"host"` 与 revision |
| `thread_event` | archived、unarchived、deleted、name_updated 等原生 thread 变化 |
| `collaboration_mode` | Chat/Plan 的上游确认；只有 `applied:true` 才更新 UI，deferred 不视为已生效 |
| `user_message` / `queued_message` / `dequeued_message` / `queue_cleared` | 用户输入和内存队列状态 |
| `message_receipt` | `clientRequestId` 的 queued/submitted/steered/rejected 状态推进 |
| `text_delta` / `reasoning` | 助手文本增量 / summary 或 full reasoning 增量 |
| `tool_use` / `tool_result` / `tool_output_delta` | 命令或动态工具开始、结果、输出增量 |
| `mcp_use` / `mcp_result` / `search` | MCP 调用、MCP 结果、Web 搜索 |
| `file_change` / `diff` / `plan` | 文件变更、turn diff、计划 |
| `approval_request` / `user_input_request` / `approval_revoked` | 审批、提问、上游撤销；打开时 payload 会附 `needId` |
| `account_login` / `account_updated` / `rate_limits` / `usage` | 账号、登录、额度和 token 用量 |
| `compact` / `rollback` | 压缩或回退结果 |
| `mcp_status` / `skills_changed` / `external_agent_config_import` | MCP、skill 和迁移状态 |
| `realtime` / `remote_control` | 实时会话与远程控制通知（服务端转发，Web 端当前无 UI）|
| `result` / `error` / `system` | turn 终态、可见错误和系统消息 |
| `raw_item` | 未识别 app-server item 的可见兜底 |

`approval_request` / `user_input_request` 对应 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`，以及兼容的 `applyPatchApproval`、`execCommandApproval`。前端必须容错未知信封类型；未知 item 使用 `raw_item` 保持可见。

## 门控与鉴权

- **传输**：远程默认要求 HTTPS；只有 `CODEX_TRUSTED_PROXY_IPS` 中的直接对端才可提供转发协议。Socket 远程连接必须命中 `CODEX_ALLOWED_ORIGINS`。
- **host token 与 session**：远程 Host 绑定要求至少 32 字符的 `AUTH_TOKEN`。浏览器用它换取设备绑定的 HttpOnly session，认证失败受 `CODEX_AUTH_MAX_FAILURES` / `CODEX_AUTH_WINDOW_MS` 限流；同一身份/窗口只审计阈值前拒绝和第一次 rate-limit 摘要。
- **设备信任**：远程新设备进入 pending；批准写入 trusted devices。外部撤销即使设备离线也会撤销 session 与 Push 绑定并断开远程 socket，但保留已连接的 loopback socket。
- **Push**：订阅路由必须通过 HTTP 鉴权并提供已批准设备 ID；投递前再次检查设备信任与全部 DNS 结果，非公网或混合解析会拒绝。TLS 仍验证原 endpoint hostname，但连接地址由已验证 DNS 结果 pin；总超时 10 秒、响应上限 64 KiB。陈旧绑定会被清除。approval/question 的 needs-you 推送只含通用提示与 `thread` / `need` 深链，不包含命令或问题正文；result/error 推送没有该深链，正文是截断至 180 字符的 status/message，可能包含实际错误文本。
- **宿主配置**：没有开关也没有解锁步骤；每个动作需要 `confirmAction`，缺失即拒绝并记审计。
- **实验协议能力**：`CODEX_P3_EXPERIMENTAL=1` 时才在共享 app-server 的 `initialize` 里声明 `experimentalApi:true`；它现在只影响 `thread/settings/update`（collaborationMode）是否可用。

详见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。

## 契约测试位置

| 范围 | 测试文件 |
|---|---|
| HTTP/session/Push、Socket 路由、精确实例目标、设备信任、宿主配置 | `test/server-integration.test.mjs`、`test/server-security.test.mjs`、`test/server-push.test.mjs` |
| 共享 app-server 传输与 thread/turn/request 路由 | `test/app-server-host.test.mjs`、`test/app-server-transport.test.mjs`、`test/thread-registry.test.mjs` |
| ACK、receipt、去重与 IndexedDB outbox | `test/socket-ack.test.mjs`、`test/message-receipt-ledger.test.mjs`、`test/message-outbox.test.mjs` |
| structured UserInput、上传与输入解析 | `test/agent-appserver.test.mjs`、`test/new-modules.test.mjs`、`test/input-parts.test.mjs` |
| catch-up、epoch/gap 重建、needs-you 决议 | `test/server-integration.test.mjs`、`test/recovery-state.test.mjs` |
| app-server 生命周期、事件映射与审批 | `test/agent-appserver.test.mjs`、`test/agent-appserver-branches.test.mjs`、`test/protocol-adaptation.test.mjs`、`test/approval-broker.test.mjs` |
| 前端信封渲染与端到端流程 | `e2e/critical-flows.spec.js`、`e2e/needs-you-recovery.spec.js`、`e2e/outbox-recovery.spec.js` |
