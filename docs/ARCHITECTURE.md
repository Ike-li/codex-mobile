# 架构

`codex-chat-mobile` 是 Codex CLI 的自托管移动端 rich client。浏览器只连接开发机上的 Node 网关；网关通过 stdio 管理一个共享的 `codex app-server`，不会把工作代理到本项目自有的托管后端。

## 运行链路

```text
手机浏览器 / PWA
  <-> HTTPS + Socket.IO 稳定事件协议
server.js（鉴权、设备、可靠投递、视图路由、恢复、Push）
  <-> ThreadRuntime[] + ThreadRegistry
  <-> AppServerHost（入站多路复用）
  <-> AppServerTransport（唯一进程、JSON-RPC request id、stdio）
每个 Node 网关进程一个共享 codex app-server
```

各层只承担一个边界：

- `AppServerTransport` 拥有子进程生命周期、全局 JSON-RPC request id、pending response map 和 NDJSON 帧。
- `AppServerHost` 只初始化一次共享进程，并按 thread、turn、request、process/login correlation 把入站通知和 server request 交给唯一 owner。无法确定 owner 的定向 server request 会 fail-closed，应答 JSON-RPC 错误而不是广播或挂起。
- `ThreadRegistry` 维护 `instanceId`、`threadId`、`turnId`、`requestId` 的交叉 ownership；标识未知、过期或指向不同 runtime 时拒绝路由。
- `ThreadRuntime`（`agent-appserver.js`）管理单个 thread 的 start/resume/turn、队列、中断、审批和事件映射，不拥有独立 app-server 子进程。
- `server.js` 管理 HTTP/Socket.IO、工作区 allowlist、每个 socket 的当前视图、消息 receipt、恢复、设备和 Push。

前端由 `public/index.html` 的 HTML shell、外部样式表 `public/css/app.css`、外部主应用模块 `public/js/app.js`，以及 `public/js/` 下的 outbox、ACK、恢复和视图路由小模块组成。它渲染文本增量、thinking/reasoning、命令与工具卡片、diff、审批、提问、状态栏和未知事件的 raw fallback。

`public/css/app.css` 的 `<link>` 必须排在 highlight.js 主题 `github-dark.min.css` 之后：应用样式表覆盖了 `.hljs` 相关的代码块外观，顺序一旦提前，覆盖关系会反转。代码块在浅色和深色配色下都是暗底（`.codex .bubble.md pre` 与 `.tool-output` 固定 `#1e1e1e`），因此只打包暗色主题、不按 `prefers-color-scheme` 切换。两条约束都由 `test/public-shell-guard.test.mjs` 守护。

## 关键数据流

浏览器网关签名见 [API.md](API.md)，app-server 协议面见 [PROTOCOL.md](PROTOCOL.md)。主要链路如下：

- **可靠发消息**：浏览器先生成稳定 `clientRequestId`，把完整 payload 和目标写入 IndexedDB outbox，再发 `user:message` 并等待 ACK。服务端以稳定 device identity + request id + payload fingerprint 做 single-flight、去重和冲突拒绝，回传 `queued` / `submitted` / `steered` receipt；同一 id 原样映射为 app-server `clientUserMessageId`。每次 gateway 启动都有新 epoch；ACK 丢失、页面中断或旧 epoch 的 queued 请求进入 `needs_reconcile`，普通 drain 不会重发。客户端先用 `message:reconcile` 按 request id 查询当前 ledger（没有 thread id 也会查询），有稳定 thread 时再以 `thread/read` 的 `userMessage.clientId` 核对。provisional instance 消失后，从未尝试的 pending 请求可保留原 id 恢复/重绑；已尝试且仍未知的请求只能由用户在重复副作用警告后确认，并生成带 `retryOfClientRequestId` 的新 id。
- **流式与实例路由**：每个浏览器 socket 维护自己的 `viewingInstanceId` 并加入 instance room。runtime 事件带 `instanceId + threadId + turnId + itemId/requestId`；网关只发送到拥有或正在查看该 runtime 的设备，不按进程级“当前标签”猜测目标。
- **审批与提问**：app-server server request 先由 host/registry 定位 owner，再由 `ApprovalBroker` 规范化。`NeedsYouRegistry` 把 approval/question 作为带 revision 的跨 thread need 聚合；新设备可取 snapshot。在同一服务进程和 revision 内，同一 `needId`/decision 可幂等重放，冲突、过期、撤销和未知结果均有明确 ACK；这避免正常重试重复应答，但不承诺跨服务重启的绝对 exactly-once。approval/question Push 只携带泛化正文和 `thread + need` 深链；result/error 也会 Push，但没有该深链，正文取最多 180 字符的 status/message，因此错误文本可能出现在系统通知预览中。
- **断线恢复**：客户端以精确 `instanceId + threadId + lastSeq + lastEpoch` 发 `catch-up`。epoch 一致且缓冲连续时只补缺失增量；环形缓冲有 gap 或 runtime epoch 改变时，网关先冻结当前 `throughSeq` watermark，再调用 `thread/read(includeTurns:true)` 返回 snapshot、watermark 和新 epoch。客户端重建期间暂存 live events，只应用 watermark 之后的事件，因此读取 snapshot 期间到达的增量不会丢失。
- **结构化输入**：`attachments` 只接受缺省/null/数组；上传先经过大小、数量、类型和路径验证，再写入 0700 的 `.ccm-uploads`（文件 0600）。业务上限是单文件 10 MiB、合计 20 MiB，Socket.IO wire cap 为 32 MiB 以容纳 base64/JSON 开销。图片映射为 `localImage`，普通文件映射为 `mention`。显式 parts 还可引用 workspace 内文件、`skills/list` 返回且 enabled 的 skill，以及在 `CODEX_ALLOW_REMOTE_IMAGES=1` 下通过 HTTPS、DNS 和 SSRF 校验的公网图片。路径或 URL 不拼进提示词文本。

## 实例生命周期

`server.js` 的 `agents` map 保存活跃 `ThreadRuntime`，以 UI `instanceId` 为键；`ThreadRegistry` 保证一个 app-server thread 同时只有一个 runtime owner。多个 socket 选择同一 thread 时复用 runtime，但各自维护当前视图。`session:new`、`session:fork` 和 `session:switch` 仍是 UI/运行时控制；历史列表、读取和续接只走 `thread:*`。

所有 runtime 共享同一个 `AppServerHost`。共享子进程退出会通知所有已挂载 runtime；下一次需要协议调用时懒重建进程，各 runtime 再按自己的 thread id 执行 `thread/resume`。`IDLE_TIMEOUT_MS` 不是 runtime 回收策略：它只在 turn 仍为 busy 且 runtime 持续无活动时触发 `turn/interrupt` 和本地中断复位。

## 状态模型

- **app-server thread**：会话内容、标题、时间和活动状态的唯一事实源；读取面为 `thread/list`、`thread/read`、`thread/resume` 和 `thread/status/changed`。
- **ThreadRegistry**：仅保存当前进程内的 live ownership，不是历史数据库。
- **每 socket 视图**：`socket.data.viewingInstanceId` 和 Socket.IO room 决定当前设备看哪个 runtime；不同设备可以同时看不同 thread。
- **UI 本地状态**：`thread-preferences.js` 只保存按 cwd 的当前 thread 指针和界面偏好；可靠 outbox 存 IndexedDB。仓库不再使用 `sessions.json` 或 JSONL legacy history 作为 fallback，也不宣称尚未实现的草稿持久化。
- **可靠投递**：浏览器 IndexedDB outbox 可跨刷新；服务端 `MessageReceiptLedger` 是进程内、有界的 single-flight/去重账本，服务端重启后不承诺保留 receipt。跨 epoch 安全性由 outbox 隔离状态和只读 reconciliation 保证；没有稳定 thread id 时仍先查 ledger。无法核对的已尝试请求保持未知且不会自动执行，只有从未尝试的 provisional 请求可以原 id 重绑。
- **实时恢复**：每个 runtime 持有有界 `seq/epoch` 事件缓冲；gap 时必须回到 `thread/read` 重建。
- **活动状态**：`thread/status/changed` 是 busy/idle/notLoaded/systemError 的协议事实，而不是由 UI 猜测。Host 为每次变化分配 revision，以 `scope:"host"` 的 `thread_status` 广播给所有已批准设备，并把最新状态覆盖到 `thread:list` 结果；若该 thread 尚无 live owner，状态仍会送达且不会为它创建 runtime。已有 owner 时才另外路由到该 runtime。
- **需人工处理**：`NeedsYouRegistry` 保存进程内 revisioned needs；upstream resolved、turn 失败/结束或 owner 释放会撤销对应卡片。
- **主机状态**：trusted/pending devices、Push subscriptions 和两类 audit 写入 `CODEX_DATA_DIR` 的 owner-only 文件。

## 协议边界

生产基线只使用 `codex app-server`，不使用旧的 `codex exec --json`。稳定主链路为 `initialize`/`initialized` → `thread/start|resume|fork` → `turn/start|steer` → 流式通知/server request → `turn/completed|error|interrupt`。

审批和用户输入 server request 必须显式应答。共享 host 只有在完整 target 唯一定位 owner 后才下发；未知定向请求返回 `-32602`，不支持的未知请求返回 `-32601`。已路由到正确 runtime 后，未知 notification 可宽容忽略；未知 item type 则降级为可见 `raw_item`。

`CODEX_P3_EXPERIMENTAL=1` 时才向 app-server 声明 `capabilities.experimentalApi`；核心聊天不依赖它，当前唯一受影响的是 collaborationMode。宿主配置操作不再有特性开关：解锁机制是安全剧场（口令为源码常量、绕行路径至少三条），已拆除；保留的是逐动作确认与审计，那防的是误触。

## 安全模型

- 空 `AUTH_TOKEN` 只允许 loopback；非 loopback 监听要求至少 32 字符。
- 远程明文 HTTP/Socket.IO 默认返回拒绝；HTTPS 反代必须来自精确 `CODEX_TRUSTED_PROXY_IPS` 并提供单一 `X-Forwarded-Proto`，远程 Socket Origin 必须精确列入 `CODEX_ALLOWED_ORIGINS`。
- 远程浏览器用静态 host token 调 `POST /auth/session`，换取绑定 `deviceToken` 的内存 HttpOnly/SameSite=Strict session；远程 Socket 不接受静态 token，HTTP query token 不参与鉴权。
- 新设备保持 pending，批准成功落盘后才解锁。设备 deny 会撤销其全部 session、删除 Push 订阅并断开在线 socket。外部原子删除 trusted-device 记录即使设备离线也会撤销 session/Push 并断开远程 socket，但会保留已经连接的 loopback socket；`DELETE /auth/session` 只撤销当前 session 并断开其 socket。
- Push subscribe 要求已认证且已批准的设备、公网 HTTPS endpoint 和有效 key；先持久化再返回成功，投递前重新验证设备信任与全部 DNS 答案。实际 TLS 请求使用原 hostname/SNI 并 pin 已验证 IP，总超时 10 秒，响应最多读取 64 KiB。
- 认证、配对容量和 Push 容量有界限流；宿主配置操作没有解锁门，但每个动作需要独立确认并写独立审计。
- `security-audit.jsonl` 使用 owner-only O_APPEND、按身份/窗口聚合 rate-limit 摘要，并在默认 1 MiB 时保留一份轮转；`host-config-audit.jsonl` 在 sink 递归脱敏 source/error。两者只记录元数据/hash ref，不保存命令、问题、回答、token 或附件正文，也都不是防篡改审计系统。

## 维护中的设计决策

- 每个 Node 网关进程只运行一个共享 app-server；受支持的部署是一台主机运行一个网关服务，同一 thread 只能有一个 live owner。当前代码不协调多个独立 `server.js` 进程。
- app-server thread API 是唯一会话事实源；浏览器本地只保存 UI 偏好、可靠 outbox 和当前指针。
- Socket.IO envelope、ACK/receipt 与 recovery snapshot 是浏览器的稳定协议边界。
- 目标不完整或标识冲突时 fail-closed，不使用全局当前视图猜测 thread。
- P0 聊天、可靠投递、恢复和安全不依赖宿主配置面板。
- 日常回归只用确定性 mock app-server。接受 Codex CLI 升级前必须按 [PROTOCOL_UPGRADE.md](PROTOCOL_UPGRADE.md) 更新 pin、基线和协议门禁。
