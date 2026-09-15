import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLineModels } from '../../public/js/diff-lines.js';

test('diffLineModels colors added, removed and hunk lines', () => {
  const lines = diffLineModels('@@ -1 +1 @@\n-old\n+new\n context');
  assert.deepEqual(lines.map(line => line.tone), ['hunk', 'del', 'add', 'plain']);
});
