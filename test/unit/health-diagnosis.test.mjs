import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseHealth, HEALTH_LAYERS } from '../../public/js/net/health-diagnosis.js';

// R-19：自托管产品最高频的求助是「连不上」，而「连不上」有六层可能。笼统地显示
// offline，用户只能一层层猜。这里的判定要给出**最外层的坏点**——修好它之前，
// 里层是好是坏都无从验证。
test('分层顺序：先报最外层的坏点', () => {
  assert.deepEqual(HEALTH_LAYERS, ['browser', 'network', 'gateway', 'appServer', 'codex', 'upstream']);
});

test('浏览器离线时不去怪服务器', () => {
  const result = diagnoseHealth({ browserOnline: false, socketConnected: false, gatewayReachable: false });
  assert.equal(result.layer, 'browser');
  assert.match(result.detail, /网络/);
  assert.equal(result.actionable, true, '这一层用户自己能处理');
});

test('浏览器在线但连不上网关：区分网络与网关本身', () => {
  const unreachable = diagnoseHealth({ browserOnline: true, socketConnected: false, gatewayReachable: false });
  assert.equal(unreachable.layer, 'network', '连 HTTP 都到不了，问题在到达路径上');

  const reachableButNoSocket = diagnoseHealth({ browserOnline: true, socketConnected: false, gatewayReachable: true });
  assert.equal(reachableButNoSocket.layer, 'gateway', 'HTTP 通而 socket 不通，是网关侧');
});

test('网关正常但 app-server 进程不在', () => {
  const result = diagnoseHealth({
    browserOnline: true, socketConnected: true, gatewayReachable: true, appServerRunning: false,
  });
  assert.equal(result.layer, 'appServer');
  assert.match(result.detail, /codex/i);
});

test('app-server 在但 codex 报了错', () => {
  const result = diagnoseHealth({
    browserOnline: true, socketConnected: true, gatewayReachable: true,
    appServerRunning: true, codexError: 'thread/start failed',
  });
  assert.equal(result.layer, 'codex');
  assert.match(result.detail, /thread\/start failed/);
});

test('上游报错时归到上游，不误判成本机问题', () => {
  const result = diagnoseHealth({
    browserOnline: true, socketConnected: true, gatewayReachable: true,
    appServerRunning: true, upstreamError: '401 from provider',
  });
  assert.equal(result.layer, 'upstream');
  assert.match(result.detail, /401/);
  assert.equal(result.actionable, false, '上游的问题不在这台机器上，别让用户白折腾');
});

test('全部正常时明确说正常，而不是返回空', () => {
  const result = diagnoseHealth({
    browserOnline: true, socketConnected: true, gatewayReachable: true, appServerRunning: true,
  });
  assert.equal(result.layer, null);
  assert.equal(result.ok, true);
});
