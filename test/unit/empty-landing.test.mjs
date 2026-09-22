import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLandingItems } from '../../public/js/ui/empty-landing.js';

test('没有上次会话也没有改动时，空状态不放通用建议', () => {
  assert.deepEqual(emptyLandingItems({}), []);
  assert.deepEqual(emptyLandingItems({ lastThread: null, changedCount: 0 }), []);
});

test('有上次会话时给出继续入口', () => {
  const items = emptyLandingItems({
    lastThread: { id: 'thr_1', cwd: '/tmp/app', title: '修胶囊' },
  });
  assert.deepEqual(items, [{
    action: 'continue',
    threadId: 'thr_1',
    cwd: '/tmp/app',
    title: '修胶囊',
    label: '继续上次会话',
  }]);
});

test('有未提交改动时给出改动入口', () => {
  const items = emptyLandingItems({ changedCount: 3 });
  assert.equal(items.length, 1);
  assert.equal(items[0].action, 'changes');
  assert.equal(items[0].label, '查看 3 项未提交改动');
});
