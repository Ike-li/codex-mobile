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

// 待审批排在最前，且是唯一一个「不处理就一直卡着」的入口：未提交改动回到电脑前
// 照样能看，而 agent 停在审批上只有手机这一条路能放行。移动端的全部意义在这里。
test('有待审批时排在最前，因为只有它会卡住 agent', () => {
  const items = emptyLandingItems({
    lastThread: { id: 'thr_1', cwd: '/tmp/app', title: '修胶囊' },
    changedCount: 3,
    pendingCount: 2,
  });

  assert.equal(items[0].action, 'approvals', '待审批必须排在继续会话与改动之前');
  assert.equal(items[0].label, '2 项等你批准');
  assert.deepEqual(items.map(item => item.action), ['approvals', 'continue', 'changes']);
});

test('没有待审批时不占位', () => {
  assert.deepEqual(emptyLandingItems({ pendingCount: 0 }), []);
  assert.deepEqual(emptyLandingItems({ changedCount: 1, pendingCount: 0 }).map(i => i.action), ['changes']);
});
