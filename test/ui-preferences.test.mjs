import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldAnnounceMcpStatus,
  readPreferences,
  writePreference,
  DEFAULT_PREFERENCES,
} from '../public/js/ui-preferences.js';

/** 最小 localStorage 替身。只实现被用到的三个方法。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  };
}

// 实测现场：一次「你是谁」产生 8 条系统消息（4 个 server × starting/ready），
// 把真正的回答整个挤出首屏。这组用例守的是「噪音静默、告警不静默」这条分界。
test('MCP 启动过程默认不进消息流', () => {
  const prefs = DEFAULT_PREFERENCES;
  for (const status of ['starting', 'ready', 'updated']) {
    assert.equal(
      shouldAnnounceMcpStatus({ name: 'codex_apps', status }, prefs),
      false,
      `${status} 是基础设施的过程状态，正常工作时不该占用注意力`,
    );
  }
});

// 这条是分界线：关掉的是噪音，不是告警。把错误也一起静默掉，用户就再也不知道
// 某个 MCP 起不来了 —— 那比刷屏严重得多。
test('MCP 出错时照报，不受偏好开关影响', () => {
  const prefs = DEFAULT_PREFERENCES;
  assert.equal(
    shouldAnnounceMcpStatus({ name: 'node_repl', status: 'ready', error: 'spawn ENOENT' }, prefs),
    true,
    'error 字段非空就是告警',
  );
  for (const status of ['failed', 'error', 'crashed']) {
    assert.equal(
      shouldAnnounceMcpStatus({ name: 'node_repl', status }, prefs),
      true,
      `${status} 本身就表示起不来了`,
    );
  }
});

test('偏好打开后，过程状态也播报', () => {
  const prefs = { ...DEFAULT_PREFERENCES, mcpStatusMessages: true };
  assert.equal(shouldAnnounceMcpStatus({ name: 'cua_repl', status: 'starting' }, prefs), true);
  assert.equal(shouldAnnounceMcpStatus({ name: 'cua_repl', status: 'ready' }, prefs), true);
});

// 上游可以随时加新状态值。未知状态按「不是已知的失败词」处理会漏报真故障，
// 按「一律报」处理又会把新的过程状态变成新的噪音源 —— 选前者的代价更小：
// 漏掉一条告警比刷屏更危险，所以未知状态归入告警侧。
test('未知状态归入告警侧，宁可多报一条也不漏掉故障', () => {
  assert.equal(
    shouldAnnounceMcpStatus({ name: 'x', status: 'somethingProtocolAddedLater' }, DEFAULT_PREFERENCES),
    true,
  );
});

test('payload 缺字段时不抛，按告警处理', () => {
  assert.equal(shouldAnnounceMcpStatus(undefined, DEFAULT_PREFERENCES), true);
  assert.equal(shouldAnnounceMcpStatus({}, DEFAULT_PREFERENCES), true);
});

test('空存储读出默认值', () => {
  assert.deepEqual(readPreferences(fakeStorage()), DEFAULT_PREFERENCES);
});

test('写入后能读回', () => {
  const storage = fakeStorage();
  writePreference(storage, 'mcpStatusMessages', true);
  assert.equal(readPreferences(storage).mcpStatusMessages, true);
});

// 存储里的东西不是我们能控制的：用户可能手改，旧版本可能写过别的结构，
// 跨设备同步工具也可能塞进半截数据。任何一种都不该让界面白屏。
test('存储损坏时回落默认值，不抛', () => {
  for (const junk of ['{不是 json', 'null', '[]', '"字符串"', '42']) {
    const storage = fakeStorage({ codex_ui_prefs: junk });
    assert.deepEqual(readPreferences(storage), DEFAULT_PREFERENCES, `输入 ${junk}`);
  }
});

// 未知键不能进结果：旧版本或手改留下的多余字段如果原样带出去，
// 调用方读到的就不再是一个已知形状的对象。
test('存储里的未知键被丢弃，只认已声明的偏好', () => {
  const storage = fakeStorage({
    codex_ui_prefs: JSON.stringify({ mcpStatusMessages: true, somethingRemovedLater: 'x' }),
  });
  const prefs = readPreferences(storage);
  assert.equal(prefs.mcpStatusMessages, true);
  assert.deepEqual(Object.keys(prefs), Object.keys(DEFAULT_PREFERENCES));
});

test('写未知键不落盘，不污染存储', () => {
  const storage = fakeStorage();
  writePreference(storage, 'somethingRemovedLater', true);
  assert.deepEqual(readPreferences(storage), DEFAULT_PREFERENCES);
});

// Safari 无痕模式下 localStorage.setItem 直接抛 QuotaExceededError；
// iOS 上还可能整个 localStorage 都不可读。偏好存不下是可以接受的降级，
// 让整个界面崩掉不是。
test('存储不可用时降级成默认值，不让界面崩', () => {
  const broken = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  assert.deepEqual(readPreferences(broken), DEFAULT_PREFERENCES);
  assert.doesNotThrow(() => writePreference(broken, 'mcpStatusMessages', true));
});

test('没有 storage 也能工作', () => {
  assert.deepEqual(readPreferences(null), DEFAULT_PREFERENCES);
  assert.doesNotThrow(() => writePreference(null, 'mcpStatusMessages', true));
});
