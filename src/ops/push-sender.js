import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicEndpointHostname, isPublicIpAddress } from '../shared/network-address.js';

export function createPushSender({
  generateRequestDetails,
  resolveHostname = defaultResolveHostname,
  request = httpsRequest,
  timeoutMs = 10_000,
  maxResponseBytes = 64 * 1024,
} = {}) {
  if (typeof generateRequestDetails !== 'function') {
    throw new Error('Push sender requires generateRequestDetails');
  }
  if (typeof resolveHostname !== 'function' || typeof request !== 'function') {
    throw new Error('Push sender requires DNS and HTTPS transports');
  }

  return function sendPushNotification(subscription, payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeRequest = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const fail = error => finish(reject, error);
      const timer = setTimeout(() => {
        const error = new Error('Push delivery timed out');
        activeRequest?.destroy?.(error);
        fail(error);
      }, timeoutMs);

      Promise.resolve().then(async () => {
        const endpoint = parsePushEndpoint(subscription?.endpoint);
        const addresses = await resolvePublicAddresses(endpoint.hostname, resolveHostname);
        if (settled) return;
        const pinned = addresses[0];
        const details = generateRequestDetails(subscription, payload);
        const generatedEndpoint = parsePushEndpoint(details?.endpoint);
        if (generatedEndpoint.href !== endpoint.href) {
          throw new Error('Generated Push endpoint does not match the validated subscription');
        }
        if (details.proxy || details.agent) {
          throw new Error('Push proxy and custom agent options are not allowed');
        }

        const options = {
          hostname: endpoint.hostname,
          port: endpoint.port || 443,
          path: `${endpoint.pathname}${endpoint.search}`,
          method: details.method,
          headers: { ...(details.headers || {}) },
          servername: endpoint.hostname,
          lookup(hostname, lookupOptions, callback) {
            if (String(hostname).toLowerCase() !== endpoint.hostname.toLowerCase()) {
              return callback(new Error('Push DNS pin hostname mismatch'));
            }
            if (lookupOptions?.all === true) {
              return callback(null, [{ address: pinned.address, family: pinned.family }]);
            }
            return callback(null, pinned.address, pinned.family);
          },
        };

        activeRequest = request(options, response => {
          const chunks = [];
          let received = 0;
          response.on('data', chunk => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += bytes.length;
            if (received > maxResponseBytes) {
              const error = new Error('Push response exceeded configured limit');
              response.destroy?.(error);
              activeRequest?.destroy?.(error);
              fail(error);
              return;
            }
            chunks.push(bytes);
          });
          response.on('error', fail);
          response.on('end', () => {
            if (settled) return;
            const body = Buffer.concat(chunks).toString('utf8');
            if (response.statusCode < 200 || response.statusCode > 299) {
              const error = new Error('Received unexpected Push response code');
              error.statusCode = response.statusCode;
              error.headers = response.headers;
              error.body = body;
              error.endpoint = endpoint.href;
              fail(error);
              return;
            }
            finish(resolve, {
              statusCode: response.statusCode,
              headers: response.headers,
              body,
            });
          });
        });
        activeRequest.on('error', fail);
        if (details.body) activeRequest.write(details.body);
        activeRequest.end();
      }).catch(fail);
    });
  };
}

function parsePushEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Push endpoint is invalid');
  }
  if (
    endpoint.protocol !== 'https:'
    || endpoint.username
    || endpoint.password
    || !isPublicEndpointHostname(endpoint.hostname)
  ) {
    throw new Error('Push endpoint must use a public HTTPS hostname');
  }
  return endpoint;
}

async function resolvePublicAddresses(hostname, resolveHostname) {
  const version = isIP(hostname);
  const raw = version
    ? [{ address: hostname, family: version }]
    : await resolveHostname(hostname);
  const addresses = (Array.isArray(raw) ? raw : []).map(record => (
    typeof record === 'string'
      ? { address: record, family: isIP(record) }
      : { address: record?.address, family: Number(record?.family) || isIP(record?.address) }
  ));
  if (
    addresses.length === 0
    || addresses.some(record => !record.family || !isPublicIpAddress(record.address))
  ) {
    throw new Error('Push endpoint resolves to a non-public address');
  }
  return addresses;
}

async function defaultResolveHostname(hostname) {
  return lookup(hostname, { all: true, verbatim: true });
}
