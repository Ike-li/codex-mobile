// agent-appserver.js —— 单 thread 语义 runtime（app-server 是唯一后端）。
// 生产环境由 AppServerHost/AppServerTransport 共享一个 stdio JSON-RPC 子进程；
// 本类负责 start/resume/turn、队列、中断、事件映射和审批。
import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppServerTransport } from './app-server-transport.js';
import { ApprovalBroker } from './approval-broker.js';
import { fixPermissions } from './file-security.js';
import { sanitize } from './sanitizer.js';
import { buildUserInputs } from './user-inputs.js';
import { truncate, truncatePayload } from './text-utils.js';
import { buildRpcLogEntry, isDeltaNotification } from './rpc-log-redaction.js';
// 配置读取走同一份 schema。此前这里有第二份实现（numberFromEnv），与 server.js 那 8 段
// 手写归一各判各的；两个枚举则完全没有校验，写错拼写会原样透传给 app-server。
import { configValue } from './src/ops/config.js';
import {
  buildTurnStartOverrides,
  collaborationModeFromThreadSettings,
  collaborationModePayload,
  isUnsupportedCollaborationModeError,
  normalizeCollaborationMode,
  sanitizeTurnOverrides,
  PERMISSION_PRESETS,
} from './public/js/cli-settings.js';

// 六个可配置项的默认值已移进 src/ops/codex-schema.js —— 那里是它们的唯一事实源。
// 留一份在这里的代价不是重复，是**漂移**：改了一边不改另一边不会有任何东西变红。
const TOOL_SUMMARY_CAP = 600;
const MAX_BACKPRESSURE_DELAY_MS = 5000;
const LEGACY_APPROVAL_METHODS = new Set(['applyPatchApproval', 'execCommandApproval']);

function inputPartEventMeta(parts) {
  return (Array.isArray(parts) ? parts : []).map(part => {
    if (part?.kind === 'mention' || part?.kind === 'skill') {
      return { kind: part.kind, name: part.name || '' };
    }
    if (part?.kind === 'imageUrl') return { kind: 'imageUrl' };
    return null;
  }).filter(Boolean);
}

let instanceCounter = 0;
function nextEpoch() {
  return `${Date.now()}.${++instanceCounter}`;
}

export class ThreadRuntime {
  constructor({ instanceId, resumeId, cwd, codexBin, idleTimeoutMs, onEvent, onSessionId, onExit, rpcLogPath, rpcLogMaxBytes, approvalAuditPath, experimentalApi = false, transportFactory, host }) {
    this.instanceId = instanceId;
    this.cwd = cwd;
    this.codexBin = codexBin || 'codex';
    this.idleTimeoutMs = idleTimeoutMs || 600000;
    this.onEvent = onEvent;
    this.onSessionId = onSessionId;
    this.onExit = onExit;

    this.sessionId = resumeId || null; // = threadId
    this.epoch = nextEpoch();
    this.seq = 0;
    this.buffer = [];
    this.bufferTrimmed = false;
    this.bufferCap = configValue('CODEX_EVENT_BUFFER_CAP');
    this.firstMessage = null;

    this.child = null;
    this.host = host || null;
    this.transport = null;
    this.transportFactory = transportFactory || (options => new AppServerTransport(options));
    this.busy = false;
    this.turnEpoch = 0;
    this.disposed = false;
    this.lastActivity = Date.now();
    this.idleTimer = null;

    this.rpcId = 0;
    this.pending = new Map(); // id -> { resolve, reject }
    // 观测日志默认开启（既有契约，protocol-adaptation 的 R1.2 断言该文件存在）；
    // CODEX_RPC_LOG=0 可以整体关掉。
    this.rpcLogPath = process.env.CODEX_RPC_LOG === '0'
      ? null
      : (rpcLogPath || join(this.cwd, '.codex-chat-rpc.jsonl'));
    this.rpcLogMaxBytes = Number.isInteger(rpcLogMaxBytes) && rpcLogMaxBytes > 0
      ? rpcLogMaxBytes
      : configValue('CODEX_RPC_LOG_MAX_BYTES');
    this.rpcLogReady = false;
    this.rpcStats = {
      clientRequests: 0,
      clientResponses: 0,
      clientNotifications: 0,
      serverRequests: 0,
      serverResponses: 0,
      serverNotifications: 0,
      errors: 0,
    };
    this.initialized = null;  // initialize + initialized notification
    this.ready = null;        // initialize + thread 就绪的 promise（只做一次）
    this.stdoutBuf = '';
    this.backpressureRetries = new Set();
    this.pendingApprovals = new Set(); // 等待手机 decision 的 server→client 请求 id
    this.approvalBroker = new ApprovalBroker({
      emit: (type, payload) => this.emit(type, payload),
      respond: (approvalId, result) => this.respond(approvalId, result),
      pendingApprovals: this.pendingApprovals,
      // 落点由调用方注入。默认写在工作区只是没有更好选择时的退路——审计是「手机丢了它
      // 被用来干过什么」的唯一答案，而用户仓库里的文件随时会被 git clean 抹掉。
      auditPath: approvalAuditPath || join(this.cwd, '.codex-chat-approval-audit.jsonl'),
    });
    this.inputQueue = [];
    this.inputQueueLimit = configValue('CODEX_INPUT_QUEUE_LIMIT');
    this.interruptTimeoutMs = configValue('CODEX_INTERRUPT_TIMEOUT_MS');
    this.currentTurnId = null;
    this.threadStatus = null;
    this.lastErrorMessage = null;
    this.drainScheduled = false;
    this.experimentalApi = experimentalApi === true;
    // 审批/沙箱（仅 app-server 后端）：默认 on-request + workspace-write，可经环境变量覆盖。
    this.approvalPolicy = configValue('CODEX_APPROVAL_POLICY');
    this.sandbox = configValue('CODEX_SANDBOX');
    this.approvalsReviewer = 'user';
    this.resolvedHostPolicy = null;
    this.turnOverrides = {};
  }

  applyTurnOverrides(turn) {
    const clean = sanitizeTurnOverrides(turn);
    if (!Object.keys(clean).length) return clean;
    if (clean.permission) {
      for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'permission']) delete this.turnOverrides[key];
      this.resolvedHostPolicy = null;
    } else if (clean.approvalPolicy || clean.approvalsReviewer || clean.sandbox) {
      delete this.turnOverrides.permission;
      this.resolvedHostPolicy = null;
    }
    this.turnOverrides = { ...this.turnOverrides, ...clean };
    if (clean.approvalPolicy) this.approvalPolicy = clean.approvalPolicy;
    if (clean.sandbox) this.sandbox = clean.sandbox;
    if (clean.approvalsReviewer) this.approvalsReviewer = clean.approvalsReviewer;
    return clean;
  }

  async resolveHostPermissions() {
    if (this.turnOverrides.permission?.mode !== 'host') return;
    await this.ensureInitialized();
    const response = await this.request('config/read', { cwd: this.cwd, includeLayers: false });
    const config = response?.config;
    const clean = sanitizeTurnOverrides({ approvalPolicy: config?.approval_policy,
      approvalsReviewer: config?.approvals_reviewer || 'user', sandbox: config?.sandbox_mode });
    if (!clean.approvalPolicy || !clean.sandbox || !clean.approvalsReviewer) throw new Error('无法解析主机权限配置，请选择明确的权限模式');
    const wire = buildTurnStartOverrides(clean);
    const workspace = config?.sandbox_workspace_write;
    if (clean.sandbox === 'workspace-write' && workspace) {
      wire.sandboxPolicy = { ...wire.sandboxPolicy,
        writableRoots: Array.isArray(workspace.writable_roots) ? workspace.writable_roots : [],
        networkAccess: workspace.network_access === true,
        excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var === true,
        excludeSlashTmp: workspace.exclude_slash_tmp === true };
    }
    this.resolvedHostPolicy = wire;
    this.approvalPolicy = clean.approvalPolicy;
    this.approvalsReviewer = clean.approvalsReviewer;
    this.sandbox = clean.sandbox;
  }

  async readSessionSettings() {
    await this.ensureInitialized();
    const results = await Promise.allSettled([
      this.request('configRequirements/read', undefined),
      this.request('config/read', { cwd: this.cwd, includeLayers: false }),
    ]);
    const requirementsKnown = results[0].status === 'fulfilled'
      && Object.hasOwn(results[0].value || {}, 'requirements');
    const requirements = requirementsKnown ? results[0].value.requirements : null;
    const config = results[1].status === 'fulfilled' ? results[1].value?.config : null;
    const profilesOnly = Boolean(requirements?.allowedPermissionProfiles);
    const allowed = preset => (!requirements?.allowedSandboxModes
      || requirements.allowedSandboxModes.includes(preset.sandbox))
      && (!requirements?.allowedApprovalPolicies
        || requirements.allowedApprovalPolicies.some(p => JSON.stringify(p) === JSON.stringify(preset.approvalPolicy)));
    const modes = Object.entries(PERMISSION_PRESETS).map(([id, preset]) => ({
      id, enabled: requirementsKnown && !profilesOnly && allowed(preset),
      reason: !requirementsKnown ? '无法读取主机权限限制' : profilesOnly ? '主机要求使用指定权限配置' : allowed(preset) ? '' : '主机策略不允许此模式',
    }));
    const hostKnown = Boolean(config?.approval_policy && config?.sandbox_mode);
    const hostAllowed = hostKnown && allowed({ approvalPolicy: config.approval_policy, sandbox: config.sandbox_mode });
    modes.push({ id: 'host', enabled: requirementsKnown && hostAllowed && !profilesOnly,
      reason: !requirementsKnown ? '无法读取主机权限限制' : !hostKnown ? '无法解析主机默认权限' : profilesOnly ? '暂不支持主机命名权限配置' : !hostAllowed ? '主机策略不允许此默认配置' : '' });
    modes.push({ id: 'custom', enabled: requirementsKnown && !profilesOnly,
      reason: profilesOnly ? '主机要求使用指定权限配置' : !requirementsKnown ? '无法读取主机权限限制' : '' });
    return {
      effective: this.effectivePermissions || null,
      available: { permissionModes: modes, collaborationModes: ['default'] },
      restrictions: requirements ? {
        allowedApprovalPolicies: requirements.allowedApprovalPolicies,
        allowedSandboxModes: requirements.allowedSandboxModes,
      } : null,
    };
  }

  rememberEffectivePermissions(response) {
    if (!response?.approvalPolicy || !response?.sandbox) return;
    this.effectivePermissions = {
      approvalPolicy: response.approvalPolicy,
      approvalsReviewer: response.approvalsReviewer || 'user',
      sandboxPolicy: response.sandbox,
      source: this.turnOverrides.permission?.mode === 'host' ? 'host' : 'session',
    };
  }

  // ---- 子进程与 JSON-RPC 底层 ----
  spawnIfNeeded() {
    if (this.child) return;
    if (this.host) {
      this.host.attach(this);
      this.child = this.host.start();
      this.startIdleWatchdog();
      return;
    }
    if (!this.transport) {
      this.transport = this.transportFactory({
        codexBin: this.codexBin,
        cwd: this.cwd,
        onMessage: message => {
          this.lastActivity = Date.now();
          this.handleFrame(message, { observed: true });
        },
        onFrame: event => this.observeTransportFrame(event),
        onStderr: chunk => {
          if (process.env.LOG_STDERR) console.error('[codex]', sanitize(chunk.toString()));
        },
        onActivity: () => {
          this.lastActivity = Date.now();
        },
        onExit: () => this.handleTransportExit(),
        onError: error => {
          if (!this.transport?.child) this.handleTransportError(error);
        },
      });
    }
    this.child = this.transport.start();
    this.startIdleWatchdog();
  }

  // 先 clear 再 set：spawnIfNeeded 会在每次 child 变 null 后重新进入，重复 setInterval
  // 会让旧 handle 失联。unref 是因为它是维护定时器，不该把进程吊住。
  startIdleWatchdog() {
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => this.checkIdle(), 30_000);
    this.idleTimer.unref?.();
  }

  handleTransportExit() {
    this.busy = false;
    this.currentTurnId = null;
    this.child = null;
    this.initialized = null;
    this.ready = null;
    this.clearQueue('process_exit');
    this.approvalBroker.clearPending();
    this.clearBackpressureRetries(new Error('app-server 进程已退出'));
    this.rejectAllPending(new Error('app-server 进程已退出'));
    clearInterval(this.idleTimer); this.idleTimer = null;
    if (!this.disposed) this.emitStatus('process_exit');
    if (!this.disposed) this.onExit?.();
  }

  handleTransportError(err) {
    // 留一份最近的错误给健康诊断：分层判定要能说出「codex 报了什么」，而不是笼统的离线。
    this.lastErrorMessage = err?.message ? String(err.message).slice(0, 200) : null;
    this.busy = false;
    this.currentTurnId = null;
    this.child = null;
    this.initialized = null;
    this.ready = null;
    this.clearQueue('process_error');
    this.clearBackpressureRetries(err);
    this.rejectAllPending(err);
    clearInterval(this.idleTimer); this.idleTimer = null;
    this.emit('error', { message: `codex app-server 启动失败：${sanitize(err.message)}`, recoverable: false });
    this.emitStatus('process_error');
  }

  rejectAllPending(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  clearBackpressureRetries(err) {
    for (const retry of this.backpressureRetries) {
      clearTimeout(retry.timer);
      retry.reject(err);
    }
    this.backpressureRetries.clear();
  }

  onStdout(d) {
    this.lastActivity = Date.now();
    this.stdoutBuf += d.toString();
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop();
    for (const line of lines) {
      if (line.trim()) this.handleLine(line.trim());
    }
  }

  handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    this.handleFrame(msg);
  }

  handleFrame(msg, { observed = false } = {}) {
    // server→client 请求：有 method 且有 id（无 result/error）→ 必须回应，否则 agent 挂起。
    if (msg.method && msg.id !== undefined) {
      if (!observed) this.observeRpc('server_request', { direction: 'inbound', id: msg.id, method: msg.method, params: msg.params || {} });
      this.handleServerRequest(msg.id, msg.method, msg.params || {});
      return;
    }
    // 对我方请求的响应：有 id + result/error。
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (!observed) {
          this.observeRpc('response', {
            direction: 'inbound',
            id: msg.id,
            method: p.method || null,
            result: msg.result,
            error: msg.error,
          });
        }
        if (msg.error) p.reject(rpcError(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }
    // 通知。
    if (msg.method) {
      if (!observed) this.observeRpc('notification', { direction: 'inbound', method: msg.method, params: msg.params || {} });
      this.handleNotification(msg.method, msg.params || {});
    }
  }

  observeTransportFrame({ direction, method, frame }) {
    // 每一帧都算活动。host 模式下 AppServerHost 构造 transport 时没传 onActivity，
    // 所以此前只有通知流会推进 lastActivity——RPC 往返（thread/resume、command/exec）
    // 和 inbound 审批请求都不算，而 checkIdle 与 isReclaimable 都建立在这个信号上。
    this.lastActivity = Date.now();
    // review/start 和 turn/start 一样开一个 turn。必须在**观察到响应**这一刻就登记，
    // 不能等 request() 的 await 返回：mock 与真实 app-server 都可能把响应和该 turn 的
    // 第一条通知放进同一个 stdout chunk，而 host 给带 turnId 的通知找 owner 时会回落到
    // currentTurnId 比对——晚一个 microtask，第一条通知就被判成无主帧丢掉，
    // 表现是审查结果稳定少掉第一个字符。
    if (direction === 'inbound' && (method === 'turn/start' || method === 'turn/steer' || method === 'review/start')) {
      this.recordCurrentTurn(frame?.result);
    }
    const details = {
      direction,
      id: frame?.id,
      method: method || frame?.method || null,
      params: frame?.params,
      result: frame?.result,
      error: frame?.error,
    };
    if (frame?.method && frame?.id !== undefined && direction === 'inbound') {
      this.observeRpc('server_request', details);
    } else if (frame?.method && frame?.id !== undefined) {
      this.observeRpc('request', details);
    } else if (frame?.method) {
      this.observeRpc('notification', details);
    } else if (frame?.id !== undefined) {
      this.observeRpc('response', details);
    }
  }

  // server→client 请求处理。审批类透传给手机；其余安全兜底回应，避免 agent 挂起。
  handleServerRequest(rpcId, method, params) {
    this.lastActivity = Date.now();
    const requestParams = normalizeServerRequestParams(this, rpcId, method, params);
    if (!this.currentTurnId && typeof requestParams?.turnId === 'string' && requestParams.turnId) {
      this.currentTurnId = requestParams.turnId;
    }
    if (this.approvalBroker.handleRequest(rpcId, method, requestParams)) {
      this.emitStatus('approval_requested');
    } else if (method === 'account/chatgptAuthTokens/refresh') {
      this.respondError(rpcId, -32601, `Unsupported server request: ${method}`);
      this.emit('system', {
        message: `ChatGPT auth token refresh is not supported by this bridge; no credentials were stored or forwarded: ${method}`,
        isError: true
      });
    } else {
      this.respondError(rpcId, -32601, `Unsupported server request: ${method}`);
      this.emit('system', {
        message: `Unsupported server request from Codex app-server: ${method}`,
        isError: true
      });
    }
  }

  respond(rpcId, result) {
    if (!this.child) return;
    if (this.host) return this.host.respond(this, rpcId, result);
    if (this.transport) return this.transport.respond(rpcId, result);
    this.observeRpc('response', { direction: 'outbound', id: rpcId, result });
    this.child.stdin.write(JSON.stringify({ id: rpcId, result }) + '\n');
  }

  respondError(rpcId, code, message) {
    if (!this.child) return;
    if (this.host) return this.host.respondError(this, rpcId, code, message);
    if (this.transport) return this.transport.respondError(rpcId, code, message);
    this.observeRpc('response', { direction: 'outbound', id: rpcId, error: { code, message } });
    this.child.stdin.write(JSON.stringify({ id: rpcId, error: { code, message } }) + '\n');
  }

  // 手机回传 decision（accept|acceptForSession|decline|cancel）。
  respondApproval(approvalId, decision, extra) {
    const ok = this.approvalBroker.respondApproval(approvalId, decision, extra);
    if (ok) this.emitStatus('approval_resolved');
    return ok;
  }

  request(method, params, options = {}) {
    const maxBackpressureRetries = integerOption(
      options.maxBackpressureRetries,
      configValue('CODEX_BACKPRESSURE_RETRIES'),
      { allowZero: true }
    );
    const backpressureBaseMs = integerOption(
      options.backpressureBaseMs,
      configValue('CODEX_BACKPRESSURE_BASE_MS')
    );
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = fn => value => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const resolveOnce = finish(resolve);
      const rejectOnce = finish(reject);

      const handleAttemptError = (err, attempt) => {
        if (isBackpressureError(err) && attempt < maxBackpressureRetries) {
          const delayMs = backpressureDelayMs(attempt, backpressureBaseMs);
          this.emit('system', {
            message: `Codex app-server 拥塞，${delayMs}ms 后重试 ${method}（${attempt + 1}/${maxBackpressureRetries}）`,
            isError: false,
            code: -32001,
            method,
            retryAfterMs: delayMs,
            attempt: attempt + 1,
            maxRetries: maxBackpressureRetries,
          });
          this.emitStatus('backpressure_retry');
          const retry = {
            timer: null,
            reject: rejectOnce,
          };
          retry.timer = setTimeout(() => {
            this.backpressureRetries.delete(retry);
            sendAttempt(attempt + 1);
          }, delayMs);
          this.backpressureRetries.add(retry);
          return;
        }
        if (isBackpressureError(err)) {
          this.emit('system', {
            message: `Codex app-server 仍然拥塞，超过重试上限（${maxBackpressureRetries}）`,
            isError: true,
            code: -32001,
            method,
          });
          this.emitStatus('backpressure_failed');
        }
        rejectOnce(err);
      };

      const sendAttempt = attempt => {
        if (settled) return;
        if (this.disposed) {
          rejectOnce(new Error('disposed'));
          return;
        }
        this.spawnIfNeeded();
        if (this.host) {
          this.host.request(this, method, params, { timeoutMs }).then(
            resolveOnce,
            err => handleAttemptError(err, attempt),
          );
          return;
        }
        if (this.transport) {
          this.transport.request(method, params, { timeoutMs }).then(
            resolveOnce,
            err => handleAttemptError(err, attempt),
          );
          return;
        }
        const id = ++this.rpcId;
        let timer = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          timer = null;
        };
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            this.pending.delete(id);
            rejectOnce(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        this.pending.set(id, {
          method,
          resolve: value => {
            cleanup();
            resolveOnce(value);
          },
          reject: err => {
            cleanup();
            handleAttemptError(err, attempt);
          },
        });
        try {
          this.observeRpc('request', { direction: 'outbound', id, method, params });
          this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
        } catch (err) {
          this.pending.delete(id);
          cleanup();
          rejectOnce(err);
        }
      };

      sendAttempt(0);
    });
  }

  notify(method, params) {
    this.spawnIfNeeded();
    if (this.host) return this.host.notify(this, method, params);
    if (this.transport) return this.transport.notify(method, params);
    this.observeRpc('notification', { direction: 'outbound', method, params });
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  // initialize app-server，只执行一次；登录等非 thread 操作也复用它。
  ensureInitialized() {
    if (this.initialized) return this.initialized;
    const initialized = this.host
      ? this.host.ensureInitialized(this)
      : (async () => {
        await this.request('initialize', {
          clientInfo: { name: 'codex-chat-mobile', title: 'Codex Chat Mobile', version: '0.1.0' },
          capabilities: {
            experimentalApi: this.experimentalApi,
            requestAttestation: false,
          },
        });
        this.notify('initialized', {});
      })();
    this.initialized = initialized;
    initialized.catch(() => {
      if (this.initialized === initialized) this.initialized = null;
    });
    return initialized;
  }

  // initialize + 建/续 thread，只执行一次。
  ensureReady() {
    if (this.ready) return this.ready;
    const ready = (async () => {
      await this.ensureInitialized();
      if (this.sessionId) {
        const resumeParams = {
          threadId: this.sessionId,
          cwd: this.cwd,
          approvalPolicy: this.approvalPolicy,
          sandbox: this.sandbox,
          approvalsReviewer: this.approvalsReviewer,
        };
        if (this.turnOverrides.model) resumeParams.model = this.turnOverrides.model;
        if (this.turnOverrides.serviceTier) resumeParams.serviceTier = this.turnOverrides.serviceTier;
        if (process.env.LOG_STDERR) console.error('[appserver] thread/resume', resumeParams);
        const resumed = await this.request('thread/resume', resumeParams);
        this.rememberEffectivePermissions(resumed);
      } else {
        const startParams = {
          cwd: this.cwd,
          approvalPolicy: this.approvalPolicy,
          sandbox: this.sandbox,
          approvalsReviewer: this.approvalsReviewer,
        };
        if (this.turnOverrides.model) startParams.model = this.turnOverrides.model;
        if (this.turnOverrides.serviceTier) startParams.serviceTier = this.turnOverrides.serviceTier;
        if (process.env.LOG_STDERR) console.error('[appserver] thread/start', startParams);
        const r = await this.request('thread/start', startParams);
        this.rememberEffectivePermissions(r);
        this.sessionId = r?.thread?.id ?? r?.threadId ?? null;
        if (this.sessionId) this.onSessionId?.(this.sessionId, this.firstMessage);
      }
      this.emit('init', { sessionId: this.sessionId, cwd: this.cwd });
      this.emitStatus('ready');
    })();
    this.ready = ready;
    ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  async send(text, savedAttachments, parts) {
    text = typeof text === 'string' ? text.trim() : '';
    const hasAttachments = Array.isArray(savedAttachments) && savedAttachments.length > 0;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if (!text && !hasAttachments && !hasParts) return false;
    if (this.disposed) return false;
    if (this.busy) {
      if (this.currentTurnId) return this.steerTurn(text, savedAttachments, parts);
      return this.enqueueInput(text, savedAttachments, parts);
    }

    return this.startTurn(text, savedAttachments, parts);
  }

  async dispatchUserMessage({ text, savedAttachments, parts, clientRequestId, turn } = {}) {
    text = typeof text === 'string' ? text.trim() : '';
    const hasAttachments = Array.isArray(savedAttachments) && savedAttachments.length > 0;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if ((!text && !hasAttachments && !hasParts) || this.disposed) {
      return { accepted: false, state: 'rejected', clientRequestId, reason: 'invalid_message' };
    }
    if (this.busy) {
      if (this.currentTurnId) {
        // steer 把输入追加进正在跑的 turn，那一轮的权限/模型早已生效，所以这里刻意
        // 不把 turn overrides 传下去——改写一个已经在执行的 turn 的权限边界是危险的。
        // 但不能静默：用户刚改完设置再发一句，得知道它这一轮不算数。
        if (turn && Object.keys(turn).length) {
          this.emit('system', {
            message: '这条追加到了正在执行的任务，本次修改的设置要等下一轮才生效。',
            isError: false,
          });
        }
        return this.steerTurnDispatch(text, savedAttachments, parts, clientRequestId);
      }
      return this.enqueueInputDispatch(text, savedAttachments, parts, clientRequestId, turn);
    }
    return this.startTurnDispatch(text, savedAttachments, parts, clientRequestId, turn);
  }

  enqueueInput(text, savedAttachments, parts) {
    return this.enqueueInputDispatch(text, savedAttachments, parts).accepted;
  }

  enqueueInputDispatch(text, savedAttachments, parts, clientRequestId, turn) {
    if (this.inputQueue.length >= this.inputQueueLimit) {
      this.emit('system', { message: `输入队列已满（上限 ${this.inputQueueLimit} 条），请等待当前任务完成后再发送`, isError: true });
      this.emitStatus('queue_full');
      return {
        accepted: false,
        state: 'rejected',
        clientRequestId,
        threadId: this.sessionId,
        reason: 'queue_full',
      };
    }
    const entry = { text, savedAttachments, parts, clientRequestId, turn, queuedAt: Date.now() };
    this.inputQueue.push(entry);
    const queuedMessage = {
      text,
      queuedAt: entry.queuedAt,
      position: this.inputQueue.length,
      queueLength: this.inputQueue.length
    };
    if (clientRequestId) queuedMessage.clientRequestId = clientRequestId;
    this.emit('queued_message', queuedMessage);
    this.emitStatus('queued');
    return {
      accepted: true,
      state: 'queued',
      clientRequestId,
      threadId: this.sessionId,
      position: this.inputQueue.length,
      queuedAt: entry.queuedAt,
    };
  }

  async startTurn(text, savedAttachments, parts) {
    const outcome = await this.startTurnDispatch(text, savedAttachments, parts);
    return outcome.accepted;
  }

  async startTurnDispatch(text, savedAttachments, parts, clientRequestId, turn) {
    const previousSettings = { turnOverrides: { ...this.turnOverrides }, approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox, approvalsReviewer: this.approvalsReviewer, resolvedHostPolicy: this.resolvedHostPolicy };
    this.applyTurnOverrides(turn);
    const turnEpoch = this.turnEpoch;
    this.busy = true;
    this.lastActivity = Date.now();
    if (this.firstMessage === null) this.firstMessage = text;
    // user_message 带附件元数据（不含服务端路径）
    const attachMeta = savedAttachments?.length
      ? savedAttachments.map(a => ({ name: a.name, mimeType: a.mimeType, size: a.size }))
      : undefined;
    const userMessage = { text, attachments: attachMeta };
    const partMeta = inputPartEventMeta(parts);
    if (partMeta.length) userMessage.parts = partMeta;
    if (clientRequestId) userMessage.clientRequestId = clientRequestId;
    this.emit('user_message', userMessage);
    this.emitStatus('turn_started');

    try {
      if (this.turnOverrides.permission) {
        const settings = await this.readSessionSettings();
        const mode = settings.available.permissionModes.find(item => item.id === this.turnOverrides.permission.mode);
        if (!mode?.enabled) throw new Error(mode?.reason || '权限模式不可用');
        const limits = settings.restrictions;
        if (mode.id === 'custom' && ((limits?.allowedSandboxModes && !limits.allowedSandboxModes.includes(this.sandbox))
          || (limits?.allowedApprovalPolicies && !limits.allowedApprovalPolicies.some(p => JSON.stringify(p) === JSON.stringify(this.approvalPolicy))))) {
          throw new Error('主机策略不允许此自定义权限');
        }
      }
      await this.resolveHostPermissions();
      await this.ensureReady();
      if (this.disposed || this.turnEpoch !== turnEpoch) {
        return {
          accepted: false,
          state: 'rejected',
          clientRequestId,
          threadId: this.sessionId,
          reason: 'interrupted',
        };
      }
      // turn/start 立即返回 inProgress；完成经 turn/completed 通知。
      const params = {
        threadId: this.sessionId,
        cwd: this.cwd,
        input: buildUserInputs({ text, attachments: savedAttachments, parts }),
        ...buildTurnStartOverrides(this.turnOverrides),
        ...this.resolvedHostPolicy,
      };
      if (clientRequestId) params.clientUserMessageId = clientRequestId;
      const turnStart = await this.request('turn/start', params);
      if (params.approvalPolicy && params.sandboxPolicy) {
        this.rememberEffectivePermissions({ approvalPolicy: params.approvalPolicy,
          approvalsReviewer: params.approvalsReviewer || this.approvalsReviewer, sandbox: params.sandboxPolicy });
        this.emitStatus('settings_applied');
      }
      const turnId = turnStart?.turn?.id ?? turnStart?.turnId ?? null;
      // abort 落在 turn/start 的在途窗口里：turn 已经在 app-server 上起来了，但既没进
      // currentTurnId 的追踪、也不会被后续任何 interrupt 命中——用户会看到「已中断」而
      // 命令仍在跑。必须就地撤销。turnEpoch 比 busy 精确：只有 abort() 会递增它，而
      // busy 也可能被 thread/status/changed 的 idle 通知改写。
      if (this.disposed || this.turnEpoch !== turnEpoch) {
        if (turnId && this.child && this.sessionId) {
          this.request('turn/interrupt', { threadId: this.sessionId, turnId }, {
            timeoutMs: this.interruptTimeoutMs,
          }).catch(() => {});
        }
        return {
          accepted: false,
          state: 'rejected',
          clientRequestId,
          threadId: this.sessionId,
          reason: 'interrupted',
        };
      }
      const outcome = {
        accepted: true,
        state: 'submitted',
        clientRequestId,
        threadId: this.sessionId,
        turnId,
      };
      if (!this.busy) {
        this.emitMessageReceipt(outcome);
        return outcome;
      }
      this.recordCurrentTurn(turnStart);
      this.emitStatus('turn_submitted');
      this.emitMessageReceipt(outcome);
      return outcome;
    } catch (err) {
      Object.assign(this, previousSettings);
      this.busy = false;
      this.emit('error', { message: `turn/start 失败：${sanitize(String(err?.message || err))}`, recoverable: true });
      this.emitStatus('turn_start_failed');
      return {
        accepted: false,
        state: 'rejected',
        clientRequestId,
        threadId: this.sessionId,
        reason: 'turn_start_failed',
      };
    }
  }

  async steerTurn(text, savedAttachments, parts) {
    const outcome = await this.steerTurnDispatch(text, savedAttachments, parts);
    return outcome.accepted;
  }

  async steerTurnDispatch(text, savedAttachments, parts, clientRequestId) {
    const expectedTurnId = this.currentTurnId;
    const attachMeta = savedAttachments?.length
      ? savedAttachments.map(a => ({ name: a.name, mimeType: a.mimeType, size: a.size }))
      : undefined;
    const userMessage = { text, attachments: attachMeta };
    const partMeta = inputPartEventMeta(parts);
    if (partMeta.length) userMessage.parts = partMeta;
    if (clientRequestId) userMessage.clientRequestId = clientRequestId;
    this.emit('user_message', userMessage);

    try {
      await this.ensureReady();
      const params = {
        threadId: this.sessionId,
        input: buildUserInputs({ text, attachments: savedAttachments, parts }),
        expectedTurnId
      };
      if (clientRequestId) params.clientUserMessageId = clientRequestId;
      const steer = await this.request('turn/steer', params);
      this.recordCurrentTurn(steer);
      const turnId = steer?.turn?.id ?? steer?.turnId ?? expectedTurnId;
      this.emit('system', {
        message: '已向当前运行任务追加指令',
        isError: false,
        turnId
      });
      this.emitStatus('steer_submitted');
      const outcome = {
        accepted: true,
        state: 'steered',
        clientRequestId,
        threadId: this.sessionId,
        turnId,
      };
      this.emitMessageReceipt(outcome);
      return outcome;
    } catch (err) {
      this.emit('error', { message: `turn/steer 失败：${sanitize(String(err?.message || err))}`, recoverable: true });
      this.emitStatus('steer_failed');
      return {
        accepted: false,
        state: 'rejected',
        clientRequestId,
        threadId: this.sessionId,
        reason: 'steer_failed',
      };
    }
  }

  emitMessageReceipt(outcome) {
    if (!outcome?.clientRequestId) return;
    if (!outcome.accepted && outcome.state !== 'rejected') return;
    const receipt = {
      clientRequestId: outcome.clientRequestId,
      state: outcome.state,
      threadId: outcome.threadId,
      turnId: outcome.turnId ?? null,
    };
    if (outcome.state === 'rejected') {
      receipt.errorCode = outcome.reason || 'dispatch_rejected';
      if (outcome.receiptReason) receipt.reason = outcome.receiptReason;
    }
    this.emit('message_receipt', receipt);
  }

  scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drainQueue().catch(err => {
        this.emit('error', { message: `队列继续执行失败：${sanitize(String(err?.message || err))}`, recoverable: true });
        this.emitStatus('queue_error');
      });
    });
  }

  async drainQueue() {
    if (this.disposed || this.busy || this.inputQueue.length === 0) return false;
    const next = this.inputQueue.shift();
    const dequeuedMessage = {
      text: next.text,
      queuedAt: next.queuedAt,
      queueLength: this.inputQueue.length
    };
    if (next.clientRequestId) dequeuedMessage.clientRequestId = next.clientRequestId;
    this.emit('dequeued_message', dequeuedMessage);
    this.emitStatus('dequeued');
    const outcome = await this.startTurnDispatch(
      next.text,
      next.savedAttachments,
      next.parts,
      next.clientRequestId,
      next.turn,
    );
    if (!outcome.accepted) this.emitMessageReceipt(outcome);
    return outcome.accepted;
  }

  // ---- app-server 通知 → 统一信封 ----
  handleNotification(method, params) {
    this.lastActivity = Date.now();
    switch (method) {
      case 'item/agentMessage/delta':
        if (params.delta) this.emit('text_delta', { text: params.delta });
        break;
      case 'item/commandExecution/outputDelta':
        this.handleCommandOutputDelta(params);
        break;
      case 'thread/realtime/started':
        this.emitRealtime('started', params);
        break;
      case 'thread/realtime/sdp':
        this.emitRealtime('sdp', params);
        break;
      case 'thread/realtime/itemAdded':
        this.emitRealtime('item_added', params);
        break;
      case 'thread/realtime/transcript/delta':
        this.emitRealtime('transcript_delta', params);
        break;
      case 'thread/realtime/transcript/done':
        this.emitRealtime('transcript_done', params);
        break;
      case 'thread/realtime/outputAudio/delta':
        this.emitRealtime('output_audio_delta', params);
        break;
      case 'thread/realtime/error':
        this.emitRealtime('error', params);
        break;
      case 'thread/realtime/closed':
        this.emitRealtime('closed', params);
        break;
      case 'remoteControl/status/changed':
        this.emit('remote_control', params || {});
        break;
      case 'serverRequest/resolved':
        this.handleServerRequestResolved(params);
        break;
      case 'item/started':
        this.approvalBroker.registerItem(params.item);
        this.handleItem(params.item, false);
        break;
      case 'item/completed':
        this.handleItem(params.item, true);
        break;
      case 'thread/tokenUsage/updated':
        // 存完整的 ThreadTokenUsage：modelContextWindow 只在顶层，状态栏要用它做分母。
        this.tokenUsage = params.tokenUsage ?? null;
        this.emit('usage', {
          usage: params.tokenUsage?.last ?? params.tokenUsage,
          tokenUsage: this.tokenUsage,
        });
        break;
      case 'thread/status/changed':
        if (params.threadId && this.sessionId && params.threadId !== this.sessionId) break;
        this.threadStatus = params.status || null;
        if (params.status?.type === 'active') this.busy = true;
        if (['idle', 'notLoaded', 'systemError'].includes(params.status?.type)) this.busy = false;
        this.emit('thread_status', {
          threadId: params.threadId || this.sessionId || null,
          status: this.threadStatus,
        });
        this.emitStatus('thread_status_changed');
        break;
      case 'thread/archived':
        this.emitThreadEvent('archived', params);
        break;
      case 'thread/unarchived':
        this.emitThreadEvent('unarchived', params);
        break;
      case 'thread/deleted':
        this.emitThreadEvent('deleted', params);
        break;
      case 'thread/name/updated':
        this.emitThreadEvent('name_updated', {
          ...params,
          name: params.threadName ?? params.name ?? null,
        });
        break;
      case 'thread/settings/updated':
        this.rememberEffectivePermissions({ ...params.threadSettings, sandbox: params.threadSettings?.sandboxPolicy });
        this.emitStatus('settings_updated');
        this.emitCollaborationMode(params.threadId, collaborationModeFromThreadSettings(params.threadSettings), {
          applied: true,
        });
        break;
      case 'thread/compacted':
        this.emit('compact', {
          status: 'compacted',
          threadId: params.threadId || null,
          turnId: params.turnId || null,
        });
        break;
      case 'account/rateLimits/updated':
        this.emit('rate_limits', params || {});
        break;
      case 'mcpServer/startupStatus/updated':
        this.emit('mcp_status', params || {});
        break;
      case 'skills/changed':
        this.emit('skills_changed', params || {});
        break;
      case 'externalAgentConfig/import/progress':
        this.emit('external_agent_config_import', { status: 'progress', ...(params || {}) });
        break;
      case 'externalAgentConfig/import/completed':
        this.emit('external_agent_config_import', { status: 'completed', ...(params || {}) });
        break;
      case 'turn/plan/updated':
        this.emit('plan', { plan: params.plan || [], explanation: params.explanation });
        break;
      case 'turn/started':
        this.recordCurrentTurn(params);
        break;
      case 'turn/diff/updated':
        if (params.diff) this.emit('diff', { diff: truncate(params.diff, TOOL_SUMMARY_CAP * 2) });
        break;
      case 'item/reasoning/summaryTextDelta':
        if (params.delta) this.emit('reasoning', reasoningPayload(params, {
          text: params.delta,
          channel: 'summary',
          kind: 'summary_text_delta',
          indexKey: 'summaryIndex'
        }));
        break;
      case 'item/reasoning/textDelta':
        if (params.delta) this.emit('reasoning', reasoningPayload(params, {
          text: params.delta,
          channel: 'full',
          kind: 'text_delta',
          indexKey: 'contentIndex'
        }));
        break;
      case 'item/reasoning/summaryPartAdded':
        this.emit('reasoning', reasoningPayload(params, {
          text: '',
          channel: 'summary',
          kind: 'summary_part_added',
          indexKey: 'summaryIndex'
        }));
        break;
      case 'account/login/completed':
        this.emit('account_login', {
          status: params.success ? 'completed' : 'failed',
          loginId: params.loginId ?? null,
          success: params.success === true,
          error: params.error ?? null
        });
        break;
      case 'account/updated':
        this.emit('account_updated', {
          authMode: params.authMode ?? null,
          planType: params.planType ?? null
        });
        break;
      case 'error':
        this.handleErrorNotification(params);
        break;
      case 'turn/completed':
        this.clearCurrentTurn(params);
        this.approvalBroker.clearItems();
        this.handleTurnCompleted(params);
        break;
      case 'turn/failed':
        this.clearCurrentTurn(params);
        this.approvalBroker.clearItems();
        this.finishTurnFailure(turnErrorMessage(params), 'turn_failed');
        break;
      // 忽略：thread/started、thread/status/changed、mcpServer/*、skills/changed、account/*、remoteControl/* 等。
    }
  }

  handleErrorNotification(params) {
    const message = protocolErrorMessage(params, 'codex app-server error');
    const willRetry = params.willRetry === true;
    this.emit('system', {
      message: willRetry ? `Codex 正在重试：${message}` : message,
      isError: !willRetry,
      willRetry,
      threadId: params.threadId || null,
      turnId: params.turnId || null
    });
    this.emitStatus(willRetry ? 'turn_retrying' : 'server_error');
  }

  emitThreadEvent(event, params) {
    this.emit('thread_event', {
      event,
      threadId: params?.threadId || null,
      name: params?.name ?? params?.threadName ?? null,
    });
  }

  handleTurnCompleted(params) {
    const status = params.turn?.status || params.status || 'completed';
    if (status === 'completed') {
      this.busy = false;
      this.approvalBroker.clearPending();
      this.emit('result', { ok: true, status });
      this.emitStatus('turn_completed');
      this.scheduleDrain();
      return;
    }
    if (status === 'failed') {
      this.finishTurnFailure(turnErrorMessage(params), 'turn_failed');
      return;
    }
    if (status === 'interrupted') {
      this.finishTurnFailure(turnErrorMessage(params, '任务已中断'), 'turn_interrupted');
      return;
    }

    this.busy = false;
    this.approvalBroker.clearPending();
    this.emit('result', { ok: false, status });
    this.emitStatus('turn_completed');
    this.scheduleDrain();
  }

  finishTurnFailure(message, statusReason) {
    this.busy = false;
    this.approvalBroker.clearPending();
    this.emit('error', { message, recoverable: true });
    this.emitStatus(statusReason);
    this.scheduleDrain();
  }

  handleCommandOutputDelta(params) {
    const text = params.delta ?? params.text ?? params.output ?? '';
    if (!text) return;
    this.emit('tool_output_delta', {
      toolUseId: params.itemId || params.toolUseId || params.item?.id || null,
      text,
      stream: params.stream || params.channel || 'stdout'
    });
  }

  emitRealtime(event, params) {
    this.emit('realtime', { event, ...(params || {}) });
  }

  handleServerRequestResolved(params) {
    this.approvalBroker.handleResolved(params);
  }

  recordCurrentTurn(source) {
    const turnId = source?.turn?.id ?? source?.turnId ?? source?.id;
    if (typeof turnId === 'string' && turnId) this.currentTurnId = turnId;
  }

  clearCurrentTurn(source) {
    const turnId = source?.turn?.id ?? source?.turnId ?? source?.id;
    if (!turnId || turnId === this.currentTurnId) this.currentTurnId = null;
  }

  // app-server item（camelCase）：
  //   agentMessage:     { type, id, text } —— 正文已由 delta 流给出，completed 不重复发。
  //   commandExecution: { type, id, command, aggregatedOutput, exitCode, status }
  handleItem(item, completed) {
    if (!item || !item.type) return;
    switch (item.type) {
      case 'agentMessage':
        break; // 流式 delta 已处理
      case 'userMessage':
        break; // 发送路径已发 user_message，回声不再画 RAW 卡
      case 'commandExecution':
        if (!completed) {
          this.emit('tool_use', {
            toolUseId: item.id,
            name: 'ShellCall',
            inputSummary: truncate(item.command || '', TOOL_SUMMARY_CAP)
          });
        } else {
          this.emit('tool_result', {
            toolUseId: item.id,
            ok: item.exitCode === 0,
            exitCode: item.exitCode,
            status: item.status || 'completed',
            outputSummary: truncate(item.aggregatedOutput || '', TOOL_SUMMARY_CAP)
          });
        }
        break;
      case 'reasoning':
        // 真实 app-server 不发 item/reasoning/* 通知，reasoning 是经 item/started|completed
        // 送出的一个 item。started 阶段 summary/content 还是空的，等 completed 再出正文，
        // 否则会先画一张空卡。
        if (completed) {
          const text = reasoningItemText(item);
          if (text) {
            this.emit('reasoning', {
              text,
              channel: 'summary',
              kind: 'item_completed',
              itemId: item.id,
            });
          }
        }
        break;
      case 'fileChange':
        if (completed) {
          this.emit('file_change', {
            itemId: item.id,
            status: item.status,
            files: (item.changes || []).map(c => ({
              path: c.path,
              kind: (c.kind && c.kind.type) || c.kind || 'modify',
              diff: truncate(c.diff || '', TOOL_SUMMARY_CAP)
            }))
          });
        }
        break;
      case 'mcpToolCall':
        if (!completed) {
          this.emit('mcp_use', {
            toolUseId: item.id,
            serverName: item.serverName || 'unknown',
            toolName: item.toolName || 'unknown',
            inputSummary: truncate(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}), TOOL_SUMMARY_CAP)
          });
        } else {
          this.emit('mcp_result', {
            toolUseId: item.id,
            ok: !item.error,
            outputSummary: truncate(item.error?.message || item.result || '', TOOL_SUMMARY_CAP)
          });
        }
        break;
      case 'webSearch':
        if (completed && item.query) {
          this.emit('search', {
            query: item.query,
            results: (item.results || []).map(r => ({ title: r.title, url: r.url, snippet: truncate(r.snippet || '', TOOL_SUMMARY_CAP) }))
          });
        }
        break;
      default:
        this.emit('raw_item', {
          completed,
          item: truncatePayload(item, TOOL_SUMMARY_CAP * 2)
        });
        break;
    }
  }

  // 空闲回收资格。runtime 只回答自己手上还有没有活；「有没有 socket 在看它」
  // 是网关才知道的信息，由 server.js 的 reclaimIdleAgents 另行判断。
  isReclaimable(idleSince) {
    return !this.disposed
      && !this.busy
      && this.pendingApprovals.size === 0
      && this.inputQueue.length === 0
      && this.lastActivity <= idleSince;
  }

  checkIdle() {
    if (!this.busy) return;
    if (Date.now() - this.lastActivity > this.idleTimeoutMs) {
      this.emit('error', {
        message: `任务静默超过 ${Math.round(this.idleTimeoutMs / 60000)} 分钟，已中断`,
        recoverable: true
      });
      this.abort();
    }
  }

  async abort() {
    this.turnEpoch += 1;
    if (this.child && this.sessionId && this.currentTurnId) {
      try {
        await this.request('turn/interrupt', {
          threadId: this.sessionId,
          turnId: this.currentTurnId
        }, { timeoutMs: this.interruptTimeoutMs });
      } catch (err) {
        this.emit('system', {
          message: `turn/interrupt 请求失败，已执行本地中断复位：${sanitize(String(err?.message || err))}`,
          isError: true
        });
      }
    }
    const dropped = this.clearQueue('interrupt');
    this.busy = false;
    this.approvalBroker.clearPending();
    this.approvalBroker.clearItems();
    this.currentTurnId = null;
    this.emitStatus(dropped ? 'interrupt_cleared_queue' : 'interrupt');
    this.emit('system', { message: '已中断', isError: false });
  }

  async forkThread(options = {}) {
    await this.ensureReady();
    const threadId = typeof options.threadId === 'string' && options.threadId
      ? options.threadId
      : this.sessionId;
    if (!threadId) throw new Error('无法 fork：当前实例没有可用 threadId');
    return this.request('thread/fork', {
      threadId,
      cwd: this.cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      ephemeral: options.ephemeral === true
    });
  }

  async startChatgptDeviceLogin() {
    await this.ensureInitialized();
    const response = await this.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (response?.type === 'chatgptDeviceCode') {
      this.emit('account_login', {
        status: 'pending',
        loginId: response.loginId,
        verificationUrl: response.verificationUrl,
        userCode: response.userCode
      });
    }
    return response;
  }

  async cancelLogin(loginId) {
    await this.ensureInitialized();
    const response = await this.request('account/login/cancel', { loginId });
    this.emit('account_login', {
      status: response?.status === 'canceled' ? 'canceled' : 'cancel_missing',
      loginId,
      cancelStatus: response?.status || null
    });
    return response;
  }

  async listThreads(options = {}) {
    await this.ensureInitialized();
    return this.request('thread/list', definedParams({
      cwd: options.cwd ?? this.cwd,
      archived: options.archived ?? false,
      limit: options.limit,
      cursor: options.cursor,
      sortKey: options.sortKey,
      sortDirection: options.sortDirection,
      searchTerm: options.searchTerm,
      sourceKinds: options.sourceKinds,
      modelProviders: options.modelProviders,
      useStateDbOnly: options.useStateDbOnly,
    }));
  }

  async archiveThread(threadId) {
    await this.ensureInitialized();
    return this.request('thread/archive', { threadId: requireThreadId(threadId, 'archive') });
  }

  async unarchiveThread(threadId) {
    await this.ensureInitialized();
    return this.request('thread/unarchive', { threadId: requireThreadId(threadId, 'unarchive') });
  }

  async deleteThread(threadId) {
    await this.ensureInitialized();
    return this.request('thread/delete', { threadId: requireThreadId(threadId, 'delete') });
  }

  async renameThread(threadId, name) {
    await this.ensureInitialized();
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('thread name is required');
    return this.request('thread/name/set', { threadId: requireThreadId(threadId, 'rename'), name: trimmed });
  }

  async updateThreadCollaborationMode(threadId, mode) {
    const normalized = normalizeCollaborationMode(mode);
    if (!normalized) throw new Error('无效的会话模式');
    const targetThreadId = requireThreadId(threadId || this.sessionId, '切换会话模式');
    const collaborationMode = collaborationModePayload(normalized);
    this.applyTurnOverrides({ collaborationMode: normalized });
    await this.ensureInitialized();
    try {
      await this.request('thread/settings/update', {
        threadId: targetThreadId,
        collaborationMode,
      });
      this.emitCollaborationMode(targetThreadId, normalized, { applied: true });
      return { ok: true, applied: true, deferred: false, mode: normalized, threadId: targetThreadId };
    } catch (error) {
      if (!isUnsupportedCollaborationModeError(error)) throw error;
      this.emitCollaborationMode(targetThreadId, normalized, { applied: false, deferred: true });
      return {
        ok: true,
        applied: false,
        deferred: true,
        mode: normalized,
        threadId: targetThreadId,
        reason: 'unsupported',
      };
    }
  }

  emitCollaborationMode(threadId, mode, extra = {}) {
    const normalized = normalizeCollaborationMode(mode);
    if (!normalized) return;
    this.emit('collaboration_mode', {
      threadId: threadId || this.sessionId || null,
      mode: normalized,
      ...extra,
    });
  }

  async compactThread(threadId = this.sessionId) {
    await this.ensureInitialized();
    return this.request('thread/compact/start', { threadId: requireThreadId(threadId, 'compact') });
  }

  // delivery 固定 inline：审查跑在当前 thread 上，结果沿用现有的 turn 事件流，
  // 前端不用为一条 review thread 单独订阅和切换。
  async startReview(options = {}) {
    // ensureReady 而不是 ensureInitialized：审的是工作区改动，空会话里也该能发起，
    // 而 thread 是懒建的（session:new 只给 instanceId，threadId 要等第一个 turn）。
    await this.ensureReady();
    const instructions = String(options.instructions || '').trim();
    // 先构造再广播：requireThreadId 抛在这一步的话，前端还没被推进 busy。
    const params = {
      threadId: requireThreadId(options.threadId || this.sessionId, 'review'),
      target: instructions
        ? { type: 'custom', instructions }
        : { type: 'uncommittedChanges' },
      delivery: 'inline',
    };
    // inline review 就是当前 thread 上的一个 turn，状态广播要和 turn/start 一致：
    // 少了这一步前端不进 busy，随后的 delta 也没有 turn 容器可落，审查结果会凭空消失。
    this.busy = true;
    this.emitStatus('turn_started');
    try {
      const response = await this.request('review/start', params);
      this.recordCurrentTurn(response);
      this.emitStatus('turn_submitted');
      return response;
    } catch (err) {
      this.busy = false;
      this.emitStatus('turn_start_failed');
      throw err;
    }
  }

  async rollbackThread(options = {}) {
    await this.ensureInitialized();
    const numTurns = Number.isInteger(options.numTurns) && options.numTurns >= 1 ? options.numTurns : 1;
    return this.request('thread/rollback', {
      threadId: requireThreadId(options.threadId || this.sessionId, 'rollback'),
      numTurns,
    });
  }

  async readThread(options = {}) {
    await this.ensureInitialized();
    const threadId = requireThreadId(options.threadId || this.sessionId, 'read thread');
    const response = await this.request('thread/read', {
      threadId,
      includeTurns: options.includeTurns !== false,
    });
    return response?.thread ?? response ?? null;
  }

  async listModels(options = {}) {
    await this.ensureInitialized();
    return this.request('model/list', definedParams({
      includeHidden: options.includeHidden ?? false,
      limit: options.limit ?? 100,
      cursor: options.cursor,
    }));
  }

  async readModelProviderCapabilities() {
    await this.ensureInitialized();
    return this.request('modelProvider/capabilities/read', {});
  }

  async readDirectory(path) {
    await this.ensureInitialized();
    return this.request('fs/readDirectory', { path: requireAbsolutePath(path, 'directory path') });
  }

  async readFile(path) {
    await this.ensureInitialized();
    return this.request('fs/readFile', { path: requireAbsolutePath(path, 'file path') });
  }

  async readAccount() {
    await this.ensureInitialized();
    return this.request('account/read', undefined);
  }

  async readUsage() {
    await this.ensureInitialized();
    return this.request('account/usage/read', undefined);
  }

  async readRateLimits() {
    await this.ensureInitialized();
    return this.request('account/rateLimits/read', undefined);
  }

  async listMcpServerStatus(options = {}) {
    await this.ensureInitialized();
    return this.request('mcpServerStatus/list', definedParams({
      detail: options.detail ?? 'Summary',
      limit: options.limit,
      cursor: options.cursor,
      threadId: options.threadId ?? this.sessionId ?? null,
    }));
  }

  async listSkills(options = {}) {
    await this.ensureInitialized();
    return this.request('skills/list', definedParams({
      cwds: options.cwds ?? [this.cwd],
      forceReload: options.forceReload,
    }));
  }

  async detectExternalAgentConfig(options = {}) {
    await this.ensureInitialized();
    return this.request('externalAgentConfig/detect', definedParams({
      includeHome: options.includeHome ?? false,
      cwds: options.cwds ?? [this.cwd],
    }));
  }

  async importExternalAgentConfig(migrationItems, options = {}) {
    await this.ensureInitialized();
    return this.request('externalAgentConfig/import', {
      migrationItems: Array.isArray(migrationItems) ? migrationItems : [],
      source: options.source ?? 'mobile',
    });
  }

  async writeConfigValue(options = {}) {
    await this.ensureInitialized();
    const keyPath = requireString(options.keyPath, 'config keyPath');
    const mergeStrategy = requireMergeStrategy(options.mergeStrategy);
    return this.request('config/value/write', definedParams({
      keyPath,
      value: options.value,
      mergeStrategy,
      filePath: options.filePath,
      expectedVersion: options.expectedVersion,
    }));
  }

  async writeConfigBatch(options = {}) {
    await this.ensureInitialized();
    if (!Array.isArray(options.edits) || options.edits.length === 0) throw new Error('config edits are required');
    return this.request('config/batchWrite', definedParams({
      edits: options.edits.map(edit => ({
        keyPath: requireString(edit?.keyPath, 'config edit keyPath'),
        value: edit?.value,
        mergeStrategy: requireMergeStrategy(edit?.mergeStrategy),
      })),
      filePath: options.filePath,
      expectedVersion: options.expectedVersion,
      reloadUserConfig: options.reloadUserConfig,
    }));
  }

  async installPlugin(options = {}) {
    await this.ensureInitialized();
    const params = definedParams({
      marketplacePath: options.marketplacePath === undefined || options.marketplacePath === null
        ? options.marketplacePath
        : requireAbsolutePath(options.marketplacePath, 'marketplace path'),
      remoteMarketplaceName: options.remoteMarketplaceName,
      pluginName: requireString(options.pluginName, 'pluginName'),
    });
    return this.request('plugin/install', params);
  }

  async uninstallPlugin(pluginId) {
    await this.ensureInitialized();
    return this.request('plugin/uninstall', { pluginId: requireString(pluginId, 'pluginId') });
  }

  async marketplaceAdd(options = {}) {
    await this.ensureInitialized();
    return this.request('marketplace/add', definedParams({
      source: requireString(options.source, 'marketplace source'),
      refName: options.refName,
      sparsePaths: options.sparsePaths,
    }));
  }

  async marketplaceRemove(marketplaceName) {
    await this.ensureInitialized();
    return this.request('marketplace/remove', { marketplaceName: requireString(marketplaceName, 'marketplaceName') });
  }

  async marketplaceUpgrade(marketplaceName = null) {
    await this.ensureInitialized();
    return this.request('marketplace/upgrade', definedParams({ marketplaceName }));
  }

  async writeFile(path, dataBase64) {
    await this.ensureInitialized();
    return this.request('fs/writeFile', {
      path: requireAbsolutePath(path, 'file path'),
      dataBase64: requireString(dataBase64, 'dataBase64'),
    });
  }

  async removePath(path, options = {}) {
    await this.ensureInitialized();
    return this.request('fs/remove', definedParams({
      path: requireAbsolutePath(path, 'remove path'),
      recursive: options.recursive,
      force: options.force,
    }));
  }

  async copyPath(options = {}) {
    await this.ensureInitialized();
    return this.request('fs/copy', definedParams({
      sourcePath: requireAbsolutePath(options.sourcePath, 'source path'),
      destinationPath: requireAbsolutePath(options.destinationPath, 'destination path'),
      recursive: options.recursive,
    }));
  }

  async callMcpTool(options = {}) {
    await this.ensureInitialized();
    return this.request('mcpServer/tool/call', definedParams({
      threadId: requireThreadId(options.threadId || this.sessionId, 'call MCP tool'),
      server: requireString(options.server, 'MCP server'),
      tool: requireString(options.tool, 'MCP tool'),
      arguments: options.arguments,
      _meta: options._meta,
    }));
  }

  async logoutAccount() {
    await this.ensureInitialized();
    return this.request('account/logout', undefined);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.idleTimer); this.idleTimer = null;
    // 趁 child 还在，把未决审批回掉，否则 app-server 侧那个 turn 永远等不到响应。
    this.approvalBroker.declinePending();
    this.clearQueue('dispose', false);
    this.clearBackpressureRetries(new Error('disposed'));
    if (this.host) {
      this.host.rejectPending?.(this, new Error('disposed'));
      this.host.detach(this);
      this.child = null;
    } else if (this.transport) {
      this.transport.dispose();
      this.child = null;
    } else if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* noop */ }
      this.child = null;
    }
    this.rejectAllPending(new Error('disposed'));
  }

  emit(type, payload) {
    const envelope = {
      seq: ++this.seq,
      epoch: this.epoch,
      sessionId: this.sessionId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      ts: Date.now(),
      type,
      payload
    };
    this.buffer.push(envelope);
    if (this.buffer.length > this.bufferCap) {
      this.buffer.splice(0, this.buffer.length - this.bufferCap);
      this.bufferTrimmed = true;
    }
    this.onEvent(envelope);
  }

  eventsSince(lastSeq) {
    const events = this.buffer.filter(e => e.seq > lastSeq);
    const oldest = this.buffer.length ? this.buffer[0].seq : this.seq + 1;
    const gap = lastSeq > 0 && this.bufferTrimmed && oldest > lastSeq + 1;
    return { events, gap, epoch: this.epoch };
  }

  clearQueue(reason, emitEvent = true) {
    const droppedEntries = this.inputQueue;
    const dropped = droppedEntries.length;
    this.inputQueue = [];
    for (const entry of droppedEntries) {
      if (!entry.clientRequestId) continue;
      this.emitMessageReceipt({
        accepted: false,
        state: 'rejected',
        clientRequestId: entry.clientRequestId,
        threadId: this.sessionId,
        reason: 'queue_cleared',
        receiptReason: reason,
      });
    }
    if (emitEvent && dropped > 0 && !this.disposed) {
      this.emit('queue_cleared', { reason, dropped });
    }
    return dropped;
  }

  statusPayload(reason) {
    const state = this.pendingApprovals.size > 0
      ? 'awaiting_approval'
      : (this.busy ? 'running' : (this.inputQueue.length > 0 ? 'queued' : 'idle'));
    return {
      reason,
      state,
      sessionId: this.sessionId,
      instanceId: this.instanceId,
      turnId: this.currentTurnId,
      threadStatus: this.threadStatus,
      cwd: this.cwd,
      busy: this.busy,
      queueLength: this.inputQueue.length,
      pendingApprovals: this.pendingApprovals.size,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      childRunning: Boolean(this.child),
      approvalsReviewer: this.approvalsReviewer,
      effectivePermissions: this.effectivePermissions || null,
      lastActivity: this.lastActivity,
      rpcStats: { ...this.rpcStats }
    };
  }

  emitStatus(reason) {
    if (this.disposed) return;
    this.emit('status', this.statusPayload(reason));
  }

  observeRpc(frame, details = {}) {
    // 统计覆盖全部帧；落盘跳过 delta。它们的正文早已被打码成占位符，诊断价值接近零，
    // 却能占掉 96% 的日志体积，把真正有用的 request/response/error 挤出保留窗口。
    this.incrementRpcStats(frame, details);
    if (isDeltaNotification(frame, details.method)) return;
    this.appendRpcLog(buildRpcLogEntry({
      ...details,
      frame,
      instanceId: this.instanceId,
      sessionId: this.sessionId,
    }));
  }

  incrementRpcStats(frame, details) {
    if (frame === 'request' && details.direction === 'outbound') this.rpcStats.clientRequests += 1;
    if (frame === 'response' && details.direction === 'inbound') this.rpcStats.clientResponses += 1;
    if (frame === 'response' && details.direction === 'outbound') this.rpcStats.serverResponses += 1;
    if (frame === 'notification' && details.direction === 'outbound') this.rpcStats.clientNotifications += 1;
    if (frame === 'notification' && details.direction === 'inbound') this.rpcStats.serverNotifications += 1;
    if (frame === 'server_request') this.rpcStats.serverRequests += 1;
    if (details.error) this.rpcStats.errors += 1;
  }

  appendRpcLog(entry) {
    if (!this.rpcLogPath) return;
    try {
      const line = JSON.stringify(entry) + '\n';
      const bytes = Buffer.byteLength(line);
      this.ensureRpcLogReady();
      let fd = this.openRpcLog();
      try {
        // 以文件的真实大小为准，不用本实例的计数器：rpcLogPath 默认是
        // join(cwd, ...)，同一个 cwd 上的多个 runtime 共写一个文件却各记各的账，
        // 谁先到上限谁就轮转，rmSync(path.1) 顺手删掉别人刚存下的那一代。
        // fstat 作用在已打开的 fd 上，比按路径 stat 便宜，也没有 TOCTOU。
        if (fstatSync(fd).size + bytes > this.rpcLogMaxBytes) {
          closeSync(fd);
          fd = null;
          try {
            this.rotateRpcLog();
          } catch {
            // 轮转失败（.1 被占、只读挂载…）就放弃这一次，继续往当前文件追加。
            // 否则文件仍然超限，下一帧再次尝试轮转、再次抛错，日志就此永久静默。
          }
          fd = this.openRpcLog();
        }
        writeSync(fd, line);
      } finally {
        if (fd !== null) closeSync(fd);
      }
    } catch (error) {
      // Observability must not interfere with JSON-RPC protocol progress.
      // 路径是符号链接（O_NOFOLLOW → ELOOP）说明有人把日志指向了别处：停用它，
      // 既不写穿过去、也不用每帧重试一次注定失败的 open。
      if (error?.code === 'ELOOP') this.rpcLogPath = null;
    }
  }

  // 每帧都显式 O_CREAT 0600：日志文件可能在运行中消失（Codex agent 在自己的 cwd
  // 里有 shell，rm / git clean -xfd 都会删它），裸 appendFileSync 会按 umask 的
  // 默认模式重建，把 RPC 流量暴露给同机其他用户。
  openRpcLog() {
    return openSync(
      this.rpcLogPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0),
      0o600,
    );
  }

  // 目录与权限只在首次落一次。这里刻意不像 audit-log 那样每条 fsync——RPC 日志是可观测
  // 数据而非安全审计，而流式回复的每个 delta 都是一帧，逐帧 fsync 会直接阻塞事件循环。
  ensureRpcLogReady() {
    if (this.rpcLogReady) return;
    mkdirSync(dirname(this.rpcLogPath), { recursive: true, mode: 0o700 });
    // 已存在的文件可能是历史遗留的宽权限，首次修一次；之后每帧的 O_CREAT 0600
    // 保证新建出来的本就是 owner-only。
    closeSync(this.openRpcLog());
    fixPermissions(this.rpcLogPath, false);
    this.rpcLogReady = true;
  }

  rotateRpcLog() {
    const rotated = `${this.rpcLogPath}.1`;
    rmSync(rotated, { force: true });
    renameSync(this.rpcLogPath, rotated);
    fixPermissions(rotated, false);
  }
}

function normalizeServerRequestParams(runtime, rpcId, method, params) {
  if (!LEGACY_APPROVAL_METHODS.has(method)) return params;
  const source = params && typeof params === 'object' ? params : {};
  const fallbackId = `legacy_request_${String(rpcId)}`;
  const itemId = typeof source.itemId === 'string' && source.itemId
    ? source.itemId
    : (typeof source.callId === 'string' && source.callId
      ? source.callId
      : (typeof source.approvalId === 'string' && source.approvalId ? source.approvalId : fallbackId));
  return {
    ...source,
    threadId: source.threadId || source.conversationId || runtime.sessionId || null,
    turnId: source.turnId || runtime.currentTurnId || `legacy_turn_${String(rpcId)}`,
    itemId,
  };
}

function definedParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

function requireThreadId(threadId, action) {
  if (typeof threadId === 'string' && threadId) return threadId;
  throw new Error(`无法 ${action}：缺少 threadId`);
}

function requireAbsolutePath(path, label) {
  if (typeof path === 'string' && (/^\//.test(path) || /^[A-Za-z]:\\/.test(path))) return path;
  throw new Error(`无效 ${label}`);
}

function requireString(value, label) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${label} is required`);
}

function requireMergeStrategy(value) {
  if (value === 'replace' || value === 'upsert') return value;
  throw new Error('mergeStrategy must be replace or upsert');
}

function rpcError(error) {
  const err = new Error(error?.message || JSON.stringify(error));
  if (error?.code !== undefined) err.code = error.code;
  if (error?.data !== undefined) err.data = error.data;
  return err;
}

function isBackpressureError(err) {
  return err?.code === -32001 || /Server overloaded; retry later/i.test(String(err?.message || err));
}

function backpressureDelayMs(attempt, baseMs) {
  return Math.min(MAX_BACKPRESSURE_DELAY_MS, baseMs * (2 ** attempt));
}

function integerOption(value, fallback, options = {}) {
  const n = Number(value);
  if (Number.isInteger(n) && (options.allowZero ? n >= 0 : n > 0)) return n;
  return fallback;
}

function turnErrorMessage(params, fallback = '任务失败') {
  return protocolErrorMessage(params?.turn, null)
    || protocolErrorMessage(params, null)
    || fallback;
}

function protocolErrorMessage(source, fallback) {
  return source?.error?.message
    || source?.message
    || fallback;
}

// reasoning item 的 summary/content 形态不固定：可能是纯字符串、{text} 或 {content}。
// 取 summary 优先（那是给人看的摘要），为空再回退 content。
function reasoningItemText(item) {
  for (const key of ['summary', 'content']) {
    const parts = item?.[key];
    if (!Array.isArray(parts) || !parts.length) continue;
    const text = parts
      .map(part => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return truncate(text, TOOL_SUMMARY_CAP);
  }
  return '';
}

function reasoningPayload(params, { text, channel, kind, indexKey }) {
  const payload = { text, channel, kind };
  for (const key of ['threadId', 'turnId', 'itemId']) {
    if (typeof params?.[key] === 'string') payload[key] = params[key];
  }
  if (params?.[indexKey] !== undefined) payload[indexKey] = params[indexKey];
  return payload;
}


