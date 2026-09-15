import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLongPress } from '../../public/js/ui/long-press.js';

// 手势的判定逻辑抽在这里测，DOM 事件绑定留在 app.js。注入 schedule/cancel
// 是为了不靠真实时钟——和 transcript-stream.js 同一个套路。
function harness(options = {}) {
  const scheduled = [];
  const cancelled = new Set();
  const fired = [];
  const gesture = createLongPress({
    delayMs: 500,
    moveTolerance: 10,
    onLongPress: () => fired.push(true),
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length - 1;
    },
    cancel(id) {
      cancelled.add(id);
    },
    ...options,
  });
  return { gesture, scheduled, cancelled, fired };
}

test('按住超过阈值触发长按', () => {
  const { gesture, scheduled, fired } = harness();
  gesture.start(100, 100);
  assert.equal(fired.length, 0);
  scheduled[0]();
  assert.equal(fired.length, 1);
  assert.equal(gesture.fired, true);
});

test('没到阈值就松手不触发', () => {
  const { gesture, cancelled, fired } = harness();
  gesture.start(100, 100);
  gesture.end();
  assert.ok(cancelled.has(0));
  assert.equal(fired.length, 0);
  assert.equal(gesture.fired, false);
});

// 列表是可滚动的：手指按住往上滑是滚动意图，不是长按。不设容差的话
// 滚动一下就弹菜单。
test('移动超过容差取消长按', () => {
  const { gesture, cancelled, fired } = harness();
  gesture.start(100, 100);
  gesture.move(104, 103); // 距离 5，仍在容差内
  assert.equal(cancelled.size, 0);
  gesture.move(100, 118); // 距离 18，超出
  assert.ok(cancelled.has(0));
  gesture.end();
  assert.equal(fired.length, 0);
});

// fired 是给 click 处理用的：长按之后 pointerup 照样会合成一次 click，
// 不看这个标志就会「弹出菜单的同时把会话也打开了」。
test('fired 在下一次按下时重置', () => {
  const { gesture, scheduled } = harness();
  gesture.start(100, 100);
  scheduled[0]();
  assert.equal(gesture.fired, true);
  gesture.start(100, 100);
  assert.equal(gesture.fired, false);
});
