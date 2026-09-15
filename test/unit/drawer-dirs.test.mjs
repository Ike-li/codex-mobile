import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadExpandedDirs,
  persistExpandedDirs,
  toggleExpandedDir,
} from '../../public/js/drawer-dirs.js';

test('loadExpandedDirs restores saved dirs and always keeps the current cwd expanded', () => {
  const storage = {
    getItem: () => JSON.stringify(['/tmp/a', '/tmp/b']),
  };
  const set = loadExpandedDirs(storage, '/tmp/current');
  assert.equal(set.has('/tmp/a'), true);
  assert.equal(set.has('/tmp/b'), true);
  assert.equal(set.has('/tmp/current'), true);
});

test('toggleExpandedDir expands a collapsed dir and collapses it on the second click', () => {
  let set = new Set();
  const first = toggleExpandedDir(set, '/tmp/a');
  assert.equal(first.expanded, true);
  assert.equal(first.set.has('/tmp/a'), true);
  const second = toggleExpandedDir(first.set, '/tmp/a');
  assert.equal(second.expanded, false);
  assert.equal(second.set.has('/tmp/a'), false);
});

test('persistExpandedDirs writes the set back to storage', () => {
  const store = {};
  persistExpandedDirs({
    setItem: (key, value) => { store[key] = value; },
  }, new Set(['/tmp/a']));
  assert.equal(store.codex_expanded_dirs, JSON.stringify(['/tmp/a']));
});
