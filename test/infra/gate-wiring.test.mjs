// test/infra/gate-wiring.test.mjs —— 门禁接线闸。
//
// 【它守什么】`scripts/gates/` 下的每个门禁，要么真的挂在 `npm run test:ci` 上，
// 要么在下面的 NOT_IN_CHECK 里显式说明它为什么不在。
//
// 【为什么需要】门禁本身写得再扎实，也挡不住「它根本没被执行」。从 test:ci 的 && 链里
// 被摘掉、或者新写一个忘了接线，都不会有任何东西变红——test:ci 照常全绿，只是少查了
// 一整类问题。这是完全静默的失效，比没有门禁更危险：它占着「这块有人守」的位置。
//
// 【为什么是白名单，而不是给每个门禁加一条「我被接线了」断言】给 N 个门禁各写一条，
// 是用治理治治理：加一个门禁要记得加一条断言，而「记得」正是失败的那一步。反过来只列
// 【不在链里的例外】，新增门禁默认就必须接线，忘了就红——默认值落在了不需要人记性的那一侧。
//
// 【为什么门禁要独立成 scripts/gates/】这道闸的判据是「这个目录里放的都是门禁」。
// 门禁与 mock/smoke/运维脚本混在 scripts/ 里时（本仓 2026-09-08 之前就是如此，15 个文件
// 只有 3 个是门禁），白名单要列 12 条例外，而「新增一个 mock 脚本要记得加一条例外」
// 又回到了靠记性——那正是这道闸想消除的东西。目录本身就是那句声明。
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// 有意不挂在 test:ci 上的门禁，附理由。加一条之前先问：它真的不该每次 CI 都跑吗？
const NOT_IN_CHECK = new Map([
  // 形如：['xxx.js', '理由——为什么它不该进 CI 链']
]);

// 把 test:ci 里的 `npm run X` 与 `npm test` 递归展开成最终命令文本。
// 不展开的话，通过别的 script 间接接线的门禁会被误判成「没接线」——
// check-test-summary.js 就是这种：它挂在 `npm test` 上，而 test:ci 引用的是 `npm test`。
function expandedCheckChain() {
  const seen = new Set();
  const expand = name => {
    if (seen.has(name)) return '';
    seen.add(name);
    return (pkg.scripts[name] ?? '')
      .replace(/\bnpm run ([A-Za-z0-9:_-]+)/g, (_, ref) => expand(ref))
      // `npm test` 是 npm 的内置别名，不写 run。漏掉它会让挂在 test 上的门禁被误判。
      .replace(/\bnpm test\b/g, () => expand('test'));
  };
  return expand('test:ci');
}

test('scripts/gates/ 下每个门禁都挂在 npm run test:ci 上，或在 NOT_IN_CHECK 里说明原因', () => {
  const chain = expandedCheckChain();
  const gates = readdirSync(new URL('../../scripts/gates', import.meta.url))
    .filter(f => f.endsWith('.js') || f.endsWith('.mjs'));

  // 扫到 0 个与「全部合规」在断言上无法区分，而前者意味着这道闸已经失明
  // （目录被改名、被移动、或者门禁被挪回 scripts/ 根都会走到这里）。
  assert.ok(gates.length > 0, 'scripts/gates/ 扫不到门禁文件——扫描面塌了，不是「全部合规」');

  for (const gate of gates) {
    if (NOT_IN_CHECK.has(gate)) continue;
    assert.ok(
      chain.includes(`scripts/gates/${gate}`),
      `${gate} 没有出现在展开后的 npm run test:ci 里。要么把它接进链，要么在 NOT_IN_CHECK 里`
      + '写明为什么不接——一个不被执行的门禁比没有门禁更危险，它占着「这块有人守」的位置',
    );
  }
});

test('NOT_IN_CHECK 里的条目必须真的不在链上，否则那条豁免已经过期', () => {
  // 反向那半：豁免写下之后没人再看，而门禁后来被接进链是常事。留着过期的豁免会让
  // 下一个读的人以为「这个不在 CI 里」，据此做出错误判断。
  const chain = expandedCheckChain();
  for (const [gate, reason] of NOT_IN_CHECK) {
    assert.ok(reason && reason.length > 0, `${gate} 的豁免没写理由`);
    assert.ok(
      !chain.includes(`scripts/gates/${gate}`),
      `${gate} 被列为不在 test:ci 链里，但它其实挂着——删掉 NOT_IN_CHECK 里的那条`,
    );
  }
});

test('test:ci 链展开后确实包含各门禁，而不是展开器本身失配', () => {
  // 上面两条都依赖 expandedCheckChain 的展开正确。展开器要是失配返回空串，
  // 第一条会把每个门禁都报成「没接线」——那是吵闹的失败，看得见。
  // 但如果它只是漏展开 `npm test` 那一跳，失败会精确落在 check-test-summary 上，
  // 容易被误当成「这个门禁真的没接线」而去改 package.json。这条把展开器本身钉住。
  const chain = expandedCheckChain();

  assert.match(chain, /scripts\/gates\/protocol-check\.mjs/, '经 npm run protocol:check 间接接线');
  assert.match(chain, /scripts\/gates\/check-coverage-delta\.js/, '在 test:ci 里直接调用');
  assert.match(chain, /scripts\/gates\/check-test-summary\.js/, '经 npm test 间接接线（内置别名，不写 run）');
});
