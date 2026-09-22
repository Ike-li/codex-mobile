---
type: workflow
title: 输入组装：@ 提及、斜杠命令与附件
description: 一条消息从手机输入框到协议 UserInput 的全过程——@ 文件提及、内置斜杠命令与动态 skill 的挑选层、图片与文件附件的按内容识别与安全落盘、服务端 resolveInputParts 的作用域闸与远程图片门控。
tags: [compose, input, attachments, slash-commands, mentions, upload]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-897d2b46717390e5ea4b0fc4
    resource: repo://public/js/compose/at-mention.js
  - id: openwiki-source-a5eeeaf90e858d24f328d4ee
    resource: repo://public/js/compose/message-request.js
  - id: openwiki-source-60a100a02cfccc4b09e0721c
    resource: repo://public/js/compose/slash-commands.js
  - id: openwiki-source-00049810bba1f9e9f0427035
    resource: repo://src/files/uploads.js
  - id: openwiki-source-473278ad49e973d167404dd5
    resource: repo://src/sessions/input-parts.js
  - id: openwiki-source-eb5f06631d1f85b6395b4337
    resource: repo://src/sessions/user-inputs.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 输入组装：@ 提及、斜杠命令与附件

一条消息在手机上可能包含四种东西：文本、`@` 提及的工作区文件、`/` 命令或 skill、图片与文件附件。它们最终要变成协议的结构化 `UserInput` 数组。

链路是：**浏览器组装 → `createMessageRequest` 打包 → `user:message` → 服务端校验/落盘/解析 → `buildUserInputs` → `turn/start`**。

## 斜杠命令：为什么必须自己实现

codex 的 slash command 整套住在 TUI 层（二进制里只有 `codex_tui::slash_command`，core 和 app-server 没有任何 slash 符号），app-server 的 `turn/start` 只收 UserInput 内容，没有 command 字段。

所以「把 `/compact` 发过去让 codex 自己解析」是死路——**TUI 自己也只是个 app-server 客户端**，它的 `/compact` 就是一次 `thread/compact/start`。本文件做的是 TUI 那张映射表的移动端版本：文本 → 意图。

命令词的正则收得很紧：开头一个词、不含第二个斜杠。这是为了不误伤正常消息——`/usr/bin/codex 这个路径不对` 和 `/etc/hosts` 都得当普通文本发出去。不收参数的命令带了参数同样当普通消息。

三类结果：

| kind | 含义 |
|---|---|
| `action` | 已接入，`app.js` 查表执行 |
| `unsupported` | codex 里有、手机端按不下去。**理由必须具体到「改用什么」**，否则用户只知道不能用，不知道下一步往哪走 |
| `unknown` | 都不是 |

`/model`、`/status`、`/permissions` 三条在 codex 里是三个命令，在这边都打开同一个「会话设置」sheet。列表里摆三个名字指向同一处是噪音，所以标 `hidden` 不进挑选层，但 `resolveSlashCommand` 照旧认——**CLI 肌肉记忆不该失效**。

`/review` 是唯一收参数的命令：无参数审未提交改动，有参数当自定义审查指令，参数**原样交出去**（它是给模型读的，只有命令名大小写不敏感）。

### 挑选层：内置 + 动态 skill

`slashPickerItems` 把两段并进同一个列表：内置命令在前（写死，因为 app-server 一个字都不上报），用户自己加的 skill 在后（`skills/list` 能拉、`skills/changed` 会推）。

这样「上游更新不用管」就在**会变的那一半**上成立了。

skill 条目带着 `name` / `path`：选中后走 `{type:'skill', name, path}` 结构化输入，**不是往输入框塞一段文本让模型猜**。

## @ 文件提及

`detectAtMentionQuery` 在光标前的文本里找 `@` 或全角 `＠` 开头的片段。`applyAtMentionPick` 插入路径时会看后面有没有空白——没有就补一个，避免路径和下一个词粘连。

选中搜索结果后由 `mentionPartFromSearchHit` 转成 `{kind:'mention', name, path}`，`name` 取 basename，`path` 拼上 cwd。文件搜索本身见[工作区与文件](workspace-and-files.md)。

## 附件：按内容识别，不看扩展名

`detectImageMimeType` 识别 PNG / JPEG / GIF / WebP 四种格式。

**为什么不能只认 PNG**：识别不出来的后果不是报错——附件会以 `mention` 而不是 `localImage` 下发，模型就「看不见」那张图，而界面上一切正常。iOS 截图确实是 PNG，但相册里的照片多是 JPEG，而「从相册发一张图」是最常见的路径之一。

**每种格式都同时查头和尾**：只查魔数头会把截断的文件也判成图片，而截断的图片解不出来，失败会发生在更下游、错误信息更难懂。查尾等于顺带确认了文件完整。WebP 是 RIFF 容器，用头里的长度字段核对实际长度，等价于查尾。

### 校验与限额

`decodeAttachments` 是零 IO 的校验层，同时把解码后的 buffer 交出去供复用——同一份 base64 此前会被解码三次（校验、指纹、落盘各一次），每次都额外分配一个完整副本。

限额：最多 10 个文件、单文件 10MB、总量 20MB。base64 解码是**严格**的（`decodeBase64Strict` 会把解码结果再编码回去比对），不接受宽松形态。

### 文件名收敛

`sanitizeName` 只取 basename，去掉路径分隔符、控制字符、危险字符，去前导点，并限制长度到 200。

两个细节各对应一次推理：

- **`trim()` 必须排在去前导点之前。** 反过来的话，`<BOM>..evil` 在去点那一步看到的首字符是 BOM 而不是点，点原样留下，trim 再把 BOM 抹掉，结果是 `..evil`——一个隐藏文件；而同样意图的 `..evil` 直接传进来得到的是 `evil`。**同一个意图的两个输入归一到不同结果，就说明顺序错了。** BOM、NBSP 都算 JS `trim` 承认的空白。
- **超长时要保住扩展名。** agent 拿到的是这个名字，`.png` 被截掉会改变它对文件的判断。只认最后一个点之后的短后缀（≤12 字符），避免把 `a.very.long.thing` 的中段当扩展名。

长度必须在这里管：超长名字不是攻击，是很平常的情况（导出工具常把日期、查询串、标题拼进文件名）。不收敛的话会一路走到 `open()` 才炸成 `ENAMETOOLONG`，用户拿到的是一句裸 errno 加一段宿主机绝对路径。

### 落盘

写到 `<工作区>/.ccm-uploads/<时间戳>-<随机8位>-<安全名>`，防线有五道：

1. 目录路径的**符号链接检查做两次**（`mkdir` 前后各一次）；
2. `lstat` 确认它是普通目录而不是符号链接；
3. `chmod 0700`；
4. 路径穿越检查（解析后的绝对路径必须严格落在目录下）；
5. `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`，模式 `0600`，写完 `fsync`。

返回的记录里 `kind` 由**内容检测**决定（`image` 或 `file`）。给前端的 `user_message` 事件用 `toEventMeta` 剥掉 `absPath`——不泄服务端路径。

上传文件 24 小时后由定时任务清理，删除量非零时写一条审计（零删除不记，避免每小时一条噪音把有价值的记录挤出环形窗口）。

## 服务端解析：resolveInputParts

这是 parts 的**作用域闸门**，三种 kind 各有判据：

**`mention`** —— 必须给 `path`，`realpath` 解析后必须仍在 runtime 的 cwd 之内（用 `relative()` 判断，拒绝 `..` 与绝对路径），并且必须是普通文件。返回的 `name` 是规范化后的相对路径。

**`skill`** —— 必须在 `skills/list` 返回且 `enabled === true` 的集合里按 `name` + `path` 找得到。前端报什么名字不作数。

**`imageUrl`** —— 默认**整个禁用**（`CODEX_ALLOW_REMOTE_IMAGES`）。开启后仍要过一串校验：长度 ≤2048、合法 URL、HTTPS 且无用户名密码、hostname 过公网判定、DNS 解析结果**逐条**必须是公网地址、`detail` 只能是四个枚举值之一。

这是一条 SSRF 防护路径，与[推送发送](../concepts/unread-and-notifications.md)同源。

其余 kind 一律抛错——白名单而不是黑名单。

## 最后一步：buildUserInputs

把文本、落盘后的附件、解析后的 parts 拼成协议的 `UserInput` 数组：

| 来源 | 协议类型 |
|---|---|
| 文本 | `text` |
| 附件 `kind: 'image'` | `localImage`（绝对路径） |
| 附件 `kind: 'file'` | `mention` |
| part `mention` / `skill` | 同名类型 |
| part `imageUrl` | `image`（URL） |

每一支都再校验一次必需字段。这不是冗余——`buildUserInputs` 是最后一道，它保证不会有半成品形状进入协议帧。

## 客户端打包

`createMessageRequest` 生成 `clientRequestId`、深拷贝 attachments 与 parts、按 `threadId` 优先于 `instanceId` 的顺序写投递目标、归一化 turn overrides。`messageWirePayload` 在发送前再校验一次 `clientRequestId` 与外层一致。

这个请求对象随后进 [outbox](../concepts/message-delivery.md)。

## 服务端的前置校验

`user:message` 在触碰 runtime 之前就拒绝一批输入，每种给一个**不可重试**的错误码：空消息 `invalid_message`、附件非法 `invalid_attachments`、文本超 50000 字符 `message_too_long`、parts 数量为 0 或超 20 `invalid_input_parts`、`clientRequestId` 格式不合法 `invalid_client_request_id`。

## 相关测试

[test/unit/at-mention.test.mjs](../../test/unit/at-mention.test.mjs)、[test/unit/slash-commands.test.mjs](../../test/unit/slash-commands.test.mjs)、[test/unit/attachments-ui.test.mjs](../../test/unit/attachments-ui.test.mjs)、[test/unit/uploads-hardening.test.mjs](../../test/unit/uploads-hardening.test.mjs)、[test/unit/input-parts.test.mjs](../../test/unit/input-parts.test.mjs)、[test/unit/user-inputs.test.mjs](../../test/unit/user-inputs.test.mjs)、[e2e/attachments-and-layout.spec.js](../../e2e/attachments-and-layout.spec.js)、[e2e/workspace-and-composer.spec.js](../../e2e/workspace-and-composer.spec.js)
