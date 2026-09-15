import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePorcelainZ,
  classifyGitEntries,
  assertSafeRelPath,
  listGitChanges,
  readGitDiff,
} from '../../git-workspace.js';

test('parsePorcelainZ understands ordinary and rename records', () => {
  const entries = parsePorcelainZ(' M src/a.js\0R  new.js\0old.js\0?? scratch.txt\0');
  assert.deepEqual(entries, [
    { xy: ' M', path: 'src/a.js' },
    { xy: 'R ', path: 'new.js', oldPath: 'old.js' },
    { xy: '??', path: 'scratch.txt' },
  ]);
});

test('classifyGitEntries splits staged, unstaged, untracked and conflicted', () => {
  const groups = classifyGitEntries([
    { xy: 'M ', path: 'staged.js' },
    { xy: ' M', path: 'dirty.js' },
    { xy: 'MM', path: 'both.js' },
    { xy: '??', path: 'new.txt' },
    { xy: 'UU', path: 'conflict.js' },
  ]);
  assert.deepEqual(groups.staged.map(item => item.path), ['staged.js', 'both.js']);
  assert.deepEqual(groups.unstaged.map(item => item.path), ['dirty.js', 'both.js']);
  assert.deepEqual(groups.untracked.map(item => item.path), ['new.txt']);
  assert.deepEqual(groups.conflicted.map(item => item.path), ['conflict.js']);
});

test('assertSafeRelPath rejects absolute, parent, and magic pathspecs', () => {
  assert.equal(assertSafeRelPath('/tmp/work', 'src/a.js'), '/tmp/work/src/a.js');
  assert.equal(assertSafeRelPath('/tmp/work', '../secret'), null);
  assert.equal(assertSafeRelPath('/tmp/work', '/etc/passwd'), null);
  assert.equal(assertSafeRelPath('/tmp/work', 'src/*'), null);
});

test('listGitChanges and readGitDiff use injected git and stay scoped', async () => {
  const calls = [];
  const execFile = (cmd, args, _opts, cb) => {
    calls.push(args.slice(2));
    const key = args.slice(2).join(' ');
    if (key === 'symbolic-ref --short HEAD') return cb(null, 'main\n', '');
    if (key === 'status --porcelain=v1 -z') return cb(null, ' M src/a.js\0', '');
    if (key === 'diff -- src/a.js') return cb(null, '-old\n+new\n', '');
    return cb(new Error(`unexpected ${key}`));
  };

  const status = await listGitChanges('/tmp/work', { execFile });
  assert.equal(status.ok, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.unstaged[0].path, 'src/a.js');

  const diff = await readGitDiff('/tmp/work', 'src/a.js', 'unstaged', { execFile });
  assert.equal(diff.ok, true);
  assert.match(diff.patch, /\+new/);

  const escaped = await readGitDiff('/tmp/work', '../secret', 'unstaged', { execFile });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.code, 'bad_path');
});

// 下面几条守的是「文件变更面板在异常情况下显示什么」。这些路径此前没有覆盖，
// 而它们恰好是用户最需要一句明确说明的时刻：目录不是仓库、文件是二进制、
// diff 大到必须截断。返回错误码而不是抛异常，页面才能给出可操作的文案。
function gitStub(handlers) {
  return (cmd, args, _opts, cb) => {
    const key = args.slice(2).join(' ');
    const handler = handlers[key];
    if (!handler) return cb(new Error(`unexpected git invocation: ${key}`));
    return handler(cb);
  };
}

function notAGitRepoError() {
  const err = new Error('fatal: not a git repository (or any of the parent directories): .git');
  err.stderr = 'fatal: not a git repository';
  return err;
}

test('不是 git 仓库时，状态和 diff 都返回 not_git 而不是抛异常', async () => {
  const execFile = gitStub({
    'symbolic-ref --short HEAD': cb => cb(notAGitRepoError()),
    'rev-parse --short HEAD': cb => cb(notAGitRepoError()),
    'status --porcelain=v1 -z': cb => cb(notAGitRepoError()),
    'diff -- a.js': cb => cb(notAGitRepoError()),
  });

  const status = await listGitChanges('/tmp/work', { execFile });
  assert.deepEqual(status, { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' });

  const diff = await readGitDiff('/tmp/work', 'a.js', 'unstaged', { execFile });
  assert.deepEqual(diff, { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' });
});

test('git 本身报错（非 not_git）时保留原始信息，便于排查', async () => {
  const execFile = gitStub({
    'symbolic-ref --short HEAD': cb => cb(null, 'main\n', ''),
    'status --porcelain=v1 -z': cb => cb(new Error('index.lock exists')),
    'diff --cached -- a.js': cb => cb(new Error('bad revision')),
  });

  const status = await listGitChanges('/tmp/work', { execFile });
  assert.equal(status.code, 'git_error');
  assert.match(status.error, /index\.lock/, '原始 git 错误要透出来，否则用户只知道「失败了」');

  const diff = await readGitDiff('/tmp/work', 'a.js', 'staged', { execFile });
  assert.equal(diff.code, 'git_error');
  assert.match(diff.error, /bad revision/);
});

test('detached HEAD 时回退到短 sha 作为分支名', async () => {
  const execFile = gitStub({
    'symbolic-ref --short HEAD': cb => cb(new Error('fatal: ref HEAD is not a symbolic ref')),
    'rev-parse --short HEAD': cb => cb(null, 'a1b2c3d\n', ''),
    'status --porcelain=v1 -z': cb => cb(null, '', ''),
  });

  const status = await listGitChanges('/tmp/work', { execFile });
  assert.equal(status.ok, true);
  assert.equal(status.branch, 'a1b2c3d', 'detached HEAD 不该让分支显示为空');
});

test('二进制文件的 diff 用占位文案，不把原始字节灌进页面', async () => {
  const execFile = gitStub({
    'diff -- logo.png': cb => cb(null, 'diff --git a/logo.png\0\x89PNG\r\n', ''),
  });

  const diff = await readGitDiff('/tmp/work', 'logo.png', 'unstaged', { execFile });
  assert.equal(diff.ok, true);
  assert.equal(diff.binary, true);
  assert.equal(diff.patch, '（二进制内容，略）');
  assert.equal(diff.truncated, false);
});

test('git 自报 Binary files differ 时也标成二进制', async () => {
  const execFile = gitStub({
    'diff -- logo.png': cb => cb(null, 'Binary files a/logo.png and b/logo.png differ\n', ''),
  });

  const diff = await readGitDiff('/tmp/work', 'logo.png', 'unstaged', { execFile });
  assert.equal(diff.binary, true, '没有 NUL 字节但 git 明说是二进制，同样要标出来');
  assert.equal(diff.truncated, false);
});

test('超出上限的 diff 被截断并标记，而不是整段丢弃或撑爆页面', async () => {
  const huge = `+${'x'.repeat(5000)}\n`;
  const execFile = gitStub({ 'diff -- big.txt': cb => cb(null, huge, '') });

  const diff = await readGitDiff('/tmp/work', 'big.txt', 'unstaged', { execFile, maxBytes: 100 });
  assert.equal(diff.ok, true);
  assert.equal(diff.truncated, true);
  assert.equal(diff.patch.length, 100);
  assert.equal(diff.empty, false);
});

test('空 diff 标成 empty，让页面能说「这个文件没有变更」', async () => {
  const execFile = gitStub({ 'diff -- clean.js': cb => cb(null, '', '') });

  const diff = await readGitDiff('/tmp/work', 'clean.js', 'unstaged', { execFile });
  assert.equal(diff.ok, true);
  assert.equal(diff.empty, true);
  assert.equal(diff.binary, false);
});

test('参数不合法时逐条给出可区分的错误码', async () => {
  assert.equal((await listGitChanges('', {})).code, 'bad_cwd');
  assert.equal((await readGitDiff('', 'a.js', 'unstaged', {})).code, 'bad_cwd');
  assert.equal((await readGitDiff('/tmp/work', 'a.js', 'both', {})).code, 'bad_side');
  assert.equal((await readGitDiff('/tmp/work', '/etc/passwd', 'unstaged', {})).code, 'bad_path');
});
