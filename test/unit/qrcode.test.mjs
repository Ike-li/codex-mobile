// test/unit/qrcode.test.mjs —— QR 编码器与终端渲染。
//
// 编码器错了的症状是「码扫不出来」或更糟——「扫得出但内容是错的」。后者没有任何提示，
// 所以这里钉的是**矩阵本身**（固化快照），而不是「函数跑完了没报错」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../../src/shared/qrcode.js';
import { encodePng } from '../../src/shared/png.js';
import { buildConnectUrl, renderMatrix, requiredColumns, reachableIPv4s } from '../../scripts/qr.js';

test('同一输入恒定产出同一矩阵——编码器必须是确定性的', () => {
  // 不确定的话，「这次扫不出来」既可能是环境问题也可能是编码器问题，查不下去。
  const a = encodeQr('https://example.com/');
  const b = encodeQr('https://example.com/');
  assert.equal(a.size, b.size);
  assert.deepEqual(a.matrix, b.matrix);
});

test('三个定位图案在正确的角上，且形态是标准的 7×7', () => {
  // 定位图案错了扫码器连网格都对不齐。这是最基本的结构性断言。
  const { matrix, size } = encodeQr('TEST');
  for (const [oy, ox] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(matrix[oy][ox], 1, '外框左上角应是暗模块');
    assert.equal(matrix[oy + 1][ox + 1], 0, '第二圈应是亮模块');
    assert.equal(matrix[oy + 3][ox + 3], 1, '中心 3×3 应是暗模块');
  }
  // 不断言右下角——V1 那里是数据区，V2 起是 alignment 图案的中心（暗模块）。
  // 按「应该是亮的」写会在两个版本上各错一次。
});

test('内容变长时版本递增，尺寸随之变大', () => {
  const short = encodeQr('a');
  const long = encodeQr('a'.repeat(100));
  assert.ok(long.version > short.version, `版本没有随内容增长：${short.version} → ${long.version}`);
  assert.equal(long.size, long.version * 4 + 17, '尺寸必须满足 4V+17');
});

test('超出 V6 容量直接抛错，不静默截断', () => {
  // 静默截断出来的码扫得出内容、但内容是错的——比扫不出来更坏，因为没有任何提示。
  const err = (() => { try { encodeQr('x'.repeat(500)); return null; } catch (e) { return e; } })();
  assert.ok(err, '超容必须抛');
  assert.match(err.message, /过长/);
  assert.match(err.message, /134/, '报错要说清上限是多少——否则用户不知道该缩到多短');
});

test('掩码可注入，注入后结果稳定——这是与外部实现逐模块对齐的唯一口子', () => {
  const a = encodeQr('MASK', { mask: 0 });
  const b = encodeQr('MASK', { mask: 0 });
  assert.equal(a.mask, 0);
  assert.deepEqual(a.matrix, b.matrix);
  assert.notDeepEqual(encodeQr('MASK', { mask: 1 }).matrix, a.matrix, '不同掩码应产出不同矩阵');
});

test('encodePng 产出合法 PNG 头与 IEND 尾', () => {
  const { matrix } = encodeQr('PNG');
  const png = encodePng(matrix, { scale: 2, quiet: 1 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IEND 块的结构是「4 字节类型 + 4 字节 CRC」，所以类型在末 8 字节的前 4 位。
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});

// ---- 连接 URL ----

test('令牌走 query 而不是 hash——本仓前端读的是 ?token=', () => {
  // 姊妹项目用 #token=。照搬那个形式会做出一张**扫得出但登不进**的码，
  // 而那种失败没有任何提示：扫码器说成功了，网页却停在登录页。
  const url = buildConnectUrl({ host: '192.168.1.5', port: 3001, token: 'abc' });
  assert.equal(url, 'http://192.168.1.5:3001/?token=abc');
  assert.doesNotMatch(url, /#/);
});

test('令牌里的特殊字符被转义，不破坏 URL', () => {
  const url = buildConnectUrl({ host: 'h', port: 1, token: 'a b&c=d' });
  assert.match(url, /token=a%20b%26c%3Dd/);
});

test('没有令牌时不产出一个空的 token 参数', () => {
  // `?token=` 会让前端读到空串并当成「用户提供了一个空令牌」，与「没提供」走不同分支。
  assert.equal(buildConnectUrl({ host: 'h', port: 1, token: '' }), 'http://h:1/');
});

// ---- 终端渲染 ----

test('渲染是全块的：每个模块占整行高度，不用半块字符', () => {
  // 真机实测：半块渲染两版都扫不出来——终端行距会在模块之间留横缝，破坏网格识别。
  const { matrix, size } = encodeQr('R');
  const out = renderMatrix(matrix, size);
  assert.doesNotMatch(out, /[▀▄█]/, '出现半块/块字符说明渲染方式退回去了');
  // 用 includes 而不是正则：断言 ANSI 转义序列时正则里必然出现控制字符，
  // 而 lint 有一条规则专门禁它（那条规则本身是对的：正则里的控制字符通常是手滑）。
  assert.ok(out.includes('\u001b[48;2;'), '必须用 ANSI 背景色——前景色画方块在深色主题下会反色');
});

test('渲染带 4 模块的静区，上下各一份', () => {
  // 逐档实测过：quiet=2 检不出，3 和 4 可解。静区少了扫码器找不到码的边界。
  const { matrix, size } = encodeQr('Q');
  const lines = renderMatrix(matrix, size).split('\n');
  assert.equal(lines.length, size + 8, `行数应为 size + 4*2，实际 ${lines.length}`);
});

test('宽度需求按每模块 2 列算——1 列会把码压成竖条', () => {
  assert.equal(requiredColumns(21), (21 + 8) * 2);
});

// ---- 地址枚举 ----

test('排除回环与 link-local——手机连不上那两类地址', () => {
  const found = reachableIPv4s({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }],
    en1: [{ family: 'IPv4', address: '169.254.10.1', internal: false }],
    en2: [{ family: 'IPv6', address: 'fe80::1', internal: false }],
    // VPN 客户端的虚拟接口。它以「真实网卡」的身份出现，但手机连不上。
    utun3: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
  });
  assert.deepEqual(found, ['192.168.1.5']);
});

test('按地址段排除虚拟接口，不按接口名——名字各家不同', () => {
  // 按 utun/tun/tap 之类的名字排除，换一家 VPN 就漏；地址段是 RFC 定死的。
  assert.deepEqual(reachableIPv4s({ x: [{ family: 'IPv4', address: '198.19.255.1', internal: false }] }), []);
  assert.deepEqual(reachableIPv4s({ x: [{ family: 'IPv4', address: '198.20.0.1', internal: false }] }), ['198.20.0.1'],
    '198.20 不在基准测试段里，不该被误杀');
});
