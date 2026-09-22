import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveComposerPrimaryMode } from '../../public/js/compose/composer-mode.js';

test('idle with content sends', () => {
  const state = resolveComposerPrimaryMode({ turnRunning: false, hasContent: true });
  assert.equal(state.mode, 'send');
  assert.equal(state.enabled, true);
  assert.equal(state.visible, true);
  assert.equal(state.followUpVisible, false);
  assert.equal(state.stopVisible, false);
});

test('idle without content hides the send button', () => {
  const state = resolveComposerPrimaryMode({ turnRunning: false, hasContent: false });
  assert.equal(state.mode, 'send');
  assert.equal(state.enabled, false);
  assert.equal(state.visible, false);
  assert.equal(state.followUpVisible, false);
});

test('打了字时主按钮是发送，停止退到旁边；点蓝钮不该中断当前轮', () => {
  const state = resolveComposerPrimaryMode({ turnRunning: true, hasContent: true });
  assert.equal(state.mode, 'send');
  assert.equal(state.enabled, true);
  assert.equal(state.visible, true);
  assert.equal(state.stopVisible, true);
  assert.equal(state.followUpVisible, false);
});

test('进行中且输入框空着时，主按钮才是停止', () => {
  const state = resolveComposerPrimaryMode({ turnRunning: true, hasContent: false });
  assert.equal(state.mode, 'stop');
  assert.equal(state.visible, true);
  assert.equal(state.stopVisible, false);
  assert.equal(state.followUpVisible, false);
});

test('中断已发出时两个按钮都不可用', () => {
  const withDraft = resolveComposerPrimaryMode({
    turnRunning: true,
    hasContent: true,
    interruptPending: true,
  });
  assert.equal(withDraft.mode, 'send');
  assert.equal(withDraft.enabled, false);
  assert.equal(withDraft.stopVisible, false);

  const empty = resolveComposerPrimaryMode({
    turnRunning: true,
    hasContent: false,
    interruptPending: true,
  });
  assert.equal(empty.mode, 'stop');
  assert.equal(empty.enabled, false);
});
