export function createRecoveryState(target = {}) {
  return {
    instanceId: stringId(target.instanceId),
    threadId: stringId(target.threadId),
    events: [],
  };
}

export function bufferRecoveryEvent(recovery, event) {
  if (!recovery || !event || !(Number(event.seq) > 0)) return false;
  const eventThreadId = stringId(event.sessionId) || stringId(event.payload?.threadId);
  if (recovery.instanceId && event.instanceId !== recovery.instanceId) return false;
  if (recovery.threadId && eventThreadId !== recovery.threadId) return false;
  recovery.events.push(event);
  return true;
}

export function completeRecovery(recovery, ack = {}) {
  if (!recovery || ack.instanceId !== recovery.instanceId || ack.threadId !== recovery.threadId) {
    return { accepted: false, events: [] };
  }

  const rebuilt = ack.gap === true && ack.rebuilt === true;
  const throughSeq = rebuilt && Number.isInteger(ack.throughSeq) ? ack.throughSeq : -1;
  if (rebuilt && ack.snapshot?.source !== 'thread/read') {
    return { accepted: false, events: [] };
  }

  const unique = new Map();
  for (const event of recovery.events) {
    if (rebuilt && event.seq <= throughSeq) continue;
    unique.set(`${event.epoch || ''}:${event.seq}`, event);
  }
  const events = [...unique.values()].sort((a, b) => a.seq - b.seq);
  return {
    accepted: true,
    gap: ack.gap === true,
    rebuilt,
    snapshot: rebuilt ? ack.snapshot : null,
    epoch: typeof ack.epoch === 'string' ? ack.epoch : null,
    throughSeq: rebuilt ? throughSeq : null,
    events,
  };
}

function stringId(value) {
  return typeof value === 'string' && value ? value : null;
}
