#!/usr/bin/env node
// scripts/gates/check-coverage-delta.js —— 检查覆盖率是否下降。
// 用于 PR 检查：对比当前覆盖率与基线，确保不下降。
//
// 覆盖率数据取自 c8 的 json-summary，而不是解析文本表格。早期实现用
// `npx c8 … | tail -20` 取输出尾部再正则匹配 `All files`，但那一行位于表头下第一行、
// 后面还跟着每个源文件一行，全量测试的表格远超 20 行，汇总行必然被截掉，
// 门禁于是每次都以「无法解析覆盖率报告」退出 1 —— 静默失效。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BASELINE_FILE = join(ROOT, '.coverage-baseline.json');

const METRICS = ['statements', 'branches', 'functions', 'lines'];

// 绝对下限。低于这里一律失败，与基线无关。
const MIN_THRESHOLDS = {
  statements: 80,
  branches: 60,
  functions: 80,
  lines: 80,
};

// 相对基线允许的最大跌幅（百分点）。
const MAX_DECREASE = 2;

/** 从 c8 json-summary 报告目录读出四项指标。 */
export function readCoverageSummary(reportDir) {
  const summaryPath = join(reportDir, 'coverage-summary.json');
  if (!existsSync(summaryPath)) {
    throw new Error(`未找到 coverage-summary.json（${summaryPath}）——c8 未产出报告`);
  }
  const total = JSON.parse(readFileSync(summaryPath, 'utf8'))?.total;
  if (!total) {
    throw new Error(`coverage-summary.json 缺少 total 段：${summaryPath}`);
  }
  const result = {};
  for (const metric of METRICS) {
    const pct = Number(total[metric]?.pct);
    if (!Number.isFinite(pct)) {
      throw new Error(`coverage-summary.json 的 ${metric}.pct 不是数字`);
    }
    result[metric] = pct;
  }
  return result;
}

/** 返回失败原因列表；空数组表示通过。baseline 为 null 时只校验绝对下限。 */
export function evaluateCoverage({ current, baseline, minThresholds, maxDecrease }) {
  const failures = [];
  for (const metric of METRICS) {
    if (current[metric] < minThresholds[metric]) {
      failures.push(`${metric} 覆盖率 ${current[metric]}% 低于最低阈值 ${minThresholds[metric]}%`);
    }
  }
  if (baseline) {
    for (const metric of METRICS) {
      const delta = current[metric] - baseline[metric];
      if (delta < -maxDecrease) {
        failures.push(`${metric} 覆盖率下降 ${Math.abs(delta).toFixed(2)}pp，超过允许的 ${maxDecrease}pp`);
      }
    }
  }
  return failures;
}

function runCoverageDeltaCheck() {
  const reportDir = mkdtempSync(join(tmpdir(), 'ccm-coverage-delta-'));
  try {
    console.log('📊 运行测试并收集覆盖率...');
    // 递归：测试按执行槽分在 test/{unit,invariants,integration,infra}/ 下。
    // 扁平 readdirSync 在分层之后会收集到 0 个文件，而「0 个」与「全都跑了」
    // 在覆盖率数字上无法区分——那正是本文件开头记的那种静默失效，所以下面补了地板断言。
    const collectTestFiles = (dir, prefix) => readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap(entry => {
        const rel = join(prefix, entry.name);
        if (entry.isDirectory()) return collectTestFiles(join(dir, entry.name), rel);
        return entry.name.endsWith('.test.mjs') ? [rel] : [];
      });
    const testFiles = collectTestFiles(join(ROOT, 'test'), 'test');
    if (testFiles.length === 0) {
      console.error('❌ 没有收集到任何测试文件，覆盖率门禁已失明');
      process.exit(1);
    }

    execFileSync(process.execPath, [
      join(ROOT, 'node_modules', 'c8', 'bin', 'c8.js'),
      '--reporter=json-summary',
      `--report-dir=${reportDir}`,
      `--temp-directory=${join(reportDir, 'tmp')}`,
      process.execPath,
      '--test',
      '--test-concurrency=1',
      ...testFiles,
    ], {
      cwd: ROOT,
      stdio: 'inherit',
      // 全量测试自身约 45 秒，加上 c8 插桩会更慢；60 秒会在慢机器上假失败。
      timeout: 180_000,
    });

    const current = readCoverageSummary(reportDir);
    console.log('\n当前覆盖率:');
    for (const metric of METRICS) console.log(`  ${metric}: ${current[metric]}%`);

    const baseline = existsSync(BASELINE_FILE)
      ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
      : null;

    if (!baseline) {
      console.log('\n📝 未找到基线，保存当前覆盖率作为基线...');
      writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2));
    } else {
      console.log('\n覆盖率变化:');
      for (const metric of METRICS) {
        const delta = current[metric] - baseline[metric];
        const symbol = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️';
        console.log(`  ${symbol} ${metric}: ${delta > 0 ? '+' : ''}${delta.toFixed(2)}pp`);
      }
    }

    const failures = evaluateCoverage({
      current,
      baseline,
      minThresholds: MIN_THRESHOLDS,
      maxDecrease: MAX_DECREASE,
    });

    if (failures.length > 0) {
      for (const failure of failures) console.error(`❌ ${failure}`);
      console.error('\n❌ 覆盖率检查未通过');
      return 1;
    }
    console.log('\n✅ 覆盖率检查通过');
    return 0;
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCoverageDeltaCheck();
  } catch (err) {
    console.error('❌ 运行失败:', err?.message || err);
    process.exitCode = 1;
  }
}
