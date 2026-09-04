// test/acceptance-doc.test.mjs —— 文档契约测试。
//
// 这份文件的判据只有一条：**违反了，读者会被坑吗？**
//
// 上一版有 401 行，其中约六成在断言标题字面存在（`## Features`、`## 运行链路`…）。
// 那些断言把文档的**形状**冻住了：改一次措辞就红一片，而红了不代表文档错了；
// 反过来，标题原封不动、正文写反，它一条都抓不到。这个文件因此被改了 12 次，
// 每次都是为了追上无关的措辞调整 —— 噪音门禁的典型代价。
//
// 现在只留两类：
//   1. 客观缺陷 —— 死链、引用了不存在的图片/文件、许可证与 package.json 不一致。
//      机器能判定对错，与措辞无关。
//   2. 具体教训 —— 每条背后有一次真实踩坑，注释里写明是哪一次。
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const readDoc = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const testingDoc = readDoc('../docs/TESTING.md');

// ---------------------------------------------------------------------------
// 一、客观缺陷：链接和引用必须解析得到
// ---------------------------------------------------------------------------

test('文档里的本地图片引用都指向真实文件', () => {
  const targets = [
    ['../README.md', '..'],
    ['../README.zh-CN.md', '..'],
    ['../docs/SHOWCASE.md', '../docs'],
  ];

  let checked = 0;
  for (const [docPath, base] of targets) {
    for (const [, target] of readDoc(docPath).matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      if (/^https?:/.test(target)) continue;
      checked += 1;
      assert.ok(
        existsSync(new URL(`${base}/${target}`, import.meta.url)),
        `${docPath} 引用了不存在的图片 ${target}`,
      );
    }
  }
  // 扫描器本身失配时上面的循环会平凡通过。这条确保它真的扫到了东西。
  assert.ok(checked >= 8, `图片扫描器只检出 ${checked} 个本地引用，疑似失配`);
});

test('文档之间的相对链接都指向真实文件', () => {
  const docs = [
    ['../README.md', '..'],
    ['../README.zh-CN.md', '..'],
    ['../CONTRIBUTING.md', '..'],
    ['../SECURITY.md', '..'],
    ['../docs/TESTING.md', '../docs'],
    ['../docs/SMOKE_MATRIX.md', '../docs'],
    ['../docs/TROUBLESHOOTING.md', '../docs'],
    ['../docs/REMOTE_ACCESS.md', '../docs'],
  ];

  let checked = 0;
  for (const [docPath, base] of docs) {
    for (const [, target] of readDoc(docPath).matchAll(/(?<!!)\[[^\]]*\]\(([^)\s#]+\.md)(?:#[^)\s]*)?\)/g)) {
      if (/^https?:/.test(target)) continue;
      checked += 1;
      assert.ok(
        existsSync(new URL(`${base}/${target}`, import.meta.url)),
        `${docPath} 指向了不存在的文档 ${target}`,
      );
    }
  }
  assert.ok(checked >= 15, `链接扫描器只检出 ${checked} 条本地链接，疑似失配`);
});

test('双语 README 互相链接，且英文版不混入中文小节', () => {
  const readmeEn = readDoc('../README.md');
  const readmeZh = readDoc('../README.zh-CN.md');

  assert.match(readmeEn, /\((?:\.\/)?README\.zh-CN\.md\)/, 'README.md 必须链到中文版');
  assert.match(readmeZh, /\((?:\.\/)?README\.md\)/, 'README.zh-CN.md 必须链回英文版');
  // 两份 README 曾被同一次编辑改串。语言混入是客观错误，不是措辞偏好。
  assert.doesNotMatch(readmeEn, /^## (当前形态|本地运行|常用命令|核心文件|文档规则)$/m,
    'README.md 里出现了中文小节标题 —— 两份 README 被改串了');
});

test('归档文档仍然存在，且自称不再维护', () => {
  // 归档目录是「不作为事实来源」的声明地。文件被删掉而 CLAUDE.md 还指着它，
  // 会让读者以为那里有答案。
  const archiveReadme = readDoc('../docs/archive/README.md');
  assert.match(archiveReadme, /不再维护/);

  for (const name of [
    'codex-app-server-interface-map-gpt-5-codex.md',
    'codex-app-server-接口地图-合并版-claude-fable-5+gpt-5-codex.md',
    'codex-app-server-接口对照清单-claude-fable-5.md',
    'codex-app-server-架构设计-claude-fable-5.md',
  ]) {
    assert.ok(existsSync(new URL(`../docs/archive/${name}`, import.meta.url)), `归档文档 ${name} 不见了`);
  }
});

test('LICENSE 与 package.json 的许可证声明一致', () => {
  // 这两处不一致是法律层面的真错误，不是文档风格问题。
  assert.match(readDoc('../LICENSE'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.equal(JSON.parse(readDoc('../package.json')).license, 'AGPL-3.0-only');
  assert.match(readDoc('../README.md'), /AGPL-3\.0/, 'README.md 必须声明许可证');
});

test('CONTRIBUTING 列出的门禁命令与 package.json 的脚本真实存在', () => {
  // 贡献者会照抄这些命令。指向不存在的 script 是可执行的错误，不是措辞。
  const contributing = readDoc('../CONTRIBUTING.md');
  const scripts = JSON.parse(readDoc('../package.json')).scripts;

  const cited = [...contributing.matchAll(/npm run ([a-z0-9:]+)/g)].map(m => m[1]);
  assert.ok(cited.length >= 3, `CONTRIBUTING.md 只提到 ${cited.length} 条 npm run 命令，疑似扫描失配`);
  for (const name of new Set(cited)) {
    assert.ok(scripts[name], `CONTRIBUTING.md 让贡献者跑 npm run ${name}，但 package.json 里没有这个脚本`);
  }
  assert.match(contributing, /npm test/, 'CONTRIBUTING.md 必须写明单测入口');
});

// ---------------------------------------------------------------------------
// 二、具体教训：每条对应一次真实踩坑
// ---------------------------------------------------------------------------

// 手机接入路径一度在四份文档里给出四套不同的首选方案，读者照哪份都能配出
// 半可用的环境。收敛成「首选只有 Tailscale Serve，其余去 REMOTE_ACCESS.md」。
// 这里不再切片比对标题（上一版靠精确标题切段落，改一个字就崩），只守两件事：
// 提到了首选方案，且给了其他方案的去处。
test('入门路径的首选方案唯一，其余方案有统一去处', () => {
  for (const path of ['../README.md', '../README.zh-CN.md',
    '../docs/GETTING_STARTED.md', '../docs/GUIDE.md']) {
    const doc = readDoc(path);
    assert.match(doc, /Tailscale Serve/, `${path} 必须给出首选的手机接入方案`);
    assert.match(doc, /REMOTE_ACCESS\.md/, `${path} 必须把其他代理方案指向 REMOTE_ACCESS.md`);
  }
  // 备选方案的完整对比只应存在于一处，否则又会各自漂移。
  const remoteAccess = readDoc('../docs/REMOTE_ACCESS.md');
  for (const proxy of ['Tailscale Serve', 'Caddy', 'Cloudflare Tunnel']) {
    assert.match(remoteAccess, new RegExp(proxy), `REMOTE_ACCESS.md 缺少 ${proxy} 方案`);
  }
});

// origin_required 和 origin_not_allowed 是两个不同的失败，此前两份文档把它们并成一条，
// 给的处方是「把完整 Origin 精确加进 CODEX_ALLOWED_ORIGINS」——那对 origin_required
// 在结构上不可能有效：白名单只在 Origin 头**存在**时才被查，而这个错说的正是头不存在。
//
// 这不是措辞问题。它让一个 P0 被当成配置错误：远程浏览器一律连不上（socket.io 先试
// polling，浏览器对同源 XHR 不发 Origin），照着这条排查怎么试都不会好。修在
// public/js/app.js（只走 websocket，RFC 6455 要求 WS 握手一律带 Origin），
// 行为由 e2e/remote-origin-handshake.spec.js 守着；这里守的是**排查建议不再合并这两者**。
test('origin_required 与 origin_not_allowed 被记成两个不同的失败', () => {
  for (const name of ['TROUBLESHOOTING.md', 'REMOTE_ACCESS.md']) {
    const doc = readDoc(`../docs/${name}`);
    for (const code of ['origin_required', 'origin_not_allowed']) {
      assert.ok(doc.includes(code), `${name} 没有提到 ${code}`);
    }

    const conflated = doc.split('\n')
      .filter(line => line.includes('origin_required') && line.includes('origin_not_allowed'));
    assert.deepEqual(conflated, [],
      `${name} 把 origin_required 和 origin_not_allowed 写在同一条里；`
      + '它们成因不同，只有后者能靠改白名单修好');

    // origin_required 的解释必须落到「哪个传输不带这个头」，否则读者无从判断该查什么。
    assert.match(doc, /polling/,
      `${name} 解释 origin_required 时没提 polling —— 那正是不带 Origin 的那个传输`);
  }
});

// R-ENG-3：无头 Linux 上跑通是本产品唯一一条官方结构上给不出的承诺——官方 Remote 要求
// host 运行 ChatGPT 桌面 app（仅 macOS/Windows）并「Keep your computer awake and online」，
// 而服务器不会休眠。既然把它当卖点，验收路径就必须写下来并可复核。
test('测试文档记录无头 Linux 的验收路径', () => {
  const section = testingDoc.slice(testingDoc.indexOf('## 无头 Linux 验收'));
  assert.ok(section.startsWith('## 无头 Linux 验收'), 'TESTING.md 缺少「## 无头 Linux 验收」小节');
  for (const keyword of ['无图形界面', 'npm run doctor', '桌面 app', '审批']) {
    assert.match(section, new RegExp(keyword), `无头 Linux 验收缺少关键项：${keyword}`);
  }
});

// ---------------------------------------------------------------------------
// 三、可视化验收文档的方法论约束
//
// SMOKE_MATRIX.md 的全部价值来自「判据是肉眼可见的画面」这一条。一旦判据里混进
// DOM 检查，它就退化成一份没人能手工执行的开发者脚本，而那正是 E2E 已经在做的事。
// 所以这里守的不是它长什么样，是它**还能不能被一个人照着执行**。
// ---------------------------------------------------------------------------

test('可视化用例的判据是画面，不是 DOM 检查', () => {
  const doc = readDoc('../docs/SMOKE_MATRIX.md');
  const blocks = doc.split(/^#### VC-/m).slice(1);
  assert.ok(blocks.length >= 55, `只有 ${blocks.length} 条可视化用例，疑似解析失配`);

  const ids = blocks.map(b => b.slice(0, 6));
  assert.equal(new Set(ids).size, ids.length, '存在重复的用例编号');

  for (const block of blocks) {
    const id = block.slice(0, 6);

    // 四件套缺一条就不能被照着执行。
    for (const field of ['**覆盖点**', '**前置**', '**步骤**', '**看到什么**', '**判定**', '**定位参考**']) {
      assert.ok(block.includes(field), `VC-${id} 缺少 ${field}`);
    }

    // selector 只允许待在「定位参考」那一行供自动化定位用，不能当判据。
    const seen = block.indexOf('**看到什么**');
    const anchor = block.indexOf('**定位参考**');
    assert.ok(seen >= 0 && anchor > seen, `VC-${id} 段落顺序不对`);
    const verdict = block.slice(seen, anchor);
    for (const banned of ['localStorage', 'querySelector', 'getComputedStyle', 'IndexedDB',
      'offsetParent', 'classList', 'dataset.']) {
      assert.ok(!verdict.includes(banned),
        `VC-${id} 的判据里出现了 ${banned} —— 判据必须是肉眼可见的画面，不是 DOM 检查`);
    }
  }
});

// 上一版这两条的前置写的是「需要第二台设备」「服务端配置允许远程接入」，于是它们连着两轮
// 被整条跳过 —— 而 VC-A02 恰恰是唯一一条用肉眼守设备闸的用例（未批准的设备不该看到任何
// 会话内容）。更糟的是那个前置是错的：真搬第二台设备来、走明文 HTTP，照样是 426
// https_required，压根到不了配对画面。所以前置必须落到**可照抄的配置项名**上。
// 配方本身由 test/server-security.test.mjs 的两条测试守着，加了新闸会先在那边红。
test('远程接入用例的前置写明配置项，而不是含糊指向服务端配置', () => {
  const doc = readDoc('../docs/SMOKE_MATRIX.md');
  const blocks = new Map(doc.split(/^#### (?=VC-)/m).slice(1).map(b => [b.slice(0, 6), b]));

  for (const id of ['VC-A02', 'VC-H05']) {
    const block = blocks.get(id);
    assert.ok(block, `${id} 不见了`);
    for (const knob of ['HOST', 'AUTH_TOKEN', 'CODEX_ALLOW_INSECURE_REMOTE', 'CODEX_ALLOWED_ORIGINS']) {
      assert.ok(block.includes(knob), `${id} 的前置没写 ${knob}，照着它配不出能跑的环境`);
    }
  }

  // J01 卡在真 HTTPS 上，ALLOW_INSECURE 对它无效——Push API 要的是浏览器侧的 secure
  // context，不是服务端放行。不写清楚，下一个人会拿 ALLOW_INSECURE 再试一次。
  assert.match(blocks.get('VC-J01'), /secure context|CODEX_ALLOW_INSECURE_REMOTE/,
    'VC-J01 没说明为什么服务端放行开关对它不管用');
});

// 有一轮把 11 处送往浏览器的错误插值统一做了脱敏，但 71 条用例里一条判据都没盯着它 ——
// 而「错误条里出现 /Users/xxx」是纯肉眼可见的，正是这份文档该管的形态。
test('宿主机路径泄漏被当成一条横切的可见失败', () => {
  const doc = readDoc('../docs/SMOKE_MATRIX.md');
  assert.match(doc, /^## 贯穿所有用例的判据$/m, 'SMOKE_MATRIX.md 缺少横切判据一节');
  const section = doc.slice(doc.indexOf('## 贯穿所有用例的判据'));
  assert.match(section.slice(0, 1200), /宿主机绝对路径|\/Users\//,
    '横切判据里没有「界面不得出现宿主机绝对路径」这一条');
});
