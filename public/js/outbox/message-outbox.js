import { createMessageRequest, messageWirePayload } from '../compose/message-request.js';
import { isDefinitelyUnattempted } from './outbox-recovery.js';
import { randomId } from '../util/random-id.js';

export function createMessageOutbox({
  store,
  transport,
  reconcileTransport,
  getGatewayEpoch = () => null,
  isConnected = () => true,
  createId = randomId,
  now = () => Date.now(),
}) {
  if (!store || typeof store.put !== 'function' || typeof store.list !== 'function') {
    throw new Error('Message outbox requires a store');
  }
  if (typeof transport !== 'function') {
    throw new Error('Message outbox requires a transport');
  }

  let activeDrain = null;
  let queuedDrainOptions = null;
  let operationTail = Promise.resolve();

  function runExclusive(operation) {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => {});
    return result;
  }

  function mergeDrainOptions(left, right) {
    if (!left) return right || {};
    const leftPredicate = left.shouldSend;
    const rightPredicate = right?.shouldSend;
    if (typeof leftPredicate !== 'function' || typeof rightPredicate !== 'function') return {};
    return {
      shouldSend: request => leftPredicate(request) || rightPredicate(request),
    };
  }

  async function runDrain(options = {}) {
    if (!isConnected()) return;
    const shouldSend = typeof options.shouldSend === 'function'
      ? options.shouldSend
      : () => true;
    const requests = await store.list();
    for (const request of requests) {
      if (!isConnected()) break;
      if (!shouldSend(request)) continue;
      if (request.state === 'rejected') break;
      if (request.state === 'needs_reconcile') break;
      if (request.state === 'queued') continue;
      const attemptedGatewayEpoch = getGatewayEpoch();
      const attempt = {
        ...request,
        state: 'sending',
        attempts: (Number.isInteger(request.attempts) ? request.attempts : 0) + 1,
        ...(attemptedGatewayEpoch ? { attemptedGatewayEpoch } : {}),
      };
      await store.put(attempt);
      let ack;
      try {
        ack = await transport(messageWirePayload(attempt));
      } catch (error) {
        await store.put({
          ...attempt,
          state: error?.resultUnknown === true
            ? 'needs_reconcile'
            : (error?.retryable === true ? 'retryable' : 'rejected'),
          lastError: {
            code: error?.code || 'transport_error',
            message: error?.message || String(error || 'transport error'),
            resultUnknown: error?.resultUnknown === true,
          },
        });
        break;
      }
      if (ack?.ok !== true) {
        await store.put({
          ...attempt,
          state: ack?.resultUnknown === true
            ? 'needs_reconcile'
            : (ack?.retryable === true ? 'retryable' : 'rejected'),
          lastError: {
            code: ack?.errorCode || 'request_rejected',
            message: ack?.error || 'Message request was rejected',
            resultUnknown: ack?.resultUnknown === true,
          },
        });
        break;
      }
      const receipt = ack?.receipt;
      const validReceipt = receipt?.clientRequestId === request.clientRequestId
        && ['queued', 'submitted', 'steered'].includes(receipt.state);
      if (!validReceipt) {
        await store.put({
          ...attempt,
          state: 'needs_reconcile',
          lastError: {
            code: 'invalid_receipt',
            message: 'Message acknowledgement did not contain a matching receipt',
            resultUnknown: true,
          },
        });
        break;
      }
      if (receipt.state === 'queued') {
        await store.put({
          ...attempt,
          state: 'queued',
          receipt: { ...receipt },
        });
        continue;
      }
      if (
        (receipt.state === 'submitted' || receipt.state === 'steered')
        && typeof store.delete === 'function'
      ) {
        await store.delete(request.clientRequestId);
      }
    }
  }

  async function acceptReceipt(receipt) {
    if (!receipt?.clientRequestId) return false;
    const requests = await store.list();
    const request = requests.find(item => item.clientRequestId === receipt.clientRequestId);
    if (!request) return false;
    if (
      (receipt.state === 'submitted' || receipt.state === 'steered')
      && typeof store.delete === 'function'
    ) {
      await store.delete(request.clientRequestId);
      return true;
    }
    if (receipt.state === 'queued') {
      await store.put({ ...request, state: 'queued', receipt: { ...receipt } });
      return true;
    }
    if (receipt.state === 'rejected') {
      await store.put({
        ...request,
        state: 'rejected',
        receipt: { ...receipt },
        lastError: {
          code: receipt.errorCode || 'dispatch_rejected',
          message: receipt.error || 'Message request was rejected by the runtime',
          resultUnknown: false,
        },
      });
      return true;
    }
    return false;
  }

  return {
    async enqueue(request) {
      await store.put(request);
      return request;
    },
    retryAfterConfirmation(clientRequestId, options = {}) {
      return runExclusive(async () => {
        const requests = await store.list();
        const request = requests.find(item => item.clientRequestId === clientRequestId);
        if (!request || request.state !== 'needs_reconcile') return null;
        if (typeof store.delete !== 'function') {
          throw new Error('Message outbox cannot replace a confirmed retry without delete support');
        }
        const target = options.target || {
          instanceId: request.payload?.instanceId,
          threadId: request.payload?.threadId,
        };
        const replacement = {
          ...createMessageRequest({
            text: request.payload?.text,
            attachments: request.payload?.attachments,
            parts: request.payload?.parts,
            target,
            turn: request.payload?.turn,
          }, { createId, now }),
          retryOfClientRequestId: request.clientRequestId,
          userConfirmedRetryAt: Number.isFinite(options.confirmedAt)
            ? options.confirmedAt
            : now(),
        };
        if (replacement.clientRequestId === request.clientRequestId) {
          throw new Error('Confirmed retry requires a fresh clientRequestId');
        }
        await store.put(replacement);
        await store.delete(request.clientRequestId);
        return replacement;
      });
    },
    rebindUnattempted(clientRequestId, target) {
      return runExclusive(async () => {
        const requests = await store.list();
        const request = requests.find(item => item.clientRequestId === clientRequestId);
        if (!request || !isDefinitelyUnattempted(request)) return null;
        const hasThread = typeof target?.threadId === 'string' && target.threadId;
        const hasInstance = typeof target?.instanceId === 'string' && target.instanceId;
        if (!hasThread && !hasInstance) throw new Error('Outbox recovery requires an exact target');
        const rebound = {
          ...request,
          ...createMessageRequest({
            text: request.payload?.text,
            attachments: request.payload?.attachments,
            parts: request.payload?.parts,
            target,
            turn: request.payload?.turn,
          }, {
            createId: () => request.clientRequestId,
            now: () => request.createdAt,
          }),
        };
        await store.put(rebound);
        return rebound;
      });
    },
    discard(clientRequestId) {
      return runExclusive(async () => {
        if (typeof clientRequestId !== 'string' || !clientRequestId) return false;
        if (typeof store.delete !== 'function') {
          throw new Error('Message outbox cannot discard without delete support');
        }
        const requests = await store.list();
        if (!requests.some(item => item.clientRequestId === clientRequestId)) return false;
        await store.delete(clientRequestId);
        return true;
      });
    },
    acceptReceipt(receipt) {
      return runExclusive(() => acceptReceipt(receipt));
    },
    reconcile(options = {}) {
      return runExclusive(async () => {
        const summary = { checked: 0, resolved: 0, unresolved: 0 };
        if (!isConnected() || typeof reconcileTransport !== 'function') return summary;
        const shouldReconcile = typeof options.shouldReconcile === 'function'
          ? options.shouldReconcile
          : () => true;
        const requests = await store.list();
        for (const request of requests) {
          if (!isConnected()) break;
          if (
            (request.state !== 'needs_reconcile' && request.state !== 'queued')
            || !shouldReconcile(request)
          ) continue;
          summary.checked += 1;
          const query = {
            clientRequestId: request.clientRequestId,
            ...(request.payload?.threadId ? { threadId: request.payload.threadId } : {}),
            ...(request.attemptedGatewayEpoch
              ? { attemptedGatewayEpoch: request.attemptedGatewayEpoch }
              : {}),
          };
          let acknowledgement;
          try {
            acknowledgement = await reconcileTransport(query);
          } catch (error) {
            acknowledgement = {
              ok: false,
              errorCode: error?.code || 'reconcile_transport_error',
              error: error?.message || String(error || 'Message reconciliation failed'),
            };
          }
          if (
            acknowledgement?.ok === true
            && acknowledgement.resolved === true
            && await acceptReceipt(acknowledgement.receipt)
          ) {
            summary.resolved += 1;
            continue;
          }
          const outcome = acknowledgement?.outcome;
          if (
            acknowledgement?.ok === true
            && acknowledgement.resolved === true
            && outcome?.ok === false
            && outcome.resultUnknown !== true
            && outcome.retryable !== true
          ) {
            await store.put({
              ...request,
              state: 'rejected',
              reconciledGatewayEpoch: acknowledgement?.gatewayEpoch || null,
              lastError: {
                code: outcome.errorCode || 'dispatch_rejected',
                message: outcome.error || 'Message request was rejected by the runtime',
                resultUnknown: false,
              },
            });
            summary.resolved += 1;
            continue;
          }
          summary.unresolved += 1;
          await store.put({
            ...request,
            state: 'needs_reconcile',
            reconciledGatewayEpoch: acknowledgement?.gatewayEpoch || null,
            lastReconcileError: {
              code: acknowledgement?.errorCode || 'result_still_unknown',
              message: acknowledgement?.error || 'The message result is still unknown',
              resultUnknown: true,
            },
          });
        }
        return summary;
      });
    },
    drain(options = {}) {
      if (activeDrain) {
        queuedDrainOptions = mergeDrainOptions(queuedDrainOptions, options);
        return activeDrain;
      }
      activeDrain = runExclusive(async () => {
        let nextOptions = options;
        while (nextOptions) {
          queuedDrainOptions = null;
          await runDrain(nextOptions);
          nextOptions = queuedDrainOptions;
        }
      }).finally(() => {
        activeDrain = null;
      });
      return activeDrain;
    },
  };
}
