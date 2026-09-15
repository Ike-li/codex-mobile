import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTranscriptStream } from '../../public/js/render/transcript-stream.js';

test('transcript stream batches deltas and finishes with the complete text', () => {
  const scheduled = [];
  const cancelled = new Set();
  const events = [];
  const stream = createTranscriptStream({
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length - 1;
    },
    cancel(id) {
      cancelled.add(id);
    },
    onStart() {
      events.push(['start']);
    },
    onText(text) {
      events.push(['text', text]);
    },
    onFinish(text) {
      events.push(['finish', text]);
    },
  });

  assert.equal(stream.append('Hel'), 'Hel');
  assert.equal(stream.append('lo'), 'Hello');
  assert.deepEqual(events, [['start']]);

  scheduled[0]();
  assert.deepEqual(events, [['start'], ['text', 'Hello']]);

  assert.equal(stream.append('!'), 'Hello!');
  assert.equal(stream.finish(), 'Hello!');
  assert.ok(cancelled.has(1));
  assert.deepEqual(events, [
    ['start'],
    ['text', 'Hello'],
    ['text', 'Hello!'],
    ['finish', 'Hello!'],
  ]);
});
