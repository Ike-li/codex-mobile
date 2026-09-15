// test/invariants/acceptance-doc.test.mjs —— 文档契约测试。
// 守护：DOC-01
//
// 这份文件的判据只有一条：**违反了，读者会被坑吗？**
//
// 上一版有 401 行，其中约六成在断言标题字面存在（`## Features`、`## 运行链路`…）。
// 那些断言把文档的**形状**冻住了：改一次措辞就红一片，而红了不代表文档错了；
// 反过来，标题原封不动、正文写反，它一条都抓不到。这个文件因此被改了 12 次，
// 每次都是为了追上无关的措辞调整 —— 噪音门禁的典型代价。
//
// 现在只留两类：
//   1. 客观缺陷 —— 死链、引用了不存在的文件、许可证与 package.json 不一致。
//      机器能判定对错，与措辞无关。
//   2. 具体教训 —— 每条背后有一次真实踩坑，注释里写明是哪一次。
//
// 【2026-09-14 的修订，本身就是第二类的一个新样本】
// 上一版有三条断言咬着 docs/REMOTE_ACCESS.md 的内容。那份文档（连同另外 5 份 docs
// 和 29 张 UI 截图）在 80c2918 里被删掉了，于是那三条从「守住文档正确」退化成
// 「守住一个不存在的东西」—— readDoc 直接 ENOENT，而且**没有任何东西提醒删除者
// 这里还挂着断言**。这和 TESTING.md 里记的 device.js fixture 那次是同一个形态：
// 数据/文档换了，硬编码它的那一侧没跟上，测试从守护者变成了噪音。
//
// 处置：删掉失去对象的断言（见文件末尾的记录），并把「点名的仓库内文件必须存在」
// 的扫描面从 scripts/ 扩到 test/ 与 e2e/ —— 这次真正没被抓到的就是那一类：
// 当时的 e2e/ui-shots.spec.js 的 OUT 仍指向已删除的 docs/assets/ui，靠人眼发现。
// （那个文件随后也退役了，见下面扫描面那条的注释。）
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const readDoc = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const testingDoc = readDoc('../../docs/TESTING.md');

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
  for (const [dir, base] of [['../..', '../..'], ['../../docs', '../../docs']]) {
    if (dir === '../..') {
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

// 【为什么图片和链接合成了一条】它们是同一类客观缺陷（本地引用解析不到），分成两条
// 只是历史。合并的直接原因是塌陷断言：上一版图片那条要求 `checked >= 2`，而 80c2918
// 删掉 docs/assets/ 之后全仓**一张本地图片都没有了**，那条阈值再也不可能满足 —— 它守的
// 不是「图片没坏」，是「图片存在」，而后者不是本门禁该管的事。
//
// 合并后图片仍然在扫描面内（将来加一张坏图照样红），塌陷断言则由链接数撑着，
// 判据回到它本来要区分的那两件事：**扫到 0 个（失明）** 还是 **全都解析得到**。
test('文档里的本地引用（链接与图片）都指向真实文件或目录', () => {
  let checked = 0;
  for (const [docPath, base] of allDocs()) {
    const doc = readDoc(docPath);
    // 两个正则分别取链接与图片。链接那条的 (?<!!) 是为了不把图片语法重复计一次。
    // 2026-09-10：上一版链接正则是 `\(([^)\s#]+\.md)\)`，只认 .md 结尾——于是
    // `[archive/](archive/)` 在目录被删之后仍然全绿，是人工发现的。目录链接、指向
    // LICENSE / package.json 这类无扩展名或非 .md 的链接，此前全在扫描面之外。
    // existsSync 对目录同样返回 true，所以不需要为目录单独分支。
    const targets = [
      ...doc.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g),
      ...doc.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g),
    ];
    for (const [, target] of targets) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const [path] = target.split('#');
      if (!path) continue;
      checked += 1;
      assert.ok(
        existsSync(new URL(`${base}/${path}`, import.meta.url)),
        `${docPath} 引用了不存在的 ${path}`,
      );
    }
  }
  // 扫到 0 个和「全都存在」在断言上无法区分，前者意味着这道检查已经失明。
  // 阈值 8：当前实测 11 条，留余量是因为这条要区分的是「失明」和「正常」，
  // 不是把当前数字焊死。
  assert.ok(checked >= 8, `本地引用扫描器只检出 ${checked} 处，疑似失配`);
});

test('LICENSE 与 package.json 的许可证声明一致', () => {
  // 这两处不一致是法律层面的真错误，不是文档风格问题。
  assert.match(readDoc('../../LICENSE'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.equal(JSON.parse(readDoc('../../package.json')).license, 'AGPL-3.0-only');
  assert.match(readDoc('../../README.md'), /AGPL-3\.0/, 'README.md 必须声明许可证');
});

test('文档里点名的 npm script 都真实存在', () => {
  // README 里的命令会被照抄执行。指向不存在的 script 是可执行的错误，不是措辞。
  const scripts = JSON.parse(readDoc('../../package.json')).scripts;
  let checked = 0;
  for (const [docPath] of allDocs()) {
    for (const [, name] of readDoc(docPath).matchAll(/npm run ([a-z0-9:]+)/g)) {
      checked += 1;
      assert.ok(scripts[name], `${docPath} 让人跑 npm run ${name}，但 package.json 里没有这个脚本`);
    }
  }
  assert.ok(checked >= 4, `npm script 扫描器只检出 ${checked} 处，疑似失配`);
});

// 文档点名一个仓库内文件，读者就会照着去找。指向不存在的路径和死链是同一类客观缺陷。
//
// 【为什么不能只扫 scripts/】上一版就是这样，而 2026-09-14 真正漏掉的那一类恰恰在
// 它视野外：当时的 e2e/ui-shots.spec.js 文件头写着「生成 docs/UI_SURFACE.md 的编号标注
// 截图」、OUT 指向 docs/assets/ui，两者都已随 80c2918 删除 —— 文档与测试互相点名对方，
// 而任何一侧被删都没有东西变红（那个 spec 最终也退役了，截图的消费方既然没了，
// 它只剩布局体检一半，整个删掉）。扫描面收窄不会让塌陷断言报警（其余引用照样够数），
// 这是这类门禁最容易静默退化的方向。
//
// 【例外为什么要写理由】讲一个**已经删除**的文件（「那个文件已被删除，代价有三条」）
// 和提出一个**尚不存在**的文件（「修法：建立 test/setup/preload-env.mjs」）都是合法用法，
// 而它们和「写错了路径」在正则看来一模一样。默认值落在「必须存在」那一侧，
// 例外显式登记 —— 加一条之前先问：读者照着去找会扑空吗？扑空了要紧吗？
const MISSING_ON_PURPOSE = new Map([
  ['test/public-ui.test.mjs', 'TESTING.md 第 7 节讲的正是它被删除后的三条代价，指代一个不存在的文件是正确的'],
]);

test('文档里点名的仓库内文件都真实存在', () => {
  let checked = 0;
  const exempted = new Set();
  for (const [docPath] of allDocs()) {
    // 路径段要允许多级（门禁在 scripts/gates/ 下，只认单层会让那三个引用静默不被检查）。
    // 通配与花括号展开（`test/*.test.mjs`、`test/app-server-{transport,host}.test.mjs`）
    // 天然不匹配这个字符集，不需要额外排除。
    const pattern = /\b((?:scripts|test|e2e)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|mjs|sh))/g;
    for (const [, target] of readDoc(docPath).matchAll(pattern)) {
      if (MISSING_ON_PURPOSE.has(target)) { exempted.add(target); continue; }
      checked += 1;
      assert.ok(
        existsSync(new URL(`../../${target}`, import.meta.url)),
        `${docPath} 点名了不存在的 ${target}`,
      );
    }
  }
  // 扫到 0 个和「全都存在」在断言上无法区分，前者意味着这道检查已经失明。
  // 当前实测 34 处（scripts 13 + test/e2e 21），阈值留在 12。
  assert.ok(checked >= 12, `仓库内文件引用扫描器只检出 ${checked} 处，疑似失配`);

  // 豁免登记了却没人再提，说明那条例外已经过期 —— 它会继续为一个不再发生的情况开口子。
  for (const target of MISSING_ON_PURPOSE.keys()) {
    assert.ok(
      exempted.has(target),
      `MISSING_ON_PURPOSE 里的 ${target} 已经没有任何文档提到了，删掉这条豁免`,
    );
  }
});

// ---------------------------------------------------------------------------
// 二、具体教训：每条对应一次真实踩坑
// ---------------------------------------------------------------------------

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

// 零额度是项目规则（AGENTS.md），TESTING.md 是它的操作说明。规则与说明分居两处时，
// 说明漂走了不会有任何东西变红 —— 而「日常回归会不会烧额度」是照着文档操作的人
// 唯一的判断依据。这里只守「文档仍然把它作为前提写明」，具体机制由
// test/zero-quota-guard.test.mjs 守（那条才是行为侧）。
test('测试文档把零额度写成前提，而不是建议', () => {
  const head = testingDoc.slice(0, testingDoc.indexOf('## 0.'));
  assert.match(head, /零模型额度/, 'TESTING.md 开篇必须声明日常回归零额度这条硬约束');
  assert.match(head, /zero-quota-guard/, '声明要指向守它的那道门禁，否则读者无从核实');
});

// ---------------------------------------------------------------------------
// 已删除的断言，记在这里免得有人以为是漏了
// ---------------------------------------------------------------------------
//
// 2026-09-14 随 docs/REMOTE_ACCESS.md 一起删除的两条：
//
// 1. 「入门路径的首选方案唯一，其余方案有统一去处」
//    守的是：手机接入路径曾在四份文档里给出四套不同的首选方案，读者照哪份都能配出
//    半可用的环境。收敛成「首选只有 Tailscale Serve，其余去 REMOTE_ACCESS.md」。
//    现状：REMOTE_ACCESS.md 已删，README.md 也不再描述接入路径，这条没有对象了。
//    **重新写接入文档时要把它加回来** —— 那个缺陷的成因（多处各自描述同一件事）
//    与文档数量正相关，一旦文档重新变多就会复发。
//
// 2. 「origin_required 与 origin_not_allowed 被记成两个不同的失败」
//    守的是：两份文档曾把它们并成一条，给的处方是「把完整 Origin 精确加进
//    CODEX_ALLOWED_ORIGINS」——那对 origin_required 在结构上不可能有效：白名单只在
//    Origin 头**存在**时才被查，而这个错说的正是头不存在。它让一个 P0 被当成配置错误
//    （远程浏览器一律连不上，socket.io 先试 polling，浏览器对同源 XHR 不发 Origin）。
//    现状：没有任何文档再给排查建议，守不到东西。
//    **行为侧仍然有守**：修在 public/js/app.js（只走 websocket，RFC 6455 要求 WS 握手
//    一律带 Origin），由 e2e/remote-origin-handshake.spec.js 咬着。所以删掉这条
//    不产生行为上的暴露面，只是少了对「排查建议别再合并这两者」的文档约束。
