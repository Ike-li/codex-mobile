---
type: reference
title: 不变量登记表与守护机制
description: 仓库里被显式登记的十条红线各自守什么、违反后的症状是什么、由哪个文件执行，以及「守护声明」与「论据锚点」的区别与编号双向闭合的门禁。
tags: [testing, invariants, registry, red-lines, guard]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:36:26.702Z
sources:
  - id: openwiki-source-a7d435908d0721e4eb6a0989
    resource: repo://docs/TESTING.md
  - id: openwiki-source-0e4ff78481dd57d3ec2a8d6e
    resource: repo://scripts/gates/check-invariant-ids.js
  - id: openwiki-source-f51048b1b14decbf640f1b15
    resource: repo://test/invariants/acceptance-doc.test.mjs
  - id: openwiki-source-181568cf72a9d5890da43a69
    resource: repo://test/invariants/delivery-contract.test.mjs
  - id: openwiki-source-b08db528553c2bc6133ba9e3
    resource: repo://test/invariants/thread-source-of-truth.test.mjs
  - id: openwiki-source-f2747ed522b30a1feb5985b8
    resource: repo://test/invariants/zero-persistence-guard.test.mjs
  - id: openwiki-source-2d58f6a6fcc12e1b2934dec9
    resource: repo://test/README.md
generated: { by: "claude-code", at: "2026-09-22T08:36:26.702Z" }
---

# 不变量登记表与守护机制

本仓有一套显式登记的「红线」：每条都写明**违反了会怎样**，并指名由哪个文件执行。登记表住在 [test/README.md](../../test/README.md)，编号的双向闭合由 [check-invariant-ids.js](../../scripts/gates/check-invariant-ids.js) 强制。

登记表条目的写法有一条要求：**写清违反了会怎样，不要只写规则名**。抽象原则会被「我这次是例外」绕过，带具体后果的不会。

## 十条红线

| 编号 | 守什么 | 违反后的症状 | 执行者 |
|---|---|---|---|
| `A2` | 不产生第二份真相 | 两份数据迟早漂移，用户不知道该信哪个 | `zero-persistence-guard`、`thread-source-of-truth` |
| `QUOTA-01` | 日常回归零模型额度 | 静默烧额度 | `zero-quota-guard` |
| `DELIVER-01` | 投递不丢不重，需要人时叫得到人 | 消息重复执行或凭空消失 | `delivery-contract` |
| `SHELL-01` | `public/` 外壳的结构性边界 | CSP 收不紧、非 secure context 下崩、用弱随机做凭证 | `public-shell-guard` |
| `DOC-01` | 文档不坑读者 | 死链、点名不存在的文件、许可证与包声明不一致 | `acceptance-doc` |
| `READ-01` | 未读位点只增不减，跨设备归并幂等 | 一屏已经看过的会话重新亮起来 | `read-state` |
| `OPS-01` | 记了就要有出口 | 某个指标永远是 0，而人会去查埋点为什么没触发 | `metrics-contract` |
| `ENV-02` | 状态库不兼容时启动即给可执行提示 | 手机端弹 `no such table` 而不知道下一步 | `doctor` |
| `GATE-02` | cancelled / skipped 不为 0 要红 | 「fail 0」的运行里整片用例根本没跑 | `infra/check-test-summary` |
| `TEST-01` | 测试不得以真实 HOME / 生产数据目录为目标 | 变异改坏算路径的代码后删掉真实目录 | `infra/mutate` |

两条由**门禁**守的红线（`GATE-02`、`TEST-01`）住在 `test/infra/` 而不是 `test/invariants/`，因为「测门禁的文件住 infra」是更优先的判据。这也是死条目检测要放宽到整棵 `test/` 树的原因。

`A2` 是唯一由两个文件守的：一个扫「有没有往 `data/` 写新东西」，一个扫「有没有把已经退役的第二份真相读回来」。两个方向都堵上它才闭合。详见[状态归属](../architecture/state-ownership.md)。

## 「守护」是什么意思

`test/invariants/` 下每个文件的**第二行**必须是 `// 守护：<编号>`，编号必须在登记表首列查得到。

区别在于文件是围绕什么组织的：

- 写 `// 守护：X` 的文件，**整个文件**为了守 X 而存在，通常没有同名源模块——删掉 X 这条红线，这个文件就该一起删。
- 单测注释里另有一套编号（`R-7`、`R-SEC-1..4`、`RECOVER-01`、`DELIVER-03/04/05/07`、`I-7`、`D6` 等）是**论据锚点**：某条断言为什么这么写、对应哪次事故或哪条需求。它们**不进登记表，也不要求文件搬家**。

把论据锚点当守护声明会产生一个具体的坏结果：`unit/ansi-html.test.mjs` 因为提到 `I-7` 就得搬进 `invariants/`，而它明明是 `public/js/render/ansi-html.js` 的模块测试。于是「按模块组织」和「按不变量组织」这条分界线就没了。

登记表首列的编号提取**只认首列**：红线正文里会出现别的编号（交叉引用），把正文一起扫进来会让登记表自己制造出悬空条目。

## 两个值得细读的样本

### DOC-01：噪音门禁的代价

`acceptance-doc` 的上一版有 401 行，其中约六成在断言标题字面存在（`## Features`、`## 运行链路`…）。那些断言把文档的**形状**冻住了：改一次措辞就红一片，而红了不代表文档错了；反过来，标题原封不动、正文写反，它一条都抓不到。这个文件因此被改了 12 次，每次都是为了追上无关的措辞调整。

现在只收两类断言：**客观缺陷**（死链、引用不存在的文件、许可证与 `package.json` 不一致——机器能判定对错，与措辞无关）和**具体教训**（每条背后有一次真实踩坑，注释里写明是哪一次）。

这个文件自己又贡献了一个新样本：它曾有三条断言咬着一份文档的内容，而那份文档连同另外 5 份 docs 和 29 张 UI 截图一起被删掉了，于是那三条从「守住文档正确」退化成「守住一个不存在的东西」——`readDoc` 直接 ENOENT，而且**没有任何东西提醒删除者这里还挂着断言**。

处置是两步：删掉失去对象的断言，并把「点名的仓库内文件必须存在」的扫描面从 `scripts/` 扩到 `test/` 与 `e2e/`——当时真正没被抓到的正是那一类（一个 e2e 文件的输出目录仍指向已删除的路径，靠人眼发现）。

扫描面是**递归**的而不是手写清单：手写清单在文档增删时会静默失配，那次把 `docs/` 从 16 份砍到 6 份时，手写清单里有 6 个条目直接 ENOENT。

### DELIVER-01：只断言外部可观察行为

`delivery-contract` 刻意只断言**同一请求发两次会怎样、断线重连后能查到什么、处理过的审批再处理一次会怎样**，不碰 `phase` / `revision` / handles 这些内部形态。

理由写得很直白：那些是实现细节，重构时会连同测试一起被改掉，安全网也就没了。这一组测试的目的是**为后续拆解这两个模块提供一张与实现无关的网**——任何改动如果让这里变红，就是真的改变了用户可见的行为，而不只是换了个写法。

## 新增一条不变量

1. 先确认它真的是「整个文件为它而存在」——否则它只是一条论据锚点，写进注释即可。
2. 在 [test/README.md](../../test/README.md) 的登记表加一行：编号、红线正文（**写清违反了会怎样**）、守它的文件。
3. 文件第二行写 `// 守护：<编号>`，文件放进 `test/invariants/`。
4. 跑 `npm test`，`check-invariant-ids` 会告诉你四种失效形态里有没有踩中。

## 不属于这里的东西

**不新增按「会怎么伤人」分的类别**——不要建 `security/` `reliability/` `performance/` 这种目录。那是缺陷的后果分类，填进上面那张表就够了。一条 SSRF 防护测试既是「安全」又是「纯函数」，按后果分它就同时该放进两个地方，于是放哪都行、放哪都对不上。

详见[测试策略](strategy.md)。
