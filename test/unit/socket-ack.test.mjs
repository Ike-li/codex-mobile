import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emitWithAck } from '../../public/js/socket-ack.js';

test('emitWithAck resolves the exact server acknowledgement', async () => {
  const socket = {
    emit(event, payload, ack) {
      assert.equal(event, 'user:message');
      assert.equal(payload.clientRequestId, 'req-ack');
      queueMicrotask(() => ack({ ok: true, duplicate: false, receipt: { state: 'submitted' } }));
    },
  };

  const ack = await emitWithAck(socket, 'user:message', { clientRequestId: 'req-ack' });

  assert.deepEqual(ack, {
    ok: true,
    duplicate: false,
    receipt: { state: 'submitted' },
  });
});

test('emitWithAck reports an unknown retryable result on timeout and ignores a late ack', async () => {
  let fireTimeout;
  let lateAck;
  let cleared = 0;
  const socket = {
    emit(_event, _payload, ack) {
      lateAck = ack;
    },
  };

  const pending = emitWithAck(socket, 'user:message', { clientRequestId: 'req-timeout' }, {
    timeoutMs: 50,
    setTimer(callback, delay) {
      assert.equal(delay, 50);
      fireTimeout = callback;
      return 7;
    },
    clearTimer(timer) {
      assert.equal(timer, 7);
      cleared += 1;
    },
  });

  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'ack_timeout');
    assert.equal(error.retryable, true);
    assert.equal(error.resultUnknown, true);
    return true;
  });
  assert.doesNotThrow(() => lateAck({ ok: true }));
  assert.equal(cleared, 1);
});

test('emitWithAck rejects immediately when the socket disconnects', async () => {
  let disconnect;
  let lateAck;
  let removed = 0;
  let cleared = 0;
  const socket = {
    once(event, listener) {
      assert.equal(event, 'disconnect');
      disconnect = listener;
    },
    off(event, listener) {
      assert.equal(event, 'disconnect');
      assert.equal(listener, disconnect);
      removed += 1;
    },
    emit(_event, _payload, ack) {
      lateAck = ack;
    },
  };

  const pending = emitWithAck(socket, 'user:message', { clientRequestId: 'req-disconnect' }, {
    setTimer() { return 9; },
    clearTimer(timer) {
      assert.equal(timer, 9);
      cleared += 1;
    },
  });

  assert.equal(typeof disconnect, 'function');
  disconnect('transport close');
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'socket_disconnected');
    assert.equal(error.retryable, true);
    assert.equal(error.resultUnknown, true);
    return true;
  });
  assert.doesNotThrow(() => lateAck({ ok: true }));
  assert.equal(removed, 1);
  assert.equal(cleared, 1);
});
