import { spawn } from 'node:child_process';

// codex 需要继承我们的环境（PATH、CODEX_HOME、上游配置都在里面），但测试框架的控制变量
// 不属于业务环境：NODE_TEST_CONTEXT 会让子进程里的 node:test 以为自己是测试子进程，
// NODE_OPTIONS 会把预加载脚本带进去。跑测试时才有，泄漏出去只会制造难查的怪事。
const CONTROL_ENV_KEYS = ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'NODE_CHANNEL_FD', 'NODE_OPTIONS'];

export function childEnv(source = process.env) {
  const env = { ...source };
  for (const key of CONTROL_ENV_KEYS) delete env[key];
  return env;
}
import { StringDecoder } from 'node:string_decoder';

export class AppServerTransport {
  constructor({
    codexBin = 'codex',
    cwd,
    spawnImpl = spawn,
    onMessage = () => {},
    onFrame = () => {},
    onStderr = () => {},
    onActivity = () => {},
    onExit = () => {},
    onError = () => {},
  } = {}) {
    this.codexBin = codexBin;
    this.cwd = cwd;
    this.spawnImpl = spawnImpl;
    this.onMessage = onMessage;
    this.onFrame = onFrame;
    this.onStderr = onStderr;
    this.onActivity = onActivity;
    this.onExit = onExit;
    this.onError = onError;

    this.child = null;
    this.disposed = false;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.nextRequestId = 0;
    this.pending = new Map();
  }

  start() {
    if (this.disposed) throw new Error('app-server transport is disposed');
    if (this.child) return this.child;

    let child;
    try {
      child = this.spawnImpl(this.codexBin, ['app-server'], {
        cwd: this.cwd,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.reportError(error);
      throw error;
    }

    if (!child?.stdin || !child?.stdout || typeof child.on !== 'function') {
      const error = new Error('spawnImpl returned an invalid app-server child');
      this.reportError(error);
      throw error;
    }

    this.child = child;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    child.stdout.on('data', chunk => this.handleStdout(child, chunk));
    child.stdout.on?.('error', error => this.handleChildError(child, error));
    child.stdin.on?.('error', error => this.handleChildError(child, error));
    child.stderr?.on?.('data', chunk => this.handleStderr(child, chunk));
    child.stderr?.on?.('error', error => this.reportError(error));
    child.on('error', error => this.handleChildError(child, error));
    child.on('close', (code, signal) => this.handleChildExit(child, code, signal));
    return child;
  }

  send(frame, { context } = {}) {
    if (this.disposed) throw new Error('app-server transport is disposed');
    if (!this.child) throw new Error('app-server transport is not started');
    const accepted = this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    const event = {
      direction: 'outbound',
      method: frame?.method ?? null,
      frame,
    };
    if (context !== undefined) event.context = context;
    this.observeFrame(event);
    return accepted;
  }

  request(method, params, { timeoutMs = 0, context } = {}) {
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (Number(timeoutMs) > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${Number(timeoutMs)}ms`));
        }, Number(timeoutMs));
        timer.unref?.();
      }

      this.pending.set(id, { method, resolve, reject, timer, context });
      try {
        this.send({ method, id, params }, { context });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params, { context } = {}) {
    return this.send({ method, params }, { context });
  }

  respond(id, result, { context } = {}) {
    return this.send({ id, result }, { context });
  }

  respondError(id, code, message, { context } = {}) {
    return this.send({ id, error: { code, message } }, { context });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.rejectPending(new Error('app-server transport disposed'));
    if (child) {
      try {
        child.kill?.('SIGTERM');
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  handleStdout(child, chunk) {
    if (child !== this.child || this.disposed) return;
    try {
      this.onActivity();
    } catch (error) {
      this.reportError(error);
    }
    this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.stdoutDecoder.write(chunk);
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  handleStderr(child, chunk) {
    if (child !== this.child || this.disposed) return;
    try {
      this.onStderr(chunk);
    } catch (error) {
      this.reportError(error);
    }
  }

  handleLine(line) {
    if (!line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line.trim());
    } catch (cause) {
      const error = new Error('Invalid JSON from codex app-server', { cause });
      this.reportError(error);
      return;
    }

    const pending = isResponse(frame) ? this.pending.get(frame.id) : null;
    const event = {
      direction: 'inbound',
      method: pending?.method ?? frame?.method ?? null,
      frame,
    };
    if (pending?.context !== undefined) event.context = pending.context;
    this.observeFrame(event);

    if (isResponse(frame)) {
      if (pending) {
        this.pending.delete(frame.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (Object.hasOwn(frame, 'error')) pending.reject(rpcError(frame.error));
        else pending.resolve(frame.result);
        return;
      }
    }

    try {
      this.onMessage(frame);
    } catch (error) {
      this.reportError(error);
    }
  }

  handleChildError(child, error) {
    if (child !== this.child || this.disposed) return;
    this.child = null;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.rejectPending(error);
    this.reportError(error);
  }

  handleChildExit(child, code, signal) {
    if (child !== this.child || this.disposed) return;
    this.stdoutBuffer += this.stdoutDecoder.end();
    if (this.stdoutBuffer.trim()) this.handleLine(this.stdoutBuffer);
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.child = null;
    this.rejectPending(new Error(
      `codex app-server exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`
    ));
    try {
      this.onExit({ code: code ?? null, signal: signal ?? null });
    } catch (error) {
      this.reportError(error);
    }
  }

  // 按 context 里的 runtime 定向拒绝。dispose 一个 runtime 时，它的在途请求会把
  // 自己留在 pending 里，条目的 context.runtime 是强引用——被回收的 runtime 连同
  // 它的事件缓冲一起留在内存里，调用方的 promise 也永不 settle。
  rejectPendingFor(runtime, error) {
    for (const [id, pending] of this.pending) {
      if (pending.context?.runtime !== runtime) continue;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  reportError(error) {
    try {
      this.onError(error);
    } catch {
      // Error reporting must not break the transport lifecycle.
    }
  }

  observeFrame(event) {
    try {
      this.onFrame(event);
    } catch (error) {
      this.reportError(error);
    }
  }
}

function isResponse(frame) {
  return frame && frame.id !== undefined
    && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'));
}

function rpcError(value) {
  const error = new Error(value?.message || 'JSON-RPC error');
  if (value?.code !== undefined) error.code = value.code;
  if (value?.data !== undefined) error.data = value.data;
  return error;
}
