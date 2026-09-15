import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTurnOutcome } from '../../public/js/turn-outcome.js';

// R-20：完成页不能只显示模型的自述。「跑过哪些验证、哪些失败了、改了哪些文件」是可以从
// 本轮的聚合 diff 与命令执行记录里客观导出的，不需要相信模型怎么说。
test('从聚合 diff 导出改动范围', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-old',
    '+new',
    '+extra',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1 @@',
    '-t',
    '+T',
  ].join('\n');

  const outcome = summarizeTurnOutcome({ diff, commands: [] });
  assert.deepEqual(outcome.files, ['src/a.js', 'README.md']);
  assert.equal(outcome.added, 3);
  assert.equal(outcome.removed, 2);
  // --- / +++ 这两行是文件头，不能算成增删。
  assert.equal(outcome.hasChanges, true);
});

test('区分跑过的验证与其中失败的', () => {
  const outcome = summarizeTurnOutcome({
    diff: '',
    commands: [
      { command: 'npm test', exitCode: 0 },
      { command: 'npm run lint', exitCode: 1 },
      { command: 'ls', exitCode: 0 },
    ],
  });
  assert.equal(outcome.checks.length, 3);
  assert.deepEqual(outcome.failed.map(item => item.command), ['npm run lint']);
  assert.equal(outcome.allPassed, false);
});

test('没有命令时不谎称验证通过', () => {
  const outcome = summarizeTurnOutcome({ diff: '', commands: [] });
  assert.equal(outcome.allPassed, null, '一个验证都没跑过，既不是通过也不是失败');
  assert.equal(outcome.hasChanges, false);
});

test('尚未结束的命令不计入结果', () => {
  const outcome = summarizeTurnOutcome({
    diff: '',
    commands: [{ command: 'npm test', exitCode: null }],
  });
  assert.equal(outcome.checks.length, 0, '没有退出码就还没有结论');
  assert.equal(outcome.allPassed, null);
});
