import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPastedImage, attachmentPreview } from '../../public/js/attachments-ui.js';

test('pickPastedImage prefers the first image clipboard item', () => {
  const image = { type: 'image/png', kind: 'file' };
  const text = { type: 'text/plain', kind: 'string' };
  assert.equal(pickPastedImage({ items: [text, image] }), image);
  assert.equal(pickPastedImage({ items: [text] }), null);
  assert.equal(pickPastedImage(null), null);
});

test('attachmentPreview only exposes image data URIs', () => {
  assert.deepEqual(
    attachmentPreview({ name: 'shot.png', mimeType: 'image/png', data: 'abc' }),
    { kind: 'image', name: 'shot.png', src: 'data:image/png;base64,abc' },
  );
  assert.deepEqual(
    attachmentPreview({ name: 'note.txt', mimeType: 'text/plain', data: 'abc' }),
    { kind: 'file', name: 'note.txt', src: '' },
  );
});
