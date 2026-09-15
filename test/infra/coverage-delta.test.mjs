// test/infra/coverage-delta.test.mjs —— 覆盖率 delta 门禁的解析与判定。
// 这个门禁曾长期静默失效:它把 c8 的文本表格通过 `| tail -20` 取尾部再正则匹配,
// 而 `All files` 汇总行位于表头下第一行,全量测试的表格远超 20 行,汇总行必被截掉,
// 于是每次都以「无法解析覆盖率报告」退出 1。改读 json-summary 后由下面的用例守护。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCoverageSummary, evaluateCoverage } from '../../scripts/gates/check-coverage-delta.js';

const MIN = { statements: 80, branches: 60, functions: 80, lines: 80 };

function withSummary(total, run) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-cov-test-'));
  try {
    writeFileSync(join(dir, 'coverage-summary.json'), JSON.stringify({ total }));
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('coverage summary is read from the json report, not scraped from table text', () => {
  // c8 json-summary 的真实形状:每项都是 {total,covered,skipped,pct}。
  const actual = withSummary({
    lines: { total: 1000, covered: 958, skipped: 0, pct: 95.79 },
    statements: { total: 1000, covered: 958, skipped: 0, pct: 95.79 },
    functions: { total: 500, covered: 489, skipped: 0, pct: 97.84 },
    branches: { total: 400, covered: 351, skipped: 0, pct: 87.88 },
  }, readCoverageSummary);

  assert.deepEqual(actual, {
    statements: 95.79,
    branches: 87.88,
    functions: 97.84,
    lines: 95.79,
  });
});

test('missing or malformed summary reports a cause instead of silently passing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-cov-test-'));
  try {
    assert.throws(() => readCoverageSummary(dir), /coverage-summary\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage below the absolute minimum fails regardless of the baseline', () => {
  const current = { statements: 79, branches: 88, functions: 98, lines: 96 };
  // 基线同样低 ⇒ delta 为 0,只有绝对阈值能拦住它。
  const baseline = { statements: 79, branches: 88, functions: 98, lines: 96 };
  const failures = evaluateCoverage({ current, baseline, minThresholds: MIN, maxDecrease: 2 });

  assert.equal(failures.length, 1);
  assert.match(failures[0], /statements/);
  assert.match(failures[0], /80/);
});

test('a drop larger than the allowed delta fails even while above the minimum', () => {
  const baseline = { statements: 95.79, branches: 87.88, functions: 97.84, lines: 95.79 };
  const current = { ...baseline, branches: 85.5 }; // −2.38pp,仍远高于 60 的绝对阈值
  const failures = evaluateCoverage({ current, baseline, minThresholds: MIN, maxDecrease: 2 });

  assert.equal(failures.length, 1);
  assert.match(failures[0], /branches/);
});

test('a drop within the allowed delta passes', () => {
  const baseline = { statements: 95.79, branches: 87.88, functions: 97.84, lines: 95.79 };
  const current = { ...baseline, branches: 86.0 }; // −1.88pp
  const failures = evaluateCoverage({ current, baseline, minThresholds: MIN, maxDecrease: 2 });

  assert.deepEqual(failures, []);
});

test('without a baseline only the absolute minimums apply', () => {
  const current = { statements: 95.79, branches: 87.88, functions: 97.84, lines: 95.79 };
  const failures = evaluateCoverage({ current, baseline: null, minThresholds: MIN, maxDecrease: 2 });

  assert.deepEqual(failures, []);
});
