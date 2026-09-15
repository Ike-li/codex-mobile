import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAtMentionQuery,
  applyAtMentionPick,
  mentionPartFromSearchHit,
} from '../../public/js/at-mention.js';

test('detects @query at the start of a line or after whitespace', () => {
  assert.deepEqual(detectAtMentionQuery('@src'), { query: 'src', matchStart: 0 });
  assert.deepEqual(detectAtMentionQuery('see ＠foo'), { query: 'foo', matchStart: 4 });
  assert.equal(detectAtMentionQuery('user@host'), null);
  assert.equal(detectAtMentionQuery('done @file more'), null);
});

test('picking a candidate replaces the trigger and avoids a double space', () => {
  const inserted = applyAtMentionPick('see @fo', { matchStart: 4, cursorPos: 7, path: 'src/app.js' });
  assert.equal(inserted.text, 'see src/app.js ');
  assert.equal(inserted.cursorPos, 'see src/app.js '.length);

  const mid = applyAtMentionPick('see @fo now', { matchStart: 4, cursorPos: 7, path: 'src/app.js' });
  assert.equal(mid.text, 'see src/app.js now');
});

test('search hits become structured mention parts inside the runtime cwd', () => {
  assert.deepEqual(mentionPartFromSearchHit('src/app.js', '/tmp/work'), {
    kind: 'mention',
    name: 'app.js',
    path: '/tmp/work/src/app.js',
  });
});
