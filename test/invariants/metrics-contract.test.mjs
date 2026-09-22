// test/invariants/metrics-contract.test.mjs —— 指标的「记了就要有出口」。
// 守护：OPS-01
//
// 测什么：源码里每个 metrics.inc('x') / gauge('x') 的字面量，都能在 KNOWN_METRICS 与
//   /metrics 的白名单映射表里查到。
// 不测什么 + 为什么：不测指标的数值对不对——那要真跑一遍链路，属于集成层；这里守的是
//   「这个指标存在于输出里」这件结构性的事。
//
// 为什么要守：inc() 记下的计数器不在输出映射里列一行，就永远不会出现在 /metrics 里，
// 而**没有任何报错**。记了等于没记，且症状是「这个指标一直是 0」——人会去查埋点为什么
// 没触发，而真正的原因在另一头。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_METRICS, inc, gauge, label, getCounter, getGauge, getLabel, reset } from '../../src/ops/metrics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 递归收集运行时源码（不含测试与工具）。 */
function runtimeSources(dir = ROOT, depth = 0) {
  if (depth > 3) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || ['node_modules', 'test', 'e2e', 'scripts', 'data', 'coverage'].includes(entry.name)) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return runtimeSources(full, depth + 1);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function usedMetricNames() {
  const names = new Set();
  for (const file of runtimeSources()) {
    const source = readFileSync(file, 'utf8');
    for (const [, name] of source.matchAll(/metrics\.(?:inc|gauge|label)\(\s*'([A-Za-z0-9_]+)'/g)) {
      names.add(name);
    }
  }
  return names;
}

test('每个被埋点的指标名都在 KNOWN_METRICS 里登记', () => {
  const used = usedMetricNames();
  assert.ok(used.size >= 3, `只扫出 ${used.size} 个埋点，扫描面塌了——这条断言已失明`);
  const missing = [...used].filter(name => !KNOWN_METRICS.includes(name)).sort();
  assert.deepEqual(missing, [],
    '这些指标被 inc()/gauge() 记了，但没登记进 KNOWN_METRICS。'
    + '记了而没有出口 = 记了等于没记，且没有任何报错。');
});

test('每个被埋点的指标都出现在 /metrics 的白名单映射表里', () => {
  // 映射表在 server.js 的 getMetricsPayload 里，直接读源码文本——它是一张手写的表，
  // 而「手写的表漏一行」正是这条断言要守的事。
  const payload = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const table = payload.slice(payload.indexOf('function getMetricsPayload'), payload.indexOf('app.get(\'/metrics\''));
  assert.ok(table.length > 200, 'getMetricsPayload 没解析出来，断言已失明');

  const missing = [...usedMetricNames()].filter(name => !table.includes(name)).sort();
  assert.deepEqual(missing, [],
    '这些指标被记了但不在 /metrics 的输出映射里——拉 /metrics 永远看不到它们。');
});

test('KNOWN_METRICS 里没有已经不再被埋点的死条目', () => {
  // 反向：死条目会以「这个指标有人管」的身份占着位置。
  const used = usedMetricNames();
  const dead = KNOWN_METRICS.filter(name => !used.has(name)).sort();
  assert.deepEqual(dead, [],
    '这些指标登记了但没有任何地方 inc()/gauge() 它们——删掉登记，或者把埋点补回来。');
});

// ---- 三张表的类型边界 ----

test('labels 不并进 gauges：类型不一致要到序列化之后才显形', () => {
  reset();
  inc('c', 2);
  gauge('g', 42);
  label('l', 'why');
  assert.equal(getCounter('c'), 2);
  assert.equal(getGauge('g'), 42);
  assert.equal(getLabel('l'), 'why');
  assert.equal(getGauge('l'), null, 'label 不该出现在 gauges 里');
});

test('getLabel/getGauge 缺省返回 null 而不是 undefined', () => {
  // undefined 会被 JSON.stringify 整个吃掉，于是前端分不清「没发生过」和
  // 「这个字段还没实现」——两者的下一步完全不同。
  reset();
  assert.equal(getLabel('nope'), null);
  assert.equal(getGauge('nope'), null);
  assert.equal(JSON.stringify({ x: getLabel('nope') }), '{"x":null}');
});

test('非有限数的 gauge 被拒，不写进表', () => {
  reset();
  gauge('g', NaN);
  gauge('g', Infinity);
  assert.equal(getGauge('g'), null);
});
