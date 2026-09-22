import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerNeeds, waitingLabel } from '../../public/js/session/needs-you-view.js';

// 「需要你」横幅的唯一职责是把**看不见的**待办拉到眼前。审批卡就在视野里时，
// 横幅是同一件事在一屏内说第二遍，还占掉首屏六分之一的高度。
test('审批卡已在视野内时，横幅不再重复它', () => {
  const needs = [
    { needId: 'n1', state: 'pending' },
    { needId: 'n2', state: 'pending' },
  ];

  assert.deepEqual(bannerNeeds(needs, { inlineNeedIds: ['n1'] }).map(n => n.needId), ['n2']);
  assert.deepEqual(bannerNeeds(needs, { inlineNeedIds: ['n1', 'n2'] }), [], '全都看得见就整条横幅收起');
  assert.deepEqual(bannerNeeds(needs, {}).map(n => n.needId), ['n1', 'n2'], '什么都看不见时照旧全列');
});

test('滚出视野的审批重新回到横幅', () => {
  const needs = [{ needId: 'n1', state: 'pending' }];
  assert.deepEqual(bannerNeeds(needs, { inlineNeedIds: ['n1'] }), []);
  assert.deepEqual(bannerNeeds(needs, { inlineNeedIds: [] }).map(n => n.needId), ['n1']);
});

// 等审批的时候它没在思考，它在等你。这是这个产品最不该说错的一句话。
test('有待审批时等待态文案说的是「等你批准」', () => {
  assert.equal(waitingLabel({ pendingApprovals: 1 }), '等你批准');
  assert.equal(waitingLabel({ pendingApprovals: 3 }), '等你批准');
  assert.equal(waitingLabel({ pendingApprovals: 0 }), '正在思考');
  assert.equal(waitingLabel({}), '正在思考');
});
