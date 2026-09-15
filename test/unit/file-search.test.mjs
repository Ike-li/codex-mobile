import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFiles, searchFiles } from '../../src/files/file-search.js';

test('empty query returns a dictionary-ordered browse list', () => {
  assert.deepEqual(
    matchFiles(['b.js', 'a.js', 'src/c.js'], '', { limit: 2 }),
    ['a.js', 'b.js'],
  );
});

test('basename hits rank ahead of path and subsequence matches', () => {
  assert.deepEqual(
    matchFiles(['src/tool.js', 'notes/app.md', 'app.js', 'lib/apple.js'], 'app'),
    ['app.js', 'lib/apple.js', 'notes/app.md'],
  );
});

test('searchFiles stays inside the supplied cwd and ignores query path traversal', async () => {
  const hits = await searchFiles('/tmp/work', '../etc/passwd', {
    listCandidates: async cwd => {
      assert.equal(cwd, '/tmp/work');
      return ['src/app.js', 'README.md'];
    },
  });
  assert.deepEqual(hits, []);
});

test('searchFiles returns relative hits from the candidate list', async () => {
  const hits = await searchFiles('/tmp/work', 'app', {
    listCandidates: async () => ['src/app.js', 'README.md'],
  });
  assert.deepEqual(hits, ['src/app.js']);
});

// ---- 变异补漏：@ 文件选择器 ----
//
// 这个模块此前从没跑过变异，41 个候选里存活 21 个。它是 composer 里打 `@` 时的候选来源——
// 用户从这个列表里选文件交给 agent 读，所以「哪些文件会出现在列表里」是一个 SCOPE 判据。

import { clearFileSearchCache, FILE_SEARCH_MAX_DEPTH } from '../../src/files/file-search.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function scratchTree(spec) {
  const root = mkdtempSync(join(tmpdir(), 'ccm-filesearch-'));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content ?? '');
  }
  return root;
}

// 走目录树时跳过两类：点开头的（.env / .git / .ssh）和显式黑名单目录。
// 判反的后果很具体：**`.env` 会出现在 @ 的候选列表里**，用户一点就把密钥交给了 agent。
// git 仓库里走的是 `git ls-files`（本来就不列 .gitignore 的东西），
// 但非 git 工作区走的是这条 readdir 路径——那正是默认没有 git 的目录。
test('遍历候选时跳过点开头的条目与黑名单目录', async () => {
  clearFileSearchCache();
  const root = scratchTree({
    'visible.js': '',
    '.env': 'SECRET=1',
    '.hidden/inside.txt': '',
    'node_modules/pkg/index.js': '',
    '.git/config': '',
    'src/app.js': '',
  });
  try {
    // 强制走 readdir 那条路（execFile 抛错 → gitLsFiles 返回 null → walkFiles）
    const failingExec = (_cmd, _args, _options, done) => done(new Error('no git'));
    const hits = await searchFiles(root, '', { execFile: failingExec });

    assert.deepEqual(hits.sort(), ['src/app.js', 'visible.js'],
      '.env / .hidden / node_modules / .git 都不该出现在 @ 的候选里');
  } finally {
    clearFileSearchCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('遍历有深度上界，超过的层不再展开', async () => {
  clearFileSearchCache();
  const deep = 'a/'.repeat(FILE_SEARCH_MAX_DEPTH + 2) + 'too-deep.txt';
  const shallow = 'a/'.repeat(FILE_SEARCH_MAX_DEPTH - 1) + 'ok.txt';
  const root = scratchTree({ [deep]: '', [shallow]: '' });
  try {
    const failingExec = (_cmd, _args, _options, done) => done(new Error('no git'));
    const hits = await searchFiles(root, '', { execFile: failingExec });
    assert.ok(hits.includes(shallow), `深度内的应当被列出：${shallow}`);
    assert.ok(!hits.includes(deep), '超过深度上界的目录不再展开，否则一个深目录树能把遍历拖死');
  } finally {
    clearFileSearchCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// git 仓库优先用 git ls-files：它天然排除 .gitignore 里的东西（构建产物、密钥文件）。
// 只有它失败时才回落到 readdir 遍历。
test('git 可用时用 git ls-files 的结果，失败才回落到目录遍历', async () => {
  clearFileSearchCache();
  const root = scratchTree({ 'walked.js': '' });
  try {
    const gitExec = (cmd, args, _options, done) => {
      assert.equal(cmd, 'git');
      assert.ok(args.includes('--exclude-standard'), 'ls-files 必须带 --exclude-standard，否则会列出被忽略的文件');
      done(null, 'from-git.js\nsrc/other.js\n');
    };
    assert.deepEqual((await searchFiles(root, '', { execFile: gitExec })).sort(),
      ['from-git.js', 'src/other.js'], 'git 可用时不该去走目录');

    clearFileSearchCache();
    const failingExec = (_cmd, _args, _options, done) => done(new Error('not a repo'));
    assert.deepEqual(await searchFiles(root, '', { execFile: failingExec }), ['walked.js'],
      'git 失败时回落到遍历，而不是返回空');
  } finally {
    clearFileSearchCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// 候选列表有 5 秒缓存：打 `@` 时每敲一个字符都会重查，没有缓存就是每次都遍历整棵树。
test('候选列表在 TTL 内复用缓存，clearFileSearchCache 之后重新取', async () => {
  clearFileSearchCache();
  const root = scratchTree({ 'a.js': '' });
  try {
    let calls = 0;
    const countingExec = (_cmd, _args, _options, done) => { calls += 1; done(null, 'a.js\n'); };

    await searchFiles(root, 'a', { execFile: countingExec });
    await searchFiles(root, 'ab', { execFile: countingExec });
    await searchFiles(root, 'abc', { execFile: countingExec });
    assert.equal(calls, 1, '同一个 cwd 在 TTL 内只取一次候选——否则每敲一个字符都遍历整棵树');

    clearFileSearchCache();
    await searchFiles(root, 'a', { execFile: countingExec });
    assert.equal(calls, 2, '清缓存之后要重新取');
  } finally {
    clearFileSearchCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cwd 不是非空字符串时直接返回空，不去碰文件系统', async () => {
  let touched = false;
  const spy = (_cmd, _args, _options, done) => { touched = true; done(null, ''); };
  for (const bad of ['', null, undefined, 123, {}]) {
    assert.deepEqual(await searchFiles(bad, 'q', { execFile: spy }), [], `cwd=${String(bad)}`);
  }
  assert.equal(touched, false, '连候选都不该去取');
});

// 排序是三级的：先按匹配层级，同层按路径长度，再同则按字典序。
// 少任何一级都会让结果不稳定——同样的输入两次给出不同顺序，用户选中的那一项会跳。
test('匹配结果的三级排序缺一不可，结果稳定', () => {
  const paths = ['src/app.js', 'app.js', 'lib/app.js', 'x/apple.js', 'a/p/p.js'];
  const first = matchFiles(paths, 'app');
  assert.deepEqual(first, matchFiles(paths, 'app'), '同样输入必须给同样顺序');
  assert.equal(first[0], 'app.js', 'basename 命中且最短的排最前');

  // 同层级、同长度时用字典序兜底。
  assert.deepEqual(matchFiles(['b/app.js', 'a/app.js'], 'app'), ['a/app.js', 'b/app.js']);
});

test('候选不是非空数组时返回空', () => {
  for (const bad of [null, undefined, 'not-an-array', {}, []]) {
    assert.deepEqual(matchFiles(bad, 'q'), [], String(bad));
  }
});
