import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTurnOverrides, buildTurnStartOverrides, effectiveComposerSettings,
  saveCliSettings, loadCliSettings, SETTINGS_STORAGE_KEY } from '../../public/js/cli-settings.js';
import { createMessageRequest } from '../../public/js/message-request.js';
import { ThreadRuntime } from '../../src/agent/agent-appserver.js';

test('permission presets override conflicting raw values through repeated sanitation', () => {
  const clean = sanitizeTurnOverrides({ permission: { mode: 'auto-review' },
    approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' });
  assert.deepEqual(sanitizeTurnOverrides(clean), clean);
  const wire = buildTurnStartOverrides(clean);
  assert.equal(wire.approvalPolicy, 'on-request');
  assert.equal(wire.approvalsReviewer, 'auto_review');
  assert.equal(wire.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(wire.sandboxPolicy.networkAccess, false);
  assert.equal(buildTurnStartOverrides({ permission: { mode: 'ask' } }).approvalsReviewer, 'user');
  assert.equal(buildTurnStartOverrides({ permission: { mode: 'full-access' } }).approvalPolicy, 'never');
});

test('granular policy survives storage, display resolution and outbox serialization', () => {
  const data = new Map();
  const storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
  const input = { granularApproval: { sandbox_approval: true, rules: true }, sandbox: 'read-only' };
  const clean = sanitizeTurnOverrides(input);
  assert.deepEqual(sanitizeTurnOverrides(clean), clean);
  saveCliSettings(storage, clean);
  assert.equal(JSON.parse(data.get(SETTINGS_STORAGE_KEY)).version, 2);
  const loaded = loadCliSettings(storage);
  assert.deepEqual(loaded.approvalPolicy, clean.approvalPolicy);
  const effective = effectiveComposerSettings(loaded, { status: { approvalPolicy: 'never' } });
  const request = createMessageRequest({ text: 'test', turn: effective });
  assert.deepEqual(request.payload.turn.approvalPolicy, clean.approvalPolicy);
});

test('host intent is not repopulated from stale runtime permissions', () => {
  const effective = effectiveComposerSettings({ permission: { mode: 'host' } }, {
    status: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  });
  const clean = sanitizeTurnOverrides(effective);
  assert.deepEqual(clean.permission, { mode: 'host' });
  assert.equal(clean.approvalPolicy, undefined);
  assert.equal(clean.sandbox, undefined);
});

test('invalid explicit permissions fail instead of silently inheriting previous access', () => {
  assert.throws(() => sanitizeTurnOverrides({ permission: { mode: 'typo' } }), /permission/i);
  assert.throws(() => sanitizeTurnOverrides({ permission: { mode: 'custom', custom: {
    approvalPolicy: 'never', sandbox: 'unknown', approvalsReviewer: 'user',
  } } }), /permission/i);
});

test('permission requirements disable forbidden presets and fail closed when unreadable', async () => {
  const session = new ThreadRuntime({ instanceId: 'caps', cwd: '/tmp/work',
    codexBin: process.execPath, onEvent: () => {} });
  session.ensureInitialized = async () => {};
  session.request = async method => {
    if (method === 'configRequirements/read') return { requirements: { allowedSandboxModes: ['workspace-write'] } };
    if (method === 'config/read') return { config: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } };
    return { data: [] };
  };
  const result = await session.readSessionSettings();
  assert.equal(result.available.permissionModes.find(m => m.id === 'full-access').enabled, false);
  assert.equal(result.available.permissionModes.find(m => m.id === 'ask').enabled, true);
  assert.equal(result.available.collaborationModes.includes('plan'), false);
  session.request = async () => { throw new Error('offline'); };
  const unavailable = await session.readSessionSettings();
  assert.ok(unavailable.available.permissionModes.every(m => !m.enabled));
});

test('runtime resets sticky permissions to cwd-resolved host config on the next turn', async () => {
  const calls = [];
  const session = new ThreadRuntime({ instanceId: 'permission-test', resumeId: 'thread-test',
    cwd: '/tmp/work', codexBin: process.execPath, onEvent: () => {} });
  session.ensureInitialized = async () => {};
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'config/read') return { config: { approval_policy: 'on-request',
      approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
      sandbox_workspace_write: { writable_roots: ['/tmp/extra'], network_access: false } } };
    if (method === 'thread/resume') return { thread: { id: 'thread-test' } };
    if (method === 'turn/start') return { turn: { id: 'turn-test' } };
    return {};
  };
  session.applyTurnOverrides({ permission: { mode: 'full-access' }, model: 'test-model' });
  await session.startTurnDispatch('test', [], [], 'request-test', { permission: { mode: 'host' } });
  const wire = calls.find(c => c.method === 'turn/start').params;
  assert.equal(wire.approvalPolicy, 'on-request');
  assert.equal(wire.approvalsReviewer, 'user');
  assert.equal(wire.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(wire.sandboxPolicy.writableRoots, ['/tmp/extra']);
  assert.equal(wire.model, 'test-model');
  assert.equal(calls.find(c => c.method === 'config/read').params.cwd, '/tmp/work');
});

test('forbidden permission cannot start a turn or replace the accepted runtime selection', async () => {
  const session = new ThreadRuntime({ instanceId: 'denied', cwd: '/tmp/work',
    codexBin: process.execPath, onEvent: () => {} });
  session.applyTurnOverrides({ permission: { mode: 'ask' } });
  session.ensureInitialized = async () => {};
  const methods = [];
  session.request = async method => {
    methods.push(method);
    if (method === 'configRequirements/read') return { requirements: { allowedSandboxModes: ['workspace-write'] } };
    return { config: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } };
  };
  const result = await session.startTurnDispatch('test', [], [], 'denied', { permission: { mode: 'full-access' } });
  assert.equal(result.accepted, false);
  assert.ok(!methods.includes('turn/start'));
  assert.equal(session.turnOverrides.permission.mode, 'ask');
});

test('external thread settings update publishes actual permission changes', () => {
  const events = [];
  const session = new ThreadRuntime({ instanceId: 'updated', cwd: '/tmp/work',
    codexBin: process.execPath, onEvent: event => events.push(event) });
  session.handleNotification('thread/settings/updated', { threadId: 'thread', threadSettings: {
    approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    collaborationMode: { mode: 'default' },
  } });
  assert.equal(session.statusPayload('test').effectivePermissions.approvalsReviewer, 'auto_review');
  assert.ok(events.some(event => event.type === 'status'));
});
