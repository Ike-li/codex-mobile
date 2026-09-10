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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const readDoc = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const testingDoc = readDoc('../docs/TESTING.md');

// ---------------------------------------------------------------------------
// 一、客观缺陷：链接和引用必须解析得到
// ---------------------------------------------------------------------------

// 扫描面是递归的而不是手写清单：手写清单在文档增删时会静默失配，而 2026-09-10
// 那次把 docs/ 从 16 份砍到 6 份，手写清单里有 6 个条目直接 ENOENT。
function allDocs() {
  const found = [];
  const walk = (dir, base) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(`${dir}/${entry.name}`, `${base}/${entry.name}`);
      } else if (entry.name.endsWith('.md')) {
        found.push([`${dir}/${entry.name}`, base]);
      }
    }
  };
  for (const [dir, base] of [['..', '..'], ['../docs', '../docs']]) {
    if (dir === '..') {
      // 根目录不递归：node_modules、.git 之类不该进来。
      for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
        if (!entry.isDirectory() && entry.name.endsWith('.md')) found.push([`${dir}/${entry.name}`, base]);
      }
    } else {
      walk(dir, base);
    }
  }
  return found;
}

test('文档里的本地图片引用都指向真实文件', () => {
  let checked = 0;
  for (const [docPath, base] of allDocs()) {
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
  assert.ok(checked >= 2, `图片扫描器只检出 ${checked} 个本地引用，疑似失配`);
});

// 扫描面覆盖所有本地链接目标，不只 `.md`。
// 2026-09-10：上一版正则是 `\(([^)\s#]+\.md)\)`，只认 .md 结尾——于是 PROTOCOL.md 里
// 那句 `[archive/](archive/)` 在 docs/archive/ 被删掉之后仍然全绿，是人工发现的。
// 目录链接、指向 LICENSE / package.json 这类无扩展名或非 .md 文件的链接，此前全部
// 在扫描面之外。existsSync 对目录同样返回 true，所以不需要为目录单独分支。
test('文档里的本地链接都指向真实文件或目录', () => {
  let checked = 0;
  for (const [docPath, base] of allDocs()) {
    for (const [, target] of readDoc(docPath).matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const [path] = target.split('#');
      if (!path) continue;
      checked += 1;
      assert.ok(
        existsSync(new URL(`${base}/${path}`, import.meta.url)),
        `${docPath} 指向了不存在的 ${path}`,
      );
    }
  }
  assert.ok(checked >= 8, `链接扫描器只检出 ${checked} 条本地链接，疑似失配`);
});

test('LICENSE 与 package.json 的许可证声明一致', () => {
  // 这两处不一致是法律层面的真错误，不是文档风格问题。
  assert.match(readDoc('../LICENSE'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.equal(JSON.parse(readDoc('../package.json')).license, 'AGPL-3.0-only');
  assert.match(readDoc('../README.md'), /AGPL-3\.0/, 'README.md 必须声明许可证');
});

test('文档里点名的 npm script 都真实存在', () => {
  // README 里的命令会被照抄执行。指向不存在的 script 是可执行的错误，不是措辞。
  const scripts = JSON.parse(readDoc('../package.json')).scripts;
  let checked = 0;
  for (const [docPath] of allDocs()) {
    for (const [, name] of readDoc(docPath).matchAll(/npm run ([a-z0-9:]+)/g)) {
      checked += 1;
      assert.ok(scripts[name], `${docPath} 让人跑 npm run ${name}，但 package.json 里没有这个脚本`);
    }
  }
  assert.ok(checked >= 4, `npm script 扫描器只检出 ${checked} 处，疑似失配`);
});

test('文档里点名的 scripts/ 脚本都真实存在', () => {
  // 【为什么上面那条抓不到】文档一度让人去看 `scripts/check-coverage.js` 判断覆盖率
  // 门禁——那个文件不存在，只有 check-coverage-delta.js。上面那条扫的是命令名
  // （/npm run ([a-z0-9:]+)/），文件路径完全在它视野外。同一份文档里两种引用形态，
  // 此前只守了一种。读者照着去找会扑空，和死链是同一类客观缺陷。
  let checked = 0;
  for (const [docPath] of allDocs()) {
    // 路径段要允许多级：门禁在 scripts/gates/ 下，只认单层会让那三个引用静默不被检查——
    // 而扫描面收窄不会让塌陷断言变红（其余引用照样够数），是这条自己差点犯的错。
    for (const [, target] of readDoc(docPath).matchAll(/\b(scripts\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|mjs|sh))/g)) {
      checked += 1;
      assert.ok(
        existsSync(new URL(`../${target}`, import.meta.url)),
        `${docPath} 点名了不存在的脚本 ${target}`,
      );
    }
  }
  // 扫到 0 个和「全都存在」在断言上无法区分，前者意味着这道检查已经失明。
  // 阈值 12 → 6：2026-09-10 把 docs/ 从 16 份砍到 6 份，实际引用数从 12 降到 8。
  // 留余量是因为这条要区分的是「失明(0)」和「正常」，不是把当前数字焊死。
  assert.ok(checked >= 6, `脚本引用扫描器只检出 ${checked} 处，疑似失配`);
});

// ---------------------------------------------------------------------------
// 二、具体教训：每条对应一次真实踩坑
// ---------------------------------------------------------------------------

// 手机接入路径一度在四份文档里给出四套不同的首选方案，读者照哪份都能配出
// 半可用的环境。收敛成「首选只有 Tailscale Serve，其余去 REMOTE_ACCESS.md」。
// 这里不再切片比对标题（上一版靠精确标题切段落，改一个字就崩），只守两件事：
// 提到了首选方案，且给了其他方案的去处。
test('入门路径的首选方案唯一，其余方案有统一去处', () => {
  for (const path of ['../README.md']) {
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
  for (const name of ['REMOTE_ACCESS.md']) {
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

