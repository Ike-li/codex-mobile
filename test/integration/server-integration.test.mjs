import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as socketClient } from 'socket.io-client';
import webpush from 'web-push';

// server.js 的运行日志走 console.log → stdout，而 node --test 的 child-v8 通道把
// 控制帧和子进程 stdout 复用在同一条流上。这个文件为每个用例 import 一份新的
// server.js（约 60 次），每次都往 stdout 打启动横幅和逐连接日志；帧解析被撞坏时
// 整个文件被判 uncaughtException（"Unable to deserialize cloned data"），报出来是
// `fail 1` 却指不出任何用例。改道到 stderr：诊断信息一条不少，但不再进入控制通道。
console.log = console.error;

const ENV_KEYS = [
  'CODEX_SERVER_NO_START',
  'CODEX_DATA_DIR',
  'WORK_DIR',
  'WORK_DIRS',
  'PORT',
  'HOST',
  'AUTH_TOKEN',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'CODEX_BIN',
  'CODEX_FAKE_RPC_LOG',
  'CODEX_FAKE_SPAWN_LOG',
  'CODEX_ALLOW_REMOTE_IMAGES',
  'CODEX_SESSION_TTL_MS',
  'CODEX_P3_EXPERIMENTAL',
  'CODEX_PUSH_MAX_SUBSCRIPTIONS',
  'CODEX_EVENT_BUFFER_CAP',
  'CODEX_ALLOWED_ORIGINS',
  'CODEX_TRUSTED_PROXY_IPS',
  'CODEX_ALLOW_INSECURE_REMOTE',
  'CODEX_AUTH_MAX_FAILURES',
  'CODEX_AUTH_WINDOW_MS',
  'CODEX_PENDING_DEVICE_LIMIT',
];

test('server lifecycle exposes HTTP and Socket.IO behavior without starting Codex', async () => {
  const fixture = await startIsolatedServer();
  try {
    const health = await fetch(`${fixture.url}/health`, {
      headers: { 'x-auth-token': fixture.authToken },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    const csp = health.headers.get('content-security-policy');
    assert.match(csp, /(?:^|;\s*)script-src 'self'(?:;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.equal((await health.json()).status, 'ok');

    const vapid = await fetch(`${fixture.url}/push/vapid-public-key`);
    assert.equal(vapid.status, 503);
    assert.deepEqual(await vapid.json(), { error: 'push not configured' });

    const subscribe = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
      },
      body: JSON.stringify({ endpoint: 'https://push.example/sub' }),
    });
    assert.equal(subscribe.status, 503);

    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      const init = await waitForAgentEvent(socket, 'init');
      assert.equal(init.payload.cwd, fixture.workDir);
      assert.deepEqual(init.payload.workDirs, [fixture.workDir, fixture.altWorkDir]);

      const threadList = await emitWithAck(socket, 'thread:list', { cwd: fixture.workDir });
      assert.equal(threadList.ok, true);
      assert.ok(Array.isArray(threadList.threads));

      const pendingDevices = await waitForAgentEvent(socket, 'pending_devices');
      assert.deepEqual(pendingDevices.payload.devices, []);

      socket.emit('user:message', { text: '   ' });
      const emptyMessage = await waitForAgentEvent(socket, 'system');
      assert.equal(emptyMessage.payload.isError, true);
      assert.match(emptyMessage.payload.message, /消息为空/);

      socket.emit('user:message', { text: 'x'.repeat(50001) });
      const longMessage = await waitForAgentEvent(socket, 'system');
      assert.equal(longMessage.payload.isError, true);
      assert.match(longMessage.payload.message, /消息过长/);

      const newAck = await emitWithAck(socket, 'session:new', { cwd: fixture.altWorkDir });
      assert.equal(newAck.ok, true);
      assert.ok(newAck.instanceId);
      assert.equal(newAck.threadId, null);
      assert.equal(newAck.cwd, fixture.altWorkDir);
      const switchedInit = await waitForAgentEvent(socket, 'init');
      assert.equal(switchedInit.payload.cwd, fixture.altWorkDir);

      const invalidFork = await emitWithAck(socket, 'session:fork', {});
      assert.equal(invalidFork.ok, false);
      assert.match(invalidFork.error, /没有可分叉/);

      const invalidCancel = await emitWithAck(socket, 'account:loginCancel', {});
      assert.equal(invalidCancel.ok, false);
      assert.match(invalidCancel.error, /无效登录任务/);

      const catchUp = await emitWithAck(socket, 'catch-up', { sessionId: 'missing-session', lastSeq: 0 });
      assert.equal(catchUp.replayed, 0);
      assert.equal(catchUp.gap, false);
      assert.equal(catchUp.errorCode, 'stale_target');
      assert.equal(catchUp.threadId, 'missing-session');

      socket.emit('user:interrupt');
      socket.emit('user:approval', { approvalId: 1, decision: 'decline' });
      socket.emit('session:switch', { instanceId: 'missing-instance' });
      socket.emit('user:approveDevice', { deviceId: '' });
      socket.emit('user:denyDevice', { deviceId: '' });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('stopServer clears every maintenance interval created by startServer', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Map();
  const cleared = new Set();
  let fixture;

  globalThis.setInterval = (callback, delay, ...args) => {
    const handle = originalSetInterval(callback, delay, ...args);
    intervals.set(handle, delay);
    return handle;
  };
  globalThis.clearInterval = handle => {
    if (intervals.has(handle)) cleared.add(handle);
    return originalClearInterval(handle);
  };

  try {
    fixture = await startIsolatedServer();
    await fixture.close();
    fixture = null;

    const maintenanceIntervals = [...intervals]
      .filter(([, delay]) => [4_000, 300_000, 3_600_000].includes(delay))
      .map(([handle]) => handle);
    assert.equal(maintenanceIntervals.length, 5);
    assert.deepEqual(
      maintenanceIntervals.filter(handle => !cleared.has(handle)),
      [],
      'stopServer must clear status, upload, auth-session, failure-window, and agent-reclaim intervals',
    );
  } finally {
    if (fixture) await fixture.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    for (const handle of intervals.keys()) originalClearInterval(handle);
  }
});

test('push subscription rejects unauthenticated requests without persisting them', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  try {
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example/unauthorized',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal(response.status, 401);
    assert.equal(existsSync(join(fixture.dataDir, 'push-subscriptions.json')), false);
  } finally {
    await fixture.close();
  }
});

test('push subscription rejects an authenticated but unapproved device', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  try {
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': 'device-not-approved',
      },
      body: JSON.stringify({
        endpoint: 'https://push.example/unapproved',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'device_not_approved' });
    assert.equal(existsSync(join(fixture.dataDir, 'push-subscriptions.json')), false);
  } finally {
    await fixture.close();
  }
});

test('push subscription binds a sanitized subscription to the approved device', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-approved-push';
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const response = await fetch(`${fixture.url}/push/subscribe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth-token': fixture.authToken,
          'x-device-token': deviceToken,
        },
        body: JSON.stringify({
          endpoint: 'https://push.example/approved',
          keys: { p256dh: 'public-key', auth: 'auth-secret' },
          deviceToken: 'attacker-controlled-device',
          privileged: true,
        }),
      });

      assert.equal(response.status, 200);
      const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
      assert.equal(stored.length, 1);
      assert.equal(stored[0].deviceToken, deviceToken);
      assert.equal(stored[0].endpoint, 'https://push.example/approved');
      assert.deepEqual(stored[0].keys, { p256dh: 'public-key', auth: 'auth-secret' });
      assert.equal(Object.hasOwn(stored[0], 'privileged'), false);
      assert.equal(Object.hasOwn(stored[0], 'createdAt'), true);
      assert.equal(Object.hasOwn(stored[0], 'updatedAt'), true);
      assert.equal(statSync(join(fixture.dataDir, 'push-subscriptions.json')).mode & 0o777, 0o600);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('push subscription reports a persistence failure instead of acknowledging success', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-push-persist-failure';
  const socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
  try {
    await waitForAgentEvent(socket, 'init');
    mkdirSync(join(fixture.dataDir, 'push-subscriptions.json.tmp'));

    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        endpoint: 'https://push.example/persist-failure',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'subscription_persist_failed' });
    assert.equal(existsSync(join(fixture.dataDir, 'push-subscriptions.json')), false);
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('successful push subscription writes a redacted security audit record', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-push-audit-secret';
  const endpoint = 'https://push.example/audit-secret-endpoint';
  const p256dh = 'audit-public-key-secret';
  const auth = 'audit-auth-secret';
  const socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
  try {
    await waitForAgentEvent(socket, 'init');
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({ endpoint, keys: { p256dh, auth } }),
    });
    assert.equal(response.status, 200);

    const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
    assert.match(audit, /"event":"push_subscription"/);
    assert.match(audit, /"action":"subscribe"/);
    assert.match(audit, /"outcome":"success"/);
    for (const secret of [deviceToken, endpoint, p256dh, auth]) {
      assert.doesNotMatch(audit, new RegExp(secret));
    }
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('denying a device removes its bound push subscriptions', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const targetDevice = 'device-push-to-revoke';
  const controllerDevice = 'device-push-controller';
  let targetSocket;
  let controllerSocket;
  try {
    targetSocket = await connectSocket(fixture.url, fixture.authToken, targetDevice);
    await waitForAgentEvent(targetSocket, 'init');
    const subscribed = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': targetDevice,
      },
      body: JSON.stringify({
        endpoint: 'https://push.example/revoked-device',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });
    assert.equal(subscribed.status, 200);

    controllerSocket = await connectSocket(fixture.url, fixture.authToken, controllerDevice);
    await waitForAgentEvent(controllerSocket, 'init');
    const disconnected = once(targetSocket, 'disconnect');
    controllerSocket.emit('user:denyDevice', { deviceId: targetDevice });
    await disconnected;

    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.deepEqual(stored, []);
  } finally {
    if (targetSocket?.connected) targetSocket.disconnect();
    if (controllerSocket?.connected) controllerSocket.disconnect();
    await fixture.close();
  }
});

test('a device replacing its push endpoint keeps only the latest subscription', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-push-endpoint-rotation';
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    await waitForAgentEvent(socket, 'init');
    for (const endpoint of ['https://push.example/old', 'https://push.example/current']) {
      const response = await fetch(`${fixture.url}/push/subscribe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth-token': fixture.authToken,
          'x-device-token': deviceToken,
        },
        body: JSON.stringify({
          endpoint,
          keys: { p256dh: 'public-key', auth: 'auth-secret' },
        }),
      });
      assert.equal(response.status, 200);
    }

    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].deviceToken, deviceToken);
    assert.equal(stored[0].endpoint, 'https://push.example/current');
  } finally {
    if (socket?.connected) socket.disconnect();
    await fixture.close();
  }
});

test('push subscription rejects a non-HTTPS endpoint without persisting it', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid });
  const deviceToken = 'device-push-invalid-endpoint';
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    await waitForAgentEvent(socket, 'init');
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        endpoint: 'http://127.0.0.1/internal-service',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_subscription' });
    assert.equal(existsSync(join(fixture.dataDir, 'push-subscriptions.json')), false);
  } finally {
    if (socket?.connected) socket.disconnect();
    await fixture.close();
  }
});

test('a new bound push subscription drops legacy unbound records', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({
    vapid,
    initialPushSubscriptions: [{
      endpoint: 'https://push.example/legacy-unbound',
      keys: { p256dh: 'legacy-public-key', auth: 'legacy-auth-secret' },
    }],
  });
  const deviceToken = 'device-push-migration';
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    await waitForAgentEvent(socket, 'init');
    const response = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        endpoint: 'https://push.example/current-bound',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });
    assert.equal(response.status, 200);

    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].deviceToken, deviceToken);
    assert.equal(stored[0].endpoint, 'https://push.example/current-bound');
  } finally {
    if (socket?.connected) socket.disconnect();
    await fixture.close();
  }
});

test('push subscription capacity rejects a new device without evicting existing bindings', async () => {
  const vapid = webpush.generateVAPIDKeys();
  const fixture = await startIsolatedServer({ vapid, pushMaxSubscriptions: 1 });
  const firstDevice = 'device-push-capacity-first';
  const secondDevice = 'device-push-capacity-second';
  let firstSocket;
  let secondSocket;
  try {
    firstSocket = await connectSocket(fixture.url, fixture.authToken, firstDevice);
    secondSocket = await connectSocket(fixture.url, fixture.authToken, secondDevice);
    await waitForAgentEvent(firstSocket, 'init');
    await waitForAgentEvent(secondSocket, 'init');

    const subscribe = deviceToken => fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
      body: JSON.stringify({
        endpoint: `https://push.example/${deviceToken}`,
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
    });

    assert.equal((await subscribe(firstDevice)).status, 200);
    const rejected = await subscribe(secondDevice);
    assert.equal(rejected.status, 429);
    assert.deepEqual(await rejected.json(), { error: 'subscription_limit' });

    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].deviceToken, firstDevice);
  } finally {
    if (firstSocket?.connected) firstSocket.disconnect();
    if (secondSocket?.connected) secondSocket.disconnect();
    await fixture.close();
  }
});

test('push delivery skips a persisted subscription whose device is no longer trusted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-stale-push-delivery-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const vapid = webpush.generateVAPIDKeys();
  const delivered = [];
  const originalSendNotification = webpush.sendNotification;
  webpush.sendNotification = async (subscription, payload) => {
    delivered.push({ subscription, payload });
  };
  const staleDevice = 'device-stale-push-binding';
  let fixture;
  let socket;
  try {
    fixture = await startIsolatedServer({
      codexBin,
      rpcLog,
      vapid,
      initialPushSubscriptions: [{
        deviceToken: staleDevice,
        endpoint: 'https://push.example/stale-binding',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }],
    });
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-current-push-controller');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_stale_push',
      cwd: fixture.workDir,
      title: 'Stale push',
    });
    socket.emit('user:message', {
      text: 'request routed approval',
      instanceId: selected.instanceId,
      threadId: 'thr_stale_push',
    });
    await waitForAgentEvent(socket, 'approval_request');
    await new Promise(resolve => setTimeout(resolve, 25));

    assert.deepEqual(delivered, []);
    const stored = JSON.parse(readFileSync(join(fixture.dataDir, 'push-subscriptions.json'), 'utf8'));
    assert.deepEqual(stored, []);
  } finally {
    webpush.sendNotification = originalSendNotification;
    socket?.disconnect();
    if (fixture) await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server routes a running user:message through turn/steer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-steer-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      socket.emit('user:message', { text: 'start long run' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');

      socket.emit('user:message', { text: 'steer while running' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'steer_submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const steer = calls.find(call => call.method === 'turn/steer');
      assert.ok(steer, 'running user:message should call turn/steer');
      assert.deepEqual(steer.params, {
        threadId: 'thr_fake',
        input: [{ type: 'text', text: 'steer while running', text_elements: [] }],
        expectedTurnId: 'turn_fake',
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message requires a stable device identity when clientRequestId is present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-identity-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'must not use socket id for receipts',
        clientRequestId: 'req-without-device',
      });

      assert.equal(ack.ok, false);
      assert.equal(ack.errorCode, 'client_identity_required');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message rejects an oversized clientRequestId before dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-id-limit-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-valid-id-1');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'must not dispatch',
        clientRequestId: `req-${'x'.repeat(129)}`,
      }, 250);

      assert.deepEqual(ack, {
        ok: false,
        errorCode: 'invalid_client_request_id',
        error: 'clientRequestId 格式无效',
        retryable: false,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('socket handshake rejects an oversized deviceToken', async () => {
  const fixture = await startIsolatedServer();
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: {
      token: fixture.authToken,
      deviceToken: `device-${'x'.repeat(129)}`,
    },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'invalid_device_token');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('socket handshake rejects a trivially short deviceToken', async () => {
  const fixture = await startIsolatedServer();
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: {
      token: fixture.authToken,
      deviceToken: 'a',
    },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'invalid_device_token');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('socket handshake rejects an evil browser Origin even with a valid token', async () => {
  const fixture = await startIsolatedServer();
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token: fixture.authToken },
    extraHeaders: { Origin: 'https://evil.example' },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('socket authentication rate-limits repeated invalid tokens from one IP', async () => {
  const fixture = await startIsolatedServer({ authMaxFailures: 2, authWindowMs: 60_000 });
  const attempt = async () => {
    const socket = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: 'wrong-token' },
    });
    try {
      const [error] = await once(socket, 'connect_error');
      return error.message;
    } finally {
      socket.disconnect();
    }
  };
  try {
    assert.equal(await attempt(), 'unauthorized');
    assert.equal(await attempt(), 'unauthorized');
    assert.equal(await attempt(), 'rate_limited');

    const valid = await connectSocket(fixture.url, fixture.authToken);
    valid.disconnect();
  } finally {
    await fixture.close();
  }
});

test('failed socket authentication writes a redacted owner-only security audit record', async () => {
  const fixture = await startIsolatedServer();
  const attemptedToken = 'wrong-secret-must-not-be-logged';
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token: attemptedToken },
  });
  try {
    await once(socket, 'connect_error');
    const auditPath = join(fixture.dataDir, 'security-audit.jsonl');
    assert.equal(statSync(auditPath).mode & 0o777, 0o600);
    const audit = readFileSync(auditPath, 'utf8');
    assert.match(audit, /"event":"auth_failure"/);
    assert.match(audit, /"outcome":"denied"/);
    assert.match(audit, /"ip":"127\.0\.0\.1"/);
    assert.doesNotMatch(audit, new RegExp(attemptedToken));
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('authentication rate limiting emits one audit summary per identity window', async () => {
  const fixture = await startIsolatedServer({ authMaxFailures: 2, authWindowMs: 60_000 });
  try {
    const statuses = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${fixture.url}/auth/session`, {
        method: 'POST',
        headers: { 'x-auth-token': `wrong-token-${index}` },
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [401, 401, 429, 429, 429, 429, 429, 429, 429, 429]);

    // 只数鉴权记录。审计文件里还有 server_restart 之类与本用例无关的条目，
    // 按文件总行数断言会让任何新增的埋点都把这条用例误判成回归。
    const records = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
      .filter(record => record.event === 'session_issue');
    assert.equal(records.length, 3, '达阈值后只该再发一条汇总，不是每次失败都发');
    assert.deepEqual(records.map(record => record.outcome), ['denied', 'denied', 'rate_limited']);
    assert.equal(records[2].attempts, 3);
    assert.equal(Number.isFinite(records[2].resetAt), true);
  } finally {
    await fixture.close();
  }
});

test('an HTTP auth session connects a socket and revocation disconnects and blocks replay', async () => {
  const fixture = await startIsolatedServer();
  const deviceToken = 'device-http-session-revoke';
  let socket;
  let replay;
  try {
    const created = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: {
        'x-auth-token': fixture.authToken,
        'x-device-token': deviceToken,
      },
    });
    assert.equal(created.status, 201);
    const cookie = created.headers.get('set-cookie');
    assert.match(cookie, /^codex_session=[^;]+;/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.equal((await created.json()).ok, true);

    socket = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: { Cookie: cookie.split(';')[0] },
    });
    await once(socket, 'connect');
    const disconnected = once(socket, 'disconnect');

    const revoked = await fetch(`${fixture.url}/auth/session`, {
      method: 'DELETE',
      headers: { Cookie: cookie.split(';')[0] },
    });
    assert.equal(revoked.status, 204);
    await disconnected;

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: { Cookie: cookie.split(';')[0] },
    });
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    socket?.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('HTTP APIs do not accept the static host token from a query string', async () => {
  const fixture = await startIsolatedServer();
  try {
    const response = await fetch(`${fixture.url}/health?token=${encodeURIComponent(fixture.authToken)}`);
    assert.equal(response.status, 401);
  } finally {
    await fixture.close();
  }
});

test('auth session issuance rate-limits repeated invalid host tokens', async () => {
  const fixture = await startIsolatedServer({ authMaxFailures: 2, authWindowMs: 60_000 });
  const attempt = () => fetch(`${fixture.url}/auth/session`, {
    method: 'POST',
    headers: {
      'x-auth-token': 'wrong-token',
      'x-device-token': 'device-session-rate-limit',
    },
  });
  try {
    assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 401);
    const limited = await attempt();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { status: 'rate_limited' });
  } finally {
    await fixture.close();
  }
});

test('denying a device revokes all auth sessions bound to that device', async () => {
  const fixture = await startIsolatedServer();
  const targetDevice = 'device-session-deny-target';
  const cookie = await createAuthSessionCookie(fixture, targetDevice);
  let target;
  let controller;
  let replay;
  try {
    target = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: targetDevice },
      extraHeaders: { Cookie: cookie },
    });
    await once(target, 'connect');
    controller = await connectSocket(fixture.url, fixture.authToken, 'device-session-controller');
    const disconnected = once(target, 'disconnect');
    controller.emit('user:denyDevice', { deviceId: targetDevice });
    await disconnected;

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: targetDevice },
      extraHeaders: { Cookie: cookie },
    });
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    target?.disconnect();
    controller?.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('device denial fails closed and reports trusted-device persistence failure', async () => {
  const fixture = await startIsolatedServer();
  const targetDevice = 'device-deny-persist-failure-target';
  const cookie = await createAuthSessionCookie(fixture, targetDevice);
  writeFileSync(
    join(fixture.dataDir, 'trusted-devices.json'),
    JSON.stringify([targetDevice]),
    { mode: 0o600 },
  );
  let target;
  let controller;
  let replay;
  try {
    target = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: targetDevice },
      extraHeaders: { Cookie: cookie },
    });
    await once(target, 'connect');
    controller = await connectSocket(fixture.url, fixture.authToken, 'device-deny-persist-failure-controller');
    mkdirSync(join(fixture.dataDir, 'trusted-devices.json.tmp'));

    const disconnected = once(target, 'disconnect');
    const result = await emitWithAck(controller, 'user:denyDevice', { deviceId: targetDevice });
    await disconnected;

    assert.deepEqual(result, { ok: false, error: 'device_persist_failed' });
    const trusted = JSON.parse(readFileSync(join(fixture.dataDir, 'trusted-devices.json'), 'utf8'));
    assert.equal(trusted.includes(targetDevice), true);

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: targetDevice },
      extraHeaders: { Cookie: cookie },
    });
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');

    const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
    assert.match(audit, /"action":"deny"/);
    assert.match(audit, /"outcome":"partial"/);
    assert.match(audit, /"reason":"persist_failed"/);
  } finally {
    target?.disconnect();
    controller?.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('device denial writes an owner-only redacted security audit record', async () => {
  const fixture = await startIsolatedServer();
  const targetDevice = 'device-audit-deny-target-secret';
  const controller = await connectSocket(fixture.url, fixture.authToken, 'device-audit-controller');
  try {
    await waitForAgentEvent(controller, 'init');
    await waitForAgentEvent(controller, 'pending_devices');
    controller.emit('user:denyDevice', { deviceId: targetDevice });
    await waitForAgentEvent(controller, 'pending_devices');

    const auditPath = join(fixture.dataDir, 'security-audit.jsonl');
    assert.equal(statSync(auditPath).mode & 0o777, 0o600);
    const audit = readFileSync(auditPath, 'utf8');
    assert.match(audit, /"event":"device_access"/);
    assert.match(audit, /"action":"deny"/);
    assert.match(audit, /"outcome":"success"/);
    assert.match(audit, /"source":"socket"/);
    assert.doesNotMatch(audit, new RegExp(targetDevice));
  } finally {
    controller.disconnect();
    await fixture.close();
  }
});

test('device approval writes a redacted security audit record', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const targetDevice = 'device-audit-approve-target-secret';
  const controllerDevice = 'device-audit-approve-controller';
  const cookie = await createAuthSessionCookie(fixture, targetDevice, { forwardedProto: 'https' });
  const controllerCookie = await createAuthSessionCookie(fixture, controllerDevice, { forwardedProto: 'https' });
  writeFileSync(
    join(fixture.dataDir, 'trusted-devices.json'),
    JSON.stringify([controllerDevice]),
    { mode: 0o600 },
  );
  const target = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken: targetDevice },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  target.__agentEvents = [];
  target.on('agent:event', event => target.__agentEvents.push(event));
  let controller;
  try {
    await once(target, 'connect');
    const pending = await waitForAgentEvent(target, 'device_status');
    assert.equal(pending.payload.status, 'pending');
    controller = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: controllerDevice },
      extraHeaders: {
        Cookie: controllerCookie,
        Origin: 'https://codex.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    controller.__agentEvents = [];
    controller.on('agent:event', event => controller.__agentEvents.push(event));
    await once(controller, 'connect');
    await waitForAgentEvent(controller, 'init');

    controller.emit('user:approveDevice', { deviceId: targetDevice });
    const approved = await waitForAgentEvent(target, 'device_status');
    assert.equal(approved.payload.status, 'approved');

    const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
    assert.match(audit, /"event":"device_access"/);
    assert.match(audit, /"action":"approve"/);
    assert.match(audit, /"outcome":"success"/);
    assert.match(audit, /"source":"socket"/);
    assert.doesNotMatch(audit, new RegExp(targetDevice));
  } finally {
    target.disconnect();
    controller?.disconnect();
    await fixture.close();
  }
});

test('device approval stays locked when trusted-device persistence fails', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const targetDevice = 'device-approve-persist-failure-target';
  const controllerDevice = 'device-approve-persist-failure-controller';
  const cookie = await createAuthSessionCookie(fixture, targetDevice, { forwardedProto: 'https' });
  const controllerCookie = await createAuthSessionCookie(fixture, controllerDevice, { forwardedProto: 'https' });
  writeFileSync(
    join(fixture.dataDir, 'trusted-devices.json'),
    JSON.stringify([controllerDevice]),
    { mode: 0o600 },
  );
  const target = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken: targetDevice },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  target.__agentEvents = [];
  target.on('agent:event', event => target.__agentEvents.push(event));
  let controller;
  try {
    await once(target, 'connect');
    const pending = await waitForAgentEvent(target, 'device_status');
    assert.equal(pending.payload.status, 'pending');

    controller = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken: controllerDevice },
      extraHeaders: {
        Cookie: controllerCookie,
        Origin: 'https://codex.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    controller.__agentEvents = [];
    controller.on('agent:event', event => controller.__agentEvents.push(event));
    await once(controller, 'connect');
    await waitForAgentEvent(controller, 'init');

    mkdirSync(join(fixture.dataDir, 'trusted-devices.json.tmp'));
    const result = await emitWithAck(controller, 'user:approveDevice', { deviceId: targetDevice });

    assert.deepEqual(result, { ok: false, error: 'device_persist_failed' });
    assert.equal(target.connected, true);
    assert.equal(
      target.__agentEvents.some(event => event?.type === 'device_status' && event.payload?.status === 'approved'),
      false,
    );
    const trusted = JSON.parse(readFileSync(join(fixture.dataDir, 'trusted-devices.json'), 'utf8'));
    assert.equal(trusted.includes(targetDevice), false);
  } finally {
    target.disconnect();
    controller?.disconnect();
    await fixture.close();
  }
});

test('atomically removing a trusted device externally disconnects it and revokes session replay', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const deviceToken = 'device-external-trust-revoke';
  const trustedPath = join(fixture.dataDir, 'trusted-devices.json');
  const cookie = await createAuthSessionCookie(fixture, deviceToken, { forwardedProto: 'https' });
  writeFileSync(trustedPath, JSON.stringify([deviceToken]), { mode: 0o600 });
  const socketOptions = {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  };
  const socket = socketClient(fixture.url, socketOptions);
  socket.__agentEvents = [];
  socket.on('agent:event', event => socket.__agentEvents.push(event));
  let replay;
  try {
    await once(socket, 'connect');
    await waitForAgentEvent(socket, 'init');
    const disconnected = once(socket, 'disconnect');

    const replacement = `${trustedPath}.external.tmp`;
    writeFileSync(replacement, '[]', { mode: 0o600 });
    renameSync(replacement, trustedPath);

    let revocationTimeout;
    try {
      await Promise.race([
        disconnected,
        new Promise((_, reject) => {
          revocationTimeout = setTimeout(
            () => reject(new Error('trusted device revocation was not observed')),
            1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(revocationTimeout);
    }

    replay = socketClient(fixture.url, socketOptions);
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    socket.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

// D2：web 上要能看到当前接入的设备并撤销其中一个。devices:list 出于最小暴露只回 16 位
// deviceRef，而 user:denyDevice 要完整 token——两者对不上，基于列表的 UI 就撤销不了任何东西。
test('设备面板能按列表里的引用撤销设备，无需知道完整 token', async () => {
  const keep = 'device-panel-keep-0000000000000001';
  const drop = 'device-panel-drop-0000000000000002';
  const fixture = await startIsolatedServer({ initialTrustedDevices: [keep, drop] });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, keep);
    try {
      const listed = await emitWithAck(socket, 'devices:list', {});
      assert.equal(listed.ok, true);
      const target = listed.devices.find(item => item.deviceRef === drop.slice(0, 16));
      assert.ok(target, '列表里应当能看到另一台设备');
      assert.equal(target.deviceRef.length, 16, '列表只暴露引用，不暴露完整 token');

      const revoked = await emitWithAck(socket, 'devices:revoke', { deviceRef: target.deviceRef });
      assert.equal(revoked.ok, true, '应当能用列表给出的引用直接撤销');

      const after = await emitWithAck(socket, 'devices:list', {});
      assert.deepEqual(after.devices.map(item => item.deviceRef), [keep.slice(0, 16)]);
    } finally {
      socket.close();
    }
  } finally {
    await fixture.close();
  }
});

// 上一条只验证了「设备从列表里消失」。真正要紧的是那台设备**当下连着的 socket**：
// 撤销之后它必须立刻失去授权并被断开，否则界面上撤销成功了，被撤的设备还在照常收发。
//
// 这里还区分了一个此前从没被区分过的点：外部文件变化那条路径传 preserveLocalSockets: true
// （保住本机会话不误伤），而 devices:revoke **不传，默认 false**——显式撤销就是要断开，
// 哪怕对方是本机。夹具里所有连接都走 127.0.0.1，所以这条正好覆盖那个方向。
test('撤销设备会立刻踢掉它当下连着的 socket，本机连接也不例外', async () => {
  const admin = 'device-revoke-admin-000000000001';
  const victim = 'device-revoke-victim-00000000002';
  const fixture = await startIsolatedServer({ initialTrustedDevices: [admin, victim] });
  try {
    const adminSocket = await connectSocket(fixture.url, fixture.authToken, admin);
    const victimSocket = await connectSocket(fixture.url, fixture.authToken, victim);
    try {
      const victimDisconnected = once(victimSocket, 'disconnect');

      const revoked = await emitWithAck(adminSocket, 'devices:revoke', {
        deviceRef: victim.slice(0, 16),
      });
      assert.equal(revoked.ok, true);
      await victimDisconnected;

      const denial = victimSocket.__agentEvents.find(event => (
        event?.type === 'device_status' && event?.payload?.status === 'denied'
      ));
      assert.ok(denial, '被撤销的设备要先收到一条 denied，再被断开——否则它不知道发生了什么');
      assert.equal(denial.payload.deviceId, victim);

      // ⚠ 反直觉方向，写下来免得被当成 bug「修好」：
      // **撤销一台设备并不能阻止它从本机重连。** server.js:1075 的
      // `if (isLocal) socket.deviceApproved = true` 是无条件的——设备闸防的是远程接入，
      // 而能在本机跑进程的人本来就有完整访问权，再挡一道只会砍掉 loopback 的可用性。
      //
      // 这条断言的价值在于把这个方向钉死：将来谁把 isLocal 那条去掉，这里会红，
      // 并且会读到上面这段解释。
      const retry = socketClient(fixture.url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        auth: { token: fixture.authToken, deviceToken: victim },
      });
      try {
        const outcome = await Promise.race([
          once(retry, 'connect').then(() => ({ kind: 'connected' })),
          once(retry, 'connect_error').then(([error]) => ({ kind: 'error', error })),
        ]);
        assert.equal(outcome.kind, 'connected', '本机重连仍然放行');

        // 而且是真的可用，不是「连上但被闸拦着」。未批准设备的事件会被静默丢弃（不回 ack），
        // 所以拿得到 ack 就说明它确实被当成已批准。
        const listed = await emitWithAck(retry, 'devices:list', {});
        assert.equal(listed.ok, true, '本机连接无条件批准，受控事件照常响应');
      } finally {
        retry.disconnect();
      }

      // 撤销别人不该波及管理端自己。
      assert.equal(adminSocket.connected, true, '发起撤销的那台设备不该被一起踢掉');
      const stillListed = await emitWithAck(adminSocket, 'devices:list', {});
      assert.deepEqual(stillListed.devices.map(item => item.deviceRef), [admin.slice(0, 16)]);
    } finally {
      adminSocket.close();
      victimSocket.close();
    }
  } finally {
    await fixture.close();
  }
});

test('atomically removing an offline trusted device revokes its session and Push binding', async () => {
  const deviceToken = 'device-offline-external-revoke';
  const endpoint = 'https://push.example/offline-external-revoke';
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
    initialTrustedDevices: [deviceToken],
    initialPushSubscriptions: [{
      deviceToken,
      endpoint,
      keys: { p256dh: 'public-key', auth: 'auth-secret' },
    }],
  });
  const trustedPath = join(fixture.dataDir, 'trusted-devices.json');
  const pushPath = join(fixture.dataDir, 'push-subscriptions.json');
  const cookie = await createAuthSessionCookie(fixture, deviceToken, { forwardedProto: 'https' });
  let replay;
  try {
    const replacement = `${trustedPath}.external.tmp`;
    writeFileSync(replacement, '[]', { mode: 0o600 });
    renameSync(replacement, trustedPath);

    await waitForCondition(
      () => JSON.parse(readFileSync(pushPath, 'utf8')).length === 0,
      'offline device Push binding was not revoked',
    );

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: {
        Cookie: cookie,
        Origin: 'https://codex.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    const outcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    replay?.disconnect();
    await fixture.close();
  }
});

test('external trust removal preserves an active loopback socket while revoking its session', async () => {
  const deviceToken = 'device-loopback-trust-file-removal';
  const fixture = await startIsolatedServer({
    initialTrustedDevices: [deviceToken],
    initialPushSubscriptions: [{
      deviceToken,
      endpoint: 'https://push.example/loopback-trust-file-removal',
      keys: { p256dh: 'public-key', auth: 'auth-secret' },
    }],
  });
  const trustedPath = join(fixture.dataDir, 'trusted-devices.json');
  const pushPath = join(fixture.dataDir, 'push-subscriptions.json');
  const cookie = await createAuthSessionCookie(fixture, deviceToken);
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken },
    extraHeaders: { Cookie: cookie },
  });
  let replay;
  try {
    await once(socket, 'connect');
    const replacement = `${trustedPath}.external.tmp`;
    writeFileSync(replacement, '[]', { mode: 0o600 });
    renameSync(replacement, trustedPath);
    await waitForCondition(
      () => JSON.parse(readFileSync(pushPath, 'utf8')).length === 0,
      'loopback device Push binding was not revoked',
    );

    assert.equal(socket.connected, true);
    const catchUp = await emitWithAck(socket, 'catch-up', {
      instanceId: 'missing-instance',
      sessionId: 'missing-thread',
      lastSeq: 0,
    });
    assert.equal(catchUp.errorCode, 'stale_target');

    replay = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: { Cookie: cookie },
    });
    const replayOutcome = await Promise.race([
      once(replay, 'connect').then(() => ({ kind: 'connected' })),
      once(replay, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(replayOutcome.kind, 'error');
    assert.equal(replayOutcome.error.message, 'unauthorized');
  } finally {
    socket.disconnect();
    replay?.disconnect();
    await fixture.close();
  }
});

test('trusted-proxy HTTP requests fail closed unless forwarded as HTTPS', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  try {
    const insecure = await fetch(`${fixture.url}/health`, {
      headers: { 'x-auth-token': fixture.authToken },
    });
    assert.equal(insecure.status, 426);
    assert.deepEqual(await insecure.json(), {
      status: 'secure_transport_required',
      errorCode: 'forwarded_proto_required',
    });

    const secure = await fetch(`${fixture.url}/health`, {
      headers: {
        'x-auth-token': fixture.authToken,
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(secure.status, 200);
  } finally {
    await fixture.close();
  }
});

test('a device behind a trusted proxy is not auto-approved as loopback', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const deviceToken = 'device-proxied-pending';
  const cookie = await createAuthSessionCookie(fixture, deviceToken, { forwardedProto: 'https' });
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  socket.__agentEvents = [];
  socket.on('agent:event', event => socket.__agentEvents.push(event));
  try {
    await once(socket, 'connect');
    const status = await waitForAgentEvent(socket, 'device_status');
    assert.equal(status.payload.status, 'pending');
    assert.equal(status.payload.deviceId, deviceToken);
    assert.equal(socket.__agentEvents.some(event => event.type === 'init'), false);
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('a remote socket cannot use the static host token without an auth session', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: {
      token: fixture.authToken,
      deviceToken: 'device-static-token-remote',
    },
    extraHeaders: {
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('remote device pairing rejects new devices after the pending capacity is reached', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
    pendingDeviceLimit: 1,
  });
  const firstDevice = 'device-pairing-first';
  const secondDevice = 'device-pairing-second';
  const firstCookie = await createAuthSessionCookie(fixture, firstDevice, { forwardedProto: 'https' });
  const secondCookie = await createAuthSessionCookie(fixture, secondDevice, { forwardedProto: 'https' });
  const optionsFor = (deviceToken, cookie) => ({
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { deviceToken },
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  const first = socketClient(fixture.url, optionsFor(firstDevice, firstCookie));
  let second;
  try {
    await once(first, 'connect');
    second = socketClient(fixture.url, optionsFor(secondDevice, secondCookie));
    const outcome = await Promise.race([
      once(second, 'connect').then(() => ({ kind: 'connected' })),
      once(second, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'pairing_capacity');

    const pending = JSON.parse(readFileSync(join(fixture.dataDir, 'pending-devices.json'), 'utf8'));
    assert.deepEqual(pending.map(device => device.deviceToken), [firstDevice]);
  } finally {
    first.disconnect();
    second?.disconnect();
    await fixture.close();
  }
});

test('a remote auth session cannot be replayed without its bound deviceToken', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const cookie = await createAuthSessionCookie(fixture, 'device-session-bound-remote', { forwardedProto: 'https' });
  const socket = socketClient(fixture.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: {},
    extraHeaders: {
      Cookie: cookie,
      Origin: 'https://codex.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  try {
    const outcome = await Promise.race([
      once(socket, 'connect').then(() => ({ kind: 'connected' })),
      once(socket, 'connect_error').then(([error]) => ({ kind: 'error', error })),
    ]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.error.message, 'unauthorized');
  } finally {
    socket.disconnect();
    await fixture.close();
  }
});

test('user:message acknowledges an invalid empty request instead of leaving its result unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-invalid-ack-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-invalid-message');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: '   ',
        clientRequestId: 'req-invalid-empty',
      }, 250);

      assert.deepEqual(ack, {
        ok: false,
        errorCode: 'invalid_message',
        error: '消息为空或格式无效',
        retryable: false,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message acknowledges invalid attachments with a non-retryable error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-invalid-attachment-ack-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-invalid-attachment');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'invalid attachment',
        attachments: [{ name: 'empty.txt', mimeType: 'text/plain', data: '' }],
        clientRequestId: 'req-invalid-attachment',
      }, 250);

      assert.deepEqual(ack, {
        ok: false,
        errorCode: 'invalid_attachments',
        error: '附件缺少数据',
        retryable: false,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message deterministically rejects a non-array attachments payload before fingerprinting', async () => {
  const fixture = await startIsolatedServer();
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-non-array-attachment');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'crafted attachment shape',
        attachments: { data: 'aA==' },
        clientRequestId: 'req-non-array-attachment',
      }, 500);

      assert.deepEqual(ack, {
        ok: false,
        errorCode: 'invalid_attachments',
        error: '附件必须是数组',
        retryable: false,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('Socket.IO accepts a valid attachment whose wire payload exceeds the default 1 MB limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-large-wire-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-large-wire-message');
    try {
      await waitForAgentEvent(socket, 'init');
      const clientRequestId = 'req-large-wire-attachment';
      const data = Buffer.alloc(1024 * 1024, 0x61).toString('base64');
      assert.ok(data.length > 1_000_000);
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'valid large wire payload',
        attachments: [{ name: 'large.txt', mimeType: 'text/plain', data }],
        clientRequestId,
      }, 5000);

      assert.equal(ack.ok, true);
      assert.equal(ack.receipt.clientRequestId, clientRequestId);
      assert.equal(socket.connected, true);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message acknowledges an oversized message with a non-retryable error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-too-long-ack-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-message-too-long');
    try {
      await waitForAgentEvent(socket, 'init');
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'x'.repeat(50001),
        clientRequestId: 'req-message-too-long',
      }, 250);

      assert.equal(ack.ok, false);
      assert.equal(ack.errorCode, 'message_too_long');
      assert.equal(ack.retryable, false);
      assert.match(ack.error, /上限 50000/);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message replays the original receipt and dispatches once when clientRequestId is retried after a lost ack', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-idempotency-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-receipt-replay');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_receipt', cwd: fixture.workDir, title: 'Receipt',
      });
      const payload = {
        text: 'dispatch exactly once',
        clientRequestId: 'req-retry-after-lost-ack',
        instanceId: selected.instanceId,
        threadId: 'thr_receipt',
      };

      socket.emit('user:message', payload);
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');
      const retry = await emitWithAck(socket, 'user:message', payload);

      assert.equal(retry.ok, true);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.receipt.clientRequestId, payload.clientRequestId);
      assert.equal(retry.receipt.instanceId, selected.instanceId);
      assert.equal(retry.receipt.threadId, 'thr_receipt');
      assert.equal(retry.receipt.state, 'submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer');
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0].params.clientUserMessageId, payload.clientRequestId);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('message reconciliation finds a persisted client request after a gateway restart without replaying it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-reconcile-restart-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createPersistentReceiptCodexBin(root);
  const deviceToken = 'device-reconcile-after-restart';
  const clientRequestId = 'req-reconcile-after-restart';
  let firstGatewayEpoch;
  let firstFixture = null;
  let secondFixture = null;
  try {
    firstFixture = await startIsolatedServer({ codexBin, rpcLog });
    const firstSocket = await connectSocket(firstFixture.url, firstFixture.authToken, deviceToken);
    try {
      const init = await waitForAgentEvent(firstSocket, 'init');
      firstGatewayEpoch = init.payload.gatewayEpoch;
      assert.match(firstGatewayEpoch, /^[a-f0-9]{32}$/);
      const selected = await emitWithAck(firstSocket, 'thread:select', {
        threadId: 'thr_reconcile_restart',
        cwd: firstFixture.workDir,
      });
      firstSocket.emit('user:message', {
        text: 'do not replay after restart',
        clientRequestId,
        instanceId: selected.instanceId,
        threadId: 'thr_reconcile_restart',
      });
      await waitForAgentEventMatching(
        firstSocket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
    } finally {
      firstSocket.disconnect();
    }
    await firstFixture.close();
    firstFixture = null;

    secondFixture = await startIsolatedServer({ codexBin, rpcLog });
    const secondSocket = await connectSocket(secondFixture.url, secondFixture.authToken, deviceToken);
    try {
      const init = await waitForAgentEvent(secondSocket, 'init');
      assert.match(init.payload.gatewayEpoch, /^[a-f0-9]{32}$/);
      assert.notEqual(init.payload.gatewayEpoch, firstGatewayEpoch);

      const reconciliation = await emitWithAck(secondSocket, 'message:reconcile', {
        clientRequestId,
        threadId: 'thr_reconcile_restart',
        attemptedGatewayEpoch: firstGatewayEpoch,
        cwd: secondFixture.workDir,
      });

      assert.equal(reconciliation.ok, true);
      assert.equal(reconciliation.resolved, true);
      assert.equal(reconciliation.source, 'thread/read');
      assert.equal(reconciliation.gatewayEpoch, init.payload.gatewayEpoch);
      assert.deepEqual(reconciliation.receipt, {
        clientRequestId,
        threadId: 'thr_reconcile_restart',
        turnId: 'turn_reconcile_restart',
        itemId: 'user_reconcile_restart',
        state: 'submitted',
      });

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => (
        call.method === 'turn/start'
        && call.params?.clientUserMessageId === clientRequestId
      ));
      assert.equal(dispatches.length, 1);
    } finally {
      secondSocket.disconnect();
    }
  } finally {
    if (firstFixture) await firstFixture.close();
    if (secondFixture) await secondFixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('message reconciliation uses the current gateway receipt before requiring a stable thread id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-reconcile-current-gateway-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  const clientRequestId = 'req-reconcile-current-gateway';
  try {
    const socket = await connectSocket(
      fixture.url,
      fixture.authToken,
      'device-reconcile-current-gateway',
    );
    try {
      const init = await waitForAgentEvent(socket, 'init');
      socket.emit('user:message', {
        text: 'recover the missing acknowledgement',
        clientRequestId,
      });
      await waitForAgentEventMatching(
        socket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );

      const reconciliation = await emitWithAck(socket, 'message:reconcile', {
        clientRequestId,
        attemptedGatewayEpoch: init.payload.gatewayEpoch,
        cwd: fixture.workDir,
      });

      assert.equal(reconciliation.ok, true);
      assert.equal(reconciliation.resolved, true);
      assert.equal(reconciliation.source, 'receipt_ledger');
      assert.equal(reconciliation.receipt.clientRequestId, clientRequestId);
      assert.equal(reconciliation.receipt.threadId, 'thr_fake');
      assert.equal(reconciliation.receipt.state, 'submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => (
        call.method === 'turn/start'
        && call.params?.clientUserMessageId === clientRequestId
      ));
      assert.equal(dispatches.length, 1);
      assert.equal(calls.some(call => call.method === 'thread/read'), false);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message replays a receipt after reconnecting with the same device identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-reconnect-receipt-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  const deviceToken = 'device-reconnect-receipt';
  try {
    const firstSocket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    let payload;
    try {
      await waitForAgentEvent(firstSocket, 'init');
      const selected = await emitWithAck(firstSocket, 'thread:select', {
        threadId: 'thr_reconnect_receipt', cwd: fixture.workDir, title: 'Reconnect receipt',
      });
      payload = {
        text: 'survive socket reconnect',
        clientRequestId: 'req-reconnect-receipt',
        instanceId: selected.instanceId,
        threadId: 'thr_reconnect_receipt',
      };
      firstSocket.emit('user:message', payload);
      await waitForAgentEventMatching(
        firstSocket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
    } finally {
      firstSocket.disconnect();
    }

    const secondSocket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
    try {
      await waitForAgentEvent(secondSocket, 'init');
      const { instanceId: _volatileInstanceId, ...logicalRetry } = payload;
      const replay = await emitWithAck(secondSocket, 'user:message', logicalRetry);

      assert.equal(replay.ok, true);
      assert.equal(replay.duplicate, true);
      assert.equal(replay.receipt.clientRequestId, payload.clientRequestId);
      assert.equal(replay.receipt.state, 'submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call =>
        (call.method === 'turn/start' || call.method === 'turn/steer')
        && call.params?.clientUserMessageId === payload.clientRequestId
      );
      assert.equal(dispatches.length, 1);
    } finally {
      secondSocket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message rejects a reused clientRequestId when the message payload changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-id-conflict-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-receipt-conflict');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_receipt_conflict', cwd: fixture.workDir, title: 'Receipt conflict',
      });
      const request = {
        text: 'original message',
        clientRequestId: 'req-conflicting-reuse',
        instanceId: selected.instanceId,
        threadId: 'thr_receipt_conflict',
      };

      socket.emit('user:message', request);
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');
      const conflict = await emitWithAck(socket, 'user:message', {
        ...request,
        text: 'different message with the same id',
      });

      assert.equal(conflict.ok, false);
      assert.equal(conflict.errorCode, 'request_id_conflict');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer');
      assert.equal(dispatches.length, 1);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent identical user:message requests share one pending dispatch and attachment save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-message-single-flight-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-receipt-single-flight');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_single_flight', cwd: fixture.workDir, title: 'Single flight',
      });
      const payload = {
        text: 'send attachment once',
        attachments: [{
          name: 'once.txt',
          mimeType: 'text/plain',
          data: Buffer.from('one durable upload').toString('base64'),
        }],
        clientRequestId: 'req-single-flight',
        instanceId: selected.instanceId,
        threadId: 'thr_single_flight',
      };

      const results = await Promise.all([
        emitWithAck(socket, 'user:message', payload),
        emitWithAck(socket, 'user:message', payload),
      ]);

      assert.equal(results.every(result => result.ok), true);
      assert.equal(results.filter(result => result.duplicate === false).length, 1);
      assert.equal(results.filter(result => result.duplicate === true).length, 1);
      assert.deepEqual(results[0].receipt, results[1].receipt);
      assert.equal(readdirSync(join(fixture.workDir, '.ccm-uploads')).length, 1);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer');
      assert.equal(dispatches.length, 1);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachment fingerprint uses decoded bytes instead of base64 spelling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-attachment-fingerprint-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-attachment-fingerprint');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_attachment_fingerprint', cwd: fixture.workDir, title: 'Attachment fingerprint',
      });
      const padded = Buffer.from('same file byte').toString('base64');
      assert.match(padded, /=+$/);
      const request = {
        text: 'same attachment bytes',
        attachments: [{ name: 'same.txt', mimeType: 'text/plain', data: padded }],
        clientRequestId: 'req-attachment-fingerprint',
        instanceId: selected.instanceId,
        threadId: 'thr_attachment_fingerprint',
      };

      const first = await emitWithAck(socket, 'user:message', request);
      const retry = await emitWithAck(socket, 'user:message', {
        ...request,
        attachments: [{
          ...request.attachments[0],
          data: padded.replace(/=+$/, ''),
        }],
      });

      assert.equal(first.ok, true);
      assert.equal(retry.ok, true);
      assert.equal(retry.duplicate, true);
      assert.equal(readdirSync(join(fixture.workDir, '.ccm-uploads')).length, 1);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatches = calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer');
      assert.equal(dispatches.length, 1);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message saves attachments inside the selected thread cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-attachment-target-cwd-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-attachment-cwd');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_attachment_alt_cwd',
        cwd: fixture.altWorkDir,
        title: 'Attachment alt cwd',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'read the attached file',
        attachments: [{
          name: 'target.txt',
          mimeType: 'text/plain',
          data: Buffer.from('target cwd content').toString('base64'),
        }],
        clientRequestId: 'req-attachment-alt-cwd',
        instanceId: selected.instanceId,
        threadId: 'thr_attachment_alt_cwd',
      });

      assert.equal(ack.ok, true);
      assert.equal(readdirSync(join(fixture.altWorkDir, '.ccm-uploads')).length, 1);
      assert.equal(existsSync(join(fixture.workDir, '.ccm-uploads')), false);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message sends a verified PNG upload as localImage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-local-image-input-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-local-image-input');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_local_image_input', cwd: fixture.workDir, title: 'Local image input',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'inspect the pixel',
        attachments: [{
          name: 'pixel.png',
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        }],
        clientRequestId: 'req-local-image-input',
        instanceId: selected.instanceId,
        threadId: 'thr_local_image_input',
      });

      assert.equal(ack.ok, true);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatch = calls.find(call => call.method === 'turn/start');
      assert.deepEqual(dispatch.params.input[0], {
        type: 'text', text: 'inspect the pixel', text_elements: [],
      });
      assert.equal(dispatch.params.input[1].type, 'localImage');
      assert.match(dispatch.params.input[1].path, /\.ccm-uploads\/.*pixel\.png$/);
      assert.equal(dispatch.params.input[1].path.includes('[附件]'), false);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message resolves a mention-only part before sending structured UserInput', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-mention-input-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const mentionedPath = join(fixture.workDir, 'mentioned.txt');
    writeFileSync(mentionedPath, 'mention me');
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-mention-input');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_mention_input', cwd: fixture.workDir, title: 'Mention input',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: '',
        parts: [{ kind: 'mention', name: 'spoofed-name', path: mentionedPath }],
        clientRequestId: 'req-mention-input',
        instanceId: selected.instanceId,
        threadId: 'thr_mention_input',
      });

      assert.equal(ack.ok, true);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatch = calls.find(call => call.method === 'turn/start');
      assert.deepEqual(dispatch.params.input, [{
        type: 'mention',
        name: 'mentioned.txt',
        path: realpathSync(mentionedPath),
      }]);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message revalidates a selected skill against skills/list before dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-skill-input-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const skillPath = join(fixture.workDir, '.agents', 'skills', 'release', 'SKILL.md');
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-skill-input');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_skill_input', cwd: fixture.workDir, title: 'Skill input',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'use release skill',
        parts: [{ kind: 'skill', name: 'release', path: skillPath }],
        clientRequestId: 'req-skill-input',
        instanceId: selected.instanceId,
        threadId: 'thr_skill_input',
      });

      assert.equal(ack.ok, true);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dispatch = calls.find(call => call.method === 'turn/start');
      assert.deepEqual(dispatch.params.input, [
        { type: 'text', text: 'use release skill', text_elements: [] },
        { type: 'skill', name: 'release', path: skillPath },
      ]);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('queued user:message replays its later submitted receipt without dispatching twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-queued-receipt-transition-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createQueuedTransitionCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-queued-transition');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_queued_transition', cwd: fixture.workDir, title: 'Queued transition',
      });

      socket.emit('user:message', {
        text: 'block while turn id is unknown',
        instanceId: selected.instanceId,
        threadId: 'thr_queued_transition',
      });
      await waitForAgentEventMatching(
        socket,
        'status',
        event => event.payload?.reason === 'turn_started',
      );

      const payload = {
        text: 'queue and later submit once',
        clientRequestId: 'req-queued-transition',
        instanceId: selected.instanceId,
        threadId: 'thr_queued_transition',
      };
      const queued = await emitWithAck(socket, 'user:message', payload);
      assert.equal(queued.ok, true);
      assert.equal(queued.receipt.state, 'queued');

      await waitForAgentEventMatching(
        socket,
        'message_receipt',
        event => event.payload?.clientRequestId === payload.clientRequestId
          && event.payload?.state === 'submitted',
      );
      const retry = await emitWithAck(socket, 'user:message', payload);

      assert.equal(retry.ok, true);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.receipt.state, 'submitted');
      assert.equal(retry.receipt.turnId, 'turn_queued_transition');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const queuedDispatches = calls.filter(call =>
        call.method === 'turn/start'
        && call.params?.clientUserMessageId === payload.clientRequestId
      );
      assert.equal(queuedDispatches.length, 1);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server keeps each socket message bound to its selected thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-socket-thread-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');

      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_socket_a',
        cwd: fixture.workDir,
        title: 'Socket A',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_socket_b',
        cwd: fixture.workDir,
        title: 'Socket B',
      });
      assert.equal(selectedA.ok, true);
      assert.equal(selectedB.ok, true);

      socketA.emit('user:message', {
        text: 'message from socket A',
        threadId: 'thr_socket_a',
        instanceId: selectedA.instanceId,
      });

      const submitted = await waitForAgentEventMatching(
        socketA,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      assert.equal(submitted.instanceId, selectedA.instanceId);
      assert.equal(submitted.sessionId, 'thr_socket_a');
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two sockets selecting the same thread share its single runtime owner', async () => {
  const fixture = await startIsolatedServer();
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');

      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_shared_owner',
        cwd: fixture.workDir,
        title: 'Shared owner',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_shared_owner',
        cwd: fixture.workDir,
        title: 'Shared owner',
      });

      assert.equal(selectedA.ok, true);
      assert.equal(selectedB.ok, true);
      assert.equal(selectedB.instanceId, selectedA.instanceId);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('two different thread runtimes share one app-server process on the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-shared-host-process-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const spawnLog = join(root, 'spawn.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog, spawnLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_shared_host_a', cwd: fixture.workDir, title: 'Shared host A',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_shared_host_b', cwd: fixture.workDir, title: 'Shared host B',
      });

      socketA.emit('user:message', {
        text: 'run on shared host A',
        instanceId: selectedA.instanceId,
        threadId: 'thr_shared_host_a',
      });
      socketB.emit('user:message', {
        text: 'run on shared host B',
        instanceId: selectedB.instanceId,
        threadId: 'thr_shared_host_b',
      });
      await waitForAgentEventMatching(socketA, 'status', event => event.payload?.reason === 'turn_submitted');
      await waitForAgentEventMatching(socketB, 'status', event => event.payload?.reason === 'turn_submitted');

      const spawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(spawns.length, 1);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared host keeps interleaved responses and notifications isolated by thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-shared-host-multiplex-test-'));
  const wireLog = join(root, 'wire.jsonl');
  const codexBin = createMultiplexFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog: wireLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    const seenA = [];
    const seenB = [];
    socketA.on('agent:event', event => seenA.push(event));
    socketB.on('agent:event', event => seenB.push(event));
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_mux_a', cwd: fixture.workDir, title: 'Mux A',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_mux_b', cwd: fixture.workDir, title: 'Mux B',
      });
      seenA.length = 0;
      seenB.length = 0;

      const [sentA, sentB] = await Promise.all([
        emitWithAck(socketA, 'user:message', {
          text: 'start mux A', instanceId: selectedA.instanceId, threadId: 'thr_mux_a',
        }),
        emitWithAck(socketB, 'user:message', {
          text: 'start mux B', instanceId: selectedB.instanceId, threadId: 'thr_mux_b',
        }),
      ]);
      assert.equal(sentA.ok, true);
      assert.equal(sentB.ok, true);
      await waitForAgentEvent(socketA, 'result');
      await waitForAgentEvent(socketB, 'result');

      const privateA = seenA.filter(event => event?.seq > 0);
      const privateB = seenB.filter(event => event?.seq > 0);
      assert.equal(privateA.every(event => event.instanceId === selectedA.instanceId), true);
      assert.equal(privateB.every(event => event.instanceId === selectedB.instanceId), true);
      assert.deepEqual(
        privateA.filter(event => event.type === 'text_delta').map(event => event.payload.text),
        ['A-one', 'A-two'],
      );
      assert.deepEqual(
        privateB.filter(event => event.type === 'text_delta').map(event => event.payload.text),
        ['B-one', 'B-two'],
      );
      assert.equal(
        seenB.some(event => event?.type === 'instances'
          && event.payload?.instances?.some(instance =>
            instance.instanceId === selectedA.instanceId && instance.busy === true
          )),
        true,
      );
      assert.equal(
        privateB.some(event => event.type === 'thread_status' && event.instanceId === selectedA.instanceId),
        false,
      );

      const wire = readFileSync(wireLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(wire.filter(entry => entry.kind === 'spawn').length, 1);
      assert.equal(wire.filter(entry => entry.kind === 'in' && entry.frame?.method === 'initialize').length, 1);
      assert.equal(wire.filter(entry => entry.kind === 'in' && entry.frame?.method === 'initialized').length, 1);
      assert.deepEqual(
        wire.filter(entry => entry.kind === 'in' && entry.frame?.method === 'thread/resume')
          .map(entry => entry.frame.params.threadId).sort(),
        ['thr_mux_a', 'thr_mux_b'],
      );
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server sends thread events only to sockets viewing that thread instance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-socket-thread-events-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');

      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_events_a',
        cwd: fixture.workDir,
        title: 'Events A',
      });
      await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_events_b',
        cwd: fixture.workDir,
        title: 'Events B',
      });
      socketA.__agentEvents.length = 0;
      socketB.__agentEvents.length = 0;

      socketA.emit('user:message', {
        text: 'private event for socket A',
        threadId: 'thr_events_a',
        instanceId: selectedA.instanceId,
      });
      await waitForAgentEventMatching(
        socketA,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      await new Promise(resolve => setTimeout(resolve, 25));

      const foreignEvents = socketB.__agentEvents.filter(event =>
        event?.seq > 0 && event?.instanceId === selectedA.instanceId
      );
      assert.deepEqual(foreignEvents, []);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message rejects a mismatched instance and thread target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-stale-thread-target-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_stale_a',
        cwd: fixture.workDir,
        title: 'Stale A',
      });
      const selectedB = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_current_b',
        cwd: fixture.workDir,
        title: 'Current B',
      });

      const rejected = await emitWithAck(socket, 'user:message', {
        text: 'must never execute',
        instanceId: selectedB.instanceId,
        threadId: 'thr_stale_a',
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.errorCode, 'stale_target');

      const calls = existsSync(rpcLog)
        ? readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        : [];
      const dispatched = calls.some(call =>
        (call.method === 'turn/start' || call.method === 'turn/steer')
        && call.params?.input?.some(item => item.text === 'must never execute')
      );
      assert.equal(dispatched, false);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:interrupt stops only the explicitly targeted thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-thread-interrupt-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_interrupt_a', cwd: fixture.workDir, title: 'Interrupt A',
      });
      const selectedB = await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_interrupt_b', cwd: fixture.workDir, title: 'Interrupt B',
      });

      socketA.emit('user:message', {
        text: 'run A', instanceId: selectedA.instanceId, threadId: 'thr_interrupt_a',
      });
      socketB.emit('user:message', {
        text: 'run B', instanceId: selectedB.instanceId, threadId: 'thr_interrupt_b',
      });
      await waitForAgentEventMatching(socketA, 'status', event => event.payload?.reason === 'turn_submitted');
      await waitForAgentEventMatching(socketB, 'status', event => event.payload?.reason === 'turn_submitted');

      const interrupted = await emitWithAck(socketA, 'user:interrupt', {
        instanceId: selectedA.instanceId,
        threadId: 'thr_interrupt_a',
        turnId: 'turn_fake',
      });
      assert.equal(interrupted.ok, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const interrupts = calls
        .filter(call => call.method === 'turn/interrupt')
        .map(call => call.params.threadId);
      assert.deepEqual(interrupts, ['thr_interrupt_a']);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:approval resolves only the explicitly targeted thread request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-thread-approval-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_approval_a', cwd: fixture.workDir, title: 'Approval A',
      });
      await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_approval_b', cwd: fixture.workDir, title: 'Approval B',
      });

      socketA.emit('user:message', {
        text: 'request routed approval',
        instanceId: selectedA.instanceId,
        threadId: 'thr_approval_a',
      });
      const request = await waitForAgentEvent(socketA, 'approval_request');
      assert.equal(request.sessionId, 'thr_approval_a');

      const resolved = await emitWithAck(socketA, 'user:approval', {
        instanceId: selectedA.instanceId,
        threadId: 'thr_approval_a',
        turnId: 'turn_fake',
        itemId: 'item_approval',
        approvalId: request.payload.approvalId,
        decision: 'accept',
      });
      assert.equal(resolved.ok, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const decisions = calls.filter(call => call.id === 9001 && call.result?.decision);
      assert.deepEqual(decisions, [{ id: 9001, result: { decision: 'accept' } }]);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy approval requests receive exact routing identities and resolve through needs-you', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-legacy-approval-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-legacy-approval');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_legacy_approval', cwd: fixture.workDir, title: 'Legacy approval',
    });
    socket.emit('user:message', {
      text: 'request legacy approval',
      instanceId: selected.instanceId,
      threadId: 'thr_legacy_approval',
    });
    const request = await waitForAgentEvent(socket, 'approval_request');
    assert.equal(request.payload.threadId, 'thr_legacy_approval');
    assert.equal(request.payload.turnId, 'turn_fake');
    assert.equal(request.payload.itemId, 'legacy_patch_call');

    const snapshot = await emitWithAck(socket, 'needs-you:snapshot', {});
    assert.equal(snapshot.needs.length, 1);
    const [need] = snapshot.needs;
    assert.deepEqual(need.target, {
      instanceId: selected.instanceId,
      threadId: 'thr_legacy_approval',
      turnId: 'turn_fake',
      itemId: 'legacy_patch_call',
      requestId: 9005,
    });

    const resolved = await emitWithAck(socket, 'user:approval', {
      needId: need.needId,
      ...need.target,
      approvalId: need.target.requestId,
      decision: 'accept',
    });
    assert.equal(resolved.ok, true);
    const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(calls.find(call => call.id === 9005 && call.result), {
      id: 9005,
      result: { decision: 'approved' },
    });
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('needs-you resolution writes a redacted central security audit record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-audit-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  const deviceToken = 'device-needs-audit-secret';
  const threadId = 'thr_needs_audit_secret';
  const socket = await connectSocket(fixture.url, fixture.authToken, deviceToken);
  try {
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId,
      cwd: fixture.workDir,
      title: 'Needs audit',
    });
    socket.emit('user:message', {
      text: 'request routed approval',
      instanceId: selected.instanceId,
      threadId,
    });
    const request = await waitForAgentEvent(socket, 'approval_request');
    const resolved = await emitWithAck(socket, 'user:approval', {
      instanceId: selected.instanceId,
      threadId,
      turnId: 'turn_fake',
      itemId: 'item_approval',
      approvalId: request.payload.approvalId,
      decision: 'accept',
    });
    assert.equal(resolved.ok, true);

    const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
    assert.match(audit, /"event":"need_resolution"/);
    assert.match(audit, /"outcome":"resolved"/);
    for (const secret of [deviceToken, threadId, 'pwd', 'request routed approval']) {
      assert.doesNotMatch(audit, new RegExp(secret));
    }
  } finally {
    socket.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh device snapshots and resolves one pending need exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-snapshot-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  let socketA;
  let socketB;
  try {
    socketA = await connectSocket(fixture.url, fixture.authToken, 'device-needs-origin');
    await waitForAgentEvent(socketA, 'init');
    const selected = await emitWithAck(socketA, 'thread:select', {
      threadId: 'thr_needs_snapshot', cwd: fixture.workDir, title: 'Needs snapshot',
    });
    socketA.emit('user:message', {
      text: 'request routed approval',
      instanceId: selected.instanceId,
      threadId: 'thr_needs_snapshot',
    });
    await waitForAgentEvent(socketA, 'approval_request');

    socketB = await connectSocket(fixture.url, fixture.authToken, 'device-needs-fresh');
    await waitForAgentEvent(socketB, 'init');
    const snapshot = await emitWithAck(socketB, 'needs-you:snapshot', {});
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.needs.length, 1);
    const [need] = snapshot.needs;
    assert.equal(typeof need.needId, 'string');
    assert.equal(need.kind, 'approval');
    assert.equal(need.state, 'pending');
    assert.deepEqual(need.target, {
      instanceId: selected.instanceId,
      threadId: 'thr_needs_snapshot',
      turnId: 'turn_fake',
      itemId: 'item_approval',
      requestId: 9001,
    });

    const resolution = {
      needId: need.needId,
      ...need.target,
      approvalId: need.target.requestId,
      decision: 'accept',
    };
    const resolved = await emitWithAck(socketB, 'user:approval', resolution);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.duplicate, false);
    assert.equal(resolved.needId, need.needId);
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.revision, 2);

    const changed = await waitForAgentEvent(socketB, 'needs_you_changed');
    assert.equal(changed.payload.need.needId, need.needId);
    assert.equal(changed.payload.need.state, 'resolved');

    const after = await emitWithAck(socketB, 'needs-you:snapshot', {});
    assert.deepEqual(after.needs, []);

    const duplicate = await emitWithAck(socketB, 'user:approval', resolution);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);

    const conflict = await emitWithAck(socketB, 'user:approval', {
      ...resolution,
      decision: 'decline',
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.errorCode, 'already_resolved');

    const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const decisions = calls.filter(call => call.id === 9001 && call.result?.decision);
    assert.deepEqual(decisions, [{ id: 9001, result: { decision: 'accept' } }]);
  } finally {
    if (socketA?.connected) socketA.disconnect();
    if (socketB?.connected) socketB.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an upstream resolved request is removed from the needs-you snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-revoked-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-needs-revoked');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_needs_revoked', cwd: fixture.workDir, title: 'Needs revoked',
    });
    socket.emit('user:message', {
      text: 'request revoked approval',
      instanceId: selected.instanceId,
      threadId: 'thr_needs_revoked',
    });
    await waitForAgentEvent(socket, 'approval_request');
    await waitForAgentEvent(socket, 'approval_revoked');
    const changed = await waitForAgentEventMatching(
      socket,
      'needs_you_changed',
      event => event.payload?.need?.state === 'revoked',
    );
    assert.equal(changed.payload.need.target.threadId, 'thr_needs_revoked');

    const snapshot = await emitWithAck(socket, 'needs-you:snapshot', {});
    assert.deepEqual(snapshot.needs, []);
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a terminal turn failure expires unresolved needs-you entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-expired-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-needs-expired');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_needs_expired', cwd: fixture.workDir, title: 'Needs expired',
    });
    socket.emit('user:message', {
      text: 'request failed approval',
      instanceId: selected.instanceId,
      threadId: 'thr_needs_expired',
    });
    await waitForAgentEvent(socket, 'approval_request');
    await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_failed');
    const changed = await waitForAgentEventMatching(
      socket,
      'needs_you_changed',
      event => event.payload?.need?.state === 'expired',
    );
    assert.equal(changed.payload.need.target.threadId, 'thr_needs_expired');
    assert.deepEqual((await emitWithAck(socket, 'needs-you:snapshot', {})).needs, []);
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// 【为什么单独加这条】TURN_TERMINAL_REASONS 有两个消费者，对它的依赖强度不同：
//   - trackNeedsYou 还认 envelope.type === 'error'，而 finishTurnFailure 是先 emit('error')
//     再 emitStatus(reason)，所以 needs-you 在 error 那一步就过期了——上面那条用例覆盖的是
//     这条路径，reason 判断对它其实是冗余的。
//   - syncRuntimeIdentity 只认 'result' 和 status.reason，**不认 'error'**。turn 失败时
//     唯一能让它释放 registry 的 turn 绑定的，就是 status(turn_failed)。
// 变异实测证实了这个缺口：把 'turn_failed' 从集合里删掉，全量 1043 条单测依然全绿。
// 绑定不释放的后果是 registry 里留着一个永不失效的 turnId，后续用它定向的请求会被
// 路由到一个早已结束的 turn 上，而不是 fail-closed 地拒绝。
test('turn 失败后 registry 释放 turn 绑定，旧 turnId 不再能定向', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-turn-release-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-turn-release');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_turn_release', cwd: fixture.workDir, title: 'Turn release',
    });
    socket.emit('user:message', {
      text: 'request failed approval',
      instanceId: selected.instanceId,
      threadId: 'thr_turn_release',
    });
    const approval = await waitForAgentEvent(socket, 'approval_request');
    const turnId = approval.payload?.turnId;
    assert.ok(turnId, '前置：审批请求必须带 turnId，否则这条用例观察不到绑定');

    await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_failed');

    // registry.resolve 是 fail-closed 的：任一标识未知就抛 stale，即使 instanceId 仍然有效。
    // 所以 turn 绑定有没有被释放，可以直接用这个旧 turnId 定向来观察。
    const stale = await emitWithAck(socket, 'user:interrupt', { turnId });
    assert.equal(stale.ok, false, 'turn 已终结，旧 turnId 不该还能定向到 runtime');
    assert.equal(stale.errorCode, 'stale_target');
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an app-server exit expires unresolved needs-you entries immediately', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-needs-you-process-exit-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  let socket;
  try {
    socket = await connectSocket(fixture.url, fixture.authToken, 'device-needs-process-exit');
    await waitForAgentEvent(socket, 'init');
    const selected = await emitWithAck(socket, 'thread:select', {
      threadId: 'thr_needs_process_exit', cwd: fixture.workDir, title: 'Needs process exit',
    });
    socket.emit('user:message', {
      text: 'request exited approval',
      instanceId: selected.instanceId,
      threadId: 'thr_needs_process_exit',
    });
    await waitForAgentEvent(socket, 'approval_request');
    await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'process_exit');
    const changed = await waitForAgentEventMatching(
      socket,
      'needs_you_changed',
      event => event.payload?.need?.state === 'expired',
    );
    assert.equal(changed.payload.need.target.threadId, 'thr_needs_process_exit');
    assert.equal(changed.payload.need.payload.closeReason, 'process_exit');
    assert.deepEqual((await emitWithAck(socket, 'needs-you:snapshot', {})).needs, []);
  } finally {
    socket?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:approval rejects a mismatched item without consuming the pending request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-approval-item-target-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_approval_item', cwd: fixture.workDir, title: 'Approval Item',
      });
      socket.emit('user:message', {
        text: 'request routed approval',
        instanceId: selected.instanceId,
        threadId: 'thr_approval_item',
      });
      const request = await waitForAgentEvent(socket, 'approval_request');

      const mismatched = await emitWithAck(socket, 'user:approval', {
        instanceId: selected.instanceId,
        threadId: 'thr_approval_item',
        turnId: 'turn_fake',
        itemId: 'wrong_item',
        approvalId: request.payload.approvalId,
        decision: 'accept',
      });
      assert.equal(mismatched.ok, false);
      assert.equal(mismatched.errorCode, 'stale_target');

      const resolved = await emitWithAck(socket, 'user:approval', {
        instanceId: selected.instanceId,
        threadId: 'thr_approval_item',
        turnId: 'turn_fake',
        itemId: 'item_approval',
        approvalId: request.payload.approvalId,
        decision: 'accept',
      });
      assert.equal(resolved.ok, true);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session:switch changes only that socket fallback target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-socket-switch-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const firstA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_switch_a', cwd: fixture.workDir, title: 'Switch A',
      });
      await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_switch_a2', cwd: fixture.workDir, title: 'Switch A2',
      });
      await emitWithAck(socketB, 'thread:select', {
        threadId: 'thr_switch_b', cwd: fixture.workDir, title: 'Switch B',
      });

      const switched = await emitWithAck(socketA, 'session:switch', {
        instanceId: firstA.instanceId,
      });
      assert.equal(switched.ok, true);
      assert.equal(switched.instanceId, firstA.instanceId);

      socketA.emit('user:message', { text: 'legacy socket-targeted message' });
      const submitted = await waitForAgentEventMatching(
        socketA,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      assert.equal(submitted.sessionId, 'thr_switch_a');
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session:new returns and binds a provisional instance to the requesting socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-new-session-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const created = await emitWithAck(socket, 'session:new', { cwd: fixture.workDir });
      assert.equal(created.ok, true);
      assert.ok(created.instanceId);
      assert.equal(created.threadId, null);

      socket.emit('user:message', { text: 'first provisional message' });
      const submitted = await waitForAgentEventMatching(
        socket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      assert.equal(submitted.instanceId, created.instanceId);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisional instance events stay private before thread/start returns an id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-provisional-event-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      const created = await emitWithAck(socketA, 'session:new', { cwd: fixture.workDir });
      assert.equal(created.ok, true);
      assert.equal(created.threadId, null);

      socketA.__agentEvents.length = 0;
      socketB.__agentEvents.length = 0;
      socketA.emit('user:message', {
        text: 'first private provisional message',
        instanceId: created.instanceId,
      });
      await waitForAgentEventMatching(
        socketA,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      await new Promise(resolve => setTimeout(resolve, 25));

      const leaked = socketB.__agentEvents.filter(event =>
        event?.seq > 0 && event?.instanceId === created.instanceId
      );
      assert.deepEqual(leaked, []);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread selection does not overwrite another socket view state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-socket-view-state-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socketA = await connectSocket(fixture.url, fixture.authToken);
    const socketB = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socketA, 'init');
      await waitForAgentEvent(socketB, 'init');
      socketA.__agentEvents.length = 0;
      socketB.__agentEvents.length = 0;

      const selectedA = await emitWithAck(socketA, 'thread:select', {
        threadId: 'thr_view_a', cwd: fixture.workDir, title: 'View A',
      });
      await new Promise(resolve => setTimeout(resolve, 25));

      const foreignInit = socketB.__agentEvents.find(event =>
        event?.type === 'init' && event?.payload?.sessionId === 'thr_view_a'
      );
      assert.equal(foreignInit, undefined);
      const latestInstances = socketB.__agentEvents
        .filter(event => event?.type === 'instances')
        .at(-1);
      assert.notEqual(latestInstances?.payload?.viewingInstanceId, selectedA.instanceId);
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread selection acknowledges the target before emitting its scoped init', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-thread-select-order-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const order = [];
      const onEvent = event => {
        if (event?.type === 'init' && event?.payload?.sessionId === 'thr_ordered') order.push('init');
      };
      socket.on('agent:event', onEvent);
      await new Promise((resolve, reject) => {
        socket.timeout(5000).emit('thread:select', {
          threadId: 'thr_ordered', cwd: fixture.workDir, title: 'Ordered',
        }, (err, ack) => {
          if (err) return reject(err);
          assert.equal(ack.ok, true);
          order.push('ack');
          resolve();
        });
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      socket.off('agent:event', onEvent);
      assert.deepEqual(order.slice(0, 2), ['ack', 'init']);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('host thread status reaches every approved device without loading that thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-host-thread-status-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createExternalThreadStatusCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  let first;
  let second;
  try {
    first = await connectSocket(fixture.url, fixture.authToken, 'device-host-status-first');
    second = await connectSocket(fixture.url, fixture.authToken, 'device-host-status-second');
    await waitForAgentEvent(first, 'init');
    await waitForAgentEvent(second, 'init');

    const firstStatus = waitForAgentEventMatching(first, 'thread_status', event => (
      event.payload?.scope === 'host' && event.payload?.threadId === 'thr_external_status'
    ));
    const secondStatus = waitForAgentEventMatching(second, 'thread_status', event => (
      event.payload?.scope === 'host' && event.payload?.threadId === 'thr_external_status'
    ));
    const list = await emitWithAck(first, 'thread:list', { cwd: fixture.workDir });
    const [eventA, eventB] = await Promise.all([firstStatus, secondStatus]);

    assert.equal(list.ok, true);
    assert.deepEqual(list.threads[0].status, { type: 'active', activeFlags: ['waitingOnApproval'] });
    assert.equal(list.threads[0].statusRevision, 1);
    assert.deepEqual(eventA.payload, eventB.payload);
    assert.deepEqual(eventA.payload, {
      scope: 'host',
      threadId: 'thr_external_status',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      revision: 1,
    });
    assert.equal(eventA.seq, 0);
    assert.equal(eventA.instanceId, null);
    assert.equal(eventA.sessionId, null);

    const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.some(call => (
      call.method === 'thread/resume' && call.params?.threadId === 'thr_external_status'
    )), false);
  } finally {
    first?.disconnect();
    second?.disconnect();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('catch-up replays only the explicitly targeted thread buffer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-catch-up-routing-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_catch_up', cwd: fixture.workDir, title: 'Catch Up',
      });
      socket.emit('user:message', {
        text: 'buffered event',
        instanceId: selected.instanceId,
        threadId: 'thr_catch_up',
      });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');
      socket.__agentEvents.length = 0;

      const replay = await emitWithAck(socket, 'catch-up', {
        instanceId: selected.instanceId,
        sessionId: 'thr_catch_up',
        lastSeq: 0,
      });
      assert.ok(replay.replayed > 0);
      assert.equal(replay.instanceId, selected.instanceId);
      assert.equal(replay.threadId, 'thr_catch_up');
      assert.equal(socket.__agentEvents.every(event => event.instanceId === selected.instanceId), true);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('catch-up rebuilds when the client epoch differs even without a buffer gap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-catch-up-epoch-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_epoch_recovery', cwd: fixture.workDir, title: 'Epoch Recovery',
      });
      socket.emit('user:message', {
        text: 'establish runtime epoch',
        instanceId: selected.instanceId,
        threadId: 'thr_epoch_recovery',
      });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');
      socket.__agentEvents.length = 0;

      const recovery = await emitWithAck(socket, 'catch-up', {
        instanceId: selected.instanceId,
        sessionId: 'thr_epoch_recovery',
        lastSeq: 999,
        lastEpoch: 'stale-runtime-epoch',
      });

      assert.equal(recovery.gap, true);
      assert.equal(recovery.rebuilt, true);
      assert.equal(recovery.replayed, 0);
      assert.equal(recovery.threadId, 'thr_epoch_recovery');
      assert.equal(recovery.snapshot.source, 'thread/read');
      assert.deepEqual(
        socket.__agentEvents.filter(event => event?.seq > 0).map(event => ({
          seq: event.seq, type: event.type, reason: event.payload?.reason,
        })),
        [],
      );
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('catch-up gap rebuilds the exact thread with thread/read instead of replaying a truncated tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-catch-up-gap-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createGapRecoveryCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog, eventBufferCap: 10 });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_gap_recovery', cwd: fixture.workDir, title: 'Gap Recovery',
      });
      socket.emit('user:message', {
        text: 'overflow recovery buffer',
        instanceId: selected.instanceId,
        threadId: 'thr_gap_recovery',
      });
      await waitForAgentEvent(socket, 'result');
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_completed');
      socket.__agentEvents.length = 0;

      const recovery = await emitWithAck(socket, 'catch-up', {
        instanceId: selected.instanceId,
        sessionId: 'thr_gap_recovery',
        lastSeq: 1,
      });

      assert.equal(recovery.gap, true);
      assert.equal(recovery.rebuilt, true);
      assert.equal(recovery.replayed, 0);
      assert.equal(recovery.instanceId, selected.instanceId);
      assert.equal(recovery.threadId, 'thr_gap_recovery');
      assert.equal(typeof recovery.epoch, 'string');
      assert.equal(Number.isInteger(recovery.throughSeq), true);
      assert.deepEqual(recovery.snapshot, {
        source: 'thread/read',
        title: 'Recovered gap thread',
        threadStatus: { type: 'idle' },
        messages: [
          { role: 'user', content: 'persisted question' },
          { role: 'assistant', content: 'persisted answer' },
        ],
      });
      const liveDuringRead = socket.__agentEvents.filter(event => event?.seq > 0);
      assert.deepEqual(liveDuringRead.map(event => event.type), ['thread_status', 'status']);
      assert.ok(
        liveDuringRead.every(event => recovery.throughSeq < event.seq),
        'snapshot watermark must be frozen before thread/read so concurrent live events are replayed',
      );

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const reads = calls.filter(call => call.method === 'thread/read');
      assert.equal(reads.length, 1);
      assert.deepEqual(reads[0].params, { threadId: 'thr_gap_recovery', includeTurns: true });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server forks the active app-server thread into a new viewed instance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-fork-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      socket.emit('user:message', { text: 'source turn' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');

      const ack = await emitWithAck(socket, 'session:fork', { ephemeral: true });
      assert.equal(ack.ok, true);
      assert.equal(ack.sessionId, 'thr_forked');
      assert.ok(ack.instanceId);

      const init = await waitForAgentEventMatching(socket, 'init', event => event.payload?.sessionId === 'thr_forked');
      assert.equal(init.payload.cwd, fixture.workDir);

      const instances = await waitForAgentEventMatching(socket, 'instances', event => event.payload?.viewingInstanceId === ack.instanceId);
      assert.ok(instances.payload.instances.some(item => item.instanceId === ack.instanceId && item.sessionId === 'thr_forked'));

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const fork = calls.find(call => call.method === 'thread/fork');
      assert.ok(fork, 'session:fork should call thread/fork');
      assert.deepEqual(fork.params, {
        threadId: 'thr_fake',
        cwd: fixture.workDir,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ephemeral: true,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server starts chatgpt device-code login and forwards account notifications', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-login-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const ack = await emitWithAck(socket, 'account:loginStart', { type: 'chatgptDeviceCode' });
      assert.equal(ack.ok, true);
      assert.equal(ack.loginId, 'login_fake');
      assert.equal(ack.userCode, 'ABCD-EFGH');
      assert.equal(ack.verificationUrl, 'https://openai.com/device');

      const pending = await waitForAgentEventMatching(socket, 'account_login', event => event.payload?.status === 'pending');
      assert.equal(pending.payload.loginId, 'login_fake');

      const completed = await waitForAgentEventMatching(socket, 'account_login', event => event.payload?.status === 'completed');
      assert.equal(completed.payload.success, true);

      const updated = await waitForAgentEvent(socket, 'account_updated');
      assert.deepEqual(updated.payload, { authMode: 'chatgpt', planType: 'plus' });

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const loginStart = calls.find(call => call.method === 'account/login/start');
      assert.deepEqual(loginStart.params, { type: 'chatgptDeviceCode' });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread:list preserves UTF-8 when an app-server frame splits inside a code point', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-transport-utf8-integration-test-'));
  const codexBin = createChunkedUtf8CodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const result = await emitWithAck(socket, 'thread:list', { cwd: fixture.workDir });

      assert.equal(result.ok, true);
      assert.equal(result.threads[0].title, '跨端会话');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread:collaborationMode updates a loaded thread without sending a user message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-collab-mode-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const fixture = await startIsolatedServer({
    codexBin: createFakeCodexBin(root),
    rpcLog,
  });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const empty = await emitWithAck(socket, 'session:new', { cwd: fixture.workDir });
      assert.equal(empty.threadId, null);
      const deferred = await emitWithAck(socket, 'thread:collaborationMode', { mode: 'plan', cwd: fixture.workDir });
      assert.equal(deferred.ok, true);
      assert.equal(deferred.applied, false);
      assert.equal(deferred.deferred, true);
      assert.equal(deferred.mode, 'plan');

      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_fake',
        cwd: fixture.workDir,
      });
      assert.equal(selected.ok, true);
      const applied = await emitWithAck(socket, 'thread:collaborationMode', {
        threadId: 'thr_fake',
        mode: 'plan',
        cwd: fixture.workDir,
      });
      assert.equal(applied.ok, true);
      assert.equal(applied.applied, true);
      assert.equal(applied.mode, 'plan');

      const event = await waitForAgentEvent(socket, 'collaboration_mode');
      assert.equal(event.payload.mode, 'plan');
      assert.equal(event.payload.applied, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(calls.some(call => call.method === 'thread/settings/update'));
      assert.ok(!calls.some(call => call.method === 'turn/start'));
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread:collaborationMode defers when app-server rejects the experimental method', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-collab-mode-unsupported-'));
  const fixture = await startIsolatedServer({
    codexBin: createUnsupportedCollaborationModeCodexBin(root),
  });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      await emitWithAck(socket, 'thread:select', { threadId: 'thr_fake', cwd: fixture.workDir });
      const result = await emitWithAck(socket, 'thread:collaborationMode', {
        threadId: 'thr_fake',
        mode: 'plan',
        cwd: fixture.workDir,
      });
      assert.equal(result.ok, true);
      assert.equal(result.applied, false);
      assert.equal(result.deferred, true);
      assert.equal(result.reason, 'unsupported');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server exposes P1 native app-server controls over Socket.IO', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-p1-controls-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const threadList = await emitWithAck(socket, 'thread:list', { archived: false });
      assert.equal(threadList.ok, true);
      assert.equal(threadList.threads[0].id, 'thr_fake');

      assert.equal((await emitWithAck(socket, 'thread:rename', { threadId: 'thr_fake', name: 'Mobile run' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:archive', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:unarchive', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:compact', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:review', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:review', { threadId: 'thr_fake', instructions: '看并发' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:rollback', { threadId: 'thr_fake', numTurns: 2 })).ok, true);

      const compact = await waitForAgentEvent(socket, 'compact');
      assert.equal(compact.payload.status, 'compacted');

      const models = await emitWithAck(socket, 'models:read', {});
      assert.equal(models.ok, true);
      assert.equal(models.models[0].model, 'gpt-5.5');
      assert.equal(models.capabilities.webSearch, true);

      const dir = await emitWithAck(socket, 'fs:readDirectory', { path: fixture.workDir });
      assert.equal(dir.ok, true);
      assert.equal(dir.entries[0].fileName, 'README.md');

      const file = await emitWithAck(socket, 'fs:readFile', { path: join(fixture.workDir, 'README.md') });
      assert.equal(file.ok, true);
      assert.equal(Buffer.from(file.dataBase64, 'base64').toString('utf8'), 'hello from fake file');

      // app-server 的 fs/* 收任意绝对路径。作用域必须由服务端兜住，否则任何已认证设备
      // 都能读走 ~/.ssh/id_rsa 和 ~/.codex/auth.json，而凭据外泄撤销设备也收不回。
      const outsideFile = join(root, 'outside-secret');
      writeFileSync(outsideFile, 'private key material');
      const escaped = await emitWithAck(socket, 'fs:readFile', { path: outsideFile });
      assert.equal(escaped.ok, false, '工作区外的文件必须被拒绝');
      assert.match(escaped.error, /工作区/);
      const escapedDir = await emitWithAck(socket, 'fs:readDirectory', { path: root });
      assert.equal(escapedDir.ok, false, '工作区外的目录必须被拒绝');

      writeFileSync(join(fixture.workDir, 'src-app.js'), 'export const ok = true\n');
      const search = await emitWithAck(socket, 'files:search', { cwd: fixture.workDir, query: 'src-app' });
      assert.equal(search.ok, true);
      assert.ok(search.paths.includes('src-app.js'));

      const ping = await emitWithAck(socket, 'conn:ping', {});
      assert.equal(ping.ok, true);
      assert.equal(typeof ping.t, 'number');

      const git = await emitWithAck(socket, 'git:status', { cwd: fixture.workDir });
      assert.equal(git.ok, false);
      assert.equal(git.errorCode, 'not_git');

      const account = await emitWithAck(socket, 'account:read', {});
      assert.equal(account.ok, true);
      assert.equal(account.account.account.type, 'chatgpt');
      assert.equal(account.usage.summary.lifetimeTokens, 123);
      assert.equal(account.rateLimits.rateLimits.limitId, 'codex');

      const mcp = await emitWithAck(socket, 'mcp:read', {});
      assert.equal(mcp.ok, true);
      assert.equal(mcp.servers[0].name, 'github');

      const skills = await emitWithAck(socket, 'skills:read', {});
      assert.equal(skills.ok, true);
      assert.equal(skills.entries[0].cwd, fixture.workDir);

      const detected = await emitWithAck(socket, 'externalAgentConfig:detect', {});
      assert.equal(detected.ok, true);
      assert.equal(detected.items[0].description, 'AGENTS.md');

      const imported = await emitWithAck(socket, 'externalAgentConfig:import', { migrationItems: detected.items });
      assert.equal(imported.ok, true);
      assert.equal(imported.importId, 'import_fake');

      const deleted = await emitWithAck(socket, 'thread:delete', { threadId: 'thr_fake' });
      assert.equal(deleted.ok, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const methods = calls.map(call => call.method).filter(Boolean);
      for (const method of [
        'thread/list',
        'thread/name/set',
        'thread/archive',
        'thread/unarchive',
        'thread/compact/start',
        'review/start',
        'thread/rollback',
        'model/list',
        'modelProvider/capabilities/read',
        'fs/readDirectory',
        'fs/readFile',
        'account/read',
        'account/usage/read',
        'account/rateLimits/read',
        'mcpServerStatus/list',
        'skills/list',
        'externalAgentConfig/detect',
        'externalAgentConfig/import',
        'thread/delete',
      ]) {
        assert.ok(methods.includes(method), `expected ${method}`);
      }

      // review 的目标和投递方式要真的落到 app-server：inline 决定审查结果走当前
      // thread 的事件流，手机端才不用为一条 review thread 单独订阅。
      const reviews = calls.filter(call => call.method === 'review/start' && call.params);
      assert.deepEqual(reviews[0].params.target, { type: 'uncommittedChanges' });
      assert.equal(reviews[0].params.delivery, 'inline');
      // 这份日志是 fake bin 记的 app-server 侧原始入参，指令必须原样抵达；
      // 我们自己落盘那份的打码由 rpc-log-redaction 的单测守。
      assert.deepEqual(reviews[1].params.target, { type: 'custom', instructions: '看并发' });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server reads and resumes native app-server threads without local session metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-native-thread-history-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const history = await emitWithAck(socket, 'thread:history', { threadId: 'thr_fake' });
      assert.equal(history.ok, true);
      assert.equal(history.source, 'thread/read');
      assert.equal(history.thread.id, 'thr_fake');
      assert.deepEqual(history.messages, [
        { role: 'user', content: 'hello from native thread\n@README.md\n$release\n[Image]' },
        { role: 'assistant', content: 'hello from Codex app-server' },
      ]);

      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_fake',
        cwd: fixture.workDir,
        title: 'Fake thread',
      });
      assert.equal(selected.ok, true);
      assert.equal(selected.sessionId, 'thr_fake');

      socket.emit('user:message', { text: 'continue native thread' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const resume = calls.find(call => call.method === 'thread/resume');
      assert.ok(resume, 'selected native thread should resume through app-server');
      assert.equal(resume.params.threadId, 'thr_fake');

      const turnStart = calls.find(call =>
        call.method === 'turn/start'
        && call.params?.input?.[0]?.text === 'continue native thread'
      );
      assert.ok(turnStart, 'follow-up should be sent to the selected native thread');
      assert.equal(turnStart.params.threadId, 'thr_fake');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user:message forwards CLI turn overrides onto turn/start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-turn-overrides-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken, 'device-turn-overrides');
    try {
      await waitForAgentEvent(socket, 'init');
      const selected = await emitWithAck(socket, 'thread:select', {
        threadId: 'thr_cli_settings',
        cwd: fixture.workDir,
        title: 'CLI settings',
      });
      const ack = await emitWithAck(socket, 'user:message', {
        text: 'use cli settings',
        clientRequestId: 'req-cli-settings',
        instanceId: selected.instanceId,
        threadId: 'thr_cli_settings',
        turn: {
          model: 'gpt-5.6-sol',
          effort: 'max',
          approvalPolicy: 'untrusted',
          sandbox: 'read-only',
          serviceTier: 'fast',
        },
      });
      assert.equal(ack.ok, true);
      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const turnStart = calls.find(call =>
        call.method === 'turn/start'
        && call.params?.input?.[0]?.text === 'use cli settings'
      );
      assert.ok(turnStart, 'CLI settings should ride along with turn/start');
      assert.equal(turnStart.params.model, 'gpt-5.6-sol');
      assert.equal(turnStart.params.effort, 'max');
      assert.equal(turnStart.params.approvalPolicy, 'untrusted');
      assert.equal(turnStart.params.serviceTier, 'fast');
      assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// routeCwd 决定一条请求落在哪个工作区：不在 workDirs 里就回落到 WORK_DIR。它被 9 处
// 调用，是工作区隔离的入口。
//
// 【为什么补这条】此前 test/new-modules.test.mjs 里有一条名叫
// 「server routing: routeCwd pattern validates whitelist」的测试，但它不 import server.js
// ——而是把那行逻辑抄进测试文件再测那个副本：
//     const routeCwd = cwd => (typeof cwd === 'string' && workDirs.includes(cwd)) ? cwd : WORK_DIR;
//     assert.equal(routeCwd('/evil'), '/a');
// 副本和生产代码当时逐字相同，所以它一直是绿的；但生产代码改成什么样它都不会红。
// 一个安全边界看起来有覆盖、实际没有，比明确没有更危险。那三条自测自写的测试已删。
//
// 这条走真实 socket：session:new 的 ACK 直接回传 routeCwd 的结果，是干净的观测点。
test('非白名单 cwd 回落到 WORK_DIR，白名单内的按原样接受', async () => {
  const fixture = await startIsolatedServer();
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      const evil = await emitWithAck(socket, 'session:new', { cwd: '/evil/not/allowed' });
      assert.equal(evil.ok, true);
      assert.equal(evil.cwd, fixture.workDir, '非白名单 cwd 必须回落，不能按原样使用');

      const allowed = await emitWithAck(socket, 'session:new', { cwd: fixture.altWorkDir });
      assert.equal(allowed.cwd, fixture.altWorkDir, '白名单内的工作区不能被误伤');

      // 非字符串同样回落——payload 来自浏览器，类型不可信。
      for (const bad of [null, undefined, 42, { path: fixture.altWorkDir }]) {
        const ack = await emitWithAck(socket, 'session:new', { cwd: bad });
        assert.equal(ack.cwd, fixture.workDir, `cwd=${JSON.stringify(bad)} 应回落到 WORK_DIR`);
      }
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

// admin 门是安全剧场：解锁口令是源码常量 ENABLE ADMIN，任何能打开页面的设备都能解锁，
// 而且绕行路径至少三条（让 agent 去做、改 config.toml、走 fs 写入）。按「唯一的安全边界是
// 设备 token，功能层不设防」拆掉解锁机制，保留逐动作确认——那防的是误触，不是攻击者。
test('宿主配置操作无需解锁，但必须带逐动作确认并留审计', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-hostcfg-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      // 少了确认字段就不执行：防的是手机上误触，不是防攻击者。
      const unconfirmed = await emitWithAck(socket, 'host:configWrite', {
        keyPath: 'model', value: 'gpt-5.5', mergeStrategy: 'replace',
      });
      assert.equal(unconfirmed.ok, false);
      assert.match(unconfirmed.error, /confirm/i);

      // 带上确认就直接执行，不需要先解锁。
      const written = await emitWithAck(socket, 'host:configWrite', {
        keyPath: 'model', value: 'gpt-5.5', mergeStrategy: 'replace',
        confirmAction: 'host:configWrite',
      });
      assert.equal(written.ok, true, '带确认的宿主配置写入应当直接生效');

      const audit = readFileSync(join(fixture.dataDir, 'host-config-audit.jsonl'), 'utf8')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const success = audit.find(entry => entry.action === 'host:configWrite' && entry.event === 'success');
      assert.ok(success, '成功的宿主配置变更必须留痕');
      assert.ok(!JSON.stringify(audit).includes('ENABLE ADMIN'), '不应再有解锁口令');
    } finally {
      socket.close();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function startIsolatedServer({ codexBin, rpcLog, spawnLog, eventBufferCap, vapid, initialPushSubscriptions, initialTrustedDevices, initialEnrollmentToken, pushMaxSubscriptions, allowedOrigins = [], trustedProxyIps = [], allowInsecureRemote = false, authMaxFailures, authWindowMs, pendingDeviceLimit, agentIdleTtlMs, fakeAuthMode } = {}) {
  const previous = snapshotEnv();
  const root = mkdtempSync(join(tmpdir(), 'ccm-server-test-'));
  let workDir = join(root, 'work');
  let altWorkDir = join(root, 'alt-work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(altWorkDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (Array.isArray(initialPushSubscriptions)) {
    writeFileSync(join(dataDir, 'push-subscriptions.json'), JSON.stringify(initialPushSubscriptions));
  }
  if (Array.isArray(initialTrustedDevices)) {
    writeFileSync(join(dataDir, 'trusted-devices.json'), JSON.stringify(initialTrustedDevices));
  }
  // 模拟「上次运行轮换过注册凭证」——server.js 在 import 时读这个文件，所以预置它
  // 等价于带着轮换结果重启一次。
  if (initialEnrollmentToken) {
    writeFileSync(join(dataDir, 'enrollment-token'), initialEnrollmentToken);
  }
  workDir = realpathSync(workDir);
  altWorkDir = realpathSync(altWorkDir);

  process.env.CODEX_SERVER_NO_START = '1';
  if (fakeAuthMode) process.env.CODEX_FAKE_AUTH_MODE = fakeAuthMode;
  process.env.CODEX_DATA_DIR = dataDir;
  process.env.WORK_DIR = workDir;
  process.env.WORK_DIRS = altWorkDir;
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.AUTH_TOKEN = 'server-integration-token';
  if (allowedOrigins.length) process.env.CODEX_ALLOWED_ORIGINS = allowedOrigins.join(',');
  else delete process.env.CODEX_ALLOWED_ORIGINS;
  if (trustedProxyIps.length) process.env.CODEX_TRUSTED_PROXY_IPS = trustedProxyIps.join(',');
  else delete process.env.CODEX_TRUSTED_PROXY_IPS;
  if (allowInsecureRemote) process.env.CODEX_ALLOW_INSECURE_REMOTE = '1';
  else delete process.env.CODEX_ALLOW_INSECURE_REMOTE;
  if (Number.isInteger(authMaxFailures) && authMaxFailures > 0) {
    process.env.CODEX_AUTH_MAX_FAILURES = String(authMaxFailures);
  } else {
    delete process.env.CODEX_AUTH_MAX_FAILURES;
  }
  if (Number.isInteger(authWindowMs) && authWindowMs > 0) {
    process.env.CODEX_AUTH_WINDOW_MS = String(authWindowMs);
  } else {
    delete process.env.CODEX_AUTH_WINDOW_MS;
  }
  if (Number.isInteger(pendingDeviceLimit) && pendingDeviceLimit > 0) {
    process.env.CODEX_PENDING_DEVICE_LIMIT = String(pendingDeviceLimit);
  } else {
    delete process.env.CODEX_PENDING_DEVICE_LIMIT;
  }
  if (Number.isInteger(agentIdleTtlMs) && agentIdleTtlMs >= 0) {
    process.env.CODEX_AGENT_IDLE_TTL_MS = String(agentIdleTtlMs);
  } else {
    delete process.env.CODEX_AGENT_IDLE_TTL_MS;
  }
  // 调用方没给 codexBin 时不能落回宿主机 PATH 上的真 codex：server.js 的 preflight
  // 找不到 codex 就 process.exit(1)，而这个文件把 server.js import 进测试子进程，
  // 于是整棵进程树被静默带走 —— 没有 TAP 输出、没有 not ok，只剩一份没有汇总行的日志。
  // CI 的 Node 22 腿正是这样死的（它跳过了 Install pinned Codex），而开发机因为装了
  // codex 所以从来看不见。同时这也是「日常回归不依赖真实 Codex CLI」的兜底。
  process.env.CODEX_BIN = codexBin || createFakeCodexBin(root);
  if (rpcLog) process.env.CODEX_FAKE_RPC_LOG = rpcLog;
  if (spawnLog) process.env.CODEX_FAKE_SPAWN_LOG = spawnLog;
  if (Number.isInteger(pushMaxSubscriptions) && pushMaxSubscriptions > 0) {
    process.env.CODEX_PUSH_MAX_SUBSCRIPTIONS = String(pushMaxSubscriptions);
  } else {
    delete process.env.CODEX_PUSH_MAX_SUBSCRIPTIONS;
  }
  if (Number.isInteger(eventBufferCap) && eventBufferCap > 0) {
    process.env.CODEX_EVENT_BUFFER_CAP = String(eventBufferCap);
  } else {
    delete process.env.CODEX_EVENT_BUFFER_CAP;
  }
  if (vapid) {
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:codex-chat-mobile@example.com';
  } else {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  }

  const serverModule = await import(`../../server.js?serverIntegration=${Date.now()}-${Math.random()}`);
  const server = serverModule.startServer();
  assert.ok(server && typeof server.address === 'function', 'startServer should return the listening http.Server');
  await once(server, 'listening');
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    workDir,
    altWorkDir,
    dataDir,
    authToken: process.env.AUTH_TOKEN,
    reclaimIdleAgents: now => serverModule.reclaimIdleAgents(now),
    async close() {
      await new Promise(resolve => serverModule.stopServer(resolve));
      restoreEnv(previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function connectSocket(url, token, deviceToken) {
  const socket = socketClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token, ...(deviceToken ? { deviceToken } : {}) },
  });
  socket.__agentEvents = [];
  socket.on('agent:event', event => {
    socket.__agentEvents.push(event);
  });
  await once(socket, 'connect');
  return socket;
}

async function createAuthSessionCookie(fixture, deviceToken, { forwardedProto } = {}) {
  const response = await fetch(`${fixture.url}/auth/session`, {
    method: 'POST',
    headers: {
      'x-auth-token': fixture.authToken,
      'x-device-token': deviceToken,
      ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
    },
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

async function waitForCondition(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // Atomic writers may briefly replace the path between poll iterations.
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function waitForAgentEvent(socket, type) {
  const existingIndex = socket.__agentEvents?.findIndex(event => event?.type === type) ?? -1;
  if (existingIndex >= 0) {
    const [event] = socket.__agentEvents.splice(existingIndex, 1);
    return Promise.resolve(event);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('agent:event', onEvent);
      reject(new Error(`Timed out waiting for agent:event ${type}`));
    }, 5000);
    const onEvent = event => {
      if (event?.type !== type) return;
      const bufferedIndex = socket.__agentEvents?.findIndex(item => item === event) ?? -1;
      if (bufferedIndex >= 0) socket.__agentEvents.splice(bufferedIndex, 1);
      clearTimeout(timer);
      socket.off('agent:event', onEvent);
      resolve(event);
    };
    socket.on('agent:event', onEvent);
  });
}

function waitForAgentEventMatching(socket, type, predicate) {
  const existingIndex = socket.__agentEvents?.findIndex(event => event?.type === type && predicate(event)) ?? -1;
  if (existingIndex >= 0) {
    const [event] = socket.__agentEvents.splice(existingIndex, 1);
    return Promise.resolve(event);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('agent:event', onEvent);
      const seen = (socket.__agentEvents || []).slice(-10).map(event => ({
        type: event?.type,
        reason: event?.payload?.reason,
        message: event?.payload?.message,
      }));
      reject(new Error(`Timed out waiting for matching agent:event ${type}; recent=${JSON.stringify(seen)}`));
    }, 5000);
    const onEvent = event => {
      if (event?.type !== type || !predicate(event)) return;
      const bufferedIndex = socket.__agentEvents?.findIndex(item => item === event) ?? -1;
      if (bufferedIndex >= 0) socket.__agentEvents.splice(bufferedIndex, 1);
      clearTimeout(timer);
      socket.off('agent:event', onEvent);
      resolve(event);
    };
    socket.on('agent:event', onEvent);
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

function createUnsupportedCollaborationModeCodexBin(root) {
  const file = join(root, 'fake-codex-no-collab.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import readline from 'node:readline';
const threadId = 'thr_fake';
const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'thread/settings/update') {
    return send({
      id: message.id,
      error: { code: -32601, message: 'thread/settings/update requires experimentalApi capability' },
    });
  }
  if (message.method === 'thread/list') {
    return send({ id: message.id, result: { data: [{
      id: threadId,
      preview: 'fake thread',
      name: 'Fake thread',
      cwd: process.env.WORK_DIR,
      createdAt: 1710000000,
      updatedAt: 1710000100,
      status: { type: 'idle' },
    }], nextCursor: null } });
  }
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: threadId } } });
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createFakeCodexBin(root) {
  const file = join(root, 'fake-codex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
	import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const spawnLogPath = process.env.CODEX_FAKE_SPAWN_LOG;
if (spawnLogPath) appendFileSync(spawnLogPath, JSON.stringify({ pid: process.pid }) + '\\n');
const threadId = 'thr_fake';
const turnId = 'turn_fake';
// 自定义 base_url 网关下账号三兄弟的实测形态（codex 0.153.4）：account/read 回
// {account:null, requiresOpenaiAuth:false}，usage 与 rateLimits 一律 -32600。
const gatewayAuth = process.env.CODEX_FAKE_AUTH_MODE === 'gateway';
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function log(message) {
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  log(message);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: threadId } } });
	  if (message.method === 'turn/start') {
	    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
	    if (message.params?.input?.some(item => item.text === 'request routed approval')) {
	      setTimeout(() => send({
	        id: 9001,
	        method: 'item/commandExecution/requestApproval',
	        params: {
	          threadId: message.params.threadId,
	          turnId,
	          itemId: 'item_approval',
	          command: ['pwd'],
	          cwd: process.env.WORK_DIR,
	          availableDecisions: ['accept', 'decline']
	        }
	      }), 5);
	    } else if (message.params?.input?.some(item => item.text === 'request legacy approval')) {
	      setTimeout(() => send({
	        id: 9005,
	        method: 'applyPatchApproval',
	        params: {
	          conversationId: message.params.threadId,
	          callId: 'legacy_patch_call',
	          fileChanges: {},
	          reason: 'legacy write',
	          grantRoot: null
	        }
	      }), 5);
	    } else if (message.params?.input?.some(item => item.text === 'request revoked approval')) {
	      setTimeout(() => {
	        send({
	          id: 9002,
	          method: 'item/commandExecution/requestApproval',
	          params: {
	            threadId: message.params.threadId,
	            turnId,
	            itemId: 'item_revoked_approval',
	            command: ['pwd'],
	            cwd: process.env.WORK_DIR,
	            availableDecisions: ['accept', 'decline']
	          }
	        });
	        setTimeout(() => send({
	          method: 'serverRequest/resolved',
	          params: { requestId: 9002, threadId: message.params.threadId }
	        }), 10);
	      }, 5);
	    } else if (message.params?.input?.some(item => item.text === 'request failed approval')) {
	      setTimeout(() => {
	        send({
	          id: 9003,
	          method: 'item/commandExecution/requestApproval',
	          params: {
	            threadId: message.params.threadId,
	            turnId,
	            itemId: 'item_failed_approval',
	            command: ['pwd'],
	            cwd: process.env.WORK_DIR,
	            availableDecisions: ['accept', 'decline']
	          }
	        });
	        setTimeout(() => send({
	          method: 'turn/failed',
	          params: { threadId: message.params.threadId, turn: { id: turnId, error: { message: 'failed' } } }
	        }), 10);
	      }, 5);
	    } else if (message.params?.input?.some(item => item.text === 'request exited approval')) {
	      setTimeout(() => {
	        send({
	          id: 9004,
	          method: 'item/commandExecution/requestApproval',
	          params: {
	            threadId: message.params.threadId,
	            turnId,
	            itemId: 'item_exited_approval',
	            command: ['pwd'],
	            cwd: process.env.WORK_DIR,
	            availableDecisions: ['accept', 'decline']
	          }
	        });
	        setTimeout(() => process.exit(17), 10);
	      }, 5);
	    }
	    return;
	  }
	  if (message.method === 'thread/list') return send({ id: message.id, result: { data: [{
	    id: threadId,
	    sessionId: threadId,
	    preview: 'fake thread',
	    name: 'Fake thread',
	    modelProvider: 'openai',
	    createdAt: 1710000000,
	    updatedAt: 1710000100,
	    recencyAt: 1710000100,
	    cwd: process.env.WORK_DIR,
	    status: { type: 'idle' },
	    turns: []
	  }], nextCursor: null, backwardsCursor: null } });
	  if (message.method === 'thread/name/set') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/settings/update') {
	    send({ id: message.id, result: {} });
	    setTimeout(() => send({
	      method: 'thread/settings/updated',
	      params: {
	        threadId: message.params.threadId,
	        threadSettings: { collaborationMode: message.params.collaborationMode },
	      },
	    }), 5);
	    return;
	  }
	  if (message.method === 'thread/archive') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/unarchive') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/delete') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/compact/start') {
	    send({ id: message.id, result: {} });
	    setTimeout(() => send({ method: 'thread/compacted', params: { threadId: message.params.threadId, turnId } }), 5);
	    return;
	  }
	  if (message.method === 'review/start') {
	    return send({ id: message.id, result: { turn: { id: turnId, threadId: message.params.threadId, status: 'inProgress', items: [] }, reviewThreadId: message.params.threadId } });
	  }
	  if (message.method === 'thread/rollback') return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
	  if (message.method === 'model/list') return send({ id: message.id, result: { data: [{ id: 'model_1', model: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', inputModalities: ['text'], serviceTiers: [], defaultServiceTier: null, isDefault: true }], nextCursor: null } });
	  if (message.method === 'modelProvider/capabilities/read') return send({ id: message.id, result: { namespaceTools: true, imageGeneration: false, webSearch: true } });
	  if (message.method === 'fs/readDirectory') return send({ id: message.id, result: { entries: [{ fileName: 'README.md', isDirectory: false, isFile: true }] } });
	  if (message.method === 'fs/readFile') return send({ id: message.id, result: { dataBase64: Buffer.from('hello from fake file').toString('base64') } });
	  if (message.method === 'account/read') {
	    // 见 mock-codex-app-server.js 里的同一处：params 是结构体，缺了就是 -32600。
	    if (message.params === undefined) return send({ id: message.id, error: { code: -32600, message: 'Invalid request: missing field \`params\`' } });
	    if (gatewayAuth) return send({ id: message.id, result: { account: null, requiresOpenaiAuth: false } });
	    return send({ id: message.id, result: { account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus' }, requiresOpenaiAuth: true } });
	  }
	  if (message.method === 'account/usage/read') {
	    if (gatewayAuth) return send({ id: message.id, error: { code: -32600, message: 'chatgpt authentication required to read token usage' } });
	    return send({ id: message.id, result: { summary: { lifetimeTokens: 123, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: [] } });
	  }
	  if (message.method === 'account/rateLimits/read') {
	    if (gatewayAuth) return send({ id: message.id, error: { code: -32600, message: 'chatgpt authentication required to read rate limits' } });
	    return send({ id: message.id, result: { rateLimits: { limitId: 'codex', limitName: 'Codex', primary: null, secondary: null, credits: null, individualLimit: null, planType: 'plus', rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: null } });
	  }
	  if (message.method === 'mcpServerStatus/list') return send({ id: message.id, result: { data: [{ name: 'github', serverInfo: null, tools: {}, resources: [], resourceTemplates: [], authStatus: 'notLoggedIn' }], nextCursor: null } });
	  if (message.method === 'skills/list') return send({ id: message.id, result: { data: [{ cwd: process.env.WORK_DIR, skills: [{ name: 'release', description: 'Release helper', path: process.env.WORK_DIR + '/.agents/skills/release/SKILL.md', enabled: true }], errors: [] }] } });
	  if (message.method === 'externalAgentConfig/detect') return send({ id: message.id, result: { items: [{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: process.env.WORK_DIR, details: null }] } });
	  if (message.method === 'externalAgentConfig/import') return send({ id: message.id, result: { importId: 'import_fake' } });
	  if (message.method === 'config/value/write') return send({ id: message.id, result: {} });
	  if (message.method === 'config/batchWrite') return send({ id: message.id, result: {} });
	  if (message.method === 'plugin/install') return send({ id: message.id, result: {} });
	  if (message.method === 'plugin/uninstall') return send({ id: message.id, result: {} });
	  if (message.method === 'marketplace/add') {
	    if (message.params?.source?.includes('audit-error')) {
	      return send({ id: message.id, error: { code: -32000, message: 'marketplace failed for ' + message.params.source } });
	    }
	    return send({ id: message.id, result: {} });
	  }
	  if (message.method === 'marketplace/remove') return send({ id: message.id, result: {} });
	  if (message.method === 'marketplace/upgrade') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/writeFile') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/remove') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/copy') return send({ id: message.id, result: {} });
	  if (message.method === 'mcpServer/tool/call') return send({ id: message.id, result: { result: { ok: true } } });
	  if (message.method === 'account/logout') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/read') return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [{ id: turnId, items: [
	    { type: 'userMessage', id: 'u1', content: [
	      { type: 'text', text: 'hello from native thread', text_elements: [] },
	      { type: 'mention', name: 'README.md', path: '/private/work/README.md' },
	      { type: 'skill', name: 'release', path: '/private/skills/release/SKILL.md' },
	      { type: 'localImage', path: '/private/uploads/image.png' }
	    ] },
	    { type: 'agentMessage', id: 'a1', text: 'hello from Codex app-server' },
	    { id: 'item_fake' }
	  ] }] } } });
	  if (message.method === 'thread/fork') {
    send({ id: message.id, result: { thread: { id: 'thr_forked', forkedFromId: threadId } } });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (message.method === 'account/login/start') {
    send({ id: message.id, result: {
      type: 'chatgptDeviceCode',
      loginId: 'login_fake',
      verificationUrl: 'https://openai.com/device',
      userCode: 'ABCD-EFGH'
    } });
    setTimeout(() => {
      send({ method: 'account/login/completed', params: { loginId: 'login_fake', success: true, error: null } });
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
      setTimeout(() => process.exit(0), 20);
    }, 10);
    return;
  }
  if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId } });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createPersistentReceiptCodexBin(root) {
  const file = join(root, 'persistent-receipt-codex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const acceptedPath = logPath + '.accepted.jsonl';
const turnId = 'turn_reconcile_restart';
const itemId = 'user_reconcile_restart';
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function acceptedMessages() {
  if (!existsSync(acceptedPath)) return [];
  return readFileSync(acceptedPath, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  }
  if (message.method === 'turn/start') {
    appendFileSync(acceptedPath, JSON.stringify({
      threadId: message.params.threadId,
      clientId: message.params.clientUserMessageId,
      input: message.params.input,
    }) + '\\n');
    return send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
  }
  if (message.method === 'thread/read') {
    const accepted = acceptedMessages().filter(entry => entry.threadId === message.params.threadId);
    return send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          turns: accepted.map(entry => ({
            id: turnId,
            items: [{
              type: 'userMessage',
              id: itemId,
              clientId: entry.clientId,
              content: entry.input,
            }],
          })),
        },
      },
    });
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createQueuedTransitionCodexBin(root) {
  const file = join(root, 'queued-transition-codex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const threadId = 'thr_queued_transition';
let turnCount = 0;
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: { thread: { id: threadId } } });
  }
  if (message.method === 'turn/start') {
    turnCount += 1;
    const turnId = turnCount === 1 ? 'turn_blocker' : 'turn_queued_transition';
    if (turnCount === 1) {
      setTimeout(() => {
        send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        setTimeout(() => send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        }), 20);
      }, 80);
      return;
    }
    return send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
  }
  send({ id: message.id, result: {} });
});
`);
  chmodSync(file, 0o755);
  return file;
}

function createChunkedUtf8CodexBin(root) {
  const file = join(root, 'fake-codex-chunked-utf8.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function sendSplitInsideUtf8(message) {
  const frame = Buffer.from(JSON.stringify(message) + '\\n');
  const marker = Buffer.from('跨');
  const index = frame.indexOf(marker);
  process.stdout.write(frame.subarray(0, index + 1));
  setTimeout(() => process.stdout.write(frame.subarray(index + 1)), 5);
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/list') return sendSplitInsideUtf8({
    id: message.id,
    result: {
      data: [{
        id: 'thr_utf8',
        name: '跨端会话',
        preview: 'chunked UTF-8',
        cwd: process.cwd(),
        createdAt: 1710000000,
        updatedAt: 1710000001,
        status: { type: 'idle' }
      }],
      nextCursor: null
    }
  });
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createGapRecoveryCodexBin(root) {
  const file = join(root, 'fake-codex-gap-recovery.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const threadId = 'thr_gap_recovery';
const turnId = 'turn_gap_recovery';
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    setImmediate(() => {
      for (let index = 0; index < 11; index++) {
        send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: 'item_gap', delta: String(index % 10) },
        });
      }
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    });
    return;
  }
  if (message.method === 'thread/read') {
    send({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'active', activeFlags: [] } },
    });
    setTimeout(() => send({ id: message.id, result: { thread: {
      id: message.params.threadId,
      name: 'Recovered gap thread',
      status: { type: 'idle' },
      turns: [{ id: 'turn_persisted', items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'persisted question' }] },
        { type: 'agentMessage', text: 'persisted answer' },
      ] }],
    } } }), 20);
    return;
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function createExternalThreadStatusCodexBin(root) {
  const file = join(root, 'fake-codex-external-thread-status.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/list') {
    send({
      method: 'thread/status/changed',
      params: {
        threadId: 'thr_external_status',
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      },
    });
    setTimeout(() => send({
      id: message.id,
      result: {
        data: [{
          id: 'thr_external_status',
          name: 'External active thread',
          preview: 'running elsewhere',
          cwd: process.env.WORK_DIR,
          createdAt: 1710000000,
          updatedAt: 1710000001,
          status: { type: 'idle' },
        }],
        nextCursor: null,
      },
    }), 20);
    return;
  }
  send({ id: message.id, result: {} });
});
`);
  chmodSync(file, 0o700);
  return file;
}

function createMultiplexFakeCodexBin(root) {
  const file = join(root, 'fake-codex-multiplex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const rl = readline.createInterface({ input: process.stdin });

function log(kind, frame = null) {
  if (logPath) appendFileSync(logPath, JSON.stringify({ kind, pid: process.pid, frame }) + '\\n');
}

function send(frame) {
  log('out', frame);
  process.stdout.write(JSON.stringify(frame) + '\\n');
}

log('spawn');
rl.on('line', line => {
  const message = JSON.parse(line);
  log('in', message);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  }
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId;
    const isA = threadId.endsWith('_a');
    const turnId = isA ? 'turn_mux_a' : 'turn_mux_b';
    const prefix = isA ? 'A' : 'B';
    const responseDelay = isA ? 18 : 4;
    setTimeout(() => send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } }), responseDelay);
    setTimeout(() => send({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } }), responseDelay + 10);
    setTimeout(() => send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'item_' + prefix, delta: prefix + '-one' } }), responseDelay + 20);
    setTimeout(() => send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'item_' + prefix, delta: prefix + '-two' } }), responseDelay + 40);
    setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }), responseDelay + 60);
    setTimeout(() => send({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } }), responseDelay + 70);
    return;
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnv(previous) {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

test('idle agents are reclaimed once no socket is viewing them', async () => {
  // createAgent 有五个调用点，agents.delete 此前只有 thread:delete 一个。每次点
  // 「新建会话」都会留下一个常驻 runtime，各自持有 500 条事件环形缓冲。
  const root = mkdtempSync(join(tmpdir(), 'ccm-agent-reclaim-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const created = await emitWithAck(socket, 'session:new', { cwd: fixture.workDir });
      assert.equal(created.ok, true);
      assert.equal(fixture.reclaimIdleAgents(Date.now() + 3_600_000), 0, '正被 socket 查看的实例不能回收');
    } finally {
      socket.disconnect();
    }
    await waitForCondition(
      () => fixture.reclaimIdleAgents(Date.now() + 3_600_000) === 1,
      '断开后无人查看的空闲实例应被回收',
    );
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a reclaimed thread can be selected again', async () => {
  // 回收的只是网关侧的 runtime 壳——thread 的事实源在 app-server，所以
  // 「断线重连找回原会话」必须不受影响。
  const root = mkdtempSync(join(tmpdir(), 'ccm-agent-reclaim-resume-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  const threadId = 'thr_reclaim_probe';
  try {
    let firstInstanceId = null;
    const first = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(first, 'init');
      const selected = await emitWithAck(first, 'thread:select', { threadId, cwd: fixture.workDir });
      assert.equal(selected.ok, true);
      firstInstanceId = selected.instanceId;
      assert.ok(firstInstanceId);
    } finally {
      first.disconnect();
    }

    await waitForCondition(
      () => fixture.reclaimIdleAgents(Date.now() + 3_600_000) >= 1,
      '断开后空闲实例应被回收',
    );

    const second = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(second, 'init');
      const reselected = await emitWithAck(second, 'thread:select', { threadId, cwd: fixture.workDir });
      assert.equal(reselected.ok, true, '回收之后仍应能重新选中同一个 thread');
      assert.equal(reselected.threadId, threadId);
      assert.ok(reselected.instanceId);
      assert.notEqual(reselected.instanceId, firstInstanceId, '应重建出一个新的 runtime 壳');
    } finally {
      second.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('stopServer terminates the codex app-server subprocess', async () => {
  // shutdown() 走 stopServer 的前提就是这条：stopServer 里 appServerHost.dispose()
  // 排在 httpServer.close() 之前，所以即便有连接吊住 close，子进程也已经收到 SIGTERM。
  const root = mkdtempSync(join(tmpdir(), 'ccm-shutdown-child-test-'));
  const spawnLog = join(root, 'spawn.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, spawnLog });
  let childPid = null;
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      await emitWithAck(socket, 'session:new', { cwd: fixture.workDir });
      socket.emit('user:message', { text: 'spawn the app-server' });
      await waitForAgentEventMatching(
        socket,
        'status',
        event => event.payload?.reason === 'turn_submitted',
      );
      const spawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean);
      childPid = JSON.parse(spawns[0]).pid;
      assert.ok(Number.isInteger(childPid), '应记录到 app-server 子进程的 pid');
      assert.equal(isProcessAlive(childPid), true, '子进程此时应在运行');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }

  await waitForCondition(
    () => !isProcessAlive(childPid),
    'stopServer 之后 codex 子进程不应残留',
  );
});

test('thread:list clamps an out-of-range limit before forwarding it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-thread-list-limit-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      await emitWithAck(socket, 'thread:list', { cwd: fixture.workDir, limit: 999_999 });
      await emitWithAck(socket, 'thread:list', { cwd: fixture.workDir, limit: -5 });
      const forwarded = readFileSync(rpcLog, 'utf8').trim().split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(message => message.method === 'thread/list')
        .map(message => message.params?.limit);
      assert.deepEqual(forwarded, [200, 1], 'Number.isInteger 通过即透传会把负数和巨值送进 app-server');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread:list forwards an empty modelProviders filter so third-party gateways stay visible', async () => {
  // 省略 modelProviders 时 app-server 只回 model_provider=openai 的会话：2026-09-14 实测
  // 同一个 cwd 省略=44 条、传 []=62 条，差的 18 条全是自定义 base_url 网关跑出来的。
  // 空数组是「空过滤器」而不是「过滤到空」——null 和省略才等于默认只给 openai。
  const root = mkdtempSync(join(tmpdir(), 'ccm-thread-list-providers-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      await emitWithAck(socket, 'thread:list', { cwd: fixture.workDir });
      const forwarded = readFileSync(rpcLog, 'utf8').trim().split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(message => message.method === 'thread/list')
        .map(message => message.params?.modelProviders);
      assert.deepEqual(forwarded, [[]], '不传该参数会让第三方网关的会话整体从抽屉里消失');
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('account:read keeps the account when usage and rate limits are gated behind chatgpt auth', async () => {
  // 实测 codex 0.153.4：配了自定义 base_url 的 model_provider 时，account/read 回
  // {account:null, requiresOpenaiAuth:false}，而 usage 与 rateLimits 一律回
  // -32600 "chatgpt authentication required"。这不是故障，是这种用法本来就没有
  // OpenAI 账号用量。Promise.all 会让这两条必然失败的请求把整个面板拖成错误态。
  const root = mkdtempSync(join(tmpdir(), 'ccm-gateway-account-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, fakeAuthMode: 'gateway' });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const account = await emitWithAck(socket, 'account:read', {});

      assert.equal(account.ok, true, '两条附加信息读不到，不等于账号面板读不到');
      assert.equal(account.account.requiresOpenaiAuth, false, '这个字段是识别第三方网关的唯一信号');
      assert.equal(account.account.account, null);
      assert.equal(account.usage, null, '读不到就是没有，不是把整块拖挂');
      assert.equal(account.rateLimits, null);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an out-of-range idle TTL falls back to the default instead of reclaiming everything', async () => {
  // 曾经为了测试方便接受 >= 0，于是 CODEX_AGENT_IDLE_TTL_MS=0 会让任何一个断开连接
  // 的会话在下一个 5 分钟 tick 里立刻被回收。测试现在注入时钟，不再需要这个口子。
  const root = mkdtempSync(join(tmpdir(), 'ccm-idle-ttl-floor-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, agentIdleTtlMs: 0 });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      await emitWithAck(socket, 'session:new', { cwd: fixture.workDir });
    } finally {
      socket.disconnect();
    }
    await new Promise(resolve => setTimeout(resolve, 150));

    // 用真实时钟：TTL=0 若被采纳，刚建的实例立刻就满足空闲条件。
    assert.equal(fixture.reclaimIdleAgents(), 0, 'TTL=0 应被当作非法值忽略，回落默认值');
    // 对照：把时钟拨到未来证明它本来就是可回收的——上面的 0 不是因为 socket 还连着。
    assert.equal(fixture.reclaimIdleAgents(Date.now() + 3_600_000), 1, '拨到未来后应可回收');
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// D6 把文件读写定为 P0 功能，不该继续藏在 admin 面板后面——那道门的口令是源码常量，任何
// 能打开页面的设备都能解锁，挡不住任何人（§3.1）。转正的代价是必须真的记审计：admin 审计
// 文件在旧的 admin 开关默认关闭时根本不启用，等于写操作此前无迹可寻。
test('文件写入不需要 admin 解锁，但必须留下不含内容的审计', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-fs-write-test-'));
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');
      const target = join(fixture.workDir, 'note.txt');
      const secret = 'PRIVATE-CONTENT-DO-NOT-LOG';
      const written = await emitWithAck(socket, 'fs:writeFile', {
        path: target,
        dataBase64: Buffer.from(secret, 'utf8').toString('base64'),
      });
      assert.equal(written.ok, true, '未解锁 admin 也应能写入');

      const outside = await emitWithAck(socket, 'fs:writeFile', {
        path: join(root, 'escape.txt'),
        dataBase64: Buffer.from('x', 'utf8').toString('base64'),
      });
      assert.equal(outside.ok, false, '工作区外的写入必须被拒绝');

      // recursive 不能由服务端替用户默认成 true：删错目录不可逆。
      const removed = await emitWithAck(socket, 'fs:remove', { path: target });
      assert.equal(removed.ok, true);

      const audit = readFileSync(join(fixture.dataDir, 'security-audit.jsonl'), 'utf8');
      assert.match(audit, /"event":"fs_mutation"/);
      assert.match(audit, /"action":"fs:writeFile"/);
      assert.match(audit, /"action":"fs:remove"/);
      assert.doesNotMatch(audit, new RegExp(secret), '审计不得记录文件内容');
      assert.doesNotMatch(audit, /PRIVATE/);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// R-SEC-1：共享 token 降级为注册凭证。已注册设备用服务端签发的专属凭证换会话，所以轮换
// 共享 token 只阻断新设备，不会把已注册设备全部踢下线。
test('已注册设备用专属凭证换会话，轮换注册凭证不影响它', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-device-secret-'));
  const codexBin = createFakeCodexBin(root);
  const deviceToken = 'dev_secret_flow_0123456789';
  const fixture = await startIsolatedServer({ codexBin, initialTrustedDevices: [deviceToken] });
  try {
    // 设备要先被批准才谈得上签发凭证——未批准的设备什么也做不了。
    const enroll = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-auth-token': fixture.authToken, 'x-device-token': deviceToken },
    });
    assert.equal(enroll.status, 201);
    const { deviceSecret } = await enroll.json();
    assert.ok(typeof deviceSecret === 'string' && deviceSecret.length >= 32, '应当回签设备凭证');

    // 此后不再需要注册凭证。
    const reAuth = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-device-secret': deviceSecret, 'x-device-token': deviceToken },
    });
    assert.equal(reAuth.status, 201, '设备凭证应当足以换取会话');

    // 错误的设备凭证不行。
    const bad = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-device-secret': 'wrong-secret-value-padding-0123', 'x-device-token': deviceToken },
    });
    assert.equal(bad.status, 401);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// server.js:437 的注释把这条承诺写得很明白：「持久化在 data/enrollment-token，重启后仍然
// 有效，否则『轮换』等于『重启前有效』，用户没法信任它」。但那只是注释——变异把读取那两行
// 的条件取反（不存在时才读 / 空的时候才用），全套测试照样绿。
//
// 取反的后果分两种，都很实：跳过文件 → 被轮换掉的旧 AUTH_TOKEN 重启后复活；把空值当有效
// → enrollmentToken 变成空串，`tokenMatches` 对任何输入都返回 false，没人再能注册新设备。
// 预置文件再启动，等价于「带着上次轮换的结果重启一次」。
test('轮换后的注册凭证跨重启仍然有效，被换掉的旧 AUTH_TOKEN 不复活', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-enrollment-restart-'));
  const codexBin = createFakeCodexBin(root);
  const rotated = 'rotated-enrollment-token-0123456789';
  const deviceToken = 'dev_enroll_after_restart_01';
  const fixture = await startIsolatedServer({
    codexBin,
    initialEnrollmentToken: rotated,
    initialTrustedDevices: [deviceToken],
  });
  try {
    const withRotated = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-auth-token': rotated, 'x-device-token': deviceToken },
    });
    assert.equal(withRotated.status, 201,
      '轮换后的凭证必须跨重启有效——否则「轮换」只是「重启前有效」，那不值得用户信任');

    const withOld = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-auth-token': fixture.authToken, 'x-device-token': deviceToken },
    });
    assert.equal(withOld.status, 401, '被轮换掉的旧 AUTH_TOKEN 不能因为一次重启就复活');
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// R-SEC-1 的轮换语义：换掉注册凭证只应阻断**新**设备注册，已注册设备照常工作。
// 现状是改 AUTH_TOKEN 需重启且所有设备 session 一并作废——方向刚好相反。
test('轮换注册凭证只阻断新设备，已注册设备不受影响', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-rotate-'));
  const codexBin = createFakeCodexBin(root);
  const enrolled = 'dev_rotate_enrolled_0123456789';
  const fixture = await startIsolatedServer({ codexBin, initialTrustedDevices: [enrolled] });
  try {
    const first = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-auth-token': fixture.authToken, 'x-device-token': enrolled },
    });
    const { deviceSecret } = await first.json();

    const rotated = await fetch(`${fixture.url}/auth/enrollment/rotate`, {
      method: 'POST',
      headers: { 'x-auth-token': fixture.authToken },
    });
    assert.equal(rotated.status, 200);
    const { enrollmentToken } = await rotated.json();
    assert.ok(enrollmentToken.length >= 32);
    assert.notEqual(enrollmentToken, fixture.authToken);

    // 已注册设备照常。
    const stillWorks = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-device-secret': deviceSecret, 'x-device-token': enrolled },
    });
    assert.equal(stillWorks.status, 201, '轮换不该把已注册设备踢下线');

    // 旧注册凭证不再能带新设备进来。
    const oldTokenNewDevice = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-auth-token': fixture.authToken, 'x-device-token': 'dev_rotate_newcomer_012345' },
    });
    assert.equal(oldTokenNewDevice.status, 401, '旧注册凭证必须立即失效');

    // 新凭证可以。
    const newTokenNewDevice = await fetch(`${fixture.url}/auth/session`, {
      method: 'POST',
      headers: { 'x-auth-token': enrollmentToken, 'x-device-token': 'dev_rotate_newcomer_012345' },
    });
    assert.equal(newTokenNewDevice.status, 201);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// pending 设备是「凭证对了、但人还没点同意」的设备。它既不该动手，也不该看见东西。
// 服务端有五处实现这道闸——broadcastNeedsYouChange、broadcastHostThreadStatus、
// broadcastInstances、refreshStatusLine 各一处 `deviceApproved !== true` 过滤，
// 加上 on() 里对入站事件的 fail-closed 丢弃。这五处此前一条测试都没有，
// 全仓 grep `deviceApproved` 在 test/ 下零结果。
//
// 坏了的后果按泄露内容排：needs-you 广播带审批 payload（agent 要跑的命令原文）、
// 实例广播带 cwd（宿主机目录路径）、thread 状态带会话名。入站那处更直接——
// pending 设备能发号施令。
test('pending 设备收不到任何广播，也发不出任何指令', async () => {
  const fixture = await startIsolatedServer({
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: ['127.0.0.1'],
  });
  const pendingDevice = 'device-pending-isolation-target';
  const approvedDevice = 'device-pending-isolation-controller';
  const pendingCookie = await createAuthSessionCookie(fixture, pendingDevice, { forwardedProto: 'https' });
  const approvedCookie = await createAuthSessionCookie(fixture, approvedDevice, { forwardedProto: 'https' });
  writeFileSync(
    join(fixture.dataDir, 'trusted-devices.json'),
    JSON.stringify([approvedDevice]),
    { mode: 0o600 },
  );

  const connect = (deviceToken, cookie) => {
    const socket = socketClient(fixture.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { deviceToken },
      extraHeaders: {
        Cookie: cookie,
        Origin: 'https://codex.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    socket.__agentEvents = [];
    socket.on('agent:event', event => socket.__agentEvents.push(event));
    return socket;
  };

  const pendingSocket = connect(pendingDevice, pendingCookie);
  let approvedSocket;
  try {
    await once(pendingSocket, 'connect');
    const status = await waitForAgentEvent(pendingSocket, 'device_status');
    assert.equal(status.payload.status, 'pending', '前提：这台确实处于未批准状态');

    approvedSocket = connect(approvedDevice, approvedCookie);
    await once(approvedSocket, 'connect');
    await waitForAgentEvent(approvedSocket, 'init');

    // 已批准的设备做一件会触发广播的事，pending 那台必须一点都收不到。
    const before = pendingSocket.__agentEvents.length;
    approvedSocket.emit('session:new', { cwd: fixture.workDir });
    await waitForAgentEvent(approvedSocket, 'instances');

    // 入站方向：pending 设备发指令必须被丢弃，不能有任何回应。
    let acked = false;
    pendingSocket.emit('session:new', { cwd: fixture.workDir }, () => { acked = true; });
    await new Promise(resolve => setTimeout(resolve, 250));

    assert.equal(acked, false, 'pending 设备的事件必须被静默丢弃，不能回 ack');
    const leaked = pendingSocket.__agentEvents.slice(before)
      .filter(event => event.type !== 'device_status' && event.type !== 'pending_devices');
    assert.deepEqual(
      leaked.map(event => event.type),
      [],
      'pending 设备只应看到自己的配对状态；收到 instances 会连 cwd 一起泄露宿主机路径，'
      + `收到 needs_you 会连审批 payload 一起泄露 agent 要执行的命令。实际收到：${
        JSON.stringify(leaked.map(e => e.type))}`,
    );
  } finally {
    pendingSocket.disconnect();
    approvedSocket?.disconnect();
    await fixture.close();
  }
});

test('/metrics 受同一张限速表管辖，不能成为暴破 AUTH_TOKEN 的旁路', async () => {
  // 不共用限速表的话，/health、/metrics、/push/* 就是一条无限次试令牌的通道——
  // 而同一个 IP 的 socket 握手早已被锁。攻击者只要挑 HTTP 这一侧打就完全绕过了锁定。
  const fixture = await startIsolatedServer({ authMaxFailures: 3 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${fixture.url}/metrics`, { headers: { 'x-auth-token': 'wrong-token' } });
      codes.push(res.status);
      // 401 与 429 说的是两件事：前者「令牌不对，重输」，后者「已达阈值，等一下」。
      // 说成同一个会让正在被锁的人一遍遍重输一个其实正确的令牌。
      if (res.status === 429) {
        assert.ok(res.headers.get('retry-after'), '429 必须带 Retry-After，否则「等多久」无从得知');
      }
    }
    assert.ok(codes.includes(401), `前几次应是 401（令牌不对），实际：${codes.join(',')}`);
    assert.ok(codes.includes(429), `达阈值后应转 429（被锁），实际：${codes.join(',')}`);
  } finally {
    await fixture.close();
  }
});

test('/metrics 用正确令牌返回白名单映射表，且不回显任何配置值', async () => {
  const fixture = await startIsolatedServer();
  try {
    const res = await fetch(`${fixture.url}/metrics`, { headers: { 'x-auth-token': fixture.authToken } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.counters && body.gauges && body.rpc, '三组都要有');
    assert.equal(typeof body.counters.auth_failures, 'number');
    // doctor 的 safe 字段同款纪律：可观测出口是人最常贴进 issue 的东西。
    assert.doesNotMatch(JSON.stringify(body), new RegExp(fixture.authToken), '绝不能把令牌回显出去');
  } finally {
    await fixture.close();
  }
});
