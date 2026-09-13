// test/devices.test.mjs —— 设备白名单模块单元测试。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 使用临时目录隔离测试数据
let tempDir;
let origEnv;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ccm-devices-test-'));
  origEnv = process.env.CODEX_DATA_DIR;
  process.env.CODEX_DATA_DIR = tempDir;
});

function cleanup() {
  process.env.CODEX_DATA_DIR = origEnv;
  rmSync(tempDir, { recursive: true, force: true });
}

// ---- isDeviceTrusted ----

test('isDeviceTrusted: returns false for empty/null/undefined token', async () => {
  // 动态导入以使用临时目录
  const { isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(isDeviceTrusted(''), false);
  assert.equal(isDeviceTrusted(null), false);
  assert.equal(isDeviceTrusted(undefined), false);
  assert.equal(isDeviceTrusted(123), false);
  cleanup();
});

test('isDeviceTrusted: returns false for untrusted token', async () => {
  const { isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(isDeviceTrusted('unknown-token'), false);
  cleanup();
});

test('isDeviceTrusted: returns true after approveDevice', async () => {
  const { approveDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  approveDevice('token-abc', { ip: '127.0.0.1', userAgent: 'test' });
  assert.equal(isDeviceTrusted('token-abc'), true);
  cleanup();
});

// ---- addPendingDevice / getPendingDevices ----

test('addPendingDevice: stores device with metadata', async () => {
  const { addPendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('pending-1', { ip: '10.0.0.1', userAgent: 'Mozilla/5.0' });
  const list = getPendingDevices();
  assert.ok(list.length >= 1);
  const found = list.find(d => d.deviceToken === 'pending-1');
  assert.ok(found);
  assert.equal(found.ip, '10.0.0.1');
  assert.equal(found.userAgent, 'Mozilla/5.0');
  assert.ok(found.ts > 0);
  cleanup();
});

test('addPendingDevice: replaces duplicate token', async () => {
  const { addPendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('dup-token', { ip: '10.0.0.1' });
  addPendingDevice('dup-token', { ip: '10.0.0.2' });
  const list = getPendingDevices();
  const matches = list.filter(d => d.deviceToken === 'dup-token');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ip, '10.0.0.2');
  cleanup();
});

test('addPendingDevice: leaves pending capacity enforcement to the server boundary', async () => {
  const { addPendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  for (let index = 0; index < 65; index += 1) {
    addPendingDevice(`pending-${index}`, { ip: '10.0.0.1' });
  }

  assert.equal(getPendingDevices().length, 65);
  cleanup();
});

test('addPendingDevice: ignores empty/null token', async () => {
  const { addPendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  const before = getPendingDevices().length;
  addPendingDevice('', { ip: '10.0.0.1' });
  addPendingDevice(null, { ip: '10.0.0.1' });
  assert.equal(getPendingDevices().length, before);
  cleanup();
});

// ---- removePendingDevice ----

test('removePendingDevice: removes existing pending device', async () => {
  const { addPendingDevice, removePendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('to-remove', { ip: '10.0.0.1' });
  removePendingDevice('to-remove');
  const list = getPendingDevices();
  assert.ok(!list.find(d => d.deviceToken === 'to-remove'));
  cleanup();
});

test('removePendingDevice: no-op for non-existent token', async () => {
  const { removePendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  const before = getPendingDevices().length;
  removePendingDevice('nonexistent');
  assert.equal(getPendingDevices().length, before);
  cleanup();
});

// ---- approveDevice ----

test('approveDevice: moves device from pending to trusted', async () => {
  const { addPendingDevice, approveDevice, isDeviceTrusted, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('approve-me', { ip: '10.0.0.1' });
  const result = approveDevice('approve-me');
  assert.equal(result, true);
  assert.equal(isDeviceTrusted('approve-me'), true);
  assert.ok(!getPendingDevices().find(d => d.deviceToken === 'approve-me'));
  cleanup();
});

test('approveDevice: returns false for empty/null token', async () => {
  const { approveDevice } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(approveDevice(''), false);
  assert.equal(approveDevice(null), false);
  cleanup();
});

test('approveDevice: returns false and rolls back trust when persistence fails', async () => {
  const { approveDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  mkdirSync(join(tempDir, 'trusted-devices.json.tmp'));

  assert.equal(approveDevice('must-not-be-trusted'), false);
  assert.equal(isDeviceTrusted('must-not-be-trusted'), false);
  cleanup();
});

// ---- denyDevice ----

test('denyDevice: removes device from both trusted and pending', async () => {
  const { addPendingDevice, denyDevice, isDeviceTrusted, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('deny-me', { ip: '10.0.0.1' });
  const result = denyDevice('deny-me');
  assert.equal(result, true);
  assert.equal(isDeviceTrusted('deny-me'), false);
  assert.ok(!getPendingDevices().find(d => d.deviceToken === 'deny-me'));
  cleanup();
});

test('denyDevice: returns false for empty/null token', async () => {
  const { denyDevice } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(denyDevice(''), false);
  assert.equal(denyDevice(null), false);
  cleanup();
});

// ---- getLatestPendingDevice ----

test('getLatestPendingDevice: returns null when no pending devices', async () => {
  // 清空 pending 文件
  const pendingFile = join(tempDir, 'pending-devices.json');
  writeFileSync(pendingFile, '[]');
  const { getLatestPendingDevice } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(getLatestPendingDevice(), null);
  cleanup();
});

test('getLatestPendingDevice: returns most recent device token', async () => {
  const { addPendingDevice, getLatestPendingDevice } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('older', { ip: '10.0.0.1' });
  // 人为制造时间差
  await new Promise(r => setTimeout(r, 10));
  addPendingDevice('newer', { ip: '10.0.0.2' });
  assert.equal(getLatestPendingDevice(), 'newer');
  cleanup();
});

// ---- 文件持久化 ----

test('trusted devices persist to file', async () => {
  const { approveDevice } = await import(`../devices.js?t=${Date.now()}`);
  approveDevice('persist-token');
  const file = join(tempDir, 'trusted-devices.json');
  assert.ok(existsSync(file));
  const data = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(file, 'utf8')));
  assert.ok(data.some(record => record.deviceToken === 'persist-token'));
  cleanup();
});

test('pending devices persist to file', async () => {
  const { addPendingDevice } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('pending-persist', { ip: '10.0.0.1' });
  const file = join(tempDir, 'pending-devices.json');
  assert.ok(existsSync(file));
  const data = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(file, 'utf8')));
  assert.ok(data.some(d => d.deviceToken === 'pending-persist'));
  cleanup();
});

test('one devices module instance follows CODEX_DATA_DIR changes without crossing stores', async () => {
  const secondDir = mkdtempSync(join(tmpdir(), 'ccm-devices-second-store-'));
  const devices = await import(`../devices.js?t=${Date.now()}`);
  try {
    devices.approveDevice('first-store-token');
    assert.equal(devices.isDeviceTrusted('first-store-token'), true);

    process.env.CODEX_DATA_DIR = secondDir;
    assert.equal(devices.isDeviceTrusted('first-store-token'), false);
    devices.approveDevice('second-store-token');
    assert.equal(devices.isDeviceTrusted('second-store-token'), true);

    process.env.CODEX_DATA_DIR = tempDir;
    assert.equal(devices.isDeviceTrusted('first-store-token'), true);
    assert.equal(devices.isDeviceTrusted('second-store-token'), false);
  } finally {
    rmSync(secondDir, { recursive: true, force: true });
    cleanup();
  }
});

test('device caches include the data file path when stores have identical mtimes', async () => {
  const secondDir = mkdtempSync(join(tmpdir(), 'ccm-devices-same-mtime-store-'));
  const sharedMtime = new Date('2025-01-01T00:00:00.000Z');
  const firstTrustedFile = join(tempDir, 'trusted-devices.json');
  const secondTrustedFile = join(secondDir, 'trusted-devices.json');
  const firstPendingFile = join(tempDir, 'pending-devices.json');
  const secondPendingFile = join(secondDir, 'pending-devices.json');

  writeFileSync(firstTrustedFile, JSON.stringify(['store-one-token']));
  writeFileSync(secondTrustedFile, JSON.stringify(['store-two-token']));
  writeFileSync(firstPendingFile, JSON.stringify([{ deviceToken: 'pending-one', ts: 1 }]));
  writeFileSync(secondPendingFile, JSON.stringify([{ deviceToken: 'pending-two', ts: 1 }]));
  for (const file of [firstTrustedFile, secondTrustedFile, firstPendingFile, secondPendingFile]) {
    utimesSync(file, sharedMtime, sharedMtime);
  }

  const devices = await import(`../devices.js?same-mtime=${Date.now()}`);
  try {
    assert.equal(devices.isDeviceTrusted('store-one-token'), true);
    assert.deepEqual(devices.getPendingDevices().map(device => device.deviceToken), ['pending-one']);

    process.env.CODEX_DATA_DIR = secondDir;
    assert.equal(devices.isDeviceTrusted('store-one-token'), false);
    assert.equal(devices.isDeviceTrusted('store-two-token'), true);
    assert.deepEqual(devices.getPendingDevices().map(device => device.deviceToken), ['pending-two']);
  } finally {
    rmSync(secondDir, { recursive: true, force: true });
    cleanup();
  }
});

// fixture 必须是**对象**形态。上一版写的是 JSON.stringify([deviceToken])——扁平字符串
// 数组，那是 R-SEC-1 之前的旧格式（见下一条用例）。旧格式下 CLI 把条目直接塞进模板
// 字符串恰好能打印出 token，于是这条一直是绿的，而真实数据（对象）打印出来是
// `ID: [object Object]`，实测到 2026-09-13 才被人眼发现。
// **fixture 停在已经迁移走的形态，等于这条用例在守一个现实中不再产生的东西。**
// 旧格式的兼容由 test/device-cli.test.mjs 单独覆盖，那边是纯函数，两种形态都能测。
test('device CLI list reads trusted devices from CODEX_DATA_DIR', () => {
  const deviceToken = 'trusted-in-configured-data-dir';
  writeFileSync(join(tempDir, 'trusted-devices.json'), JSON.stringify([{
    deviceToken,
    ip: '10.0.0.5',
    userAgent: 'probe-agent',
    approvedAt: 1789320644069,
    lastSeenAt: 1789320644069,
    secretHash: null,
  }]));
  try {
    const result = spawnSync(process.execPath, ['scripts/device.js', 'list'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, CODEX_DATA_DIR: tempDir },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(deviceToken));
  } finally {
    cleanup();
  }
});

// R-SEC-1：设备表此前是扁平字符串数组，IP / UA / 时间在批准瞬间被丢弃——设备列表页因此
// 无法回答「这台是什么设备、什么时候接进来的、最近还在不在用」，而那正是判断要不要撤销
// 它的依据。
test('设备记录保留元数据，且能读回旧的扁平数组', async () => {
  const { addPendingDevice, approveDevice, getTrustedDevices, touchDevice } =
    await import(`../devices.js?meta=${Date.now()}`);

  addPendingDevice('dev_meta', { ip: '10.0.0.9', userAgent: 'iPhone Safari' });
  assert.equal(approveDevice('dev_meta'), true);

  const [record] = getTrustedDevices();
  assert.equal(record.deviceToken, 'dev_meta');
  assert.equal(record.ip, '10.0.0.9', '批准时不该丢掉来源 IP');
  assert.equal(record.userAgent, 'iPhone Safari');
  assert.ok(record.approvedAt > 0, '需要首次注册时间');
  assert.equal(record.lastSeenAt, record.approvedAt);

  touchDevice('dev_meta', { now: record.approvedAt + 5000 });
  assert.equal(getTrustedDevices()[0].lastSeenAt, record.approvedAt + 5000, '最近活跃要能更新');
});

test('旧格式的扁平数组仍可读，缺失字段留空而不是伪造', async () => {
  writeFileSync(join(tempDir, 'trusted-devices.json'), JSON.stringify(['dev_legacy']));
  const { getTrustedDevices, isDeviceTrusted } =
    await import(`../devices.js?legacy=${Date.now()}`);

  assert.equal(isDeviceTrusted('dev_legacy'), true, '旧格式设备不能因为升级就被踢下线');
  const [record] = getTrustedDevices();
  assert.equal(record.deviceToken, 'dev_legacy');
  assert.equal(record.ip, null, '旧记录没有这些信息，留空而不是编一个');
  assert.equal(record.approvedAt, null);
});

// R-SEC-1 的核心：共享 token 降级为**注册凭证**，只在新设备首次接入时用一次；此后设备
// 用服务端为它签发的专属凭证。这样轮换共享 token 只阻断新设备注册，不会把已注册设备
// 全部踢下线——而那正是当前「改 AUTH_TOKEN 要重启且所有人重登」的问题。
test('批准设备时签发专属凭证，可据此认证且可单独撤销', async () => {
  const { addPendingDevice, approveDevice, issueDeviceSecret, verifyDeviceSecret, denyDevice } =
    await import(`../devices.js?secret=${Date.now()}`);

  addPendingDevice('dev_a', { ip: '10.0.0.1' });
  approveDevice('dev_a');
  const secret = issueDeviceSecret('dev_a');
  assert.equal(typeof secret, 'string');
  assert.ok(secret.length >= 32, '凭证要有足够熵，它替代共享 token 承担日常认证');

  assert.equal(verifyDeviceSecret('dev_a', secret), true);
  assert.equal(verifyDeviceSecret('dev_a', 'wrong'), false);
  assert.equal(verifyDeviceSecret('dev_b', secret), false, '凭证绑定到具体设备');

  denyDevice('dev_a');
  assert.equal(verifyDeviceSecret('dev_a', secret), false, '撤销设备后其凭证立即失效');
});

test('凭证不以明文落盘', async () => {
  const { addPendingDevice, approveDevice, issueDeviceSecret } =
    await import(`../devices.js?hash=${Date.now()}`);
  addPendingDevice('dev_h', {});
  approveDevice('dev_h');
  const secret = issueDeviceSecret('dev_h');

  const raw = await import('node:fs').then(fs => fs.readFileSync(join(tempDir, 'trusted-devices.json'), 'utf8'));
  assert.ok(!raw.includes(secret), '设备表被读走时不该等于交出所有设备的通行证');
});

// 写操作前的 force 重载防的是什么：`dev:ino:size:mtimeMs` 这个缓存签名会碰撞。
// 外部进程（本机 CLI、手工编辑）把文件换成**等长**内容、且 mtime 恰好相同时，
// 非 force 的加载会命中缓存、拿着过期快照去写盘——外部那次改动就被静默覆盖了。
//
// 变异运行里 5 处 `force: true → false` 全部存活，说明这条路径从没被断言盯过。
test('approveDevice reloads before writing so a signature collision cannot lose an external change', async () => {
  const { approveDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  const file = join(tempDir, 'trusted-devices.json');

  // 两个等长 token，保证换内容后 size 不变。
  const older = 'aaaa-token-00000001';
  const newer = 'bbbb-token-00000002';
  const record = token => ({
    deviceToken: token, ip: null, userAgent: null, approvedAt: 1700000000000, lastSeenAt: 1700000000000,
  });

  const stamp = new Date(1700000000000);

  // ⚠ 顺序要紧：mtime 必须在**第一次读之前**就定死，否则缓存进去的是写入时刻的签名，
  // 后面再怎么复位 mtime 都对不上，force:false 照样会重读——这条测试就测了个寂寞。
  writeFileSync(file, JSON.stringify([record(older)]));
  utimesSync(file, stamp, stamp);
  const beforeLength = readFileSync(file, 'utf8').length;
  assert.equal(isDeviceTrusted(older), true, '前置：older 应当先被缓存进内存');

  // 外部把 older 换成 newer：内容等长，mtime 复位到同一时刻 —— 签名碰撞。
  writeFileSync(file, JSON.stringify([record(newer)]));
  utimesSync(file, stamp, stamp);
  assert.equal(readFileSync(file, 'utf8').length, beforeLength,
    '前置：两份内容必须等长，否则 size 不同、签名不会碰撞，这条测试就测不到东西了');

  approveDevice('cccc-token-00000003');

  assert.equal(isDeviceTrusted(newer), true,
    'approve 前必须 force 重载：否则拿过期快照写盘，外部加入的设备被静默覆盖');
  assert.equal(isDeviceTrusted('cccc-token-00000003'), true, '本次批准的设备当然要在');
  cleanup();
});

// denyDevice 与 approveDevice 是同一族：两者都在写盘前 force 重载，防的是同一个
// 签名碰撞。批 1 的教训是「补断言前先 grep 守卫出现几次」——这里是 3 处
// （approve / deny / rotate），所以两条都要有，不能只测 approve 那一路。
test('denyDevice reloads before writing so a signature collision cannot lose an external change', async () => {
  const { denyDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  const file = join(tempDir, 'trusted-devices.json');

  const doomed = 'dddd-token-00000004';
  const newer = 'bbbb-token-00000002';
  const record = token => ({
    deviceToken: token, ip: null, userAgent: null, approvedAt: 1700000000000, lastSeenAt: 1700000000000,
  });
  const stamp = new Date(1700000000000);

  writeFileSync(file, JSON.stringify([record(doomed)]));
  utimesSync(file, stamp, stamp);
  const beforeLength = readFileSync(file, 'utf8').length;
  assert.equal(isDeviceTrusted(doomed), true, '前置：doomed 先进缓存');

  // 外部把 doomed 换成 newer（等长、同 mtime）——签名碰撞。
  writeFileSync(file, JSON.stringify([record(newer)]));
  utimesSync(file, stamp, stamp);
  assert.equal(readFileSync(file, 'utf8').length, beforeLength, '前置：两份内容必须等长');

  denyDevice(doomed);

  assert.equal(isDeviceTrusted(newer), true,
    'deny 前必须 force 重载：否则拿过期快照写盘，外部加入的设备被这次撤销顺手抹掉');
  assert.equal(isDeviceTrusted(doomed), false, '被 deny 的设备当然不该还在');
  cleanup();
});

// 族里的第三处，也是后果最重的一处。approve / deny 那两路丢的是"外部那次改动"；
// 这一路丢的是**撤销本身**：缓存过期时 issueDeviceSecret 会在已被撤销的设备上找到记录，
// 给它签发一份能用的新凭证，然后把过期快照整个写回去——那次撤销就被完整地取消了。
// 撤销一台设备是运维在设备丢失后做的第一件事，它必须是终态。
test('issueDeviceSecret reloads before writing so a revoked device cannot be handed a fresh credential', async () => {
  const { issueDeviceSecret, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  const file = join(tempDir, 'trusted-devices.json');

  const revoked = 'eeee-token-00000005';
  const survivor = 'ffff-token-00000006';
  const record = token => ({
    deviceToken: token, ip: null, userAgent: null, approvedAt: 1700000000000, lastSeenAt: 1700000000000,
  });
  const stamp = new Date(1700000000000);

  writeFileSync(file, JSON.stringify([record(revoked)]));
  utimesSync(file, stamp, stamp);
  const beforeLength = readFileSync(file, 'utf8').length;
  assert.equal(isDeviceTrusted(revoked), true, '前置：revoked 先进缓存');

  // 外部（本机 CLI / 手工编辑）撤销 revoked，同时留下 survivor。等长、同 mtime —— 签名碰撞。
  writeFileSync(file, JSON.stringify([record(survivor)]));
  utimesSync(file, stamp, stamp);
  assert.equal(readFileSync(file, 'utf8').length, beforeLength, '前置：两份内容必须等长');

  assert.equal(issueDeviceSecret(revoked), null,
    '已被撤销的设备不该拿到凭证：签发前必须 force 重载，否则过期缓存里它还在');
  assert.equal(isDeviceTrusted(survivor), true, '外部那次撤销的另一半（保留 survivor）也不能被覆盖掉');
  assert.equal(isDeviceTrusted(revoked), false, '撤销必须是终态，不能被一次签发悄悄复活');
  cleanup();
});

// ---- 变异补漏：批 2（AUTH + DEVICE） ----

// 这条是这批里后果最重的。变异把 :133 的 `return false` 改成 `return true` —— 那一行是
// 设备凭证校验的入口守卫，改完等于「参数不合法即认证通过」，而当时 27 条测试没有一条会红。
//
// 选「secret 传成包着真凭证的数组」这个用例，是因为它一发命中该行的三个变异；更要紧的是
// 它不是构造出来的怪输入：Socket.IO 的载荷是 JSON，客户端完全可以发 { secret: ["..."] }，
// 而 Array.prototype.toString 会把它还原成那个字符串——下游 hashSecret(String(secret))
// 算出的哈希和真凭证一模一样。挡住它的只有 `typeof secret !== 'string'` 这半句。
test('verifyDeviceSecret 拒绝类型混淆：包着真凭证的数组不算凭证', async () => {
  const { approveDevice, issueDeviceSecret, verifyDeviceSecret } = await import(`../devices.js?t=${Date.now()}`);
  approveDevice('dev_tc');
  const secret = issueDeviceSecret('dev_tc');
  assert.equal(verifyDeviceSecret('dev_tc', secret), true, '前置：真凭证要能通过，否则下面测的是空气');

  assert.equal(verifyDeviceSecret('dev_tc', [secret]), false,
    'secret 是数组时 String() 会还原出真凭证，必须在类型上就拦掉');
  assert.equal(verifyDeviceSecret([...'dev_tc'].join(''), [secret]), false, '同上，token 是否字符串不影响这条');
  assert.equal(verifyDeviceSecret(['dev_tc'], secret), false, 'deviceToken 同样要求是字符串');
  assert.equal(verifyDeviceSecret('dev_tc', ''), false, '空 secret 永远不通过');
  assert.equal(verifyDeviceSecret('dev_tc', undefined), false);
  assert.equal(verifyDeviceSecret(null, null), false);
  cleanup();
});

// approveDevice 的持久化失败路径有测试，denyDevice 的没有——又是「形态漏过整族」。
// 这条的方向 ⚠ 反直觉，所以更要写下来：**撤销写盘失败时，设备仍然是被信任的**。
// 看着不安全，但另一种做法更糟：只在内存里删掉，磁盘那份没变，重启后设备原样回来，
// 而管理员以为已经吊销了。回滚 + 返回 false 让失败是显式的，管理员会看到并重试。
test('denyDevice: 写盘失败时回滚并返回 false，不留下「内存已撤销、磁盘还信任」的假象', async () => {
  const { approveDevice, denyDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  approveDevice('deny-fails');
  assert.equal(isDeviceTrusted('deny-fails'), true, '前置：先得真的被信任');

  // 占住原子写的临时文件路径，让写入必然失败（与 approveDevice 那条同一手法）。
  mkdirSync(join(tempDir, 'trusted-devices.json.tmp'));

  assert.equal(denyDevice('deny-fails'), false, '撤销没落盘就必须报告失败');
  assert.equal(isDeviceTrusted('deny-fails'), true,
    '回滚后设备仍被信任：宁可撤销失败让管理员重试，也不要一个重启就复活的「已撤销」');
  cleanup();
});

// devices.js:147 的注释写着「落盘由调用方按需触发——每次握手都写一次文件不划算」。
// 那句话就是契约，但没有测试守着它：把 `if (persist)` 改成 `if (!persist)` 语义整个反过来，
// 全部测试仍然绿。反过来的后果正是这行注释要避免的——每次握手都写盘，而显式要求落盘的那次反倒不写。
test('touchDevice: persist 决定这次推进要不要落盘，默认落盘', async () => {
  const { approveDevice, touchDevice } = await import(`../devices.js?t=${Date.now()}`);
  const file = join(tempDir, 'trusted-devices.json');
  approveDevice('dev_touch');

  const before = readFileSync(file, 'utf8');
  assert.equal(touchDevice('dev_touch', { now: 1800000000000, persist: false }), true);
  assert.equal(readFileSync(file, 'utf8'), before, 'persist:false 不该写盘——每次握手写一次文件不划算');

  assert.equal(touchDevice('dev_touch', { now: 1900000000000, persist: true }), true);
  assert.match(readFileSync(file, 'utf8'), /1900000000000/, 'persist:true 必须把 lastSeenAt 落盘');

  assert.equal(touchDevice('dev_touch', { now: 2000000000000 }), true);
  assert.match(readFileSync(file, 'utf8'), /2000000000000/, '省略 persist 时默认落盘，不能悄悄丢掉这次推进');

  // 返回值目前没有消费者（server.js:658 丢弃），但它是导出函数的契约：
  // 将来谁写 `if (!touchDevice(t)) reject()`，返回反了就会把可信设备挡在门外。
  assert.equal(touchDevice('never-approved', { now: 1 }), false, '未知设备推进不了，要如实返回 false');
  cleanup();
});

// server.js 的两处广播过滤（:906、:951）拿它的结果决定谁收得到事件。
// 这里把「返回的是装着全部可信 token 的 Set」钉死——换成别的类型，has() 的语义就变了。
test('getTrustedDeviceTokens 返回可信 token 的 Set，供广播过滤使用', async () => {
  const { approveDevice, getTrustedDeviceTokens } = await import(`../devices.js?t=${Date.now()}`);
  approveDevice('dev_a');
  approveDevice('dev_b');

  const tokens = getTrustedDeviceTokens();
  assert.ok(tokens instanceof Set, '广播过滤按 Set 用');
  assert.deepEqual([...tokens].sort(), ['dev_a', 'dev_b']);
  cleanup();
});

// 四个字段共用同一个形态 `typeof x === 'string' && x ? x : null`，再加 num() 的
// `Number.isFinite(v) && v > 0`——五个位置一族。换成 || 之后空串和非正数会被原样留下。
// 后果在渲染侧：下游用 `?? '未知'` 兜底，而 ?? 只对 null/undefined 生效，
// 留下空串会渲染成空白，留下 0 会显示成 1970 年。
test('设备记录归一化：空串和非正数一律变成 null，不是原样留下', async () => {
  const { getTrustedDevices } = await import(`../devices.js?t=${Date.now()}`);
  writeFileSync(join(tempDir, 'trusted-devices.json'), JSON.stringify([{
    deviceToken: 'dev_norm',
    ip: '',
    userAgent: '',
    approvedAt: 0,
    lastSeenAt: -1,
    secretHash: '',
  }]));

  assert.deepEqual(getTrustedDevices(), [{
    deviceToken: 'dev_norm',
    ip: null,
    userAgent: null,
    approvedAt: null,
    lastSeenAt: null,
    secretHash: null,
  }]);
  cleanup();
});

// :80 的 `d && typeof d.deviceToken === 'string'` 换成 || 之后，数组里出现 null 会让
// typeof null.deviceToken 抛异常、被外层 catch 吞掉——结果是**整个待批队列被清空**。
// 一条坏记录不该让其余待批设备一起消失：那会让用户的配对请求无声无息地不见。
test('pending 文件里混进坏记录时，只丢掉坏的那条，其余待批设备保留', async () => {
  const { getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  writeFileSync(join(tempDir, 'pending-devices.json'), JSON.stringify([
    null,
    { deviceToken: 'good-1', ip: '10.0.0.1', ts: 2 },
    { ip: '10.0.0.2', ts: 3 },
    'not-an-object',
    { deviceToken: 'good-2', ip: '10.0.0.3', ts: 1 },
  ]));

  assert.deepEqual(getPendingDevices().map(d => d.deviceToken), ['good-1', 'good-2']);
  cleanup();
});

// DEVICE-05 的方向此前只是一行 catch 里的赋值，没有任何东西声明过它是**选过的**。
// 现状：trusted-devices.json 读不出来（损坏 / 权限 / 磁盘错）→ 清空信任 → 所有设备被挡在门外。
//
// 这是 fail-closed，代价是可用性：一次文件损坏会把所有人锁在外面，得用注册凭证重新配对。
// 姊妹项目在同一个岔口选了相反方向（保留 last-good 快照，可用性优先）。两个方向都成立，
// 差别在于：本项目的门后面是能改本机文件系统的 agent，所以「宁可全锁死也不要拿一份
// 不知道是否过期的信任表放行」——这个理由要写在这里，否则下一个人会按直觉把它改成 last-good。
//
// 第二段断言同样重要：**这是持续 fail-closed，不是永久卡死**。文件恢复后信任要跟着回来。
// （早先我误判过这里：catch 分支没有重置 lastTrustedSignature，看着像会永久锁死。实际上
// 旧签名与新文件的签名不等，所以每次调用都会重新尝试读——不对称不等于缺陷。）
test('trusted-devices.json 读不出来时清空全部信任，文件恢复后信任跟着回来', async () => {
  const { approveDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  const file = join(tempDir, 'trusted-devices.json');
  approveDevice('dev_fc');
  assert.equal(isDeviceTrusted('dev_fc'), true, '前置：先真的被信任');

  writeFileSync(file, '{ 这不是合法 JSON');
  assert.equal(isDeviceTrusted('dev_fc'), false,
    '读不出信任表时不放行：门后面是能改本机文件系统的 agent，宁可全锁死也不拿存疑的信任表放行');

  // 恢复文件——信任必须回来，否则一次瞬时读失败就等于永久失信。
  writeFileSync(file, JSON.stringify([{ deviceToken: 'dev_fc', approvedAt: 1700000000000 }]));
  assert.equal(isDeviceTrusted('dev_fc'), true, '这是持续 fail-closed，不是永久卡死');
  cleanup();
});

// 读失败之后**禁止写盘**。这不是方向取舍，是防数据丢失：
// approveDevice / denyDevice 都是「load → 改内存 → save 整张表」，而 load 失败会把
// 内存清空。于是一次瞬时读失败（fd 耗尽、权限被改、EIO——磁盘上的字节完全没问题）之后，
// 管理员批准任何一台设备，saveTrustedDevices 就会把「只剩这一台」原子覆盖回文件，
// 原来那份好数据永久消失，所有老设备必须重新配对。
//
// 修法是最窄的那个：上一次加载失败时不允许写。两个写入方本来就有
// `if (!saveTrustedDevices())` 的回滚分支，会自动走进去并如实返回 false。
test('信任表读不出来时禁止写盘，不让一次批准把整张表覆盖掉', async () => {
  const { approveDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  const file = join(tempDir, 'trusted-devices.json');
  const record = token => ({
    deviceToken: token, ip: null, userAgent: null, approvedAt: 1700000000000, lastSeenAt: 1700000000000,
  });

  const good = JSON.stringify([record('old-1'), record('old-2')]);
  writeFileSync(file, good);
  assert.equal(isDeviceTrusted('old-1'), true, '前置：两台老设备是可信的');

  const broken = '{ 这不是合法 JSON';
  writeFileSync(file, broken);

  assert.equal(approveDevice('brand-new-device'), false,
    '读不出信任表时不该声称批准成功——管理员需要知道这次没生效');
  assert.equal(readFileSync(file, 'utf8'), broken,
    '磁盘上那份必须原封不动。覆盖成「只剩新设备这一台」会让老设备永久失联');

  // 不是永久砖化：文件恢复后一切照常。
  writeFileSync(file, good);
  assert.equal(approveDevice('brand-new-device'), true, '文件恢复后批准要能重新生效');
  assert.equal(isDeviceTrusted('old-1'), true, '老设备仍在');
  assert.equal(isDeviceTrusted('brand-new-device'), true);
  cleanup();
});

// denyDevice 是同一形态的第二个写入方（批 1 的教训：补断言前先 grep 守卫出现几次）。
// 它更危险一点：空 Map 上 delete 再 save，写回去的是一个空数组。
test('信任表读不出来时撤销也不写盘，不把整张表清成空数组', async () => {
  const { denyDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  const file = join(tempDir, 'trusted-devices.json');
  const record = token => ({
    deviceToken: token, ip: null, userAgent: null, approvedAt: 1700000000000, lastSeenAt: 1700000000000,
  });

  writeFileSync(file, JSON.stringify([record('keep-1'), record('doomed')]));
  assert.equal(isDeviceTrusted('keep-1'), true, '前置');

  const broken = '[{"deviceToken": ';
  writeFileSync(file, broken);

  assert.equal(denyDevice('doomed'), false, '读不出信任表时撤销无从谈起，要如实报失败');
  assert.equal(readFileSync(file, 'utf8'), broken, '不能写回一个空数组');
  cleanup();
});
