// thread-registry.js -- fail-closed ownership index for live thread runtimes.

export class ThreadRegistry {
  #records = new Map();
  #instances = new Map();
  #threads = new Map();
  #turns = new Map();
  #requests = new Map();

  register(runtime, options = {}) {
    requireRuntime(runtime);
    const target = options ?? {};
    const instanceId = requiredStringId(target.instanceId, 'instanceId');
    const threadId = optionalStringId(target.threadId, 'threadId');
    const existing = this.#records.get(runtime);

    if (existing) {
      if (existing.instanceId !== instanceId) {
        throw staleTarget('runtime is already registered to another instance');
      }
      if (threadId !== undefined) this.bind(runtime, { threadId });
      return runtime;
    }

    assertAvailable(this.#instances, instanceId, runtime, 'instanceId');
    if (threadId !== undefined) {
      assertAvailable(this.#threads, threadId, runtime, 'threadId');
    }

    const record = {
      runtime,
      instanceId,
      threadId: threadId ?? null,
      turnId: null,
      requestIds: new Set(),
    };
    this.#records.set(runtime, record);
    this.#instances.set(instanceId, runtime);
    if (threadId !== undefined) this.#threads.set(threadId, runtime);
    return runtime;
  }

  bind(runtime, options = {}) {
    requireRuntime(runtime);
    const record = this.#records.get(runtime);
    if (!record) throw staleTarget('runtime is not registered');

    const target = options ?? {};
    const threadId = optionalStringId(target.threadId, 'threadId');
    const turnId = optionalStringId(target.turnId, 'turnId');
    const requestId = optionalRequestId(target.requestId);

    // Validate the full operation before changing any index.
    if (threadId !== undefined) {
      if (record.threadId !== null && record.threadId !== threadId) {
        throw staleTarget('runtime is already bound to another thread');
      }
      assertAvailable(this.#threads, threadId, runtime, 'threadId');
    }

    if (threadId !== undefined && record.threadId === null) {
      record.threadId = threadId;
      this.#threads.set(threadId, runtime);
    }
    if (turnId !== undefined && record.turnId !== turnId) {
      if (record.turnId !== null) deleteOwned(this.#turns, record.turnId, runtime);
      record.turnId = turnId;
      addOwner(this.#turns, turnId, runtime);
    }
    if (requestId !== undefined && !record.requestIds.has(requestId)) {
      record.requestIds.add(requestId);
      addOwner(this.#requests, requestId, runtime);
    }
    return runtime;
  }

  resolve(options = {}) {
    const target = options ?? {};
    const identifiers = [];
    const instanceId = optionalStringId(target.instanceId, 'instanceId');
    const threadId = optionalStringId(target.threadId, 'threadId');
    const turnId = optionalStringId(target.turnId, 'turnId');
    const requestId = optionalRequestId(target.requestId);

    if (instanceId !== undefined) identifiers.push([this.#instances, instanceId]);
    if (threadId !== undefined) identifiers.push([this.#threads, threadId]);
    if (turnId !== undefined) identifiers.push([this.#turns, turnId]);
    if (requestId !== undefined) identifiers.push([this.#requests, requestId]);
    if (identifiers.length === 0) throw staleTarget('no target identifiers were provided');

    let candidates = null;
    for (const [index, id] of identifiers) {
      if (!index.has(id)) throw staleTarget('target identifier is unknown');
      const owners = ownersFor(index.get(id));
      candidates = candidates === null
        ? owners
        : new Set([...candidates].filter(owner => owners.has(owner)));
      if (candidates.size === 0) throw staleTarget('target identifiers have different owners');
    }
    if (candidates.size !== 1) throw staleTarget('target identifiers are ambiguous');
    return candidates.values().next().value;
  }

  clearTurn(runtime, expectedTurnId) {
    const record = this.#records.get(runtime);
    if (!record || record.turnId === null) return false;
    const expected = optionalStringId(expectedTurnId, 'turnId');
    if (expected !== undefined && record.turnId !== expected) return false;
    deleteOwned(this.#turns, record.turnId, runtime);
    record.turnId = null;
    return true;
  }

  releaseRequest(runtime, requestId) {
    const record = this.#records.get(runtime);
    const id = optionalRequestId(requestId);
    if (!record || id === undefined || !record.requestIds.has(id)) return false;
    deleteOwned(this.#requests, id, runtime);
    record.requestIds.delete(id);
    return true;
  }

  release(runtime) {
    const record = this.#records.get(runtime);
    if (!record) return false;

    deleteOwned(this.#instances, record.instanceId, runtime);
    if (record.threadId !== null) deleteOwned(this.#threads, record.threadId, runtime);
    if (record.turnId !== null) deleteOwned(this.#turns, record.turnId, runtime);
    for (const requestId of record.requestIds) {
      deleteOwned(this.#requests, requestId, runtime);
    }
    this.#records.delete(runtime);
    return true;
  }

  snapshot() {
    return [...this.#records.values()].map(record => ({
      runtime: record.runtime,
      instanceId: record.instanceId,
      threadId: record.threadId,
      turnId: record.turnId,
      requestIds: [...record.requestIds],
    }));
  }
}

function requireRuntime(runtime) {
  if (runtime === null || runtime === undefined) {
    throw staleTarget('runtime is required');
  }
}

function requiredStringId(value, name) {
  const id = optionalStringId(value, name);
  if (id === undefined) throw staleTarget(`${name} is required`);
  return id;
}

function optionalStringId(value, name) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw staleTarget(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalRequestId(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw staleTarget('requestId must be a non-empty string or finite number');
}

function assertAvailable(index, id, runtime, name) {
  if (index.has(id) && index.get(id) !== runtime) {
    throw staleTarget(`${name} already has another owner`);
  }
}

function deleteOwned(index, id, runtime) {
  const value = index.get(id);
  if (value instanceof Set) {
    value.delete(runtime);
    if (value.size === 0) index.delete(id);
  } else if (value === runtime) {
    index.delete(id);
  }
}

function addOwner(index, id, runtime) {
  const owners = index.get(id);
  if (owners instanceof Set) owners.add(runtime);
  else if (owners === undefined) index.set(id, new Set([runtime]));
  else index.set(id, new Set([owners, runtime]));
}

function ownersFor(value) {
  return value instanceof Set ? new Set(value) : new Set([value]);
}

function staleTarget(message) {
  const error = new Error(message);
  error.code = 'stale_target';
  return error;
}
