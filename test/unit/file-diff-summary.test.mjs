import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTextChange } from '../../public/js/files/file-diff-summary.js';

// R-16 要求写入前展示 diff 并确认。手机误触代价高，光说「要覆盖 X 吗」不够——
// 必须能看出改了什么。
test('概括两段文本之间的行级差异', () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'a\nB2\nc\nd\n';
  const summary = summarizeTextChange(before, after);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.unchanged, false);
  // 只呈现变化处及其上下文，不把整份文件搬到确认框里。
  assert.deepEqual(summary.hunk.map(line => `${line.sign}${line.text}`), ['-b', '+B2']);
  assert.equal(summary.firstChangedLine, 2);
});

test('新建文件与内容未变都要能分辨', () => {
  const created = summarizeTextChange(null, 'x\ny\n');
  assert.equal(created.created, true);
  assert.equal(created.added, 2);
  assert.equal(created.removed, 0);

  const same = summarizeTextChange('x\ny\n', 'x\ny\n');
  assert.equal(same.unchanged, true);
  assert.equal(same.added, 0);
  assert.equal(same.removed, 0);
});

test('只截取变化区间，长文件不会把整份内容塞进确认框', () => {
  const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 250', 'line 250 changed');
  const summary = summarizeTextChange(before, after);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.firstChangedLine, 251);
  assert.ok(summary.hunk.length <= 20, `实际 ${summary.hunk.length} 行`);
});
