// test/unit/workdirs-from-entries.test.mjs —— WORKDIRS 数组 → 允许列表。
//
// 这条路径是迁移之后工作区能不能活下来的唯一通道：codex.config.json 里的 WORKDIRS
// 是新键，而旧入口读的是 WORK_DIR / WORK_DIRS。接错了的症状是「迁移报成功，手机上
// 一个工作区都没有」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkdirsFromEntries } from '../../workdir-allowlist.js';

function withDirs(names, fn) {
  const root = mkdtempSync(join(tmpdir(), 'ccm-workdirs-'));
  try {
    const paths = names.map(name => {
      const p = join(root, name);
      mkdirSync(p, { recursive: true });
      return p;
    });
    return fn(paths, root);
  } finally {
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
}

test('首项就是主工作目录——它是手机端默认打开的那个', () => {
  withDirs(['a', 'b'], ([a, b]) => {
    const r = resolveWorkdirsFromEntries({ entries: [a, b] });
    assert.equal(r.workDir, realpathSync(a));
    assert.deepEqual(r.workDirs, [realpathSync(a), realpathSync(b)]);
  });
});

test('路径全部 realpath 归一——范围判定是权限边界，不能一侧解析一侧不解析', () => {
  withDirs(['a'], ([a], root) => {
    const r = resolveWorkdirsFromEntries({ entries: [join(root, '.', 'a')] });
    assert.equal(r.workDir, realpathSync(a));
  });
});

test('坏条目逐条告警，不影响有效条目', () => {
  withDirs(['a'], ([a], root) => {
    const r = resolveWorkdirsFromEntries({ entries: [a, join(root, 'nope')] });
    assert.deepEqual(r.workDirs, [realpathSync(a)]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /nope/);
  });
});

test('对象形态 {path} 与字符串都认', () => {
  withDirs(['a'], ([a]) => {
    const r = resolveWorkdirsFromEntries({ entries: [{ path: a }] });
    assert.deepEqual(r.workDirs, [realpathSync(a)]);
  });
});

test('去重：同一个目录写两遍只留一份', () => {
  withDirs(['a'], ([a]) => {
    const r = resolveWorkdirsFromEntries({ entries: [a, a] });
    assert.deepEqual(r.workDirs, [realpathSync(a)]);
  });
});

test('一个有效条目都没有时抛错，而不是退化成空白名单', () => {
  // 空白名单的后果不是「没有工作区」，是范围判定失去参照——所以这里 fail-loud。
  withDirs([], (_p, root) => {
    assert.throws(() => resolveWorkdirsFromEntries({ entries: [join(root, 'nope')] }), /工作区/);
    assert.throws(() => resolveWorkdirsFromEntries({ entries: [] }), /工作区/);
  });
});

test('相对路径被拒——工作区是权限边界，不能取决于进程从哪里启动', () => {
  assert.throws(() => resolveWorkdirsFromEntries({ entries: ['./relative'] }), /绝对路径/);
});
