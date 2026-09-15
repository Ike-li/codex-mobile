import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONN_BANNER_CONNECTING_DELAY_MS,
  CONN_BANNER_DISCONNECT_DELAY_MS,
  CONN_BANNER_RETRY_DELAY_MS,
  CONN_BANNER_RECONNECTED_LINGER_MS,
  resolveConnectionBanner,
  resolveInsecureTransportBanner,
} from '../../public/js/net/connection-banner.js';

test('first connect stays quiet until the delay, then shows connecting', () => {
  assert.equal(resolveConnectionBanner({
    phase: 'connecting',
    elapsedMs: CONN_BANNER_CONNECTING_DELAY_MS - 1,
  }), null);

  const shown = resolveConnectionBanner({
    phase: 'connecting',
    elapsedMs: CONN_BANNER_CONNECTING_DELAY_MS,
  });
  assert.equal(shown.tone, 'info');
  assert.equal(shown.label, '连接中…');
  assert.equal(shown.spinner, true);
  assert.equal(shown.retry, false);
});

test('retry appears only after the later retry delay', () => {
  const beforeRetry = resolveConnectionBanner({
    phase: 'offline',
    elapsedMs: CONN_BANNER_RETRY_DELAY_MS - 1,
  });
  assert.equal(beforeRetry.retry, false);

  const afterRetry = resolveConnectionBanner({
    phase: 'offline',
    elapsedMs: CONN_BANNER_RETRY_DELAY_MS,
  });
  assert.equal(afterRetry.tone, 'warn');
  assert.equal(afterRetry.label, '连接断开，自动重连中…');
  assert.equal(afterRetry.retry, true);
  assert.match(afterRetry.detail, /已断开/);
});

test('a brief reconnect after a visible banner lingers, then hides', () => {
  assert.equal(resolveConnectionBanner({
    phase: 'online',
    elapsedMs: 0,
    wasVisible: false,
  }), null);

  const linger = resolveConnectionBanner({
    phase: 'online',
    elapsedMs: 0,
    wasVisible: true,
  });
  assert.equal(linger.tone, 'success');
  assert.equal(linger.label, '已重新连接');
  assert.equal(linger.spinner, false);

  assert.equal(resolveConnectionBanner({
    phase: 'online',
    elapsedMs: CONN_BANNER_RECONNECTED_LINGER_MS,
    wasVisible: true,
  }), null);
});

test('auth overlay and invalid clocks hide the banner', () => {
  assert.equal(resolveConnectionBanner({
    phase: 'offline',
    elapsedMs: CONN_BANNER_DISCONNECT_DELAY_MS + 10,
    suppressed: true,
  }), null);
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: NaN }), null);
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: -1 }), null);
});

// R-SEC-4：局域网模式不强制 TLS（强制自签证书会大幅抬高接入成本，违背「接入方式与项目
// 解耦」），但必须让用户知道 token 和全部流量在这张网里是明文的。
// isSecureContext 正好是这个判据：HTTPS 与 loopback 为 true，其余为 false。
test('非安全上下文下给出明文告警，安全上下文不打扰', () => {
  const banner = resolveInsecureTransportBanner({ secureContext: false });
  assert.equal(banner.tone, 'warn');
  assert.match(banner.label, /明文/);
  assert.ok(banner.detail.length > 0, '要说明后果，不能只喊一声不安全');

  assert.equal(resolveInsecureTransportBanner({ secureContext: true }), null);
  // 缺省视为安全，避免在拿不到该能力的环境里长期挂一条吓人的横幅。
  assert.equal(resolveInsecureTransportBanner({}), null);
});
