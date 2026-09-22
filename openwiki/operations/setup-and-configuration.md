---
type: operations
title: 配置系统与装机路径
description: 配置的单一事实源 CODEX_SCHEMA、codex.config.json 与 .env 的源选择与优先级合并、启动期校验为何按 kind 分档、装机向导的拒绝矩阵、配置 CLI 的全或无写入与只读键，以及二维码配对入口。
tags: [configuration, setup, cli, schema, validation, migration]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-e2dd23f01c900f431c107f59
    resource: repo://codex.config.json.example
  - id: openwiki-source-6328f87fb0fb0eabcfe189c5
    resource: repo://scripts/config.js
  - id: openwiki-source-38128c874be7c9c3c5f20e89
    resource: repo://scripts/qr.js
  - id: openwiki-source-f52b6042255133b34aacf3b7
    resource: repo://scripts/setup.js
  - id: openwiki-source-c6ca9bf34f466f7e7e626c95
    resource: repo://server.js
  - id: openwiki-source-8040abdfb08fe48f57b5f157
    resource: repo://src/agent/app-server-transport.js
  - id: openwiki-source-7b774bd411e409736c3c65f6
    resource: repo://src/ops/codex-schema.js
  - id: openwiki-source-0a1b13dfc6aff1fa30f89c99
    resource: repo://src/ops/config-file.js
  - id: openwiki-source-87dc091fff03eb9cab17d5a0
    resource: repo://src/shared/png.js
  - id: openwiki-source-70a676b211abe44d2575ca5d
    resource: repo://src/shared/qrcode.js
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 配置系统与装机路径

## 单一事实源：CODEX_SCHEMA

[src/ops/codex-schema.js](../../src/ops/codex-schema.js) 回答三个问题：有哪些配置键、什么类型、默认值是多少。

这张表是换血的产物。换血前，同一个判据

```js
const raw = Number(process.env.X);
const X = Number.isInteger(raw) && raw > 0 ? raw : 默认;
```

在 `server.js` 里逐字重复了 8 次，在 `agent-appserver.js` 里又有第二份实现，而 `CODEX_APPROVAL_POLICY` / `CODEX_SANDBOX` 两个枚举**一次校验都没有**——写错拼写会原样透传给 app-server，症状是行为不对而日志里什么都没有。默认值散在 8 个三元表达式里，也就没有任何地方能回答「这个配置项的默认值是多少」。

条目里**不放校验函数**：校验按 `kind` 分支集中在 `checkOne()`。条目只描述「是什么」，不描述「怎么查」——把校验逻辑塞进条目会让每加一个配置项都要重新发明一次判据。

### kind 与它们的语义

| kind | 语义 |
|---|---|
| `number` | 整数且落在 `[min, max]`，越界回落 default |
| `toggle` | JSON 里是 boolean，投影成 `'1'` / `'0'` |
| `enum` | 必须在 `values` 里，不在就是**硬错误** |
| `list` | JSON 数组（迁移期也认逗号分隔） |
| `secret` | 同 text 但永不回显 |
| `readonly` | 不接受写入 |

两个值得记的边界：`PORT` 的 `min` 是 0 而不是 1，因为 0 表示「让系统分配随机端口」，是一个被使用中的语义——照搬「端口必须 ≥ 1」会静默掐掉它，症状是「配了 0 却起在 3001」。`CODEX_AGENT_IDLE_TTL_MS` 的下界是一分钟：曾经接受 0 只是为了测试方便，但那意味着误配成 0 时任何断开连接的会话都会在下一个 tick 里被立刻回收。

`PASSTHROUGH_KEYS` 是四个不进 schema 但要透传的键（`CODEX_DATA_DIR`、`CODEX_SERVER_NO_START`、`WORK_DIR`、`WORK_DIRS`），登记它们是为了让「拼错的配置项」与「没配置」不再行为相同。

### 失败方向按 kind 分档

`validateConfig` 的分档是选过的，不是「所有不合法都拒绝」：

- **enum 非法 → error，启动期拒绝。** 回落是危险的：用户以为自己配了 `danger-full-access` 或 `never`，实际跑的是另一套语义，而两者都不会有任何提示。**拼错一个字母就换了一套安全边界，这件事必须当场停下来。**
- **number 越界 → warning，回落默认值。** 拒绝启动意味着一次升级就能让一台配了越界值、原本跑得好好的部署起不来——代价不对称。这个方向有一条集成用例盯着。
- **成套缺项 → warning。** 配一半比一个都不配更危险，因为它看起来像是配好了（典型是 VAPID 那一组：推送不会工作，但服务本身是好的）。

`codex.config.json.example` 由 `buildExampleConfig()` 从 schema 生成而不是手写。手写的示例与代码之间没有机械联系，漂移是必然的——本仓的 `.env.example` 就漏过三项真实被读取的键，而漏掉的症状是「照着示例配完，某个功能没生效」。示例只出非 secret 且非 readonly 的项：它要提交进仓库，不该有任何形似凭据的东西，**哪怕是占位符——占位符被原样用上线过**。

## 源选择与优先级

两件事分成两个函数，各有踩过的坑：

**`loadConfigSources`** 决定读哪份文件。`codex.config.json` 存在就用它（同时存在 `.env` 时告警说明后者被忽略）；只有 `.env` 时用它并提示迁移；两个都没有是全新安装的正常态，零告警。

**坏 JSON 直接抛。** 回落成空配置的后果不是「少几个设置」，而是 server 以「未设 `AUTH_TOKEN`」启动，然后静默降级绑 `127.0.0.1`——手机全连不上，而日志里一个错字都没有。改坏一个逗号的代价不该是「服务看起来好好的但没人能连」。

**`resolveConfigValues`** 决定同一个 key 两边都有时谁赢：**shell 环境变量 > 配置文件 > 消费点默认值**。

判据是 key 的**存在性**（`Object.hasOwn`）而不是值的非空性。这逐字复刻 dotenv 的「不覆盖已存在 key」语义，包括那个反直觉的后果：`export PORT=` 之后，shell 里的空串会**挡住**配置文件里的 `PORT`。注释解释了为什么不顺手改掉：换加载器这一步的全部价值在于「新旧投影逐键相等」这个可证明的性质，顺手改一处语义就把这个证明弄没了。

`projectToEnv` 把结构化值投影回 `process.env`，因为消费点仍然是 `process.env.X` 的读法，而且 `childEnv()` 直接展开 `process.env` 传给 codex 子进程——不投影等于子进程什么都收不到。

### 为什么不用 dotenv.config()

`src/ops/config.js` 的存在理由不是 dotenv 不好用，而是**加载点需要一个可注入、可单测的边界**：配置从哪来、谁压过谁，之前只存在于 `server.js` 顶层那四行里，没有任何测试看得见；而 doctor 要回答的恰恰是「它看到的 = server 启动时会看到的」。

原先那行 `dotenv.config({ quiet: true })` 的 `quiet` 也不是洁癖：dotenv v17 默认往 stdout 打一条内容随机的推广横幅，而 `node --test` 的 child-v8 通道把控制帧和子进程 stdout 复用在同一条流上，随机多字节写入会撞坏帧解析、把整个测试文件判失败。加载器改用 `dotenv.parse()`——它只解析文本、从不写 stdout，这个坑因此是**结构上消失**的，不再依赖谁记得传 `quiet`。

## 装机向导：一张拒绝矩阵

`npm run setup` 的主体是 `resolveSetupPlan()`，一个纯函数——所有 IO（TTY 探测、文件存在性）由调用方查好传进来。

危险不在装不上，在**替用户做了他不知道的决定**。这三件都不会报错而后果很晚才显形：

| 拒绝码 | 挡什么 |
|---|---|
| `unknown_flag` | 不认识的参数不静默忽略——它很可能正是用户以为自己指定了的那一项（`--work-dirs=` 多写一个 s） |
| `invalid_host` | 只接受 `127.0.0.1` 或 `0.0.0.0`。不猜意图：「lan」大概率想要 `0.0.0.0`，但替用户猜着写进配置会一直生效到有人发现为止，而那时它已经把服务暴露在局域网上了 |
| `tty_required` | 在 CI 或管道里跑时，交互分支会读到 EOF 然后按默认值走完——而那些默认值从来没有人确认过 |
| `work_dir_required` | `--yes` 模式必须显式给 `--work-dir`，**不给不会回落到家目录** |
| `work_dir_not_absolute` | 相对路径会让权限边界取决于从哪个目录启动 |
| `work_dir_is_home` | 把家目录当工作区 = 把 `~/.ssh`、`~/.aws`、其他项目的 `.env` 一并交给 agent |
| `config_exists` | 不覆盖还在用的配置。`--force` 会生成新 `AUTH_TOKEN`，所有已注册设备都要重新批准 |

拒绝的**顺序**也是设计过的：`unknown_flag` 排在最前，因为先报别的会把注意力引开。

家目录那条与「不配工作区时拒绝启动」是同一条红线的两个入口——只堵一边等于没堵，因为向导正是最容易让人随手敲个 `~` 的地方。

危险动作的缺省值落在保守那一侧：不给 `--host` 时默认 `127.0.0.1`。默认对外监听意味着「跑一遍装机命令」就把服务暴露到局域网。

## 配置 CLI

`npm run config <init|get|set|unset|check|migrate|schema>` 是唯一会**写**配置文件的地方，所以每条写入路径都有一道防线：

- **全或无** —— 一批赋值里只要有一个不合法，一个都不写。部分写入最糟：一半生效一半没有，而命令报的是失败，人会以为什么都没变。
- **只读键** —— `AUTH_TOKEN` 不接受 `set`/`unset`。改它到重启之间文件与进程不一致，重启后含正在操作的这台手机在内全部要重输，极易把自己锁在门外。
- **迁移窗口闸** —— 只有 `.env` 而没有 `codex.config.json` 时拒绝写入。直接写入会生成一份**只含本次改动**的 `codex.config.json`，而它的优先级高于 `.env`，结果是整份旧配置被静默遮蔽。
- **未知 flag 不静默忽略** —— `--revael` 被当成没写的话，人会以为屏幕上那串就是明文。

secret 类的值在输出里显示成 `<已设置，N 字符>`，只有显式 `--reveal` 才回显。

### .env 迁移

`migrateEnvValues` 有两条注释钉住的约束：

- **工作区的折叠顺序不可换**：先把 `WORK_DIRS` 展开成数组，再把 `WORK_DIR` 折进首项。反过来的话 `WORK_DIR` 会折进一个还没展开的字符串上，结果只剩它自己——而迁移仍然会报「成功」。
- **读不出来的东西一律保留原键并告警，不静默丢弃**：少搬一个工作区、换掉手机端默认打开的目录，用户都要等到下次开手机才发现，而那时已经没有 `.env` 可以对照了。

迁移不删原 `.env`，跑错了还有东西可对照。

## 配对入口：二维码

`npm run qr` 把连接地址打成终端二维码。`AUTH_TOKEN` 是 64 位十六进制串，在手机上手输一次几乎必然出错，而出错的表现是「令牌无效」——与令牌配错了长得一模一样。

它**含凭据，所以必须显式敲**，不进启动横幅：横幅会出现在日志、截图、录屏里，而一张带令牌的二维码等于把那台机器的访问权一并贴了出去。

渲染必须是全块字符。姊妹项目真机实测：半块渲染（`▀` 单字符法与四字符法）**两版都扫不出来**，同一个矩阵改成全块立刻能扫。根因是一行文字承载两行模块做不到像素精确——终端行距会在模块之间留下横缝，破坏扫码器的网格识别。代价是高度翻倍，但一张扫不出来的码高度再省也没用。

QR 与 PNG 编码器都是自己写的（`src/shared/qrcode.js` / `png.js`），因为装机走 `npm ci --omit=dev`，加一个运行时依赖等于每个用户都多拉一个包，而这里要的只是编码本身。

## 装机顺序

```bash
npm install
npm run setup     # 选工作区、绑定地址、生成访问令牌
npm start
npm run qr        # 手机扫码即连
```

装不起来先跑 `npm run doctor`——它用和 server 完全相同的配置加载路径自检，所以「配置文件放错位置 / 被环境变量压过」这类最难查的问题它看得见。详见[自检与可观测](diagnostics-and-observability.md)。

## 相关测试

[test/unit/codex-schema.test.mjs](../../test/unit/codex-schema.test.mjs)、[test/unit/config-loader.test.mjs](../../test/unit/config-loader.test.mjs)、[test/unit/config-migrate.test.mjs](../../test/unit/config-migrate.test.mjs)、[test/unit/config-cli.test.mjs](../../test/unit/config-cli.test.mjs)、[test/unit/setup.test.mjs](../../test/unit/setup.test.mjs)、[test/unit/qrcode.test.mjs](../../test/unit/qrcode.test.mjs)
