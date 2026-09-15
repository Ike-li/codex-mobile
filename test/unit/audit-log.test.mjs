import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendJsonlAuditRecord } from '../../audit-log.js';

test('JSONL audit appends owner-only records and retains only one bounded rotation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-audit-log-'));
  const auditPath = join(root, 'security-audit.jsonl');
  try {
    for (let index = 0; index < 20; index += 1) {
      appendJsonlAuditRecord(auditPath, {
        event: 'auth_failure',
        outcome: 'denied',
        index,
      }, { maxBytes: 240, maxGenerations: 1, now: () => index });
    }

    assert.deepEqual(readdirSync(root).sort(), [
      'security-audit.jsonl',
      'security-audit.jsonl.1',
    ]);
    const retained = [auditPath, `${auditPath}.1`].flatMap(path => (
      readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    ));
    assert.ok(retained.length < 20);
    assert.equal(retained.some(record => record.index === 19), true);
    for (const path of [auditPath, `${auditPath}.1`]) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.ok(statSync(path).size <= 240);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 原设计只留一代（base + .1），约 2 MiB。D6 把文件读写纳入审计、R-SEC-2 还要扩到消息、
// 附件与策略变更之后，这个窗口太短——而审计里最有价值的恰恰是旧记录，入侵往往事后才发现。
// 仍然保持有界：自托管服务不能让日志无限长。
test('审计日志按代数滚动，丢最旧的一代而不是每次都清空上一代', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-audit-gen-'));
  const auditPath = join(root, 'security-audit.jsonl');
  try {
    for (let index = 0; index < 40; index += 1) {
      appendJsonlAuditRecord(auditPath, { event: 'fs_denied', index }, {
        maxBytes: 120,
        maxGenerations: 3,
        now: () => index,
      });
    }

    assert.deepEqual(readdirSync(root).sort(), [
      'security-audit.jsonl',
      'security-audit.jsonl.1',
      'security-audit.jsonl.2',
      'security-audit.jsonl.3',
    ], '保留 maxGenerations 代，不多不少');

    const byGeneration = ['', '.1', '.2', '.3'].map(suffix => (
      readFileSync(`${auditPath}${suffix}`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    ));
    // 代号越大越旧：.3 里的记录必须早于 .1，否则滚动方向反了。
    const newestOf = records => Math.max(...records.map(record => record.index));
    assert.ok(newestOf(byGeneration[0]) > newestOf(byGeneration[1]));
    assert.ok(newestOf(byGeneration[1]) > newestOf(byGeneration[2]));
    assert.ok(newestOf(byGeneration[2]) > newestOf(byGeneration[3]));
    assert.equal(newestOf(byGeneration[0]), 39, '最新一条必须在活动文件里');

    for (const suffix of ['', '.1', '.2', '.3']) {
      assert.equal(statSync(`${auditPath}${suffix}`).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 变异补漏：批 5（AUDIT） ----

// 注入的 now 要真的被用上。判反的话线上会用注入进来的那个"函数对象"当时间戳
// （JSON.stringify 一个函数得到 undefined），审计记录里就没有时间——
// 而事后追查时时间往往是唯一能对上的东西。
test('注入的 now 被真的用上，没注入才回落到 Date.now', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-audit-now-'));
  const auditPath = join(root, 'a.jsonl');
  try {
    appendJsonlAuditRecord(auditPath, { event: 'x' }, { now: () => 1700000000000 });
    assert.equal(JSON.parse(readFileSync(auditPath, 'utf8').trim()).ts, 1700000000000);

    const before = Date.now();
    appendJsonlAuditRecord(auditPath, { event: 'y' });
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    const ts = JSON.parse(lines[1]).ts;
    assert.ok(Number.isInteger(ts) && ts >= before, '没注入时用真实时钟，且必须是个数字');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 非法的容量与代数配置要回落到默认值。当成有效值的后果很实：
// maxBytes=0 会让每一条记录都「超出保留上限」而抛异常——审计从此一条也写不进去，
// 而调用方把审计写入包在 try/catch 里，所以这个故障是完全静默的。
test('非法的 maxBytes / maxGenerations 回落到默认值，不让审计彻底写不进去', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-audit-limits-'));
  try {
    for (const bad of [0, -1, 1.5, Number.NaN, '1024', null]) {
      const auditPath = join(root, `bytes-${String(bad)}.jsonl`);
      appendJsonlAuditRecord(auditPath, { event: 'x' }, { maxBytes: bad });
      assert.equal(readFileSync(auditPath, 'utf8').trim().split('\n').length, 1,
        `maxBytes=${String(bad)} 必须回落到默认的 1MB`);
    }

    // maxGenerations 非法时同样回落。用一个很小的 maxBytes 逼出轮转，
    // 然后确认保留的代数是默认的 5 而不是 0 或 NaN。
    for (const bad of [0, -1, Number.NaN, '5']) {
      const dir = mkdtempSync(join(root, `gen-`));
      const auditPath = join(dir, 'a.jsonl');
      for (let i = 0; i < 8; i += 1) {
        appendJsonlAuditRecord(auditPath, { event: 'x'.repeat(40) }, { maxBytes: 120, maxGenerations: bad });
      }
      const generations = readdirSync(dir).filter(name => /\.\d+$/.test(name));
      assert.equal(generations.length, 5,
        `maxGenerations=${String(bad)} 必须回落到默认的 5 代，实际保留 ${generations.length} 代`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
