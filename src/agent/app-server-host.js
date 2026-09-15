import { AppServerTransport } from './app-server-transport.js';

// thread 状态缓存只用来给 thread:list 补最新状态，丢掉冷门 thread 的旧状态没有影响。
// 不设上限的话，每个被 app-server 报过状态的 thread 都会留一条，跑几天单调增长。
const MAX_THREAD_STATUSES = 512;

const TARGETED_SERVER_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'applyPatchApproval',
  'execCommandApproval',
]);

export class AppServerHost {
  constructor({
    codexBin = 'codex',
    cwd,
    registry,
    spawnImpl,
    experimentalApi = false,
    onUnrouted = () => {},
    onThreadStatus = () => {},
  } = {}) {
    if (!registry) throw new Error('AppServerHost requires a ThreadRegistry');
    this.registry = registry;
    this.experimentalApi = experimentalApi === true;
    this.onUnrouted = onUnrouted;
    this.onThreadStatus = onThreadStatus;
    this.runtimes = new Set();
    this.inboundOwners = new WeakMap();
    this.correlationOwners = new Map();
    this.channelOwners = new Map();
    this.threadStatuses = new Map();
    this.threadStatusRevision = 0;
    this.initialized = null;
    this.disposed = false;

    this.transport = new AppServerTransport({
      codexBin,
      cwd,
      ...(spawnImpl ? { spawnImpl } : {}),
      onMessage: frame => this.handleMessage(frame),
      onFrame: event => this.handleObservedFrame(event),
      onExit: detail => this.handleExit(detail),
      onError: error => this.handleError(error),
    });
  }

  get child() {
    return this.transport.child;
  }

  attach(runtime) {
    if (!runtime || this.disposed) throw new Error('cannot attach runtime to disposed host');
    // 已 dispose 的 runtime 不再接回来。ensureInitialized 的 await 解开后会走
    // notify() → attach()，把一个刚被回收的 runtime 重新塞进 runtimes，而 detach
    // 只由 dispose 调用、不会再发生第二次，于是永久泄漏。
    if (runtime.disposed === true) return runtime;
    this.runtimes.add(runtime);
    return runtime;
  }

  rejectPending(runtime, error) {
    this.transport.rejectPendingFor(runtime, error);
  }

  detach(runtime) {
    for (const [key, owner] of this.correlationOwners) {
      if (owner === runtime) this.correlationOwners.delete(key);
    }
    for (const [key, owner] of this.channelOwners) {
      if (owner === runtime) this.channelOwners.delete(key);
    }
    return this.runtimes.delete(runtime);
  }

  start() {
    return this.transport.start();
  }

  ensureInitialized(runtime) {
    this.attach(runtime);
    if (this.initialized) return this.initialized;
    const pending = (async () => {
      await this.request(runtime, 'initialize', {
        clientInfo: { name: 'codex-chat-mobile', title: 'Codex Chat Mobile', version: '0.1.0' },
        capabilities: {
          experimentalApi: this.experimentalApi,
          requestAttestation: false,
        },
      });
      this.notify(runtime, 'initialized', {});
    })();
    const singleFlight = pending.catch(error => {
      if (this.initialized === singleFlight) this.initialized = null;
      throw error;
    });
    this.initialized = singleFlight;
    return singleFlight;
  }

  request(runtime, method, params, options) {
    this.attach(runtime);
    const processId = params?.processId ?? params?.processHandle;
    if (typeof processId === 'string' && processId) {
      const key = `process:${processId}`;
      const owner = this.correlationOwners.get(key);
      if (owner && owner !== runtime) {
        const error = new Error(`processId is already owned by another runtime: ${processId}`);
        error.code = 'process_id_conflict';
        return Promise.reject(error);
      }
      this.correlationOwners.set(key, runtime);
    }
    this.start();
    return this.transport.request(method, params, {
      ...(options || {}),
      context: { runtime },
    });
  }

  notify(runtime, method, params) {
    this.attach(runtime);
    this.start();
    return this.transport.notify(method, params, { context: { runtime } });
  }

  respond(runtime, id, result) {
    if (!this.child) return false;
    return this.transport.respond(id, result, { context: { runtime } });
  }

  respondError(runtime, id, code, message) {
    if (!this.child) return false;
    return this.transport.respondError(id, code, message, { context: { runtime } });
  }

  handleObservedFrame(event) {
    let runtime = null;
    if (event.direction === 'outbound' || isResponse(event.frame)) {
      runtime = event.context?.runtime ?? null;
      if (runtime && event.direction === 'inbound') {
        this.bindResponseOwner(runtime, event.method, event.frame?.result);
      }
      if (runtime && event.direction === 'outbound' && event.frame?.method?.startsWith('account/')) {
        this.channelOwners.set('account', runtime);
      }
      if (runtime && event.direction === 'outbound' && event.frame?.method === 'experimentalFeature/list') {
        this.channelOwners.set('experimental', runtime);
      }
      const outboundThreadId = event.direction === 'outbound' ? event.frame?.params?.threadId : null;
      if (runtime && typeof outboundThreadId === 'string' && outboundThreadId) {
        this.correlationOwners.set(`thread:${outboundThreadId}`, runtime);
      }
      const outboundProcessId = event.direction === 'outbound'
        ? event.frame?.params?.processId ?? event.frame?.params?.processHandle
        : null;
      if (runtime && typeof outboundProcessId === 'string' && outboundProcessId) {
        this.correlationOwners.set(`process:${outboundProcessId}`, runtime);
      }
      const loginId = event.frame?.result?.loginId;
      if (runtime && typeof loginId === 'string' && loginId) {
        this.correlationOwners.set(`login:${loginId}`, runtime);
      }
    } else {
      runtime = this.resolveInboundOwner(event.frame);
      if (runtime) this.inboundOwners.set(event.frame, runtime);
    }

    if (runtime) runtime.observeTransportFrame?.(event);
    else if (event.direction === 'inbound' && !isThreadStatusFrame(event.frame)) {
      this.reportUnrouted(event.frame);
    }
  }

  bindResponseOwner(runtime, method, result) {
    if (method === 'thread/start' || method === 'thread/resume') {
      const threadId = result?.thread?.id ?? result?.threadId;
      if (typeof threadId === 'string' && threadId) {
        this.registry.bind(runtime, { threadId });
      }
    }
    if (method === 'turn/start' || method === 'turn/steer') {
      const turnId = result?.turn?.id ?? result?.turnId;
      if (typeof turnId === 'string' && turnId) {
        this.registry.bind(runtime, { turnId });
      }
    }
  }

  handleMessage(frame) {
    const threadStatus = isThreadStatusFrame(frame) ? this.publishThreadStatus(frame) : null;
    const runtime = this.inboundOwners.get(frame) ?? this.resolveInboundOwner(frame);
    this.inboundOwners.delete(frame);
    if (!runtime) {
      if (threadStatus) return;
      this.reportUnrouted(frame);
      if (frame?.method && frame?.id !== undefined) {
        const targeted = TARGETED_SERVER_REQUESTS.has(frame.method);
        this.transport.respondError(
          frame.id,
          targeted ? -32602 : -32601,
          targeted
            ? `No runtime owns server request: ${frame.method}`
            : `Unsupported server request: ${frame.method}`,
        );
      }
      return;
    }
    runtime.handleFrame?.(frame, { observed: true });
    if (frame?.method === 'process/exited') {
      const processId = frame?.params?.processId ?? frame?.params?.processHandle;
      const key = typeof processId === 'string' && processId ? `process:${processId}` : null;
      if (key && this.correlationOwners.get(key) === runtime) this.correlationOwners.delete(key);
    }
  }

  resolveInboundOwner(frame) {
    const params = frame?.params || {};
    const threadId = params.threadId ?? params.thread?.id ?? params.conversationId;
    const turnId = params.turnId ?? params.turn?.id;
    if (frame?.method === 'thread/status/changed') {
      if (typeof threadId !== 'string' || !threadId) return null;
      try {
        return this.registry.resolve({ threadId });
      } catch {
        return null;
      }
    }
    if (typeof params.loginId === 'string' && params.loginId) {
      const owner = this.correlationOwners.get(`login:${params.loginId}`);
      if (owner) return owner;
    }
    if (frame?.method?.startsWith('account/')) {
      const owner = this.channelOwners.get('account');
      if (owner) return owner;
    }
    if (frame?.method?.startsWith('remoteControl/')) {
      const owner = this.channelOwners.get('experimental');
      if (owner) return owner;
    }
    const processId = params.processId ?? params.processHandle;
    if (typeof processId === 'string' && processId) {
      const owner = this.correlationOwners.get(`process:${processId}`);
      if (owner) return owner;
    }
    if (typeof threadId === 'string' && threadId) {
      let threadOwner;
      try {
        threadOwner = this.registry.resolve({ threadId });
      } catch {
        const operationOwner = this.correlationOwners.get(`thread:${threadId}`);
        if (operationOwner) return operationOwner;
        return frame?.method?.startsWith('thread/realtime/')
          ? this.channelOwners.get('experimental') ?? null
          : null;
      }

      if (typeof turnId !== 'string' || !turnId) return threadOwner;
      try {
        return this.registry.resolve({ threadId, turnId });
      } catch {
        if (frame?.method === 'thread/compacted') return threadOwner;
        if (threadOwner.currentTurnId === turnId) return threadOwner;
        if (frame?.method === 'turn/started' || TARGETED_SERVER_REQUESTS.has(frame?.method)) {
          if (!threadOwner.currentTurnId || threadOwner.currentTurnId === turnId) {
            this.registry.bind(threadOwner, { turnId });
            return threadOwner;
          }
        }
        return null;
      }
    }

    if (typeof turnId === 'string' && turnId) {
      try {
        return this.registry.resolve({ turnId });
      } catch {
        return null;
      }
    }
    return null;
  }

  publishThreadStatus(frame) {
    const threadId = frame?.params?.threadId;
    const status = frame?.params?.status;
    if (typeof threadId !== 'string' || !threadId || !status || typeof status !== 'object') {
      return null;
    }
    const change = {
      threadId,
      status: structuredClone(status),
      revision: ++this.threadStatusRevision,
    };
    // 先删再插：Map 保持插入顺序，这样淘汰的是最久没更新的那个，而不是最早见到的。
    this.threadStatuses.delete(threadId);
    this.threadStatuses.set(threadId, change);
    while (this.threadStatuses.size > MAX_THREAD_STATUSES) {
      this.threadStatuses.delete(this.threadStatuses.keys().next().value);
    }
    try {
      this.onThreadStatus(structuredClone(change));
    } catch {
      // Host-level activity observers must not break JSON-RPC routing.
    }
    return change;
  }

  latestThreadStatus(threadId) {
    const change = this.threadStatuses.get(threadId);
    return change ? structuredClone(change) : null;
  }

  reportUnrouted(frame) {
    try {
      this.onUnrouted({
        method: frame?.method ?? null,
        id: frame?.id ?? null,
        threadId: frame?.params?.threadId ?? frame?.params?.conversationId ?? null,
        turnId: frame?.params?.turnId ?? null,
      });
    } catch {
      // Routing diagnostics must not break the shared transport.
    }
  }

  handleExit(detail) {
    this.initialized = null;
    this.correlationOwners.clear();
    this.channelOwners.clear();
    this.threadStatuses.clear();
    for (const runtime of this.runtimes) runtime.handleTransportExit?.(detail);
  }

  handleError(error) {
    if (this.transport.child) return;
    this.initialized = null;
    this.correlationOwners.clear();
    this.channelOwners.clear();
    this.threadStatuses.clear();
    for (const runtime of this.runtimes) runtime.handleTransportError?.(error);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.initialized = null;
    this.correlationOwners.clear();
    this.channelOwners.clear();
    this.threadStatuses.clear();
    this.threadStatusRevision = 0;
    this.transport.dispose();
    this.runtimes.clear();
  }
}

function isResponse(frame) {
  return frame?.id !== undefined
    && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'));
}

function isThreadStatusFrame(frame) {
  return frame?.method === 'thread/status/changed';
}
