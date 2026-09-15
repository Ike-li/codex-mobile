import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCurrentThread,
  getCurrentThread,
  setCurrentThread,
} from '../../public/js/thread-preferences.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('current thread preference is isolated by cwd and migrates the legacy global pointer once', () => {
  const storage = memoryStorage({ codex_current_session_id: 'thr-legacy' });

  assert.equal(getCurrentThread(storage, '/workspace/a'), 'thr-legacy');
  assert.equal(storage.getItem('codex_current_session_id'), null);
  assert.equal(getCurrentThread(storage, '/workspace/b'), null);

  setCurrentThread(storage, '/workspace/a', 'thr-a');
  setCurrentThread(storage, '/workspace/b', 'thr-b');
  assert.equal(getCurrentThread(storage, '/workspace/a'), 'thr-a');
  assert.equal(getCurrentThread(storage, '/workspace/b'), 'thr-b');

  clearCurrentThread(storage, '/workspace/a', 'thr-a');
  assert.equal(getCurrentThread(storage, '/workspace/a'), null);
  assert.equal(getCurrentThread(storage, '/workspace/b'), 'thr-b');
});
