import { isIP } from 'node:net';

export function normalizeAddress(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

export function hostnameFromHeader(value = '') {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host;
  }
  const colon = host.lastIndexOf(':');
  if (colon > -1 && host.indexOf(':') === colon) host = host.slice(0, colon);
  return host;
}

export function isLoopbackAddress(value = '') {
  const addr = normalizeAddress(value);
  return addr === 'localhost' || addr === '::1' || /^127(?:\.\d{1,3}){3}$/.test(addr);
}

export function isLoopbackHostHeader(value = '') {
  return isLoopbackAddress(hostnameFromHeader(value));
}

export function isLocalAccess({ remoteAddress, hostHeader }) {
  return isLoopbackAddress(remoteAddress) && isLoopbackHostHeader(hostHeader);
}

export function resolveListenHost({ env = {}, authToken = '' }) {
  const host = env.HOST || '127.0.0.1';
  const remote = !isLoopbackHostHeader(host);
  if (!authToken && remote) {
    throw new Error('HOST must be loopback when AUTH_TOKEN is empty; set AUTH_TOKEN before binding remote interfaces');
  }
  if (remote && String(authToken).length < 32) {
    throw new Error('AUTH_TOKEN must be at least 32 characters before binding remote interfaces');
  }
  return host;
}

export function evaluateTransportSecurity(request = {}, policy = {}) {
  const peerAddress = normalizeAddress(request.remoteAddress);
  const trustedProxyIps = Array.isArray(policy.trustedProxyIps)
    ? policy.trustedProxyIps.map(normalizeAddress)
    : [];
  const viaTrustedProxy = trustedProxyIps.includes(peerAddress);
  const local = !viaTrustedProxy && isLocalAccess({
    remoteAddress: peerAddress,
    hostHeader: request.hostHeader,
  });
  let effectiveProtocol = request.socketEncrypted === true ? 'https' : 'http';
  if (viaTrustedProxy) {
    if (typeof request.forwardedProtoHeader !== 'string' || !request.forwardedProtoHeader.trim()) {
      return {
        ok: false,
        reason: 'forwarded_proto_required',
        local,
        remote: !local,
        secure: false,
        viaTrustedProxy,
        effectiveProtocol: 'http',
      };
    }
    const forwardedProtocol = request.forwardedProtoHeader.trim().toLowerCase();
    if (forwardedProtocol !== 'http' && forwardedProtocol !== 'https') {
      return {
        ok: false,
        reason: 'invalid_forwarded_proto',
        local,
        remote: !local,
        secure: false,
        viaTrustedProxy,
        effectiveProtocol: 'http',
      };
    }
    effectiveProtocol = forwardedProtocol;
  }
  const secure = effectiveProtocol === 'https';
  const result = {
    ok: true,
    reason: null,
    local,
    remote: !local,
    secure,
    viaTrustedProxy,
    effectiveProtocol,
  };
  if (result.remote && !secure && policy.allowInsecureRemote !== true) {
    return { ...result, ok: false, reason: 'https_required' };
  }
  return result;
}

export function evaluateSocketHandshakeSecurity(request = {}, policy = {}) {
  const transport = evaluateTransportSecurity(request, policy);
  if (!transport.ok) return { ...transport, normalizedOrigin: null };

  const rawOrigin = typeof request.originHeader === 'string' ? request.originHeader.trim() : '';
  if (!rawOrigin || rawOrigin === 'null') {
    if (transport.remote) {
      return { ...transport, ok: false, reason: 'origin_required', normalizedOrigin: null };
    }
    return { ...transport, normalizedOrigin: null };
  }
  const normalizedOrigin = canonicalOrigin(rawOrigin);
  if (!normalizedOrigin) {
    return { ...transport, ok: false, reason: 'invalid_origin', normalizedOrigin: null };
  }

  const allowedOrigins = new Set((policy.allowedOrigins || []).map(canonicalOrigin).filter(Boolean));
  if (transport.remote) {
    if (!allowedOrigins.has(normalizedOrigin)) {
      return { ...transport, ok: false, reason: 'origin_not_allowed', normalizedOrigin };
    }
    return { ...transport, normalizedOrigin };
  }

  const sameOrigin = canonicalOrigin(`${transport.effectiveProtocol}://${request.hostHeader || ''}`);
  if (normalizedOrigin !== sameOrigin && !allowedOrigins.has(normalizedOrigin)) {
    return { ...transport, ok: false, reason: 'origin_not_allowed', normalizedOrigin };
  }
  return { ...transport, normalizedOrigin };
}

export function parseGatewaySecurityPolicy(env = {}) {
  const origins = splitCsv(env.CODEX_ALLOWED_ORIGINS);
  const allowedOrigins = [];
  for (const value of origins) {
    const origin = canonicalOrigin(value);
    if (!origin) throw new Error(`Invalid CODEX_ALLOWED_ORIGINS entry: ${value}`);
    if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }

  const trustedProxyIps = [];
  for (const value of splitCsv(env.CODEX_TRUSTED_PROXY_IPS)) {
    const address = normalizeAddress(value);
    if (!isIP(address)) throw new Error(`Invalid CODEX_TRUSTED_PROXY_IPS entry: ${value}`);
    if (!trustedProxyIps.includes(address)) trustedProxyIps.push(address);
  }

  const insecure = String(env.CODEX_ALLOW_INSECURE_REMOTE || '').trim();
  if (insecure && insecure !== '0' && insecure !== '1') {
    throw new Error('CODEX_ALLOW_INSECURE_REMOTE must be 0 or 1');
  }
  return {
    allowedOrigins,
    trustedProxyIps,
    allowInsecureRemote: insecure === '1',
  };
}

function canonicalOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function splitCsv(value) {
  return String(value || '').split(',').map(entry => entry.trim()).filter(Boolean);
}
