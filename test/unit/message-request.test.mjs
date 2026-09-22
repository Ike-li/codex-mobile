import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMessageRequest, messageWirePayload } from '../../public/js/compose/message-request.js';

test('message requests get unique ids while retries preserve the original logical-thread payload', () => {
  const ids = ['req-one', 'req-two'];
  const options = {
    createId: () => ids.shift(),
    now: () => 1234,
  };
  const input = {
    text: 'same message',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data: 'bm90ZQ==' }],
    target: { instanceId: 'inst-volatile', threadId: 'thr-durable' },
  };

  const first = createMessageRequest(input, options);
  const second = createMessageRequest(input, options);

  assert.notEqual(first.clientRequestId, second.clientRequestId);
  assert.deepEqual(messageWirePayload(first), {
    clientRequestId: 'req-one',
    text: 'same message',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data: 'bm90ZQ==' }],
    threadId: 'thr-durable',
  });
  assert.deepEqual(messageWirePayload(first), messageWirePayload(first));
  assert.equal(first.createdAt, 1234);
  assert.equal(first.state, 'pending');
});

test('message requests persist structured input parts in the retry payload', () => {
  const request = createMessageRequest({
    text: 'use selected references',
    parts: [
      { kind: 'mention', name: 'server.js', path: '/tmp/work/server.js' },
      { kind: 'skill', name: 'release', path: '/tmp/work/.agents/skills/release/SKILL.md' },
    ],
    target: { threadId: 'thr-structured-input' },
  }, { createId: () => 'req-structured-input', now: () => 5678 });

  assert.deepEqual(messageWirePayload(request).parts, [
    { kind: 'mention', name: 'server.js', path: '/tmp/work/server.js' },
    { kind: 'skill', name: 'release', path: '/tmp/work/.agents/skills/release/SKILL.md' },
  ]);
});

test('message requests persist CLI turn overrides in the retry payload', () => {
  const request = createMessageRequest({
    text: 'use selected model',
    target: { threadId: 'thr-turn' },
    turn: {
      model: 'gpt-5.6-sol',
      effort: 'max',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      serviceTier: 'fast',
    },
  }, { createId: () => 'req-turn', now: () => 9 });

  assert.deepEqual(messageWirePayload(request).turn, {
    model: 'gpt-5.6-sol',
    effort: 'max',
    approvalPolicy: 'untrusted',
    sandbox: 'read-only',
    serviceTier: 'fast',
  });
});

// 非 secure context（http://<主机名>，即明文远程接入）里浏览器**不提供**
// crypto.randomUUID，只提供 getRandomValues。实测：
//   127.0.0.1 / localhost → isSecureContext=true  → randomUUID 存在
//   gateway.test          → isSecureContext=false → randomUUID undefined
//
// 而发消息的两条路径（message-request.js 与 message-outbox.js）都直接调
// randomUUID，于是在 CODEX_ALLOW_INSECURE_REMOTE=1 的本机验收路径（VC-A02 /
// VC-H05）下发消息会抛 TypeError 并**静默失败**：文字留在输入框，什么都没送出，
// 状态还显示 idle，界面上没有任何提示。跑 VC-H05 时就是这么撞上的。
//
// app.js 的 createDeviceToken 早有 getRandomValues 兜底 —— 三处调用点里只加了一处，
// 而加了的那处恰好是能走到配对画面的那条路，所以「连得上、进得去、就是发不出」。
test('创建消息请求不依赖 randomUUID —— 非 secure context 里它不存在', () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: original.getRandomValues.bind(original) },
    configurable: true,
    writable: true,
  });
  try {
    assert.equal(typeof globalThis.crypto.randomUUID, 'undefined', '前置：本测试要模拟没有 randomUUID');
    const request = createMessageRequest({ text: '在明文远程接入下发一条' });
    assert.equal(typeof request.payload.clientRequestId, 'string');
    assert.ok(request.payload.clientRequestId.length >= 16,
      'clientRequestId 太短，撞号风险；投递去重全靠它');
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true });
  }
});
