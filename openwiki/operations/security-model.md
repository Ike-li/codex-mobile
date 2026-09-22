---
type: operations
title: 安全边界：绑定、令牌、设备配对与脱敏
description: 默认只绑 loopback 与显式开远程的代价、入册令牌与设备专属凭证、设备配对握手与待批上限、鉴权失败的窗口限流、Origin 与传输安全判定，以及日志与 RPC 帧的脱敏闸。
tags: [security, authentication, device-pairing, rate-limit, cors, redaction]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-d7fd5ab53bb84e56628edfdd
    resource: repo://src/agent/rpc-log-redaction.js
  - id: openwiki-source-7fe36de5900360a87e726462
    resource: repo://src/auth/devices.js
  - id: openwiki-source-47ca446328fb5ed8edaf9009
    resource: repo://src/auth/server-security.js
  - id: openwiki-source-1a82b4c8690c3080b2709351
    resource: repo://src/ops/client-error-log.js
  - id: openwiki-source-048b1ce57bad90f097d425b2
    resource: repo://src/shared/sanitizer.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 安全边界：绑定、令牌、设备配对与脱敏

这个网关把「能在你机器上跑任意命令的 agent」接到了手机上。它的安全模型可以概括成一句：**审批与沙箱由 Codex 自己执行，网关不绕过；网关自己负责的是「谁能连上来」和「连上来之后能碰到什么」。**

## 绑定：默认 loopback

`resolveListenHost` 有两条硬拒绝：

- 没有 `AUTH_TOKEN` 时，`HOST` 必须是 loopback；
- 绑非 loopback 时，`AUTH_TOKEN` 至少 32 字符。

两条都在启动期抛错并退出，不降级。配套的 `noTokenLocalOnly` 中间件在没有令牌时把所有非本地请求挡在 403。

要让手机连上得**显式**改成 `0.0.0.0` 并配好来源白名单——装机向导会问，不替用户决定。

## 传输安全判定

`evaluateTransportSecurity` 每个 HTTP 请求跑一次，结论挂在 `req.codexGatewaySecurity` 上，不通过直接 426。

| 判定 | 规则 |
|---|---|
| 本地 | 对端是 loopback **且** Host 头是 loopback，且不是经可信代理进来的 |
| 协议 | socket 加密就是 https；经可信代理时改用 `X-Forwarded-Proto` |
| 远程明文 | 除非 `CODEX_ALLOW_INSECURE_REMOTE=1`，否则拒绝 |

可信代理那一支很严：在可信 IP 列表里却**没有** `X-Forwarded-Proto` 头就直接拒（`forwarded_proto_required`），头的值不是 `http`/`https` 也拒。半信半疑地猜一个协议比拒绝更危险。

Origin 判定（`evaluateSocketHandshakeSecurity`）分本地远程两套：远程连接**必须**带 Origin 且在白名单里；本地连接允许无 Origin，有 Origin 时要么同源要么在白名单里。`canonicalOrigin` 只接受纯 origin 形态——带路径、query、hash、用户名密码的一律判非法。

策略解析 `parseGatewaySecurityPolicy` 对非法条目**抛错而不是忽略**：一个拼错的 origin 被静默丢掉，结果是用户以为配了白名单而实际没有。

所有响应都带一组安全头：CSP（`script-src 'self'`，配合 SHELL-01 的「无内联 script」）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。

## 两级凭证

**入册令牌**（`enrollmentToken`）启动时取自 `AUTH_TOKEN`，可在运行时经 `POST /auth/enrollment/rotate` 轮换，持久化在 `data/enrollment-token`。它只在新设备首次接入时用一次。

持久化是必须的：否则「轮换」等于「轮换到重启前有效」，用户没法信任它。

**设备专属凭证**：设备被批准后 `issueDeviceSecret` 签发一个 32 字节随机串，只存哈希。此后设备用它换会话，不再经过入册令牌。

这个两级设计的意义是：**轮换入册令牌只阻断新设备注册，已注册设备不受影响**。改 `AUTH_TOKEN` 要重启且所有人重登，方向正好相反。

令牌比对一律用 `timingSafeEqual` 并先比长度。

**会话 cookie**：`issueAuthSession` 发 32 字节随机 token，服务端只存 SHA-256 后的 key。Cookie 属性 `HttpOnly; SameSite=Strict; Path=/`，传输安全时追加 `Secure`。有 TTL，过期条目每 5 分钟清一次。撤销设备时按 deviceToken 批量吊销它的全部会话。

## 设备配对

Socket 握手（`io.use`）的顺序是：

1. **鉴权**：无 `AUTH_TOKEN` 时只认本地；本地且令牌匹配可以直接过；否则要 cookie 会话且其 deviceToken 与握手声明的一致。
2. **deviceToken 形状校验**：非本地连接必须提供，提供了就必须匹配 `DEVICE_TOKEN_PATTERN`。
3. **信任判定**：本地连接直接 `deviceApproved = true`；否则查信任表，不在表里就进待批队列并在服务端控制台打印一段醒目提示（有 TTY 时按回车即批准，否则给出 `node scripts/device.js approve` 命令）。

待批队列有上限（`CODEX_PENDING_DEVICE_LIMIT`），满了直接以 `pairing_capacity` 拒绝——不然任何人都可以用无限新设备把队列刷爆。

已批准的设备可以在手机上远程批准/拒绝其他待批设备（`user:approveDevice` / `user:denyDevice`）。

信任表文件被 `fs.watch` 盯着，外部改动（比如用 CLI 批准）会触发 `reconcileTrustedDeviceSockets`，把受影响的 socket 解锁或断开。

### 信任表读失败：fail-closed

`loadTrustedDevices` 读失败时**清空内存表并标记 `trustedLoadFailed`**，之后 `saveTrustedDevices` 拒绝把这份残缺的表写回磁盘。

不挡住的话，一次瞬时读失败（fd 耗尽、权限被改、EIO——磁盘上的字节完全没问题）之后的任何一次批准/撤销，都会把一份残缺的表原子覆盖回文件，**老设备永久失联**。

方向选择被写进注释：读不出信任表就谁也不信。门后面是能改本机文件系统的 agent，宁可全锁死也不拿一份不知道是否过期的信任表放行。注释还注明姊妹项目在同一岔口选了保留 last-good（可用性优先），两个方向都成立——改方向前先读那段。

签名缓存在失败时一并作废：留着旧签名的话，文件被恢复成逐字节相同的那一份时会命中缓存，于是拿着这份空表当成「已是最新」。

## 限流

HTTP 与 socket 握手**共用同一张失败窗口表**。不共用的话，`/health`、`/metrics`、`/push/*` 就是一条无限次试令牌的通道，而同一个 IP 的 socket 早已被锁——攻击者只要挑 HTTP 这一侧打就完全绕过了锁定。

401 与 429 说的是两件事：401 是「令牌不对，重输」，429 是「已达阈值被锁，等一下」并给 `Retry-After`。说成同一个会让正在被锁的人一遍遍重输一个其实正确的令牌。

失败日志只记 path / 来源 / 失败类别，**绝不带令牌值**。`bad_token` 指向配置漂移，`no_token` 指向扫描器——两个完全不同的排查方向。

### 限流表自己不能变成放大器

这张表有两套回收，各管一头，**不可互相替代**：

- `trimAuthFailureWindows` 只保证**上界**（10000 条），每次失败时跑。
- `pruneExpiredFailureWindows` 负责上界之下的**过期回收**，每 5 分钟全表扫。

为什么不能只留一个：`Map.set` 对已存在的 key 只更新值、不改变迭代顺序，而窗口过期后会就地重建（新的 `resetAt`）。于是一个持续失败的来源会一直待在表头，它的 `resetAt` 反倒是全表最新的——「表头即最早到期」不成立，trim 的循环在第一个条目就 break，一个也删不掉。

为什么不能把 prune 挂到每次失败上：实测冲过阈值后同样 2000 次调用从 0.3ms 涨到 309ms（899 倍）。而且可达性不是理论上的——IPv6 下一个 /64 前缀给单台主机 $2^{64}$ 个源地址，每个都会新建一个窗口，**为抵抗认证滥用而存在的限流表自己成了 DoS 放大器**。

上界的代价被明确写出来：攻击者用一万次失败可以把自己早先那条被限流的记录顶出去，等于提前重置计数。但那一万次本身就是失败的认证请求，而他本来也只要等一个窗口就能重置。

## 安全审计

`data/security-audit.jsonl` 记录鉴权失败、设备配对、工作区越界、文件变更、审批决议、附件写入、保留清理、服务重启等事件。多代轮转，owner-only 权限，写入失败被吞掉——**安全日志不得让认证路径崩溃**。

重启事件单独记一条：重启边界是读审计时唯一的分段标记，而「这条异常发生在重启前还是重启后」常常就是排查的分水岭。

审计里的标识符过 `securityRef()`（SHA-256 前 16 位），不记原值。

## 工作区越界

`fs/*` 的作用域闸门在网关这一侧：协议只校验「是不是绝对路径」。`requireWorkspacePath` 解析失败时写一条 `workspace_scope / denied` 审计并抛错。

**只记拒绝**：那是安全事件，而放行的读取太频繁（文件浏览器持续列目录），逐条记会把审计淹掉。详见[工作区与文件](../workflows/workspace-and-files.md)。

## 脱敏

三层，各守一处：

**`src/shared/sanitizer.js`** —— 通用日志脱敏。十余条模式覆盖 API key 形态、GitHub token、JWT、PEM 私钥、Bearer / Basic、AWS key、URL 里的用户名密码等，外加一条「敏感赋值」规则。

这条规则的写法有两个坑被注释钉住：

- 不能写成 `[A-Za-z_]*(key|secret|…)[A-Za-z_]*`——前后两个 Kleene star 与中间 alternation 的字符集完全重叠，每个起始位置都要穷举切分点，实测退化到 O(n³)。
- 值必须停在分隔符处。用 `\S+` 会吃掉整个非空白串，`replace` 的 `lastIndex` 随之跨过后面的敏感赋值——`project=demo&secret=…` 里的 secret 就是这样整条漏出去的。

还负责剥离 ANSI 转义序列与终端控制字符。

**`src/agent/rpc-log-redaction.js`** —— RPC 帧落盘前的闸。它被从 `agent-appserver.js` 里搬出来的理由是：原先是模块私有函数、没有任何测试直接调过，变异跑出来这一族有 31 个存活——**而它守的是唯一把 API key、prompt、绝对路径挡在落盘日志之外的那道闸**。日志文件是 0600 的，但它仍然会进备份、进 issue 附件、进截图。

三条判据分工不同：

| 判据 | 动作 |
|---|---|
| `SENSITIVE_RPC_KEY_RE`（键名像凭证） | 整个值换成 `<redacted>`，一个字节都不留 |
| `CONTENT_RPC_KEY_RE`（键名是正文） | 只留长度，用户 prompt 与工具输出不落盘 |
| 其余 | 过 `sanitize()` + `sanitizePath()` 后截断 |

高频增量通知（方法名以 `Delta` 结尾）由 `isDeltaNotification` 识别，逐帧留档没有意义。

**`src/ops/client-error-log.js`** —— 前端错误上报的收敛层。前端错误是**不可信输入**：字段可以是任意类型、任意长度，内容里可能带令牌或路径。进日志之前三道收敛：形状校验 → 长度钳制 → 脱敏，另加一个按 socket 的限流器。少任何一道，一次前端崩溃就能把一段带凭据的堆栈原样写进服务端日志。

契约层的 `ackError` 同样过 `sanitize`，见 [Socket.IO 契约层](../architecture/socket-contract.md)。

## 出站安全

Push 发送是一条加固过的 SSRF 防护路径（公网 HTTPS 校验 + DNS 结果逐条校验 + 地址 pin + endpoint 逐字比对），见[未读位点与通知](../concepts/unread-and-notifications.md)。`/push/subscribe` 的订阅体在入口就做同样的 endpoint 校验，并限制 key 长度。

远程图片 URL 默认关闭（`CODEX_ALLOW_REMOTE_IMAGES`），开启时也要过公网判定，见[输入组装](../workflows/compose-and-input.md)。

## 相关测试

- [test/unit/server-security.test.mjs](../../test/unit/server-security.test.mjs)、[test/unit/devices.test.mjs](../../test/unit/devices.test.mjs)
- [test/unit/sanitizer.test.mjs](../../test/unit/sanitizer.test.mjs)、[test/unit/rpc-log-redaction.test.mjs](../../test/unit/rpc-log-redaction.test.mjs)
- [e2e/remote-origin-handshake.spec.js](../../e2e/remote-origin-handshake.spec.js) —— 服务端 Origin 判定的两条分支（靠 Chromium 的 `--host-resolver-rules` 走到「远程」分支）
