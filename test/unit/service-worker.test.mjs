import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('service worker preserves a needs-you tag and opens its deep link', async () => {
  const source = readFileSync(new URL('../../public/js/sw.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const notifications = [];
  const opened = [];
  const context = {
    URL,
    self: {
      location: { origin: 'https://codex.example' },
      registration: {
        showNotification: async (title, options) => notifications.push({ title, options }),
      },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
    clients: {
      matchAll: async () => [],
      openWindow: async url => opened.push(url),
    },
  };
  vm.runInNewContext(source, context);

  let pushWork;
  listeners.get('push')({
    data: {
      json: () => ({
        title: 'Codex 待审批',
        body: '有操作等待审批',
        tag: 'need:need_abc',
        data: { url: '/?thread=thr_1&need=need_abc', needId: 'need_abc' },
      }),
    },
    waitUntil: promise => { pushWork = promise; },
  });
  await pushWork;
  assert.equal(notifications[0].options.tag, 'need:need_abc');
  assert.deepEqual(notifications[0].options.data, {
    url: '/?thread=thr_1&need=need_abc',
    needId: 'need_abc',
  });

  let clickWork;
  listeners.get('notificationclick')({
    notification: {
      data: notifications[0].options.data,
      close() {},
    },
    waitUntil: promise => { clickWork = promise; },
  });
  await clickWork;
  assert.deepEqual(opened, ['/?thread=thr_1&need=need_abc']);
});

// 上面那条覆盖的是一条 happy path：同源深链 + 没有已打开的窗口。
// 下面补两类此前完全没走过的分支。
//
// 一是 sw.js 里唯一做信任决策的地方——通知数据里的 url 必须校验同源。点通知会
// 导航用户已经打开的 PWA 窗口，异源放行等于把这个窗口交给别人。它现在没有测试守着。
//
// 二是「窗口已经开着」这条分支。真实使用里这才是常态（手机上 PWA 常驻），而原测试的
// clients.matchAll 返回空数组，navigate/focus 那条路一次都没跑过——坏了的表现是
// 点通知没有任何反应。
function loadServiceWorker({ windows = [] } = {}) {
  const source = readFileSync(new URL('../../public/js/sw.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const notifications = [];
  const opened = [];
  const navigated = [];
  const focused = [];
  const context = {
    URL,
    self: {
      location: { origin: 'https://codex.example' },
      registration: {
        showNotification: async (title, options) => notifications.push({ title, options }),
      },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async url => opened.push(url),
    },
  };
  vm.runInNewContext(source, context);
  return { listeners, notifications, opened, navigated, focused };
}

async function clickNotification(sw, data) {
  let work;
  sw.listeners.get('notificationclick')({
    notification: { data, close() {} },
    waitUntil: promise => { work = promise; },
  });
  await work;
}

test('通知里的异源深链被拒绝，回落到站点根而不是导航出去', async () => {
  for (const hostile of [
    'https://evil.example/steal',
    '//evil.example/steal',
    'http://codex.example/downgrade',
    'javascript:fetch("/steal")',
  ]) {
    const sw = loadServiceWorker();
    await clickNotification(sw, { url: hostile });
    assert.deepEqual(
      sw.opened,
      ['/'],
      `「${hostile}」不能被当成可导航目标——点通知会导航用户已打开的 PWA 窗口`,
    );
  }
});

test('同源深链保留 path、query 和 hash，但丢掉来源里的 origin', async () => {
  const sw = loadServiceWorker();
  await clickNotification(sw, { url: 'https://codex.example/?thread=t1&need=n1#card' });
  assert.deepEqual(sw.opened, ['/?thread=t1&need=n1#card']);
});

test('通知数据缺 url 或 url 不合法时回落到站点根', async () => {
  for (const data of [{}, { url: '' }, { url: null }, undefined]) {
    const sw = loadServiceWorker();
    await clickNotification(sw, data);
    assert.deepEqual(sw.opened, ['/'], '没有目标时也要把用户带回应用，而不是什么都不做');
  }
});

test('已有同源窗口时导航并聚焦它，而不是再开一个', async () => {
  const navigated = [];
  let focusedClient = false;
  const existing = {
    url: 'https://codex.example/',
    navigate: async url => { navigated.push(url); return { focus() { focusedClient = true; } }; },
    focus() { focusedClient = true; },
  };
  const sw = loadServiceWorker({ windows: [existing] });

  await clickNotification(sw, { url: '/?thread=t1' });

  assert.deepEqual(navigated, ['/?thread=t1'], '常态是 PWA 已经开着，应当导航它');
  assert.equal(focusedClient, true, '导航完要把窗口带到前台，否则用户点了没反应');
  assert.deepEqual(sw.opened, [], '不该再开一个新窗口');
});

test('已有窗口不支持 navigate 时退回到只聚焦', async () => {
  let focused = false;
  const existing = { url: 'https://codex.example/', focus() { focused = true; } };
  const sw = loadServiceWorker({ windows: [existing] });

  await clickNotification(sw, { url: '/?thread=t1' });

  assert.equal(focused, true);
  assert.deepEqual(sw.opened, []);
});

test('只有异源窗口开着时开新窗口，不去碰别人的页面', async () => {
  const foreign = {
    url: 'https://evil.example/',
    navigate: async () => { throw new Error('不该导航异源窗口'); },
    focus() { throw new Error('不该聚焦异源窗口'); },
  };
  const sw = loadServiceWorker({ windows: [foreign] });

  await clickNotification(sw, { url: '/?thread=t1' });

  assert.deepEqual(sw.opened, ['/?thread=t1']);
});

test('推送缺少 title/body 时仍然弹出通知，不是静默丢弃', async () => {
  const sw = loadServiceWorker();
  let work;
  sw.listeners.get('push')({
    data: { json: () => ({}) },
    waitUntil: promise => { work = promise; },
  });
  await work;
  assert.equal(sw.notifications.length, 1, '没有内容也要提醒——静默丢弃等于漏掉一次待审批');
  assert.equal(sw.notifications[0].title, 'Codex');
  assert.equal(sw.notifications[0].options.body, '');
});
