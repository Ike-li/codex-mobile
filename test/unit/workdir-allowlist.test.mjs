import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkdirAllowlist, resolveWithinWorkdirs } from '../../src/files/workdir-allowlist.js';

test('WORK_DIRS can load a JSON array of workspace paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-workdirs-'));
  try {
    const alpha = join(root, 'alpha');
    const beta = join(root, 'beta');
    mkdirSync(alpha);
    mkdirSync(beta);
    writeFileSync(join(root, 'workdirs.json'), JSON.stringify([alpha, beta, alpha]));
    const primaryPath = join(root, 'primary');
    mkdirSync(primaryPath);
    const primary = realpathSync(primaryPath);
    const resolved = resolveWorkdirAllowlist({
      workDir: primary,
      extra: 'workdirs.json',
      baseDir: root,
    });
    assert.deepEqual(resolved.workDirs, [primary, realpathSync(alpha), realpathSync(beta)]);
    assert.equal(resolved.warnings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('comma-separated WORK_DIRS still adds extra directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-workdirs-csv-'));
  try {
    const primaryPath = join(root, 'primary');
    const extra = join(root, 'extra');
    mkdirSync(primaryPath);
    mkdirSync(extra);
    const resolved = resolveWorkdirAllowlist({
      workDir: primaryPath,
      extra,
      baseDir: root,
    });
    assert.deepEqual(resolved.workDirs, [realpathSync(primaryPath), realpathSync(extra)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// fs/readFile 与 fs/writeFile 只收绝对路径，协议侧不做作用域约束——手机拿到一个有效
// token 就能读 ~/.ssh/id_rsa 和 ~/.codex/auth.json。凭据外泄是唯一撤销设备也收不回的
// 破坏，所以边界要落在服务端，不能只是前端约定。
test('工作区作用域拦截穿越、软链接逃逸和前缀碰撞', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-scope-')));
  try {
    const work = join(root, 'work');
    const outside = join(root, 'outside');
    // 前缀碰撞：/…/work 获准时 /…/work-other 不能跟着获准。
    const sibling = join(root, 'work-other');
    for (const dir of [work, outside, sibling]) mkdirSync(dir);
    writeFileSync(join(work, 'a.txt'), 'a');
    writeFileSync(join(outside, 'secret'), 's');
    writeFileSync(join(sibling, 'b.txt'), 'b');
    symlinkSync(join(outside, 'secret'), join(work, 'escape'));
    const workDirs = [work];

    assert.equal(resolveWithinWorkdirs(join(work, 'a.txt'), workDirs), join(work, 'a.txt'));
    assert.equal(resolveWithinWorkdirs(work, workDirs), work, '工作区根目录本身可用');
    // 尚不存在的目标要能通过，否则新建文件无从下手；但祖先仍需落在工作区内。
    assert.equal(resolveWithinWorkdirs(join(work, 'new.txt'), workDirs), join(work, 'new.txt'));

    assert.equal(resolveWithinWorkdirs(join(outside, 'secret'), workDirs), null, '工作区外');
    assert.equal(resolveWithinWorkdirs(join(work, '..', 'outside', 'secret'), workDirs), null, '路径穿越');
    assert.equal(resolveWithinWorkdirs(join(work, 'escape'), workDirs), null, '软链接逃逸');
    assert.equal(resolveWithinWorkdirs(join(sibling, 'b.txt'), workDirs), null, '前缀碰撞');
    assert.equal(resolveWithinWorkdirs('relative/path', workDirs), null, '相对路径');
    assert.equal(resolveWithinWorkdirs('', workDirs), null);
    assert.equal(resolveWithinWorkdirs(join(work, 'a.txt'), []), null, '没有工作区时一律拒绝');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 大小写不敏感的文件系统（macOS/Windows 默认）上，realpath 不做大小写归一：
// 磁盘上叫 work，realpath('…/WORK') 原样返回 '…/WORK'。于是异大小写的区内路径
// 会被拒绝 —— 这是 fail closed，用户看到的是一次拒绝，重新输入即可。
//
// 不要把它「修」成大小写不敏感比较：在大小写敏感的文件系统上（Linux 生产环境）
// /srv/work 和 /srv/WORK 是两个真实存在的不同目录，不敏感比较会变成真正的越权。
// 这条断言的作用就是让那种改动变红。
test('异大小写的区内路径被拒绝而不是被放行', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-scope-case-')));
  try {
    const work = join(root, 'work');
    mkdirSync(work);
    writeFileSync(join(work, 'a.txt'), 'a');
    const workDirs = [work];

    const upper = join(root, 'WORK', 'a.txt');
    assert.equal(
      resolveWithinWorkdirs(upper, workDirs),
      null,
      '大小写不匹配必须 fail closed；放行意味着比较变成了大小写不敏感',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 配置写错时必须说清楚是哪一条、错在哪。这些告警会出现在启动日志和 doctor 输出里，
// 是用户唯一能看到的线索 —— 静默忽略一条坏路径的后果是「工作区少了一个但没人知道」，
// 排查时会一路怀疑到权限和软链接上去。
test('WORK_DIRS 的坏条目逐条告警而不是整体静默失败', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-workdirs-bad-')));
  try {
    const primary = join(root, 'primary');
    const good = join(root, 'good');
    const aFile = join(root, 'a-file.txt');
    mkdirSync(primary);
    mkdirSync(good);
    writeFileSync(aFile, 'not a directory');

    const resolved = resolveWorkdirAllowlist({
      workDir: primary,
      extra: [good, aFile, join(root, 'does-not-exist')].join(','),
      baseDir: root,
    });

    assert.deepEqual(resolved.workDirs, [primary, good], '好的条目照常生效，坏的不能连累它们');
    assert.equal(resolved.warnings.length, 2);
    assert.ok(resolved.warnings.some(w => w.includes('不是目录') && w.includes('a-file.txt')));
    assert.ok(resolved.warnings.some(w => w.includes('不存在/不可达') && w.includes('does-not-exist')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WORK_DIRS 指向的 JSON 读不动时报出文件名和原因', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-workdirs-json-')));
  try {
    const primary = join(root, 'primary');
    mkdirSync(primary);
    writeFileSync(join(root, 'broken.json'), '{ this is not json');

    const resolved = resolveWorkdirAllowlist({ workDir: primary, extra: 'broken.json', baseDir: root });
    assert.deepEqual(resolved.workDirs, [primary]);
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0], /WORK_DIRS 无法读取 broken\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WORK_DIRS 的 JSON 不是数组时明说，而不是当成逗号分隔的路径', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-workdirs-obj-')));
  try {
    const primary = join(root, 'primary');
    mkdirSync(primary);
    writeFileSync(join(root, 'obj.json'), JSON.stringify({ path: '/tmp' }));

    const resolved = resolveWorkdirAllowlist({ workDir: primary, extra: 'obj.json', baseDir: root });
    assert.deepEqual(resolved.workDirs, [primary]);
    assert.match(resolved.warnings[0], /WORK_DIRS JSON 不是数组/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WORK_DIRS 的 JSON 数组里，无效条目单独告警且不影响有效条目', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-workdirs-mixed-')));
  try {
    const primary = join(root, 'primary');
    const alpha = join(root, 'alpha');
    mkdirSync(primary);
    mkdirSync(alpha);
    // 支持两种条目写法：裸字符串和 { path }。数字和空串都是无效条目。
    writeFileSync(join(root, 'mixed.json'), JSON.stringify([{ path: alpha }, 42, '   ', null]));

    const resolved = resolveWorkdirAllowlist({ workDir: primary, extra: 'mixed.json', baseDir: root });
    assert.deepEqual(resolved.workDirs, [primary, alpha], '{ path } 形式要被接受');
    assert.equal(resolved.warnings.length, 3, '42、空白串、null 各报一条');
    for (const warning of resolved.warnings) assert.match(warning, /WORK_DIRS 忽略无效条目/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WORK_DIR 本身无效时直接抛错，而不是退化成一个空的允许列表', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-workdir-invalid-')));
  try {
    const aFile = join(root, 'file.txt');
    writeFileSync(aFile, 'x');

    assert.throws(
      () => resolveWorkdirAllowlist({ workDir: join(root, 'missing'), baseDir: root }),
      /WORK_DIR 不存在/,
      '不存在时要提示去 .env 设置有效路径',
    );
    assert.throws(
      () => resolveWorkdirAllowlist({ workDir: aFile, baseDir: root }),
      /WORK_DIR 不是目录/,
      '指到文件上也要拦住 —— 空的允许列表等于所有 fs 操作全被拒，症状会指向别处',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空的 WORK_DIRS 不产生条目也不产生告警', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-workdirs-empty-')));
  try {
    const primary = join(root, 'primary');
    mkdirSync(primary);
    for (const extra of ['', '   ', undefined]) {
      const resolved = resolveWorkdirAllowlist({ workDir: primary, extra, baseDir: root });
      assert.deepEqual(resolved.workDirs, [primary]);
      assert.deepEqual(resolved.warnings, []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没配工作区时拒绝，且不回落家目录', () => {
  // 曾经 server.js 写的是 `process.env.WORK_DIR || homedir()`：不配工作区时整个家目录
  // 进入 agent 的文件作用域——~/.ssh、~/.aws、浏览器配置、其他项目的 .env 全在里面，
  // 而用户看不到这件事发生了，启动日志只印一条看起来正常的路径。
  assert.throws(() => resolveWorkdirAllowlist({ workDir: '' }), /没有配置任何工作区/);
  assert.throws(() => resolveWorkdirAllowlist({}), /没有配置任何工作区/);
});

test('「没配」与「路径打错了」是两条不同的消息——下一步动作不同', () => {
  const notConfigured = (() => { try { resolveWorkdirAllowlist({ workDir: '' }); } catch (e) { return e.message; } })();
  const wrongPath = (() => { try { resolveWorkdirAllowlist({ workDir: '/definitely/not/here' }); } catch (e) { return e.message; } })();
  assert.notEqual(notConfigured, wrongPath);
  assert.match(wrongPath, /不存在/);
});
