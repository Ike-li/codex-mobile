import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUserInputs } from '../../user-inputs.js';

test('buildUserInputs emits the pinned v2 text shape with text_elements', () => {
  assert.deepEqual(buildUserInputs({ text: 'hello app-server' }), [{
    type: 'text',
    text: 'hello app-server',
    text_elements: [],
  }]);
});

test('buildUserInputs maps a verified uploaded image to localImage', () => {
  assert.deepEqual(buildUserInputs({
    text: 'inspect this image',
    attachments: [{
      kind: 'image',
      absPath: '/tmp/.ccm-uploads/pixel.png',
      name: 'pixel.png',
      detectedMimeType: 'image/png',
    }],
  }), [
    { type: 'text', text: 'inspect this image', text_elements: [] },
    { type: 'localImage', path: '/tmp/.ccm-uploads/pixel.png' },
  ]);
});

test('buildUserInputs maps an uploaded file to mention without path text injection', () => {
  assert.deepEqual(buildUserInputs({
    text: 'review this file',
    attachments: [{
      kind: 'file',
      absPath: '/tmp/.ccm-uploads/notes.txt',
      name: 'notes.txt',
      mimeType: 'text/plain',
    }],
  }), [
    { type: 'text', text: 'review this file', text_elements: [] },
    { type: 'mention', name: 'notes.txt', path: '/tmp/.ccm-uploads/notes.txt' },
  ]);
});

test('buildUserInputs maps a server-verified skill descriptor', () => {
  assert.deepEqual(buildUserInputs({
    text: 'use the selected skill',
    parts: [{
      kind: 'skill',
      name: 'release-notes',
      path: '/tmp/work/.agents/skills/release-notes/SKILL.md',
    }],
  }), [
    { type: 'text', text: 'use the selected skill', text_elements: [] },
    {
      type: 'skill',
      name: 'release-notes',
      path: '/tmp/work/.agents/skills/release-notes/SKILL.md',
    },
  ]);
});

test('buildUserInputs maps a server-verified workspace mention', () => {
  assert.deepEqual(buildUserInputs({
    parts: [{
      kind: 'mention',
      name: 'src/server.js',
      path: '/tmp/work/src/server.js',
    }],
  }), [{
    type: 'mention',
    name: 'src/server.js',
    path: '/tmp/work/src/server.js',
  }]);
});

test('buildUserInputs maps a server-verified image URL with pinned detail', () => {
  assert.deepEqual(buildUserInputs({
    parts: [{
      kind: 'imageUrl',
      url: 'https://images.example.test/reference.png',
      detail: 'high',
    }],
  }), [{
    type: 'image',
    url: 'https://images.example.test/reference.png',
    detail: 'high',
  }]);
});

// ---- 变异补漏：批 4（SCOPE） ----

// 三条校验链共 9 个变异全部存活。它们的形态一样：`typeof X !== 'string' || !X`，
// 任一 || 变成 && 都会让空串和非字符串穿过去，然后被原样塞进发给 runtime 的 inputs：
// 一个 path 为空串的 localImage、一个 name 为 123 的 mention。runtime 那边拿到的是
// 一个它无法解释的输入，报错发生在很远的地方，读起来完全不像「这里少填了个字段」。
test('附件与 part 的必填字段：空串和非字符串都要当场拒绝，不能原样塞进 inputs', () => {
  const rejected = [
    ['image 的 absPath 是空串', { attachments: [{ kind: 'image', absPath: '' }] }, /absolute path/],
    ['image 的 absPath 是数字', { attachments: [{ kind: 'image', absPath: 123 }] }, /absolute path/],
    ['image 缺 absPath', { attachments: [{ kind: 'image' }] }, /absolute path/],

    ['file 的 name 是空串', { attachments: [{ kind: 'file', name: '', absPath: '/x' }] }, /name and absolute path/],
    ['file 的 name 是数字', { attachments: [{ kind: 'file', name: 1, absPath: '/x' }] }, /name and absolute path/],
    ['file 的 absPath 是空串', { attachments: [{ kind: 'file', name: 'n', absPath: '' }] }, /name and absolute path/],
    ['file 的 absPath 是数字', { attachments: [{ kind: 'file', name: 'n', absPath: 1 }] }, /name and absolute path/],

    ['imageUrl 的 url 是空串', { parts: [{ kind: 'imageUrl', url: '' }] }, /requires a URL/],
    ['imageUrl 的 url 是数字', { parts: [{ kind: 'imageUrl', url: 1 }] }, /requires a URL/],

    ['skill 的 name 是空串', { parts: [{ kind: 'skill', name: '', path: '/p' }] }, /Skill requires/],
    ['skill 的 path 是数字', { parts: [{ kind: 'skill', name: 'n', path: 1 }] }, /Skill requires/],
    ['mention 的 name 是数字', { parts: [{ kind: 'mention', name: 1, path: '/p' }] }, /Mention requires/],
    ['mention 的 path 是空串', { parts: [{ kind: 'mention', name: 'n', path: '' }] }, /Mention requires/],
  ];

  for (const [label, input, message] of rejected) {
    assert.throws(() => buildUserInputs(input), message, label);
  }
});

// detail 是可选的：没给就不该报错，给了就必须在白名单里。
// 判反的后果不对称——把「没给」判成非法会让所有普通图片都发不出去，
// 把「给了个乱七八糟的值」判成合法则会把它原样透给 runtime。
test('imageUrl 的 detail 可以不给，给了就必须在白名单里', () => {
  assert.deepEqual(buildUserInputs({ parts: [{ kind: 'imageUrl', url: 'https://x/a.png' }] }),
    [{ type: 'image', url: 'https://x/a.png' }], '不给 detail 是合法的');

  for (const detail of ['auto', 'low', 'high', 'original']) {
    assert.deepEqual(buildUserInputs({ parts: [{ kind: 'imageUrl', url: 'https://x/a.png', detail }] }),
      [{ type: 'image', url: 'https://x/a.png', detail }], `${detail} 在白名单里`);
  }

  for (const detail of ['ultra', '', 0, null, 'HIGH']) {
    assert.throws(
      () => buildUserInputs({ parts: [{ kind: 'imageUrl', url: 'https://x/a.png', detail }] }),
      /detail is invalid/,
      `detail=${String(detail)} 不在白名单里，必须拒绝`,
    );
  }
});
