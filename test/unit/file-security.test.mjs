// test/unit/file-security.test.mjs —— 文件安全模块单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, lstatSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isOpenableTarget,
  mkdirBounded,
  writeOwnerOnlyFile,
  isOwnerOnly,
  fixPermissions,
  rejectableSymlinkComponent,
  checkPermissions,
} from '../../src/files/file-security.js';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ccm-fs-test-'));
}

// ---- isOwnerOnly ----

test('isOwnerOnly: 0600 文件返回 true', () => {
  const dir = makeTempDir();
  try {
    const f = join(dir, 'test.txt');
    writeFileSync(f, 'data');
    chmodSync(f, 0o600);
    assert.equal(isOwnerOnly(f), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isOwnerOnly: 0644 文件返回 false', () => {
  const dir = makeTempDir();
  try {
    const f = join(dir, 'test.txt');
    writeFileSync(f, 'data');
    chmodSync(f, 0o644);
    assert.equal(isOwnerOnly(f), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isOwnerOnly: 0700 目录返回 true', () => {
  const dir = makeTempDir();
  try {
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    chmodSync(sub, 0o700);
    assert.equal(isOwnerOnly(sub, true), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isOwnerOnly: 0755 目录返回 false', () => {
  const dir = makeTempDir();
  try {
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    chmodSync(sub, 0o755);
    assert.equal(isOwnerOnly(sub, true), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isOwnerOnly: 不存在的路径返回 false', () => {
  assert.equal(isOwnerOnly('/nonexistent/path/file.txt'), false);
});

// ---- fixPermissions ----

test('fixPermissions: 修复 0644 文件为 0600', () => {
  const dir = makeTempDir();
  try {
    const f = join(dir, 'test.txt');
    writeFileSync(f, 'data');
    chmodSync(f, 0o644);
    assert.equal(fixPermissions(f), true);
    const stat = lstatSync(f);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixPermissions: 修复 0755 目录为 0700', () => {
  const dir = makeTempDir();
  try {
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    chmodSync(sub, 0o755);
    assert.equal(fixPermissions(sub, true), true);
    const stat = lstatSync(sub);
    assert.equal(stat.mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixPermissions: 不存在的路径返回 false', () => {
  assert.equal(fixPermissions('/nonexistent/path/file.txt'), false);
});

// ---- writeOwnerOnlyFile ----

test('writeOwnerOnlyFile: 创建文件内容正确', () => {
  const dir = makeTempDir();
  try {
    const f = join(dir, 'test.json');
    writeOwnerOnlyFile(f, '{"key":"value"}');
    const content = readFileSync(f, 'utf8');
    assert.equal(content, '{"key":"value"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOwnerOnlyFile: 文件权限为 0600', () => {
  const dir = makeTempDir();
  try {
    const f = join(dir, 'test.json');
    writeOwnerOnlyFile(f, '{}');
    const stat = lstatSync(f);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOwnerOnlyFile: 覆盖已有文件', () => {
  const dir = makeTempDir();
  try {
    const f = join(dir, 'test.json');
    writeOwnerOnlyFile(f, 'old');
    writeOwnerOnlyFile(f, 'new');
    const content = readFileSync(f, 'utf8');
    assert.equal(content, 'new');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOwnerOnlyFile: 空内容写入', () => {
  const dir = makeTempDir();
  try {
    const f = join(dir, 'empty.txt');
    writeOwnerOnlyFile(f, '');
    assert.ok(existsSync(f));
    const stat = lstatSync(f);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- checkPermissions ----

test('checkPermissions: 返回空数组当所有文件权限正确', () => {
  const dir = makeTempDir();
  try {
    const f1 = join(dir, 'a.txt');
    const f2 = join(dir, 'b.txt');
    writeFileSync(f1, 'a');
    writeFileSync(f2, 'b');
    chmodSync(f1, 0o600);
    chmodSync(f2, 0o600);
    const problems = checkPermissions([f1, f2]);
    assert.equal(problems.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPermissions: 返回权限不正确的文件', () => {
  const dir = makeTempDir();
  try {
    const f1 = join(dir, 'good.txt');
    const f2 = join(dir, 'bad.txt');
    writeFileSync(f1, 'a');
    writeFileSync(f2, 'b');
    chmodSync(f1, 0o600);
    chmodSync(f2, 0o644);
    const problems = checkPermissions([f1, f2]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0], f2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPermissions: 跳过不存在的文件', () => {
  const problems = checkPermissions(['/nonexistent/a.txt', '/nonexistent/b.txt']);
  assert.equal(problems.length, 0);
});

// ---- rejectableSymlinkComponent ----

test('rejectableSymlinkComponent: 普通路径返回 null', () => {
  const dir = makeTempDir();
  try {
    const f = join(dir, 'normal.txt');
    writeFileSync(f, 'data');
    assert.equal(rejectableSymlinkComponent(f), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejectableSymlinkComponent: 不存在的路径返回 null', () => {
  assert.equal(rejectableSymlinkComponent('/nonexistent/path/file.txt'), null);
});

test('isOpenableTarget 放行普通文件与软链，挡住 FIFO 与目录', () => {
  // FIFO 是这条判定存在的全部理由：POSIX 下 open(FIFO, O_RDONLY) 在没有 writer 时
  // **无限阻塞**，而本服务是单进程 Node —— 挂住的是整个事件循环，所有会话一起卡死，
  // 没有报错、没有超时、没有日志。O_NOFOLLOW 挡不住它（那管的是软链，不是文件类型）。
  const dir = mkdtempSync(join(tmpdir(), 'ccm-openable-'));
  try {
    const file = join(dir, 'real.txt');
    writeFileSync(file, 'x');
    assert.equal(isOpenableTarget(file), true);

    const link = join(dir, 'link.txt');
    symlinkSync(file, link);
    assert.equal(isOpenableTarget(link), true, '软链本身放行——范围校验在别处做');

    assert.equal(isOpenableTarget(dir), false, '目录不该被当成可读文件');
    assert.equal(isOpenableTarget(join(dir, 'nope')), false, '看不到就不开');

    const fifo = join(dir, 'pipe');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status === 0) {
      assert.equal(isOpenableTarget(fifo), false, 'FIFO 必须在 open 之前就被挡住');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});

// ---- mkdirBounded：Node 的递归 mkdir 会活锁，这里要的是有界 ----
//
// 背景：Linux 的 procfs 是可写挂载，却对创建条目返回 ENOENT。Node 的
// mkdirSync({recursive:true}) 把 ENOENT 当成「父目录缺失」→ 去建 /proc（已存在）
// → 回头重试子路径 → 又 ENOENT → 无限循环，100% CPU 且永不返回。
// 实测过：CODEX_DATA_DIR 指向 /proc/... 时整个进程挂死（见 audit-vocabulary 那条用例）。
//
// 判据必须证明「有界」，不能断言「跑得快」——后者是时序判据，本身就是脆的。
// 所以在 fs 边界注入假实现，直接数调用次数。

test('mkdirBounded 逐级创建缺失目录，调用次数等于缺失层数', () => {
  const made = [];
  const existing = new Set(['/base']);
  mkdirBounded('/base/a/b/c', {
    mode: 0o700,
    exists: p => existing.has(p),
    mkdir: (p) => { made.push(p); existing.add(p); },
  });
  // 由浅到深，一次不多：证明工作量是路径深度而不是重试次数
  assert.deepEqual(made, ['/base/a', '/base/a/b', '/base/a/b/c']);
});

test('mkdir 恒抛 ENOENT 时立刻抛出，不重试——这是活锁那条路', () => {
  let calls = 0;
  const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  assert.throws(() => mkdirBounded('/proc/nonexistent-ccm', {
    exists: p => p === '/proc',      // 父目录存在，子路径不存在：正是 procfs 的形态
    mkdir: () => { calls += 1; throw err; },
  }), /ENOENT/);
  assert.equal(calls, 1, '只能尝试一次；重试就是活锁');
});

test('EEXIST 被忽略——并发创建不该让调用方变红', () => {
  const err = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
  assert.doesNotThrow(() => mkdirBounded('/base/a', {
    exists: p => p === '/base',
    mkdir: () => { throw err; },
  }));
});

test('目标已存在时一次 mkdir 都不发', () => {
  let calls = 0;
  mkdirBounded('/base/a', { exists: () => true, mkdir: () => { calls += 1; } });
  assert.equal(calls, 0);
});

test('mkdirBounded 真的能在文件系统上建出多层目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-mkdirp-'));
  try {
    const deep = join(root, 'x', 'y', 'z');
    mkdirBounded(deep, { mode: 0o700 });
    assert.equal(existsSync(deep), true);
    assert.equal(isOwnerOnly(deep, true), true, '中间与末级目录都应是 owner-only');
  } finally {
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
