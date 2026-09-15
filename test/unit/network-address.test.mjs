import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPublicIpAddress, isPublicEndpointHostname } from '../../network-address.js';

test('public IP classification rejects non-global IPv4 and IPv6 ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    'ff00::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('public IP classification rejects the well-known NAT64 prefix', () => {
  // 64:ff9b::/96 把 IPv4 映射进 IPv6。此前只挡了 64:ff9b:1::/48（local-use），
  // 于是 64:ff9b::7f00:1 —— 也就是 127.0.0.1 —— 会被当作公网地址放行。
  for (const address of ['64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::c0a8:101']) {
    assert.equal(isPublicIpAddress(address), false, `${address} 不应被当作公网地址`);
  }
});

test('public IP classification rejects IPv4-compatible and IPv4-translated forms', () => {
  // ::/96 与 ::ffff:0:0/96 都把 IPv4 塞进 IPv6 地址。已被废弃（RFC 4291 / RFC 2765），
  // 主流内核也不做自动隧道，但这个谓词是 push-sender 和 input-parts 两处 SSRF 防线的
  // 共同基础，不该依赖「内核大概不会路由它」这种前提。
  for (const address of ['::7f00:1', '::a00:1', '::c0a8:101', '::ffff:0:7f00:1', '::ffff:0:a00:1']) {
    assert.equal(isPublicIpAddress(address), false, `${address} 不应被当作公网地址`);
  }
});

test('public IP classification still accepts genuine global IPv6', () => {
  for (const address of ['2606:4700:4700::1111', '2400:cb00::1']) {
    assert.equal(isPublicIpAddress(address), true, `${address} 是公网地址`);
  }
});

// ---- 变异补漏：批 4（SCOPE） ----

// 这两个函数是「服务端替用户去取一个 URL」之前的最后一道闸（SSRF）。
// 17 个变异存活 10 个，是全仓最差的比例——原因很直接：isPublicEndpointHostname
// 此前连 import 都没被 import 过，整个函数零覆盖。

// ::ffff: 前缀的 IPv4-mapped 地址必须**还原成 IPv4 再判**。不还原的话它会以 IPv6 的
// 身份去查表，而 IPv6 的封禁前缀里没有它——`::ffff:169.254.169.254` 就成了「公网地址」，
// 而那正是云元数据服务的地址。
test('IPv4-mapped 地址还原成 IPv4 再判，不以 IPv6 身份蒙混过去', () => {
  for (const address of [
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '[::ffff:127.0.0.1]',
    '::FFFF:127.0.0.1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, `${address} 还原后是私有地址，不能判成公网`);
  }
  assert.equal(isPublicIpAddress('::ffff:8.8.8.8'), true, '还原后确实是公网的仍然放行');
});

// 认不出是 IP 的输入一律**不是**公网地址。判成 true 的后果是任何字符串都能过闸。
test('认不出是 IP 的输入一律不算公网地址', () => {
  for (const value of ['', null, undefined, 'not-an-ip', 'example.com', '999.999.999.999', '::zzzz']) {
    assert.equal(isPublicIpAddress(value), false, `${String(value)} 不是 IP，不能判成公网`);
  }

  // 「以某个公网 IP 结尾的垃圾串」尤其要挡住：只看后缀就会把它当成 8.8.8.8。
  assert.equal(isPublicIpAddress('xxxxxxx8.8.8.8'), false,
    '不是合法 IP 就是不合法，不能靠切掉前缀去凑一个合法的出来');
});

test('公网 IP 仍然被放行，否则这道闸等于把功能关掉了', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '203.0.114.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicIpAddress(address), true, `${address} 是公网地址，应当放行`);
  }
});

// 主机名侧的闸：本机与内网专用后缀不算公网端点。
// 这几条的方向都是 && 串联，任何一条被改成 || 都会让整条链退化成「几乎全放行」。
test('本机与内网专用主机名不算公网端点', () => {
  for (const hostname of [
    '',
    null,
    undefined,
    'localhost',
    'LOCALHOST',
    '  localhost  ',
    'foo.localhost',
    'printer.local',
    'svc.internal',
    'a.b.c.internal',
  ]) {
    assert.equal(isPublicEndpointHostname(hostname), false,
      `${String(hostname)} 指向本机或内网，不能当成公网端点`);
  }
});

test('普通公网主机名仍然被放行', () => {
  for (const hostname of ['example.com', 'a.b.example.com', '  example.com  ', 'localhost.example.com']) {
    assert.equal(isPublicEndpointHostname(hostname), true, `${hostname} 是公网主机名，应当放行`);
  }
});
