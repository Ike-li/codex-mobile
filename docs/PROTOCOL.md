# Codex App Server 协议参考

本文件是 codex-chat-mobile 对 Codex `app-server` JSON-RPC 2.0 协议的维护型参考。仓库 pin 为 `.codex-version` 中的 `0.147.0`；类型与方法事实以 `.protocol/stable/` 的 `generate-ts` 基线为准，桥接行为以 `app-server-host.js`、`app-server-transport.js`、`thread-registry.js` 和 `agent-appserver.js` 为准。

本文只记录项目实际依赖与适配边界，不记录某台开发机某次门禁是否通过。更早的调研底稿位于 [archive/](archive/)；它们不再维护，也不是事实来源。

## 三层集合模型

同一批方法在不同视角下的可见性不同：

```text
A   Codex 官方文档
B1  codex app-server generate-ts                → 默认导出
B2  generate-ts --experimental / Codex 源码     → 包含实验接口
```

- `generate-ts` 默认过滤带实验标记的请求方法，但不会因此过滤所有相关通知，所以可能出现“通知已导出、启动方法未导出”。
- `B1 ⊂ B2`；本仓库的 `.protocol/stable/` 固定为 pin 版本的 B1。
- 项目主干只依赖 B1 中的稳定方法。Labs 是项目自身的产品门控：其中既可能包装 B1 方法，也可能只消费实验通知；不能把“出现在 Labs”解释为“一定不在 B1”。
- 共享 app-server 只有在 `CODEX_P3_EXPERIMENTAL=1` 时，才在一次性的 `initialize` 中声明 `capabilities.experimentalApi:true`。

`0.147.0` 默认导出集合为：ClientRequest 98、ServerRequest 10、ServerNotification 72、ClientNotification 1。

## 产品主干接口

### 初始化与唯一事实源

网关对共享 app-server 只执行一次 `initialize` → `initialized`。每个 runtime 随后按需调用：

- 新 thread：`thread/start`
- 恢复 thread：`thread/resume`
- 列表与搜索：`thread/list`
- 历史重建：`thread/read(includeTurns:true)`
- 分叉：`thread/fork`
- 维护操作：`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/name/set`、`thread/compact/start`、`thread/rollback`

thread 的标题、cwd、更新时间、历史和归档状态全部来自上述 app-server 数据；网关不保存平行的 thread 元数据或历史副本。运行中活动状态以 `thread/status/changed` 为准，映射为 `thread_status` 与 `status` 信封，而不是由浏览器猜测。

### Turn 与结构化输入

`turn/start` 创建 turn；运行中追加指令使用 `turn/steer`；中断使用 `turn/interrupt`。输入统一写入 `input: UserInput[]`：

| 浏览器来源 | app-server UserInput |
|---|---|
| 文本 | `{type:"text", text, text_elements:[]}` |
| 经签名验证的本地 PNG | `{type:"localImage", path}` |
| 上传文件或 cwd 内文件引用 | `{type:"mention", name, path}` |
| 已启用 skill | `{type:"skill", name, path}` |
| 允许且通过 SSRF 校验的远程图片 | `{type:"image", url, detail?}` |

上传路径与引用不会改写成提示词文本。可靠发送时，浏览器 `clientRequestId` 原样写入 `turn/start.clientUserMessageId` 或 `turn/steer.clientUserMessageId`。

流式主链为 `item/started` → delta → `item/completed`：

- 助手文本：`item/agentMessage/delta`
- reasoning：`item/reasoning/summaryTextDelta`、`item/reasoning/textDelta`、`item/reasoning/summaryPartAdded`
- 命令输出：`item/commandExecution/outputDelta`
- turn：`turn/started`、`turn/completed`、`turn/plan/updated`、`turn/diff/updated`
- thread：`thread/status/changed`、`thread/tokenUsage/updated`、`thread/archived`、`thread/unarchived`、`thread/deleted`、`thread/name/updated`、`thread/compacted`

终态从 `turn/completed.status` 读取。`turn/failed` 只作为 `0.147.0` 基线外的一版本兼容项保留。

### Server request、账号与资源

app-server 发起且必须响应的交互：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- 兼容 `applyPatchApproval`、`execCommandApproval`

`serverRequest/resolved` 会撤销对应的浏览器待办。`account/chatgptAuthTokens/refresh` 被明确回复 `-32601`，不会透传凭证。

主干还使用：

- 账号：`account/read`、`account/usage/read`、`account/rateLimits/read`、`account/login/start`、`account/login/cancel`
- 模型：`model/list`、`modelProvider/capabilities/read`
- 会话模式：B1 可读取 `thread/settings/updated.collaborationMode`；写入走实验方法 `thread/settings/update`（探测失败则降级为下一轮 `turn/start.collaborationMode`）
- 只读资源：`fs/readFile`、`fs/readDirectory`、`mcpServerStatus/list`、`skills/list`、`externalAgentConfig/detect`、`externalAgentConfig/import`
- 需要逐动作确认的宿主机写操作：`config/value/write`、`config/batchWrite`、`fs/writeFile`、`fs/remove`、`fs/copy`、`plugin/install`、`plugin/uninstall`、`marketplace/add`、`marketplace/remove`、`marketplace/upgrade`、`mcpServer/tool/call`、`account/logout`

常见 item wire `type` 包括 `userMessage`、`agentMessage`、`plan`、`reasoning`、`commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`webSearch`、`imageView`、`enteredReviewMode`、`exitedReviewMode`、`contextCompaction`。只有已由 host 精确路由到 owner runtime 的未知通知才可宽容忽略；无法路由的帧会记录诊断，定向 server request 会 fail-closed。未知 item 转成可见的 `raw_item`，避免静默丢失用户可见工作。

## 实验门控接口

以下能力位于项目 Labs 面板，默认关闭：

| 分组 | 底层协议 | 当前适配 |
|---|---|---|
| 网页终端 | `command/exec`、`command/exec/write`、`command/exec/resize`、`command/exec/terminate` 及输出通知 | 映射为 `term_output` / `term_exit`；虽然方法已在 B1，仍由项目 flag 隔离 |
| 历史分页视图 | `thread/read` | `p3:threadTurns` 返回 `source:"thread/read"`，不调用不存在的独立分页接口 |
| thread 搜索 | `thread/list(searchTerm)` | `p3:threadSearch` 返回 `source:"thread/list"` |
| 实时语音 | `thread/realtime/*` 通知 | 仅映射通知，不启动真实音频会话 |
| 远程控制 | `remoteControl/status/changed` | 仅展示状态，不实现 Codex 官方 pairing |

`experimentalFeature/list` 用作能力探测。Labs 的浏览器入口和 Socket 事件在 flag 关闭时统一返回 `feature_disabled`。

## 传输与运维约定

### 一个共享 app-server

当前网关进程只有一个懒启动的 `AppServerHost`，其内部只有一个 `AppServerTransport`：

```text
browser sockets
      │
      ▼
server.js ── ThreadRuntime(instances)
                   │
                   ▼
             AppServerHost
             ├─ ThreadRegistry
             └─ AppServerTransport ── stdio JSONL ── codex app-server
```

- `AppServerTransport` 负责启动 `codex app-server`、逐行 JSON 编解码、JSON-RPC request id、pending promise 与退出清理。
- `AppServerHost` 负责共享初始化、runtime attach/detach、响应关联和入站 owner 解析。
- `ThreadRegistry` 是 fail-closed 所有权索引，以 `instanceId`、`threadId`、`turnId`、`requestId` 的交集解析唯一 runtime；未知、歧义或互相冲突的标识返回 stale target。
- app-server 的 thread/turn 响应会回绑 registry；审批请求先按 thread + turn 路由，随后绑定 request id。浏览器决议还必须匹配 needs-you 记录中的 item id。
- runtime 释放时只从 host 与 registry 解绑定；不会终止共享子进程。服务停止时才统一 dispose host。

因此浏览器、tab 或 runtime 都不会各自启动 app-server。浏览器也不直连 stdio；Node 网关把 JSON-RPC 适配成带目标、ACK、恢复与安全策略的浏览器协议。

### 网关补充的可靠性语义

以下不是 app-server 自动提供的完整浏览器投递层，而由网关实现：

- `clientRequestId` + 设备身份的进程内去重账本，映射到 `clientUserMessageId`；浏览器 IndexedDB outbox 负责跨刷新持久重试，gateway 重启后的去重不由内存账本单独保证
- ACK / receipt 与浏览器 IndexedDB outbox
- 每个 runtime 的 `seq`、`epoch` 和有界事件缓冲
- `catch-up` 增量补发；epoch 不同或存在 gap 时，用精确 `thread/read` 快照重建
- needs-you 在当前 gateway 进程内跨 thread 聚合；同一 registry 生命周期和 need 记录内相同决议幂等重放、不同决议冲突，只提交一次确定响应。该保证不跨 gateway 进程或进程重启

### 背压与日志

- JSON-RPC 返回 `-32001 "Server overloaded"` 时，runtime 按配置指数退避，并发出 `backpressure_retry` 状态。
- `clientInfo.name` 固定为 `codex-chat-mobile`，便于上游审计识别。
- Codex 侧可使用 `RUST_LOG`、`LOG_FORMAT=json`；网关 RPC 观察日志写 owner-only `.codex-chat-rpc.jsonl`，并经过脱敏/截断。

## 与本项目实现的映射

| 层 | 职责 | 代码入口 |
|---|---|---|
| JSONL 传输 | 单子进程、frame 编解码、request/response | `app-server-transport.js` |
| 共享宿主 | 初始化单飞、owner correlation、入站分派 | `app-server-host.js` |
| 精确索引 | instance/thread/turn/request 唯一所有权 | `thread-registry.js` |
| thread runtime | 协议方法、队列、状态、事件映射 | `agent-appserver.js` / `thread-runtime.js` |
| 浏览器网关 | HTTP、Socket、设备视图、catch-up、Push/宿主配置 | `server.js` |
| 可靠请求 | receipt ledger 与客户端 outbox | `message-receipt-ledger.js` / `public/js/message-outbox.js` |
| 跨会话待办 | needs-you 状态机与精确决议 | `needs-you-registry.js` |

对 `0.147.0` 基线的静态使用统计：

| 方向 | 默认导出 | bridge 字面使用 | 说明 |
|---|---:|---:|---|
| Client → Server Request | 98 | 46 | 45 项在基线内，另 1 项是 experimental allowlist 的 `thread/settings/update`；未用能力不会由网关暴露 |
| Client → Server Notification | 1 | 1 | `initialized` |
| Server → Client Request | 10 | 7 | 未处理：`attestation/generate`、`item/tool/call`、`mcpServer/elicitation/request` |
| Server → Client Notification | 72 | 41 | 40 项在基线内，另 1 项是 legacy allowlist 的 `turn/failed` |

「bridge 字面使用」一列统一为 `collectBridgeMethodUsage` 数出的总数，allowlist 项含在内、并在说明列拆开；`0.142.5` 那版表格的 Request 行填的是「在基线内」的数，与列头对不上，这次一并纠正。

从 `0.142.5` 升到 `0.147.0` 是纯新增、零移除：ServerNotification 多出 `thread/environment/connected`、`thread/environment/disconnected`、`rawResponse/completed`，ClientRequest 多出 `threadSection/{list,create,update,delete}`、`thread/section/move`、`app/read`、`app/installed`、`externalAgentConfig/import/recordHistory`。bridge 一项都没接，新通知靠 `handleNotification` 的 switch 落空安全忽略。

统计由 `scripts/gates/protocol-check.mjs` 的静态收集逻辑定义。未处理通知进入 `handleNotification` default 分支并安全忽略；未识别 item 才转成 `raw_item`。

## 升级与验证

升级流程见 [PROTOCOL_UPGRADE.md](PROTOCOL_UPGRADE.md)：

1. 更新 `.codex-version`，用对应 Codex 重新生成临时 TypeScript 导出。
2. 比较方法集合、类型集合与逐文件内容。
3. 修复 `agent-appserver.js`、共享 host/registry 路由、fixtures 和聚焦测试。
4. 审核 `LEGACY_METHOD_ALLOWLIST`；当前只允许 `turn/failed`。
5. 重新生成并提交 `.protocol/stable/`，同步本文的计数与接口清单。

`npm run protocol:check` 同时检查“bridge 使用的方法是否存在于基线”和“当前 pin 重新导出后是否漂移”。该命令会调用本机配置的 Codex 二进制生成协议文件；按项目规则应在明确的协议升级/验证步骤执行。本页不以文字替代真实门禁结果，也不宣称当前机器已经运行通过。
