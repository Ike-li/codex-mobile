// Protocol bridge adaptation tests for docs/codex-app-server-refactor Phase 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadRuntime } from '../../agent-appserver.js';

function makeSession(overrides = {}) {
  const events = [];
  const session = new ThreadRuntime({
    instanceId: 'inst_protocol',
    resumeId: null,
    cwd: '/tmp/work',
    // 见 agent-appserver.test.mjs：字面量 'codex' 会引入对宿主机 PATH 的隐式依赖。
    codexBin: process.execPath,
    idleTimeoutMs: 600000,
    onEvent: env => events.push(env),
    onSessionId: () => {},
    onExit: () => {},
    ...overrides,
  });
  return { session, events };
}

const byType = (events, type) => events.filter(e => e.type === type);
const flushDrain = () => new Promise(resolve => setImmediate(resolve));

function attachRpcWriter(session) {
  const writes = [];
  session.child = {
    stdin: {
      write: line => {
        writes.push(JSON.parse(line));
      },
    },
  };
  return writes;
}

test('R1.1 error notification reports retry state while turn/completed failed owns terminal recovery', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_protocol';
  session.ensureReady = async () => {};

  const started = [];
  session.request = async (method, params) => {
    if (method === 'turn/start') started.push(params.input[0].text);
    return {};
  };

  assert.equal(await session.send('first turn'), true);
  assert.equal(await session.send('queued turn'), true);

  session.handleNotification('error', {
    error: { message: 'temporary upstream failure' },
    willRetry: true,
  });

  assert.equal(session.busy, true);
  assert.deepEqual(started, ['first turn']);
  assert.equal(session.inputQueue.length, 1);

  const retryNotice = byType(events, 'system').at(-1);
  assert.ok(retryNotice, 'retrying error notification should surface as a system warning');
  assert.equal(retryNotice.payload.isError, false);
  assert.equal(retryNotice.payload.willRetry, true);
  assert.match(retryNotice.payload.message, /temporary upstream failure/);

  session.handleNotification('error', {
    error: { message: 'older non-terminal error' },
    willRetry: false,
  });
  session.handleNotification('turn/completed', {
    turn: {
      id: 'turn_failed',
      status: 'failed',
      error: { message: 'terminal turn failure' },
    },
  });

  const terminalErrors = byType(events, 'error');
  assert.equal(terminalErrors.length, 1);
  assert.match(terminalErrors[0].payload.message, /terminal turn failure/);
  assert.doesNotMatch(terminalErrors[0].payload.message, /older non-terminal error/);
  assert.equal(terminalErrors[0].payload.recoverable, true);
  assert.equal(byType(events, 'status').at(-1).payload.busy, false);

  await flushDrain();

  assert.deepEqual(started, ['first turn', 'queued turn']);
});

test('R1.1 legacy turn failed notification still reports error and drains queued input', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_protocol';
  session.ensureReady = async () => {};

  const started = [];
  session.request = async (method, params) => {
    if (method === 'turn/start') {
      started.push(params.input[0].text);
      return { turn: { id: `turn_${started.length}`, status: 'inProgress' } };
    }
    return {};
  };

  assert.equal(await session.send('first turn'), true);
  assert.equal(session.enqueueInput('queued turn'), true);

  session.handleNotification('turn/failed', {
    turn: { error: { message: 'legacy failed message' } },
  });

  const terminalError = byType(events, 'error').at(-1);
  assert.ok(terminalError, 'legacy turn/failed should emit an error envelope');
  assert.match(terminalError.payload.message, /legacy failed message/);
  assert.equal(terminalError.payload.recoverable, true);
  assert.equal(session.busy, false);

  await flushDrain();

  assert.deepEqual(started, ['first turn', 'queued turn']);
});

test('R1.2 unknown server request returns method-not-found error and warns the client', () => {
  const { session, events } = makeSession();
  const writes = attachRpcWriter(session);

  session.handleLine(JSON.stringify({
    id: 'req_unknown',
    method: 'example/unknown/request',
    params: { unexpected: true },
  }));

  assert.deepEqual(writes, [{
    id: 'req_unknown',
    error: {
      code: -32601,
      message: 'Unsupported server request: example/unknown/request',
    },
  }]);

  const warning = byType(events, 'system').at(-1);
  assert.ok(warning, 'unsupported request should emit a system warning');
  assert.equal(warning.payload.isError, true);
  assert.match(warning.payload.message, /example\/unknown\/request/);
});

test('R2.1 tool user input request emits user_input_request and returns answers', () => {
  const { session, events } = makeSession();
  const writes = attachRpcWriter(session);

  session.handleLine(JSON.stringify({
    id: 42,
    method: 'item/tool/requestUserInput',
    params: {
      itemId: 'tool_1',
      questions: [{
        id: 'q1',
        header: 'Continue',
        question: 'Continue?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'Yes', description: 'Continue the run' }],
      }],
      autoResolutionMs: 1000,
    },
  }));

  assert.deepEqual(writes, []);
  assert.equal(session.pendingApprovals.has(42), true);
  const request = byType(events, 'user_input_request').at(-1);
  assert.ok(request, 'tool user input should emit user_input_request');
  assert.equal(request.payload.approvalId, 42);
  assert.equal(request.payload.kind, 'item/tool/requestUserInput');
  assert.equal(request.payload.autoResolutionMs, 1000);
  assert.equal(request.payload.questions[0].id, 'q1');

  assert.equal(session.respondApproval(42, null, { answers: { q1: ['Yes'] } }), true);
  assert.deepEqual(writes.at(-1), {
    id: 42,
    result: { answers: { q1: { answers: ['Yes'] } } },
  });
});

test('R1.2 chatgpt auth token refresh returns method-not-found without storing credentials', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-protocol-auth-'));
  try {
    const { session, events } = makeSession({ cwd });
    const writes = attachRpcWriter(session);

    session.handleLine(JSON.stringify({
      id: 'auth_refresh',
      method: 'account/chatgptAuthTokens/refresh',
      params: { reason: 'expired', previousAccountId: 'acct_previous' },
    }));

    assert.deepEqual(writes, [{
      id: 'auth_refresh',
      error: {
        code: -32601,
        message: 'Unsupported server request: account/chatgptAuthTokens/refresh',
      },
    }]);
    assert.deepEqual(readdirSync(cwd), ['.codex-chat-rpc.jsonl']);
    const rpcLogPath = join(cwd, '.codex-chat-rpc.jsonl');
    const rpcLog = readFileSync(rpcLogPath, 'utf8');
    assert.equal(statSync(rpcLogPath).mode & 0o777, 0o600);
    assert.match(rpcLog, /account\/chatgptAuthTokens\/refresh/);
    assert.match(rpcLog, /"params":"<redacted>"/);
    assert.doesNotMatch(rpcLog, /acct_previous/);
    assert.doesNotMatch(rpcLog, /expired/);
    assert.equal(session.authTokens, undefined);
    assert.equal(session.accessToken, undefined);
    assert.equal(session.chatgptAuthTokens, undefined);

    const warning = byType(events, 'system').at(-1);
    assert.ok(warning, 'auth token refresh should emit a system warning');
    assert.equal(warning.payload.isError, true);
    assert.match(warning.payload.message, /ChatGPT auth token refresh/);
    assert.match(warning.payload.message, /not supported/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R1.2 legacy apply patch approval request is forwarded to the approval envelope', () => {
  const { session, events } = makeSession();
  const writes = attachRpcWriter(session);

  session.handleLine(JSON.stringify({
    id: 77,
    method: 'applyPatchApproval',
    params: {
      conversationId: 'thr_protocol',
      callId: 'patch_call',
      fileChanges: {},
      reason: 'needs write access',
      grantRoot: null,
    },
  }));

  assert.deepEqual(writes, []);
  assert.equal(session.pendingApprovals.has(77), true);

  const approval = byType(events, 'approval_request').at(-1);
  assert.ok(approval, 'legacy apply patch approval should emit approval_request');
  assert.equal(approval.payload.approvalId, 77);
  assert.equal(approval.payload.kind, 'applyPatchApproval');
  assert.equal(approval.payload.reason, 'needs write access');
  assert.deepEqual(approval.payload.availableDecisions, ['accept', 'decline']);
});

test('R1.2 command execution approval request is not rejected as unsupported', () => {
  const { session, events } = makeSession();
  const writes = attachRpcWriter(session);

  session.handleLine(JSON.stringify({
    id: 88,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thr_protocol',
      turnId: 'turn_protocol',
      itemId: 'item_shell',
      startedAtMs: Date.now(),
      environmentId: null,
      command: 'npm test',
      cwd: '/tmp/work',
      reason: 'run tests',
    },
  }));

  assert.deepEqual(writes, []);
  assert.equal(session.pendingApprovals.has(88), true);

  const approval = byType(events, 'approval_request').at(-1);
  assert.ok(approval, 'command execution approval should emit approval_request');
  assert.equal(approval.payload.approvalId, 88);
  assert.equal(approval.payload.kind, 'item/commandExecution/requestApproval');
  assert.equal(approval.payload.command, 'npm test');
  assert.equal(approval.payload.cwd, '/tmp/work');
  assert.equal(approval.payload.reason, 'run tests');
});

test('R2.1 file change approval joins changes from item/started cache', () => {
  const { session, events } = makeSession();
  const writes = attachRpcWriter(session);

  session.handleNotification('item/started', {
    item: {
      type: 'fileChange',
      id: 'file_item_1',
      changes: [{ path: '/tmp/work/a.txt', kind: { type: 'modify' }, diff: '-old\n+new\n' }],
    },
  });
  session.handleLine(JSON.stringify({
    id: 89,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thr_protocol',
      turnId: 'turn_protocol',
      itemId: 'file_item_1',
      reason: 'review file changes',
      grantRoot: '/tmp/work',
    },
  }));

  assert.deepEqual(writes, []);
  const approval = byType(events, 'approval_request').at(-1);
  assert.ok(approval, 'file change approval should emit approval_request');
  assert.deepEqual(approval.payload.changes, [
    { path: '/tmp/work/a.txt', kind: 'modify', diff: '-old\n+new\n' },
  ]);
});

test('R1.3 abort sends turn interrupt as a request with the active turn id', async () => {
  const { session, events } = makeSession();
  const writes = attachRpcWriter(session);
  session.sessionId = 'thr_abort';
  session.busy = true;
  session.inputQueue = [{ text: 'queued turn' }];
  session.handleNotification('turn/started', {
    threadId: 'thr_abort',
    turn: { id: 'turn_abort', status: 'inProgress' },
  });

  const aborting = session.abort();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'turn/interrupt');
  assert.ok(writes[0].id, 'interrupt should be a JSON-RPC request with an id');
  assert.deepEqual(writes[0].params, {
    threadId: 'thr_abort',
    turnId: 'turn_abort',
  });

  session.handleLine(JSON.stringify({ id: writes[0].id, result: {} }));
  await aborting;

  assert.equal(session.busy, false);
  assert.equal(session.inputQueue.length, 0);
  assert.equal(session.currentTurnId, null);
  assert.equal(byType(events, 'queue_cleared').at(-1).payload.dropped, 1);
});

test('R1.3 abort timeout still resets local turn state and warns the client', async () => {
  const { session, events } = makeSession();
  const writes = attachRpcWriter(session);
  session.sessionId = 'thr_abort_timeout';
  session.currentTurnId = 'turn_timeout';
  session.interruptTimeoutMs = 5;
  session.busy = true;
  session.inputQueue = [{ text: 'queued turn' }];

  await session.abort();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'turn/interrupt');
  assert.deepEqual(writes[0].params, {
    threadId: 'thr_abort_timeout',
    turnId: 'turn_timeout',
  });
  assert.equal(session.pending.size, 0);
  assert.equal(session.busy, false);
  assert.equal(session.inputQueue.length, 0);
  assert.equal(session.currentTurnId, null);

  const systems = byType(events, 'system');
  const warning = systems.find(event => event.payload.isError === true);
  assert.ok(warning, 'interrupt timeout should emit a system warning');
  assert.match(warning.payload.message, /turn\/interrupt/);
  assert.match(warning.payload.message, /timed out/);
  assert.ok(systems.some(event => event.payload.message === '已中断'));
  assert.equal(byType(events, 'queue_cleared').at(-1).payload.dropped, 1);
});

test('R1.4 server request resolved clears pending approval and emits approval revoked envelope', () => {
  const { session, events } = makeSession();
  session.pendingApprovals.add(123);

  session.handleNotification('serverRequest/resolved', {
    threadId: 'thr_protocol',
    requestId: '123',
  });

  assert.equal(session.pendingApprovals.has(123), false);
  const revoked = byType(events, 'approval_revoked').at(-1);
  assert.ok(revoked, 'resolved server request should emit approval_revoked');
  assert.equal(revoked.payload.approvalId, 123);
  assert.equal(revoked.payload.requestId, '123');
  assert.equal(revoked.payload.threadId, 'thr_protocol');
});

test('R1.4 server request resolved is idempotent when approval is already absent', () => {
  const { session, events } = makeSession();
  session.pendingApprovals.add(456);

  session.handleNotification('serverRequest/resolved', {
    threadId: 'thr_protocol',
    requestId: 456,
  });
  const emittedOnce = byType(events, 'approval_revoked').length;

  assert.doesNotThrow(() => {
    session.handleNotification('serverRequest/resolved', {
      threadId: 'thr_protocol',
      requestId: '456',
    });
    session.handleNotification('serverRequest/resolved', {
      threadId: 'thr_protocol',
      requestId: 'missing',
    });
  });

  assert.equal(session.pendingApprovals.size, 0);
  assert.equal(byType(events, 'approval_revoked').length, emittedOnce);
});
