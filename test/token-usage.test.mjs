// test/token-usage.test.mjs —— 上下文占用的展示格式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextFromTokenUsage, formatContextMeter, formatTokens } from '../public/js/token-usage.js';

// ---- contextFromTokenUsage：协议字段 → ctx ----
// 服务端(statusline.js)和浏览器(app.js)共用这一份，协议字段名只在这里出现。

test('从协议的 ThreadTokenUsage 取当前上下文和窗口', () => {
  assert.deepEqual(contextFromTokenUsage({
    last: { totalTokens: 82491, inputTokens: 80000, cachedInputTokens: 60000 },
    total: { totalTokens: 250000 },
    modelContextWindow: 272000,
  }), { contextTokens: 82491, contextWindow: 272000, usedPct: 30 });
});

test('用的是 last 不是 total —— total 是累计成本，不是当前上下文', () => {
  const ctx = contextFromTokenUsage({
    last: { totalTokens: 10000 },
    total: { totalTokens: 999999 },
    modelContextWindow: 272000,
  });
  assert.equal(ctx.contextTokens, 10000);
});

test('认不出字段时返回 null，不返回全零对象', () => {
  // snake_case 是上一版 statusline.js 用的名字，必须落到 null 而不是 0
  assert.equal(contextFromTokenUsage({ last: { input_tokens: 1000 } }), null);
  assert.equal(contextFromTokenUsage({ last: { totalTokens: 0 } }), null);
  assert.equal(contextFromTokenUsage(null), null);
  assert.equal(contextFromTokenUsage({}), null);
});

test('缺 modelContextWindow 时窗口和百分比都是 null', () => {
  assert.deepEqual(contextFromTokenUsage({ last: { totalTokens: 1800 } }),
    { contextTokens: 1800, contextWindow: null, usedPct: null });
});

// ---- 展示格式 ----

test('formatTokens: 千位以下给整数，以上给 1 位小数的 k', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1800), '1.8k');
  assert.equal(formatTokens(82491), '82.5k');
  // 整千不该显示成 "272.0k"
  assert.equal(formatTokens(272000), '272k');
});

test('上下文占用带窗口时显示占用/上限', () => {
  const meter = formatContextMeter({ contextTokens: 82491, contextWindow: 272000, usedPct: 30 });
  assert.equal(meter.visible, true);
  assert.equal(meter.label, '82.5k/272k');
});

test('缺窗口时只显示绝对值', () => {
  const meter = formatContextMeter({ contextTokens: 1800, contextWindow: null, usedPct: null });
  assert.equal(meter.visible, true);
  assert.equal(meter.label, '1.8k');
  assert.equal(meter.tone, 'ok');
});

test('无数据时不显示', () => {
  const empty = { visible: false, label: '', tone: '', pct: null, title: '' };
  assert.deepEqual(formatContextMeter(null), empty);
  assert.deepEqual(formatContextMeter(undefined), empty);
});

// 这个 meter 存在的理由就是回答「我该 compact 了吗」。只显示数字而不在逼近
// 上限时改变语气，等于把判断重新丢回给用户。
test('逼近上限时升级语气', () => {
  const at = pct => formatContextMeter({
    contextTokens: Math.round(272000 * pct / 100), contextWindow: 272000, usedPct: pct,
  }).tone;
  assert.equal(at(30), 'ok');
  assert.equal(at(74), 'ok');
  assert.equal(at(75), 'warn');
  assert.equal(at(89), 'warn');
  assert.equal(at(90), 'bad');
  assert.equal(at(99), 'bad');
});

// 上下文用量从数字胶囊改成圆环（抄 ChatGPT 桌面端的 contextUsageIndicator）：
// 环按百分比填充，具体数字退到 tooltip。文案取它的
// composer.contextWindowUsageTooltip「已用 {usedTokens}k 标记，共 {contextWindow}k」。

test('给出百分比和 tooltip 文案，供圆环和悬停用', () => {
  const meter = formatContextMeter({ contextTokens: 82491, contextWindow: 272000, usedPct: 30 });
  assert.equal(meter.pct, 30);
  assert.equal(meter.title, '已用 82.5k 标记，共 272k');
});

test('缺窗口时没有百分比可画，tooltip 只说用了多少', () => {
  const meter = formatContextMeter({ contextTokens: 1800, contextWindow: null, usedPct: null });
  assert.equal(meter.pct, null);
  assert.equal(meter.title, '已用 1.8k 标记');
});

// 用量可以超过窗口（长会话累积到 437% 是实测出来的，不是构造的极端值）。
// 数字胶囊时代它只是显示得奇怪，喂给 conic-gradient 就是非法输入。
test('用量超出窗口时环钳在 100%，但 tooltip 仍报真实数字', () => {
  const meter = formatContextMeter({ contextTokens: 1190000, contextWindow: 272000, usedPct: 437 });
  assert.equal(meter.pct, 100, '环的填充比例必须是合法百分比');
  assert.equal(meter.tone, 'bad');
  assert.equal(meter.title, '已用 1190k 标记，共 272k');
});
