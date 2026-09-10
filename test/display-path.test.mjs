// test/display-path.test.mjs —— 路径在界面上的显示形态。
//
// compactPath 是「界面不得出现宿主机绝对路径」这条横切判据的**实现机制**
// （横切判据）。在此之前它没有任何单测：
// 它藏在 app.js 的 4034 行里，只被 public-ui.test.mjs 的一条源码文本断言
// 「覆盖」着，而那条断言证明不了它到底缩没缩、缩得对不对。
//
// 一份可视化验收文档说「看到 /Users/xxx 就是失败」，但没有任何自动化能在
// 合并前发现这件事 —— 那条判据要等到有人手工跑那 71 条用例时才生效。
// 这个文件把它前移成一道机器可判的闸。
import test from 'node:test';
import assert from 'node:assert/strict';

import { compactPath, parentPath } from '../public/js/display-path.js';

test('深路径缩成末两段，宿主机身份不出现在界面上', () => {
  // 真实形态：macOS 的 ~ 展开后带用户名，Linux 网关带部署路径。
  assert.equal(compactPath('/Users/raylee/code/codex-chat-mobile'), '…/code/codex-chat-mobile');
  assert.equal(compactPath('/home/deploy/srv/app'), '…/srv/app');
  assert.equal(compactPath('/var/lib/gateway/workspaces/proj'), '…/workspaces/proj');
});

test('缩写后的结果里不再有用户名段', () => {
  // 这条守的是判据本身，不是某一个样例：无论路径多深，
  // 倒数第三段及以前都不该泄漏出去。
  for (const path of [
    '/Users/raylee/code/x',
    '/Users/someone-else/very/deep/nested/dir',
    '/home/ci-runner/build/out',
  ]) {
    const shown = compactPath(path);
    const segments = String(path).split('/').filter(Boolean);
    for (const hidden of segments.slice(0, -2)) {
      assert.ok(!shown.includes(hidden),
        `compactPath('${path}') = '${shown}' 里仍然泄漏了路径段 '${hidden}'`);
    }
  }
});

test('浅路径本来就不含身份信息，原样显示', () => {
  // 缩写不是目的，可读才是。'/tmp' 缩成 '…/tmp' 只会让用户更迷惑。
  assert.equal(compactPath('/tmp'), '/tmp');
  assert.equal(compactPath('/srv/app'), '/srv/app');
  assert.equal(compactPath('relative/dir'), 'relative/dir');
});

test('空值不会渲染成 undefined 或 null 字样', () => {
  // 这类值会直接进 innerHTML，漏出去就是界面上一个字面的 "undefined"。
  for (const empty of [null, undefined, '', 0]) {
    assert.equal(compactPath(empty), '');
  }
});

test('parentPath 逐级上溯，并在根目录停住', () => {
  assert.equal(parentPath('/Users/raylee/code'), '/Users/raylee');
  assert.equal(parentPath('/Users'), '/');
  // 停不住就会在工作区抽屉里出现一个走不出去的向上按钮。
  assert.equal(parentPath('/'), null);
});

test('parentPath 归一化尾部斜杠，不会原地打转', () => {
  // 目录路径带不带尾斜杠取决于来源。不归一的话 '/a/b/' 的父目录会算成 '/a/b'，
  // 用户点「上一级」看到的还是同一个目录。
  assert.equal(parentPath('/Users/raylee/code/'), '/Users/raylee');
  assert.equal(parentPath('/Users/raylee/code///'), '/Users/raylee');
  assert.equal(parentPath('//'), null);
});

test('parentPath 对空值返回 null 而不是抛异常', () => {
  for (const empty of [null, undefined, '']) {
    assert.equal(parentPath(empty), null);
  }
});
