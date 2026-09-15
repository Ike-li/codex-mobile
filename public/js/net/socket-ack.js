export class AckTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Socket acknowledgement timed out after ${timeoutMs}ms`);
    this.name = 'AckTimeoutError';
    this.code = 'ack_timeout';
    this.retryable = true;
    this.resultUnknown = true;
  }
}

export class SocketDisconnectedError extends Error {
  constructor(reason) {
    super(`Socket disconnected before acknowledgement${reason ? `: ${reason}` : ''}`);
    this.name = 'SocketDisconnectedError';
    this.code = 'socket_disconnected';
    this.retryable = true;
    this.resultUnknown = true;
  }
}

export function emitWithAck(socket, event, payload, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
  const setTimer = options.setTimer || globalThis.setTimeout;
  const clearTimer = options.clearTimer || globalThis.clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let disconnectListener = null;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      if (disconnectListener && typeof socket.off === 'function') {
        socket.off('disconnect', disconnectListener);
      }
      callback(value);
    };

    timer = setTimer(() => {
      settle(reject, new AckTimeoutError(timeoutMs));
    }, timeoutMs);
    if (typeof socket.once === 'function') {
      disconnectListener = reason => {
        settle(reject, new SocketDisconnectedError(reason));
      };
      socket.once('disconnect', disconnectListener);
    }
    try {
      socket.emit(event, payload, ack => settle(resolve, ack));
    } catch (error) {
      settle(reject, error);
    }
  });
}
