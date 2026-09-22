const THREAD_POINTERS_KEY = 'codex_current_thread_by_cwd';
const LEGACY_POINTER_KEY = 'codex_current_session_id';

export function getCurrentThread(storage, cwd) {
  if (!storage || typeof cwd !== 'string' || !cwd) return null;
  const pointers = readPointers(storage);
  const current = pointers[cwd];
  if (typeof current === 'string' && current) return current;

  const legacy = safeGet(storage, LEGACY_POINTER_KEY);
  if (typeof legacy !== 'string' || !legacy) return null;
  pointers[cwd] = legacy;
  writePointers(storage, pointers);
  safeRemove(storage, LEGACY_POINTER_KEY);
  return legacy;
}

export function setCurrentThread(storage, cwd, threadId) {
  if (!storage || typeof cwd !== 'string' || !cwd) return false;
  if (typeof threadId !== 'string' || !threadId) return clearCurrentThread(storage, cwd);
  const pointers = readPointers(storage);
  pointers[cwd] = threadId;
  return writePointers(storage, pointers);
}

export function clearCurrentThread(storage, cwd, expectedThreadId) {
  if (!storage || typeof cwd !== 'string' || !cwd) return false;
  const pointers = readPointers(storage);
  if (expectedThreadId && pointers[cwd] !== expectedThreadId) return false;
  if (!Object.hasOwn(pointers, cwd)) return true;
  delete pointers[cwd];
  return writePointers(storage, pointers);
}

function readPointers(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(THREAD_POINTERS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePointers(storage, pointers) {
  try {
    storage.setItem(THREAD_POINTERS_KEY, JSON.stringify(pointers));
    return true;
  } catch {
    return false;
  }
}

function safeGet(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function safeRemove(storage, key) {
  try { storage.removeItem(key); } catch { /* best effort */ }
}
