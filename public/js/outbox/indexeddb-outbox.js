const DEFAULT_DB_NAME = 'codex-chat-mobile';
const DEFAULT_STORE_NAME = 'message-outbox';
const DEFAULT_VERSION = 1;

export function createIndexedDbMessageStore(options = {}) {
  const indexedDb = options.indexedDB || globalThis.indexedDB;
  const dbName = options.dbName || DEFAULT_DB_NAME;
  const storeName = options.storeName || DEFAULT_STORE_NAME;
  const version = options.version || DEFAULT_VERSION;
  if (!indexedDb || typeof indexedDb.open !== 'function') {
    throw new Error('IndexedDB is unavailable');
  }

  let dbPromise = null;
  let openedDb = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(dbName, version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'clientRequestId' });
        }
      };
      request.onsuccess = () => {
        openedDb = request.result;
        openedDb.onversionchange = () => openedDb?.close();
        resolve(openedDb);
      };
      request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB outbox'));
      request.onblocked = () => reject(new Error('IndexedDB outbox upgrade is blocked'));
    });
    return dbPromise;
  }

  async function runRequest(mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      let settled = false;
      let result;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const transaction = db.transaction(storeName, mode);
      transaction.oncomplete = () => settle(resolve, result);
      transaction.onerror = () => settle(reject, transaction.error || new Error('IndexedDB outbox transaction failed'));
      transaction.onabort = () => settle(reject, transaction.error || new Error('IndexedDB outbox transaction aborted'));
      try {
        const request = operation(transaction.objectStore(storeName));
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => settle(reject, request.error || new Error('IndexedDB outbox request failed'));
      } catch (error) {
        transaction.abort();
        settle(reject, error);
      }
    });
  }

  return {
    async put(record) {
      if (!record || typeof record.clientRequestId !== 'string' || !record.clientRequestId) {
        throw new Error('Outbox record requires clientRequestId');
      }
      await runRequest('readwrite', store => store.put(record));
      return record;
    },
    async list() {
      const records = await runRequest('readonly', store => store.getAll());
      return (Array.isArray(records) ? records : []).sort((a, b) => {
        const timeDiff = Number(a?.createdAt || 0) - Number(b?.createdAt || 0);
        if (timeDiff) return timeDiff;
        return String(a?.clientRequestId || '').localeCompare(String(b?.clientRequestId || ''));
      });
    },
    async delete(clientRequestId) {
      await runRequest('readwrite', store => store.delete(clientRequestId));
    },
    async clear() {
      await runRequest('readwrite', store => store.clear());
    },
    async recoverInterrupted() {
      const records = await runRequest('readonly', store => store.getAll());
      const interrupted = (Array.isArray(records) ? records : [])
        .filter(record => record?.state === 'sending' || record?.state === 'queued');
      for (const record of interrupted) {
        const wasQueued = record.state === 'queued';
        await runRequest('readwrite', store => store.put({
          ...record,
          state: 'needs_reconcile',
          lastError: {
            code: wasQueued ? 'queued_state_unverified' : 'client_restart',
            message: wasQueued
              ? 'The previous queued receipt could not be verified after restart'
              : 'The previous send attempt was interrupted',
            resultUnknown: true,
          },
        }));
      }
      return interrupted.length;
    },
    close() {
      openedDb?.close();
      openedDb = null;
      dbPromise = null;
    },
  };
}
