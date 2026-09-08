import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isLocalAccess,
  isLoopbackAddress,
  isLoopbackHostHeader,
  resolveListenHost,
  normalizeAddress,
  hostnameFromHeader,
  evaluateTransportSecurity,
  evaluateSocketHandshakeSecurity,
  parseGatewaySecurityPolicy,
} from '../server-security.js';

// ---- normalizeAddress ----

test('normalizeAddress: strips ::ffff: prefix', () => {
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('::ffff:10.0.0.1'), '10.0.0.1');
});

test('normalizeAddress: lowercases and trims', () => {
  assert.equal(normalizeAddress('  LOCALHOST  '), 'localhost');
  assert.equal(normalizeAddress('::1'), '::1');
});

test('normalizeAddress: handles empty/null/undefined', () => {
  assert.equal(normalizeAddress(''), '');
  assert.equal(normalizeAddress(null), '');
  assert.equal(normalizeAddress(undefined), '');
});

// ---- hostnameFromHeader ----

test('hostnameFromHeader: extracts host from IPv6 bracket notation', () => {
  assert.equal(hostnameFromHeader('[::1]:3001'), '::1');
  assert.equal(hostnameFromHeader('[fe80::1]:8080'), 'fe80::1');
});

test('hostnameFromHeader: strips port from IPv4', () => {
  assert.equal(hostnameFromHeader('127.0.0.1:3001'), '127.0.0.1');
  assert.equal(hostnameFromHeader('example.com:80'), 'example.com');
});

test('hostnameFromHeader: returns host as-is when no port', () => {
  assert.equal(hostnameFromHeader('localhost'), 'localhost');
  assert.equal(hostnameFromHeader('127.0.0.1'), '127.0.0.1');
});

test('hostnameFromHeader: handles empty/null/undefined', () => {
  assert.equal(hostnameFromHeader(''), '');
  assert.equal(hostnameFromHeader(null), '');
  assert.equal(hostnameFromHeader(undefined), '');
});

// ---- isLoopbackAddress ----

test('isLoopbackAddress: recognizes all loopback formats', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('127.255.255.255'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('localhost'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
});

test('isLoopbackAddress: rejects non-loopback addresses', () => {
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('192.168.1.1'), false);
  assert.equal(isLoopbackAddress('0.0.0.0'), false);
  assert.equal(isLoopbackAddress('8.8.8.8'), false);
  assert.equal(isLoopbackAddress('example.com'), false);
  assert.equal(isLoopbackAddress('::2'), false);
  assert.equal(isLoopbackAddress('fe80::1'), false);
});

test('isLoopbackAddress: handles empty/null/undefined', () => {
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

// ---- isLoopbackHostHeader ----

test('isLoopbackHostHeader: recognizes loopback with port', () => {
  assert.equal(isLoopbackHostHeader('localhost:3001'), true);
  assert.equal(isLoopbackHostHeader('127.0.0.1:8080'), true);
  assert.equal(isLoopbackHostHeader('[::1]:3001'), true);
});

test('isLoopbackHostHeader: rejects non-loopback hosts', () => {
  assert.equal(isLoopbackHostHeader('public.example.com'), false);
  assert.equal(isLoopbackHostHeader('0.0.0.0:3001'), false);
  assert.equal(isLoopbackHostHeader('10.0.0.1:3001'), false);
});

// ---- isLocalAccess ----

test('isLocalAccess: requires both loopback socket AND host header', () => {
  // Both loopback → true
  assert.equal(isLocalAccess({ remoteAddress: '127.0.0.1', hostHeader: 'localhost:3001' }), true);
  assert.equal(isLocalAccess({ remoteAddress: '::1', hostHeader: '127.0.0.1:3001' }), true);
  assert.equal(isLocalAccess({ remoteAddress: '::ffff:127.0.0.1', hostHeader: '[::1]:3001' }), true);
});

test('isLocalAccess: rejects when either is non-loopback', () => {
  // Remote loopback, host public → false
  assert.equal(isLocalAccess({ remoteAddress: '127.0.0.1', hostHeader: 'public.example.com' }), false);
  // Remote public, host loopback → false
  assert.equal(isLocalAccess({ remoteAddress: '10.0.0.42', hostHeader: 'localhost:3001' }), false);
  // Both public → false
  assert.equal(isLocalAccess({ remoteAddress: '10.0.0.1', hostHeader: 'public.example.com' }), false);
});

test('isLocalAccess: handles missing fields', () => {
  assert.equal(isLocalAccess({}), false);
  assert.equal(isLocalAccess({ remoteAddress: '' }), false);
  assert.equal(isLocalAccess({ hostHeader: '' }), false);
});

// ---- resolveListenHost ----

test('server defaults to loopback binding', () => {
  assert.equal(resolveListenHost({ env: {}, authToken: '' }), '127.0.0.1');
});

test('server refuses non-loopback host without AUTH_TOKEN', () => {
  assert.throws(
    () => resolveListenHost({ env: { HOST: '0.0.0.0' }, authToken: '' }),
    /AUTH_TOKEN/
  );
});

test('server allows explicit remote bind only when AUTH_TOKEN is set', () => {
  assert.equal(resolveListenHost({ env: { HOST: '0.0.0.0' }, authToken: 'a'.repeat(32) }), '0.0.0.0');
});

test('server refuses a weak AUTH_TOKEN for a remote bind', () => {
  assert.throws(
    () => resolveListenHost({ env: { HOST: '0.0.0.0' }, authToken: 'short-secret' }),
    /32 characters/
  );
});

test('resolveListenHost: allows loopback host without AUTH_TOKEN', () => {
  assert.equal(resolveListenHost({ env: { HOST: '127.0.0.1' }, authToken: '' }), '127.0.0.1');
  assert.equal(resolveListenHost({ env: { HOST: 'localhost' }, authToken: '' }), 'localhost');
});

test('resolveListenHost: uses custom HOST from env', () => {
  assert.equal(resolveListenHost({ env: { HOST: '192.168.1.100' }, authToken: 'a'.repeat(32) }), '192.168.1.100');
});

// ---- Host header injection ----

test('isLoopbackHostHeader: rejects host injection attempts', () => {
  // Double host header
  assert.equal(isLoopbackHostHeader('localhost, public.example.com'), false);
  // Null byte injection
  assert.equal(isLoopbackHostHeader('localhost\0.evil.com'), false);
  // Whitespace injection
  assert.equal(isLoopbackHostHeader(' localhost :3001'), true); // trimmed, still loopback
});

test('transport security rejects a direct remote HTTP request by default', () => {
  assert.deepEqual(evaluateTransportSecurity({
    remoteAddress: '10.0.0.42',
    hostHeader: 'codex.example.com',
    socketEncrypted: false,
  }, {
    trustedProxyIps: [],
    allowInsecureRemote: false,
  }), {
    ok: false,
    reason: 'https_required',
    local: false,
    remote: true,
    secure: false,
    viaTrustedProxy: false,
    effectiveProtocol: 'http',
  });
});

test('transport security accepts HTTPS asserted by an explicitly trusted proxy', () => {
  assert.deepEqual(evaluateTransportSecurity({
    remoteAddress: '127.0.0.1',
    hostHeader: 'codex.example.com',
    socketEncrypted: false,
    forwardedProtoHeader: 'https',
  }, {
    trustedProxyIps: ['127.0.0.1'],
    allowInsecureRemote: false,
  }), {
    ok: true,
    reason: null,
    local: false,
    remote: true,
    secure: true,
    viaTrustedProxy: true,
    effectiveProtocol: 'https',
  });
});

test('socket handshake security rejects a remote origin outside the exact allowlist', () => {
  const result = evaluateSocketHandshakeSecurity({
    remoteAddress: '10.0.0.42',
    hostHeader: 'codex.example.com',
    socketEncrypted: true,
    originHeader: 'https://evil.example',
  }, {
    allowedOrigins: ['https://codex.example.com'],
    trustedProxyIps: [],
    allowInsecureRemote: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_allowed');
  assert.equal(result.normalizedOrigin, 'https://evil.example');
});

// docs/SMOKE_MATRIX.md 的 VC-A02 / VC-H05 要在本机复现「远程设备接入」，靠的是一份
// 四项配置的配方。这条测试守的不是某一道闸，而是**那份配方仍然是完整的**：四项配齐就放行，
// 拿掉任何一项就被挡在对应的那道闸上。将来若新增第五道闸，「配齐即放行」这半边会先红，
// 提醒同步改文档 —— 否则文档会静默过期，而过期的前置比没有前置更贵：上一版写的是
// 「需要第二台真机」，照做的人会撞在 https_required 上，然后得出「这条跑不了」的结论。
const REMOTE_RECIPE = Object.freeze({
  env: { CODEX_ALLOW_INSECURE_REMOTE: '1', CODEX_ALLOWED_ORIGINS: 'http://192.168.1.10:3001' },
  request: {
    remoteAddress: '192.168.1.10',
    hostHeader: '192.168.1.10:3001',
    socketEncrypted: false,
    originHeader: 'http://192.168.1.10:3001',
  },
});

test('the documented single-machine remote-access recipe still lets a remote device reach the pairing gate', () => {
  const policy = parseGatewaySecurityPolicy(REMOTE_RECIPE.env);
  const result = evaluateSocketHandshakeSecurity(REMOTE_RECIPE.request, policy);

  assert.equal(result.ok, true, `远程握手被 ${result.reason} 挡住了；文档里的配方已经不完整`);
  // remote 必须为真：整条用例的意义就在于这台设备走的是非本地路径，会落进待批队列。
  // 若哪天它被判成 local，A02 会「通过」得毫无意义 —— 设备闸根本没参与。
  assert.equal(result.remote, true, '这台设备被判成了本地，设备配对流程不会触发');
});

test('dropping any single knob from the remote-access recipe blocks it at a nameable gate', () => {
  const cases = [
    ['CODEX_ALLOW_INSECURE_REMOTE', { CODEX_ALLOWED_ORIGINS: REMOTE_RECIPE.env.CODEX_ALLOWED_ORIGINS }, 'https_required'],
    ['CODEX_ALLOWED_ORIGINS', { CODEX_ALLOW_INSECURE_REMOTE: '1' }, 'origin_not_allowed'],
  ];
  for (const [dropped, env, expected] of cases) {
    const result = evaluateSocketHandshakeSecurity(REMOTE_RECIPE.request, parseGatewaySecurityPolicy(env));
    assert.equal(result.ok, false, `少了 ${dropped} 却仍然放行`);
    assert.equal(result.reason, expected, `少了 ${dropped} 应当被 ${expected} 挡住`);
  }

  // 第三项：浏览器不发 Origin。远程接入必须自报来源，否则无从判断同源。
  const noOrigin = evaluateSocketHandshakeSecurity(
    { ...REMOTE_RECIPE.request, originHeader: '' },
    parseGatewaySecurityPolicy(REMOTE_RECIPE.env),
  );
  assert.equal(noOrigin.reason, 'origin_required');
});

test('gateway security policy canonicalizes and deduplicates exact origins and proxy IPs', () => {
  assert.deepEqual(parseGatewaySecurityPolicy({
    CODEX_ALLOWED_ORIGINS: ' https://codex.example.com/,https://codex.example.com:443,https://two.example ',
    CODEX_TRUSTED_PROXY_IPS: '127.0.0.1,::ffff:127.0.0.1,::1',
    CODEX_ALLOW_INSECURE_REMOTE: '0',
  }), {
    allowedOrigins: ['https://codex.example.com', 'https://two.example'],
    trustedProxyIps: ['127.0.0.1', '::1'],
    allowInsecureRemote: false,
  });
});

// AUTH-02 的后半句是「缺失、多值、来自非可信 IP 一律拒绝」。前两项在实现里是
// evaluateTransportSecurity 的两条早退，而变异显示这两条出口此前**一次都没被进入过**：
// 把它们的 ok:false 改成 ok:true、secure:false 改成 secure:true，整个文件 34 条测试全绿。
// 也就是说，谁把这两个分支"简化"掉，可信代理后面的远程明文就会被判成安全连接放行，
// 而不会有任何测试变红。
//
// 多值为什么算非法：Node 把重复出现的同名请求头用 ', ' 拼成**一个字符串**（set-cookie 除外）。
// 链路上第二个代理再补一个 X-Forwarded-Proto，这里拿到的就是 'https, http'——它既不等于
// 'http' 也不等于 'https'，落进 invalid_forwarded_proto。取第一段或最后一段都是错的：
// 前者信了最外层代理（可被伪造），后者信了最内层（可能根本没做 TLS）。无法确定就拒绝。
const VIA_TRUSTED_PROXY = Object.freeze({
  remoteAddress: '127.0.0.1',
  hostHeader: 'codex.example.com',
  socketEncrypted: false,
});
const TRUSTED_PROXY_POLICY = Object.freeze({
  trustedProxyIps: ['127.0.0.1'],
  allowInsecureRemote: false,
});

test('可信代理给不出单一 X-Forwarded-Proto 时，传输层拒绝，而不是替它猜一个协议', () => {
  const cases = [
    ['头缺失', undefined, 'forwarded_proto_required'],
    ['头只有空白', '   ', 'forwarded_proto_required'],
    ['头不是字符串', ['https'], 'forwarded_proto_required'],
    ['多值：两级代理各加了一个', 'https, http', 'invalid_forwarded_proto'],
    ['协议不认识', 'ftp', 'invalid_forwarded_proto'],
  ];

  for (const [label, forwardedProtoHeader, reason] of cases) {
    assert.deepEqual(
      evaluateTransportSecurity({ ...VIA_TRUSTED_PROXY, forwardedProtoHeader }, TRUSTED_PROXY_POLICY),
      {
        ok: false,
        reason,
        local: false,
        remote: true,
        secure: false,
        viaTrustedProxy: true,
        effectiveProtocol: 'http',
      },
      `${label}：代理的协议断言不可用时必须拒绝，且不能顺手把连接标成 secure`,
    );
  }
});

// evaluateSocketHandshakeSecurity 有 8 条返回出口。变异显示测试此前只走到 3 条：把 :108 /
// :112 / :125 / :127 的 return 换成 return null，测试照样全绿——那几行从来没被执行过。
//
// 缺的那块里最要紧的是**本机来源的 Origin 判定**。远程那条（origin_not_allowed）有测试，
// 本机那条没有；而本机那条挡的是同一台机器上另一个端口的页面把 socket 连过来——loopback
// 绑定挡得住外网，挡不住本机上任何一个跑在浏览器里的页面。
const LOCAL_REQUEST = Object.freeze({
  remoteAddress: '127.0.0.1',
  hostHeader: 'localhost:3001',
  socketEncrypted: false,
});
const REMOTE_REQUEST = Object.freeze({
  remoteAddress: '10.0.0.42',
  hostHeader: 'codex.example.com',
  socketEncrypted: true,
});

test('握手的每一条出口都有且只有一种判定：本机同源放行、本机异源按远程同样的白名单挡', () => {
  const cases = [
    // [名字, request, policy, 期望 {ok, reason, normalizedOrigin}]
    ['本机 + 同源', { ...LOCAL_REQUEST, originHeader: 'http://localhost:3001' }, {},
      { ok: true, reason: null, normalizedOrigin: 'http://localhost:3001' }],

    // 本机上另一个端口的页面。loopback 绑定对它毫无作用，只有这道 Origin 闸挡得住。
    ['本机 + 异源且不在白名单', { ...LOCAL_REQUEST, originHeader: 'http://localhost:9999' }, {},
      { ok: false, reason: 'origin_not_allowed', normalizedOrigin: 'http://localhost:9999' }],

    // 白名单对本机同样生效：显式列进去的异源要放行，否则反代自测这类场景无法配置。
    ['本机 + 异源但已列入白名单', { ...LOCAL_REQUEST, originHeader: 'http://localhost:9999' },
      { allowedOrigins: ['http://localhost:9999'] },
      { ok: true, reason: null, normalizedOrigin: 'http://localhost:9999' }],

    // ⚠ 反直觉方向：本机不带 Origin 是**放行**的。非浏览器客户端（curl、Node 脚本）不发
    // Origin，而本机 CLI 工具是被支持的用法；远程同样情形则拒绝（下一条）。
    ['本机 + 完全不带 Origin', { ...LOCAL_REQUEST }, {},
      { ok: true, reason: null, normalizedOrigin: null }],

    ['远程 + 完全不带 Origin', { ...REMOTE_REQUEST }, {},
      { ok: false, reason: 'origin_required', normalizedOrigin: null }],

    // 浏览器在跨源不透明请求里发的字面量 'null'，等同于没有来源。
    ['远程 + Origin 是字面量 null', { ...REMOTE_REQUEST, originHeader: 'null' }, {},
      { ok: false, reason: 'origin_required', normalizedOrigin: null }],

    // 规范化失败和"规范化成功但不在白名单"是两种不同的拒绝，理由不能混：前者是请求本身畸形，
    // 后者是配置没覆盖到。运维照着 reason 排查时，指错方向比不给理由更贵。
    ['任意来源 + Origin 畸形（带路径）', { ...LOCAL_REQUEST, originHeader: 'http://localhost:3001/admin' }, {},
      { ok: false, reason: 'invalid_origin', normalizedOrigin: null }],

    ['远程 + Origin 不在白名单', { ...REMOTE_REQUEST, originHeader: 'https://evil.example' },
      { allowedOrigins: ['https://codex.example.com'] },
      { ok: false, reason: 'origin_not_allowed', normalizedOrigin: 'https://evil.example' }],

    ['远程 + Origin 在白名单', { ...REMOTE_REQUEST, originHeader: 'https://codex.example.com' },
      { allowedOrigins: ['https://codex.example.com'] },
      { ok: true, reason: null, normalizedOrigin: 'https://codex.example.com' }],

    // 传输层先拒的，握手层原样透传并补上 normalizedOrigin: null——不能因为 Origin 合法
    // 就把 https_required 覆盖掉。
    ['传输层已拒（远程明文）时 Origin 合法也不翻案',
      { ...REMOTE_REQUEST, socketEncrypted: false, originHeader: 'https://codex.example.com' },
      { allowedOrigins: ['https://codex.example.com'] },
      { ok: false, reason: 'https_required', normalizedOrigin: null }],
  ];

  for (const [label, request, policy, expected] of cases) {
    const result = evaluateSocketHandshakeSecurity(request, {
      trustedProxyIps: [],
      allowInsecureRemote: false,
      ...policy,
    });
    assert.deepEqual(
      { ok: result.ok, reason: result.reason, normalizedOrigin: result.normalizedOrigin },
      expected,
      label,
    );
  }
});

// canonicalOrigin 的严格程度对**配置**才是真的有价值：运维写 CODEX_ALLOWED_ORIGINS 时
// 若把路径也写进去（想限制到某个前缀），静默截成 origin 会授予比他以为的更大的范围。
// 当场报错才能让他知道 Origin 里没有路径这回事。
// （Origin 请求头那边这套严格性只是卫生：浏览器不会发带凭据或路径的 Origin，非浏览器攻击者
// 也可以直接发干净的那个，所以它不构成绕过面。两处用同一个函数，测配置这一侧就够了。）
test('CODEX_ALLOWED_ORIGINS 只收纯 origin，多写的部分当场报错而不是被悄悄截掉', () => {
  const rejected = [
    ['带路径', 'https://codex.example.com/app'],
    ['带查询串', 'https://codex.example.com/?token=x'],
    ['带片段', 'https://codex.example.com/#/chat'],
    ['带用户名', 'https://user@codex.example.com'],
    ['带用户名和密码', 'https://user:pw@codex.example.com'],
    ['协议不是 http(s)', 'ftp://codex.example.com'],
    ['压根不是 URL', 'codex.example.com'],
  ];

  for (const [label, value] of rejected) {
    assert.throws(
      () => parseGatewaySecurityPolicy({ CODEX_ALLOWED_ORIGINS: value }),
      /Invalid CODEX_ALLOWED_ORIGINS entry/,
      `${label}：${value} 应当被拒绝`,
    );
  }
});

// ackError 是 26 个 socket 处理器共用的失败出口（thread:*、models:read、files:search、
// account:read、mcp:read、externalAgentConfig:import、p3:* 等），它给出的字符串会被
// appendSystem(ack?.error, true) 直接渲染进手机上的消息列表。
//
// 全仓其他用户可见的错误都过 sanitize()——agent-appserver 的 turn/start、turn/steer、
// 启动失败都是。ackError 曾是唯一一条绕过去的：原始 error.message 直送浏览器。后果很具体：
// externalAgentConfig:import 解析带 API key 的外部配置、mcp:read 读带凭证的 MCP 配置、
// account:* 走认证流程，这些地方的报错都可能把密钥带在 message 里，最后显示在屏幕上并
// 进入用户的截图。控制字符同理——escHtml 挡 HTML，不挡 ANSI 转义。
async function importServerHelpers() {
  const prev = process.env.CODEX_SERVER_NO_START;
  process.env.CODEX_SERVER_NO_START = '1';
  try {
    return await import(`../server.js?ackError=${Date.now()}-${Math.random()}`);
  } finally {
    if (prev === undefined) delete process.env.CODEX_SERVER_NO_START;
    else process.env.CODEX_SERVER_NO_START = prev;
  }
}

test('ackError 抹掉错误信息里的密钥，不把它送到手机屏幕上', async () => {
  const { ackError } = await importServerHelpers();
  const acks = [];

  ackError(payload => acks.push(payload), new Error(
    'failed to parse config: OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  ));

  assert.equal(acks[0].ok, false);
  assert.doesNotMatch(
    acks[0].error,
    /sk-proj-abcdefghijklmnopqrstuvwxyz012345/,
    '密钥不能出现在返回给浏览器的错误里',
  );
  assert.match(acks[0].error, /failed to parse config/, '有用的部分要留着，否则没法排查');
});

test('ackError 剥掉控制字符，避免 ANSI 转义污染消息列表', async () => {
  const { ackError } = await importServerHelpers();
  const acks = [];
  const ansi = '\u001b[31mfatal\u001b[0m bad state';

  ackError(payload => acks.push(payload), new Error(ansi));

  assert.ok(!acks[0].error.includes('\u001b'), 'escHtml 只挡 HTML，不挡终端控制序列');
  assert.match(acks[0].error, /fatal/);
});

test('ackError 对非 Error 的抛出物也给得出可读的字符串', async () => {
  const { ackError } = await importServerHelpers();
  const acks = [];

  ackError(payload => acks.push(payload), 'plain string failure');
  ackError(payload => acks.push(payload), null);

  assert.equal(acks[0].error, 'plain string failure');
  assert.equal(acks[1].ok, false);
  assert.ok(acks[1].error, '兜底也要有话说，不能是空串让页面显示一片空白');
});

test('ackError 没有 ack 回调时不抛异常', async () => {
  const { ackError } = await importServerHelpers();
  assert.doesNotThrow(() => ackError(undefined, new Error('no ack')));
});

test('送往浏览器的错误文案一律经过 sanitize', () => {
  // 这是一条绊线，守的是一整类问题而不是某一处：只要有人再写一处
  // `${err.message}` 直插用户可见文案，这里就会红。
  //
  // 判据是「会不会到浏览器」：console.* 是宿主机自己的终端，主人看自己的完整报错
  // 天经地义，不脱敏；emit / ack / payload.message 会跨网络到手机上，必须脱敏。
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const lines = source.split('\n');
  const offenders = [];
  lines.forEach((line, index) => {
    // 两种写法都要管：模板插值 `…${err.message}…`，以及 { error: err.message }。
    // 第一版只查了前者，于是 message:reconcile、结构化输入校验和 dispatch_failed
    // 三处漏网 —— 一条只覆盖一半形态的绊线，比没有绊线更危险，因为它会让人以为查过了。
    const interpolated = /\$\{(?:err|error)\??\.message/.test(line);
    const assigned = /^\s*error:\s*(?:err|error)\??\.message/.test(line);
    if (!interpolated && !assigned) return;
    if (/sanitize\(/.test(line)) return;
    if (/console\.(error|warn|log)/.test(line)) return;
    // 审计文件那条路整条 entry 都会过 sanitizeAdminAuditValue 递归脱敏，不必在写入点重复。
    const window = lines.slice(Math.max(0, index - 8), index).join('\n');
    if (/append(?:SecurityAudit|HostConfigAudit)\(/.test(window)) return;
    offenders.push(`${index + 1}: ${line.trim()}`);
  });
  assert.deepEqual(
    offenders,
    [],
    '这些行把原始 err.message 插进了会发到浏览器的文案里。上游报错可能带 API key、'
    + 'Bearer token 或 ANSI 转义 —— 前两者会显示在手机屏幕上并进入截图，后者会污染消息列表。'
    + '用 sanitize(...) 包一层；如果这条确实只进宿主机的 console，改用 console.*。',
  );
});

test('任何向全部 socket 广播的循环都必须过 deviceApproved 过滤', () => {
  // pending 设备是「凭证对了、但人还没点同意」的设备。服务端有五处广播循环
  // 各自写着一行 `if (socket.deviceApproved !== true) continue;`——同一个不变量
  // 复制了五遍，从其中一处漏掉不会有任何东西报警。
  //
  // 漏了会泄什么，按严重程度：needs-you 广播带审批 payload（agent 要执行的命令原文）、
  // instances 广播带 cwd（宿主机目录路径）、thread 状态带会话名、状态栏带其内容。
  //
  // 判据只看会不会发数据：遍历 socket 去 disconnect、去收集列表、去清字段的循环
  // 不需要这道闸，所以规则是「循环体里出现 socket.emit 就必须出现 deviceApproved」。
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const lines = source.split('\n');
  const offenders = [];

  lines.forEach((line, index) => {
    if (!/for \(const socket of io\.sockets\.sockets\.values\(\)\) \{/.test(line)) return;
    // 从循环起始行做花括号配平，取出循环体。
    let depth = 0;
    let body = '';
    for (let i = index; i < lines.length; i += 1) {
      body += `${lines[i]}\n`;
      for (const char of lines[i]) {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
      }
      if (depth === 0 && i > index) break;
    }
    if (!/socket\.emit\(/.test(body)) return; // 不发数据的循环不需要这道闸
    if (/deviceApproved/.test(body)) return;
    offenders.push(`${index + 1}: ${line.trim()}`);
  });

  assert.deepEqual(
    offenders,
    [],
    '这些广播循环没有过滤未批准设备。pending 设备持有有效会话但人还没点同意，'
    + '它不该看到审批命令、宿主机路径或会话名。加上 `if (socket.deviceApproved !== true) continue;`。',
  );
});

// ---- AUTH-05：认证失败限流 ----
//
// 既有的「同一个 IP 连续失败会被限流」在 server-integration 里有测试，但变异暴露了另外半边
// 完全没人守：`const key = clientIp(address) || 'unknown'` 换成 `&&` 之后，所有来源塌进
// 同一个桶——**一个人被限流会牵连所有人**，而那条既有测试照样全绿（它只从一个 IP 发起）。
//
// 这三条从 socket 那一侧驱动不了：来源地址由内核决定，注入不进去。所以直接驱动导出的
// recordAuthFailure，用注入的 now 控时间——与 reclaimIdleAgents / pushDecision 同一做法。
async function importServerWithAuthLimits({ maxFailures, windowMs }) {
  const prev = {
    start: process.env.CODEX_SERVER_NO_START,
    max: process.env.CODEX_AUTH_MAX_FAILURES,
    win: process.env.CODEX_AUTH_WINDOW_MS,
  };
  process.env.CODEX_SERVER_NO_START = '1';
  process.env.CODEX_AUTH_MAX_FAILURES = String(maxFailures);
  process.env.CODEX_AUTH_WINDOW_MS = String(windowMs);
  try {
    return await import(`../server.js?authlimits=${Date.now()}-${Math.random()}`);
  } finally {
    for (const [key, value] of [
      ['CODEX_SERVER_NO_START', prev.start],
      ['CODEX_AUTH_MAX_FAILURES', prev.max],
      ['CODEX_AUTH_WINDOW_MS', prev.win],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const T0 = 1_700_000_000_000;

test('认证失败窗口按来源隔离：一个来源被限流不牵连另一个', async () => {
  const { recordAuthFailure } = await importServerWithAuthLimits({ maxFailures: 2, windowMs: 60_000 });

  assert.equal(recordAuthFailure('10.0.0.1', T0).rateLimited, false);
  assert.equal(recordAuthFailure('10.0.0.1', T0).rateLimited, false);
  assert.equal(recordAuthFailure('10.0.0.1', T0).rateLimited, true, '同一来源第 3 次越过上限');

  const other = recordAuthFailure('10.0.0.2', T0);
  assert.equal(other.count, 1, '另一个来源必须是全新窗口，而不是接着别人的计数');
  assert.equal(other.rateLimited, false,
    '窗口以来源为键。塌成一个全局桶的话，一个攻击者失败几次就能把所有人挡在门外');

  // 反过来也要成立：取不到来源地址的连接必须共用一个桶，否则「没有地址」等于无限次尝试。
  assert.equal(recordAuthFailure('', T0).count, 1);
  assert.equal(recordAuthFailure(undefined, T0).count, 2, '地址取不到时归进同一个桶');
});

test('限流窗口在它自己报出的 resetAt 时刻真的过期', async () => {
  const { recordAuthFailure } = await importServerWithAuthLimits({ maxFailures: 2, windowMs: 60_000 });

  const first = recordAuthFailure('10.0.0.3', T0);
  assert.equal(first.resetAt, T0 + 60_000);
  recordAuthFailure('10.0.0.3', T0);
  assert.equal(recordAuthFailure('10.0.0.3', T0).rateLimited, true, '前置：先真的被限流');

  // 服务端在 429 响应里把 resetAt 告诉了客户端。客户端按它重试时必须真的放行——
  // 差一毫秒就意味着「照提示重试仍被拒」，用户读到的是一句不兑现的话。
  const atReset = recordAuthFailure('10.0.0.3', first.resetAt);
  assert.equal(atReset.count, 1, 'resetAt 当刻必须开新窗口，不是接着旧计数');
  assert.equal(atReset.rateLimited, false);
});

// ⚠ 这条测试改过一次，原因值得写下来。
//
// 它原来断言的是「表撑满时一条生效中的窗口都不许清」。加上硬上界之后它红了——而它**应该**红：
// 「永不淘汰生效中的窗口」和「表有硬上界」在**所有窗口都生效**时是互相矛盾的，
// 两个不能都要。原来那条断言实际上描述的是一个无界的设计。
//
// 仍然成立、也仍然要守的是它的另一半：**有过期条目可清时，绝不去动生效中的窗口**。
// 这才是「攻击者不能靠撑表来重置自己的计数」在有界前提下能保住的部分。
test('表撑满时优先淘汰过期窗口，生效中的窗口不被误伤', async () => {
  const { recordAuthFailure } = await importServerWithAuthLimits({ maxFailures: 2, windowMs: 60_000 });
  const filler = index => `10.0.${(index >> 8) & 255}.${index & 255}`;
  const attacker = '10.9.9.9';

  // 先铺满一批会过期的条目，它们位于表头。
  for (let index = 0; index < 10_050; index += 1) recordAuthFailure(filler(index), T0);

  // 时间推过窗口：上面那批全部过期。攻击者此刻才开始失败，它的窗口在表尾且生效中。
  const later = T0 + 60_001;
  recordAuthFailure(attacker, later);
  recordAuthFailure(attacker, later);
  assert.equal(recordAuthFailure(attacker, later).rateLimited, true, '前置：攻击者已被限流');

  // 再灌一批把表继续顶到上限之上。要淘汰的话，表头那批过期的够用了。
  for (let index = 20_000; index < 20_200; index += 1) recordAuthFailure(filler(index), later);

  assert.equal(recordAuthFailure(attacker, later).rateLimited, true,
    '表头还有过期条目可清时，生效中的窗口不该被淘汰——否则攻击者靠撑表就能重置自己的计数');
});

// ⚠ 这条是性能与资源基线里第一条真正咬到东西的。
//
// `if (authFailureWindows.size > 10_000) pruneExpiredFailureWindows(now)` 看起来是个上界，
// 其实不是：条目还没过期时 prune 一个都删不掉，表继续涨，而**每次调用都要全表扫一遍**。
// 实测冲过阈值后同样 2000 次调用从 0.3ms 涨到 309ms（899×），且随表继续增长。
//
// 可达性不是理论上的：IPv6 下一个 /64 前缀给单台主机 2^64 个源地址，每个都会新建一个窗口。
// 也就是说——**为抵抗认证滥用而存在的限流表，自己成了放大器**。
//
// 上界不可从外部直接观察（表不导出），所以用它的可观察副作用来钉：表满之后最早那批
// 必须被淘汰，它们再来时是全新窗口。
test('认证失败窗口表有硬上界，大量不同来源不会让它无界增长', async () => {
  const { recordAuthFailure } = await importServerWithAuthLimits({
    maxFailures: 5,
    windowMs: 3_600_000,   // 一小时：整个用例期间没有任何条目会自然过期
  });
  const ip = index => `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;

  assert.equal(recordAuthFailure(ip(0), T0).count, 1, '前置：第一条是新窗口');

  for (let index = 1; index <= 10_100; index += 1) recordAuthFailure(ip(index), T0);

  assert.equal(recordAuthFailure(ip(0), T0).count, 1,
    '表撑满后最早的窗口要被淘汰。淘汰不掉就意味着这张表随「不同来源数」无界增长，'
    + '而每次失败都要全表扫一遍——限流表本身变成 DoS 放大器');
});

// 上一条钉的是「表有上界」，这条钉的是那个上界带来的后果：**每次调用的开销不随
// 已见过的来源数增长**。两条一起才完整——只有上界没有开销约束的话，一个 O(n) 的扫描
// 照样能把网关拖死。
//
// ⚠ 测量方式要紧：两次测量都必须落在**上界之上**。第一版比的是「上界生效前 vs 生效后」，
// 那测的是「淘汰这件事有没有成本」（必然有，1.2 → 21×），不是「成本随不随 n 涨」。
// 正确的比法是同样都在上界之上、只让"见过的来源数"差一个数量级。
test('认证失败的处理开销不随已见过的来源数增长', async () => {
  const { recordAuthFailure } = await importServerWithAuthLimits({
    maxFailures: 5,
    windowMs: 3_600_000,
  });
  const ip = index => `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;

  const batch = (from, count) => {
    const started = performance.now();
    for (let index = from; index < from + count; index += 1) recordAuthFailure(ip(index), T0);
    return performance.now() - started;
  };

  batch(0, 14_000);                                   // 先冲过上界，之后每次都要淘汰一条
  const atCap = Math.max(batch(14_000, 2000), 0.5);
  batch(16_000, 60_000);                              // 再见过 6 万个来源
  const farPast = batch(76_000, 2000);

  assert.ok(farPast / atCap < 3,
    `见过的来源数涨了五倍之后，单次开销放大了 ${(farPast / atCap).toFixed(1)}×——说明它在随 n 增长。`
    + '上界失效时这个数字约等于表长之比（≈5×），生效时应当接近 1');
});
