export const CONN_BANNER_CONNECTING_DELAY_MS = 800;
export const CONN_BANNER_DISCONNECT_DELAY_MS = 1000;
export const CONN_BANNER_RETRY_DELAY_MS = 5000;
export const CONN_BANNER_RECONNECTED_LINGER_MS = 1600;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function resolveConnectionBanner({
  phase,
  elapsedMs,
  suppressed = false,
  wasVisible = false,
} = {}) {
  if (suppressed) return null;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;

  if (phase === 'connecting') {
    if (elapsedMs < CONN_BANNER_CONNECTING_DELAY_MS) return null;
    return {
      tone: 'info',
      label: '连接中…',
      detail: '',
      spinner: true,
      retry: elapsedMs >= CONN_BANNER_RETRY_DELAY_MS,
    };
  }

  if (phase === 'offline') {
    if (elapsedMs < CONN_BANNER_DISCONNECT_DELAY_MS) return null;
    return {
      tone: 'warn',
      label: '连接断开，自动重连中…',
      detail: `已断开 ${formatElapsed(elapsedMs)}`,
      spinner: true,
      retry: elapsedMs >= CONN_BANNER_RETRY_DELAY_MS,
    };
  }

  if (phase === 'online') {
    if (!wasVisible || elapsedMs >= CONN_BANNER_RECONNECTED_LINGER_MS) return null;
    return {
      tone: 'success',
      label: '已重新连接',
      detail: '',
      spinner: false,
      retry: false,
    };
  }

  return null;
}

// 局域网模式不强制 TLS——强制自签证书会大幅抬高接入成本，违背「接入方式与项目解耦」。
// 代价是 token 和全部流量在这张网里是明文的，用户必须看得见这件事：家里可以接受，
// 咖啡厅的 WiFi 不行，而这个判断只能由用户自己做。
//
// isSecureContext 正好是需要的判据：HTTPS 与 loopback 为 true，其余为 false。拿不到时
// 视为安全，免得在不支持该能力的环境里长期挂一条吓人的横幅。
export function resolveInsecureTransportBanner({ secureContext } = {}) {
  if (secureContext !== false) return null;
  return {
    tone: 'warn',
    label: '明文连接',
    detail: '访问令牌与全部会话内容在这个网络里未加密，同网设备可以看到。仅在你信任的网络下使用。',
    spinner: false,
    retry: false,
  };
}
