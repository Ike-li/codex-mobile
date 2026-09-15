import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPushSender } from '../../src/ops/push-sender.js';

function requestDetails(subscription, payload) {
  return {
    endpoint: subscription.endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from(payload),
  };
}

function successfulRequest(capture, chunks = []) {
  return (options, onResponse) => {
    capture.options = options;
    const request = new EventEmitter();
    request.write = body => { capture.body = body; };
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 201;
      response.headers = { location: 'accepted' };
      response.destroy = error => response.emit('error', error);
      onResponse(response);
      for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
      response.emit('end');
    });
    return request;
  };
}

test('push sender rejects mixed public and private DNS answers before opening a socket', async () => {
  let requestCalls = 0;
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    request() { requestCalls += 1; },
  });

  await assert.rejects(
    send({ endpoint: 'https://push.example/send', keys: {} }, 'payload'),
    /non-public address/,
  );
  assert.equal(requestCalls, 0);
});

test('push sender pins the validated address while preserving TLS server identity', async () => {
  const capture = {};
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async hostname => {
      assert.equal(hostname, 'push.example');
      return [{ address: '93.184.216.34', family: 4 }];
    },
    request: successfulRequest(capture, ['ok']),
  });

  const result = await send({ endpoint: 'https://push.example/send?topic=one', keys: {} }, 'payload');
  assert.equal(result.statusCode, 201);
  assert.equal(result.body, 'ok');
  assert.equal(capture.options.hostname, 'push.example');
  assert.equal(capture.options.servername, 'push.example');
  assert.equal(capture.options.path, '/send?topic=one');
  assert.deepEqual(capture.body, Buffer.from('payload'));
  const pinned = await new Promise((resolve, reject) => {
    capture.options.lookup('push.example', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
});

test('push sender enforces one total timeout including DNS resolution', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => new Promise(() => {}),
    request: successfulRequest({}),
    timeoutMs: 10,
  });

  await assert.rejects(
    send({ endpoint: 'https://push.example/send', keys: {} }, 'payload'),
    /timed out/,
  );
});

test('push sender rejects an oversized response body', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    request: successfulRequest({}, ['12345']),
    maxResponseBytes: 4,
  });

  await assert.rejects(
    send({ endpoint: 'https://push.example/send', keys: {} }, 'payload'),
    /response exceeded/,
  );
});

// endpoint 校验是 SSRF 的第一道闸：Push 订阅的 endpoint 由浏览器提供，而浏览器
// 是我们信任边界之外的东西。一个被诱导的订阅可以让服务端去连内网地址、或者把
// 凭证塞进 URL 带出去。下面每一条都要在**开 socket 之前**拒绝。
function neverRequests() {
  return () => { throw new Error('request() 不该被调用 —— endpoint 校验应当先拒绝'); };
}

test('endpoint 不是合法 URL 时在开 socket 前拒绝', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => { throw new Error('DNS 不该被调用'); },
    request: neverRequests(),
  });
  await assert.rejects(send({ endpoint: 'not a url', keys: {} }, 'p'), /endpoint is invalid/);
});

test('非 HTTPS 的 endpoint 一律拒绝', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => { throw new Error('DNS 不该被调用'); },
    request: neverRequests(),
  });
  for (const endpoint of ['http://push.example/send', 'ftp://push.example/send']) {
    await assert.rejects(send({ endpoint, keys: {} }, 'p'), /public HTTPS hostname/);
  }
});

test('endpoint 里带用户名或密码时拒绝', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => { throw new Error('DNS 不该被调用'); },
    request: neverRequests(),
  });
  for (const endpoint of [
    'https://user@push.example/send',
    'https://user:secret@push.example/send',
  ]) {
    await assert.rejects(send({ endpoint, keys: {} }, 'p'), /public HTTPS hostname/);
  }
});

test('endpoint 直接写成私网/环回地址时拒绝，且不开 socket', async () => {
  // 拒绝可能来自两处：主机名闸（parsePushEndpoint）或地址闸
  // （resolvePublicAddresses，IP 字面量走这条）。要紧的性质不是文案而是
  // 「没有连出去」，所以断言 request() 一次都没被调用。
  let requestCalls = 0;
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    // localhost 这类名字会真的走一次解析，生产环境解到 127.0.0.1 后被地址闸拒；
    // 这里照实模拟，而不是让桩抛错 —— 抛错会掩盖「解析后仍被正确拦下」这件事。
    resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }],
    request() { requestCalls += 1; },
  });
  for (const host of ['localhost', '127.0.0.1', '[::1]', '10.0.0.5', '169.254.169.254']) {
    await assert.rejects(
      send({ endpoint: `https://${host}/send`, keys: {} }, 'p'),
      /public HTTPS hostname|non-public address/,
      `${host} 必须被拒`,
    );
  }
  assert.equal(requestCalls, 0, '任何一条都不该走到开连接这一步');
});

test('DNS 返回空结果时拒绝，而不是当作「没有限制」放行', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [],
    request: neverRequests(),
  });
  await assert.rejects(send({ endpoint: 'https://push.example/send', keys: {} }, 'p'), /non-public address/);
});

test('DNS 返回字符串数组这种旧形态也要逐个校验', async () => {
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => ['93.184.216.34', '192.168.1.1'],
    request: neverRequests(),
  });
  await assert.rejects(send({ endpoint: 'https://push.example/send', keys: {} }, 'p'), /non-public address/);
});

test('endpoint 本身就是公网 IP 时跳过 DNS 但仍然校验', async () => {
  let resolved = 0;
  const capture = {};
  const send = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => { resolved += 1; return []; },
    request: successfulRequest(capture),
  });
  const result = await send({ endpoint: 'https://93.184.216.34/send', keys: {} }, 'p');
  assert.equal(resolved, 0, 'IP 字面量不需要再过 DNS');
  assert.equal(result.statusCode, 201);
});

// ---- 变异补漏：批 4（SCOPE / SSRF） ----

function respondWith(statusCode) {
  return (options, onResponse) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.headers = {};
      response.destroy = () => {};
      onResponse(response);
      response.emit('end');
    });
    return request;
  };
}

// Push endpoint 是用户从浏览器交上来的一个 URL，服务端会主动去请求它——
// 这是一条现成的 SSRF 通道。四条判据串在一起，最后那条（主机名不能指向本机/内网）
// 被改成 && 之后，`https://localhost/...` 就会被放行。
test('push endpoint 必须是公网 HTTPS 主机名，四条判据缺一不可', async () => {
  const sender = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    request: respondWith(201),
  });

  const rejected = [
    ['明文 http', 'http://push.example.com/x'],
    ['带用户名', 'https://user@push.example.com/x'],
    ['带用户名和密码', 'https://user:pw@push.example.com/x'],
    ['指向本机', 'https://localhost/x'],
    ['指向 .local', 'https://printer.local/x'],
    ['指向 .internal', 'https://metadata.internal/x'],
  ];
  for (const [label, endpoint] of rejected) {
    await assert.rejects(
      () => sender({ endpoint }, 'payload'),
      /public HTTPS hostname/,
      `${label}：不能作为 push endpoint`,
    );
  }

  await assert.rejects(() => sender({ endpoint: 'not a url' }, 'p'), /endpoint is invalid/);
  await sender({ endpoint: 'https://push.example.com/x' }, 'payload');
});

// 只有 2xx 算送达。判反的后果是：推送服务返回 410 Gone（订阅已失效）时被当成成功，
// 那条订阅永远不会被清理，此后每次推送都白发一次。
test('只有 2xx 算送达，4xx / 5xx 必须报失败', async () => {
  const make = statusCode => createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    request: respondWith(statusCode),
  });

  for (const statusCode of [200, 201, 204, 299]) {
    const result = await make(statusCode)({ endpoint: 'https://push.example.com/x' }, 'p');
    assert.equal(result.statusCode, statusCode, `${statusCode} 应当算送达`);
  }
  for (const statusCode of [199, 300, 400, 410, 500]) {
    await assert.rejects(
      () => make(statusCode)({ endpoint: 'https://push.example.com/x' }, 'p'),
      `${statusCode} 不该被当成送达`,
    );
  }
});

// DNS 记录不一定带 family（不同解析器返回的形状不同）。缺了就用地址本身推断，
// 而不是判成「解析不出公网地址」——那会让推送对一整类解析器直接失效。
test('DNS 记录缺 family 时按地址本身推断，不直接判失败', async () => {
  const shapes = [
    ['带 family 的对象', [{ address: '93.184.216.34', family: 4 }]],
    ['不带 family 的对象', [{ address: '93.184.216.34' }]],
    ['family 是字符串', [{ address: '93.184.216.34', family: '4' }]],
    ['裸字符串', ['93.184.216.34']],
  ];
  for (const [label, records] of shapes) {
    const sender = createPushSender({
      generateRequestDetails: requestDetails,
      resolveHostname: async () => records,
      request: respondWith(201),
    });
    const result = await sender({ endpoint: 'https://push.example.com/x' }, 'p');
    assert.equal(result.statusCode, 201, label);
  }

  // 解析到私有地址仍然要拒——这是 DNS rebinding 的那道闸。
  const rebinding = createPushSender({
    generateRequestDetails: requestDetails,
    resolveHostname: async () => [{ address: '169.254.169.254', family: 4 }],
    request: respondWith(201),
  });
  await assert.rejects(
    () => rebinding({ endpoint: 'https://push.example.com/x' }, 'p'),
    /non-public address/,
    '主机名公网、解析结果私有，是 DNS rebinding 的典型形态',
  );
});

test('缺少 DNS 或 HTTPS 传输时构造就报错，两个都要检查', () => {
  assert.throws(() => createPushSender({}), /generateRequestDetails/);
  assert.throws(
    () => createPushSender({ generateRequestDetails: requestDetails, resolveHostname: null }),
    /DNS and HTTPS transports/,
  );
  assert.throws(
    () => createPushSender({ generateRequestDetails: requestDetails, request: null }),
    /DNS and HTTPS transports/,
    '只检查其中一个的话，另一个缺失时会在第一次推送时才炸',
  );
});
