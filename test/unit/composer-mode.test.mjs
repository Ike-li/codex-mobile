import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveComposerPrimaryMode } from '../../public/js/composer-mode.js';

test('idle with content sends', () => {
  const state = resolveComposerPrimaryMode({ turnRunning: false, hasContent: true });
  assert.equal(state.mode, 'send');
  assert.equal(state.enabled, true);
  assert.equal(state.visible, true);
  assert.equal(state.followUpVisible, false);
});

test('idle without content hides the send button', () => {
  const state = resolveComposerPrimaryMode({ turnRunning: false, hasContent: false });
  assert.equal(state.mode, 'send');
  assert.equal(state.enabled, false);
  assert.equal(state.visible, false);
  assert.equal(state.followUpVisible, false);
});

test('a running turn keeps stop and reveals follow-up send when the draft has text', () => {
  const state = resolveComposerPrimaryMode({ turnRunning: true, hasContent: true });
  assert.equal(state.mode, 'stop');
  assert.equal(state.enabled, true);
  assert.equal(state.visible, true);
  assert.equal(state.followUpVisible, true);
});

test('a running turn without a draft only shows stop', () => {
  const state = resolveComposerPrimaryMode({ turnRunning: true, hasContent: false });
  assert.equal(state.mode, 'stop');
  assert.equal(state.visible, true);
  assert.equal(state.followUpVisible, false);
});

test('interrupt pending disables stop and hides follow-up send', () => {
  const state = resolveComposerPrimaryMode({
    turnRunning: true,
    hasContent: true,
    interruptPending: true,
  });
  assert.equal(state.mode, 'stop');
  assert.equal(state.enabled, false);
  assert.equal(state.followUpVisible, false);
});
