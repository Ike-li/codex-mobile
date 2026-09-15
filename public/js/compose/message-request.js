import { sanitizeTurnOverrides } from '../util/cli-settings.js';
import { randomId } from '../util/random-id.js';

export function createMessageRequest(input = {}, options = {}) {
  const createId = options.createId || randomId;
  const now = options.now || (() => Date.now());
  const clientRequestId = createId();
  if (typeof clientRequestId !== 'string' || !clientRequestId) {
    throw new Error('Unable to create clientRequestId');
  }

  const payload = {
    clientRequestId,
    text: typeof input.text === 'string' ? input.text : '',
  };
  if (Array.isArray(input.attachments) && input.attachments.length) {
    payload.attachments = input.attachments.map(attachment => ({ ...attachment }));
  }
  if (Array.isArray(input.parts) && input.parts.length) {
    payload.parts = input.parts.map(part => ({ ...part }));
  }
  if (typeof input.target?.threadId === 'string' && input.target.threadId) {
    payload.threadId = input.target.threadId;
  } else if (typeof input.target?.instanceId === 'string' && input.target.instanceId) {
    payload.instanceId = input.target.instanceId;
  }
  const turn = sanitizeTurnOverrides(input.turn);
  if (Object.keys(turn).length) payload.turn = turn;

  return {
    clientRequestId,
    createdAt: now(),
    state: 'pending',
    payload,
  };
}

export function messageWirePayload(request) {
  if (!request?.payload || request.payload.clientRequestId !== request.clientRequestId) {
    throw new Error('Invalid message request');
  }
  const payload = { ...request.payload };
  if (Array.isArray(payload.attachments)) {
    payload.attachments = payload.attachments.map(attachment => ({ ...attachment }));
  }
  if (Array.isArray(payload.parts)) {
    payload.parts = payload.parts.map(part => ({ ...part }));
  }
  return payload;
}
