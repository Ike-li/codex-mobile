// test/check-test-summary.test.mjs —— 守护 GATE-02：cancelled / skipped 视同 fail。
// 守护：GATE-02
// 测什么：给定一段测试汇总，判定对不对；以及报告格式读不懂时是不是 fail-closed。
// 不测什么 + 为什么：不真去制造一次 cancelled——那依赖 Node 版本的具体行为
//   （v25.9.0 上用 unref 定时器和永久挂起的 promise 都复现不出来，前者直接 pass，
//   后者把 runner 挂死），拿它当前置条件会让这道门随 Node 升级时红时绿。
//   这里喂构造的汇总，验证的是「出现这个数字时会不会拦」，那才是门的职责。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryVerdict } from '../scripts/gates/check-test-summary.js';

const summary = ({ tests = 10, pass = 10, fail = 0, cancelled = 0, skipped = 0 }) => `
✔ 某个用例 (1.2ms)
ℹ tests ${tests}
ℹ suites 0
ℹ pass ${pass}
ℹ fail ${fail}
ℹ cancelled ${cancelled}
ℹ skipped ${skipped}
ℹ todo 0
ℹ duration_ms 123.4
`;

test('全 0 的汇总放行', () => {
  const verdict = summaryVerdict(summary({}));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.counts.pass, 10);
});

test('cancelled 不为 0 时拦下 —— 那是没跑，不是跑过了', () => {
  const verdict = summaryVerdict(summary({ tests: 13, pass: 9, cancelled: 4 }));
  assert.equal(verdict.ok, false,
    'cancelled 4 必须拦下。node --test 不把它计进 fail，汇总看起来是通过的——'
    + '这正是 app-server-transport 那四条错误路径长期未被验证的原因');
  assert.match(verdict.reason, /没跑/, '失败消息要说清 cancelled 意味着什么');
});

test('skipped 不为 0 时拦下 —— 跳过的用例不提供保护', () => {
  const verdict = summaryVerdict(summary({ skipped: 2 }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /skipped 2/);
});

test('读不到汇总行时 fail-closed，而不是沉默放行', () => {
  const verdict = summaryVerdict('测试输出格式变了，这里没有任何汇总行\n');
  assert.equal(verdict.ok, false,
    '解析不到就放行等于把这道门拆了——报告格式变化恰恰是最该被人看见的时刻');
  assert.match(verdict.reason, /读不到测试汇总行/);
});

// 这条守的是解析器本身的一个真实陷阱：本仓的测试注释里就出现过 "cancelled" 这个词
// （docs/TESTING.md 和 scripts/gates/check-test-summary.js 的文件头都在讲它），
// 用例名里出现它也完全可能。只按关键字搜会把正文当成汇总。
test('用例名里出现 cancelled 不会被误当成汇总', () => {
  const output = `
✔ 看到 cancelled 不为 0 时不要放过 (0.5ms)
✔ 另一个提到 skipped 的用例 (0.3ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
`;
  const verdict = summaryVerdict(output);
  assert.equal(verdict.ok, true,
    '用例名里的 cancelled / skipped 不是汇总。误判会让这道门在无辜的地方变红，'
    + '而被追着改绿的门最后都会被绕过去');
});
