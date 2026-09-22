// test/invariants/read-state.test.mjs —— 未读位点的四条不变量。
// 守护：READ-01
//
// 测什么：跨设备归并后位点不会倒退、不会复活、不会自相矛盾。
// 不测什么 + 为什么：不测「点该不该亮」的渲染——那是 logic/unread.js 的判定，
//   有它自己的用例；这里只测**位点本身**的演化规则。
//
// 四条不变量每一条背后都是同一种失败形态：位点被拨回过去，于是一屏已经看过的会话
// 重新亮起来。而那看起来像「未读功能不准」，不像数据被改坏了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStateStore } from '../../src/sessions/read-state.js';
import { isManualUnreadNow, isSessionUnread } from '../../public/js/session/unread.js';

const T0 = 1_700_000_000_000;

function withStore(fn, { now = () => T0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-read-state-'));
  try {
    return fn(createReadStateStore({ file: join(dir, 'read-state.json'), now }));
  } finally {
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
}

// ---- READ-01 ①：markRead 单调不回退 ----

test('① 乱序到达的旧 ack 不把位点拨回过去', () => {
  withStore(store => {
    store.markRead('s1', T0 + 1000);
    store.markRead('s1', T0 + 500);        // 迟到的旧 ack
    assert.equal(store.snapshot().seen.s1, T0 + 1000);
  });
});

// ---- READ-01 ②：setManual(off) 的 seen 也必须单调 ----

test('② 「标为已读」同样不能把位点拨回过去——两侧必须同向', () => {
  // 这条路径原先无条件覆盖：一个乱序到达的旧「标为已读」会把 seen 拨回它的时间戳，
  // 于是那之后的所有活动重新变成未读。与 ① 是同一个不变量的两个入口。
  withStore(store => {
    store.markRead('s1', T0 + 1000);
    store.setManual('s1', false, T0 + 500);
    assert.equal(store.snapshot().seen.s1, T0 + 1000);
  });
});

// ---- READ-01 ③：「标为已读」必须同时记 seen ----

test('③ 取消手动未读时要记 seen，不能只删标记', () => {
  // 判据是 manual[id] > seen[id]。只删标记的话，别的设备把旧 manual 条目合并回来
  // 就又亮了——而本地明明点过「标为已读」。
  withStore(store => {
    store.setManual('s1', true, T0 + 100);
    store.setManual('s1', false, T0 + 200);
    const snap = store.snapshot();
    assert.ok(Number.isFinite(snap.seen.s1), 'seen 必须被记上');
    assert.equal(isManualUnreadNow(snap.manual, snap.seen, 's1'), false);

    // 别的设备带着旧 manual 条目回来
    const merged = store.applyClientState({ baselineTs: T0, seen: {}, manual: { s1: T0 + 100 } });
    assert.equal(isManualUnreadNow(merged.manual, merged.seen, 's1'), false, '旧标记不该复活');
  });
});

// ---- READ-01 ④：markRead 顺带清掉被盖过的 manual ----

test('④ 被更晚的 seen 盖过的 manual 条目要清掉，不能留着', () => {
  // 不清的话形成长期不对称：本地删了、服务端留着、下一趟 hydrate 又合并回本地。
  // 两台设备时钟有偏移时，那份复活的旧标记会翻成假未读。
  withStore(store => {
    store.setManual('s1', true, T0 + 100);
    store.markRead('s1', T0 + 200);
    assert.equal(Object.hasOwn(store.snapshot().manual, 's1'), false);
  });
});

test('④ 之反面：比 seen 更晚的 manual 不能被清掉', () => {
  // 用户正看着一个会话时长按「标为未读」——那一笔比任何离场记录都晚，必须活下来。
  withStore(store => {
    store.markRead('s1', T0 + 100);
    store.setManual('s1', true, T0 + 200);
    const snap = store.snapshot();
    assert.equal(isManualUnreadNow(snap.manual, snap.seen, 's1'), true);
  });
});

// ---- 基线 ----

test('基线只钉一次，之后的调用不再改它', () => {
  // 基线是「从哪一刻起算未读」。每次启动重钉等于所有旧会话永远不亮。
  let clock = T0;
  withStore(store => {
    const first = store.snapshot().baselineTs;
    clock = T0 + 999_999;
    assert.equal(store.snapshot().baselineTs, first);
    store.markRead('s1', clock);
    assert.equal(store.snapshot().baselineTs, first);
  }, { now: () => clock });
});

test('客户端上报的 baselineTs 不参与——取 min 会传染，取 max 会吞掉离线期的活动', () => {
  // 取 min：最老那台设备的基线会传染给全体，所有人一起看到一屏假未读。
  // 取 max：app 关着时来的新活动会被吞掉，那些才是最该亮的。
  withStore(store => {
    const own = store.snapshot().baselineTs;
    const merged = store.applyClientState({ baselineTs: T0 - 999_999, seen: {}, manual: {} });
    assert.equal(merged.baselineTs, own);
    const merged2 = store.applyClientState({ baselineTs: T0 + 999_999, seen: {}, manual: {} });
    assert.equal(merged2.baselineTs, own);
  });
});

// ---- 跨设备归并 ----

test('归并逐 key 取较晚，且与顺序无关', () => {
  withStore(store => {
    store.applyClientState({ seen: { a: T0 + 100, b: T0 + 500 }, manual: {} });
    store.applyClientState({ seen: { a: T0 + 300, b: T0 + 200 }, manual: {} });
    assert.deepEqual(store.snapshot().seen, { a: T0 + 300, b: T0 + 500 });
  });
});

test('归并对畸形输入不崩，也不写进脏值', () => {
  withStore(store => {
    for (const bad of [null, undefined, 'nope', 42, { seen: 'x', manual: null }, { seen: { a: 'NaN' } }]) {
      const snap = store.applyClientState(bad);
      assert.ok(Number.isFinite(snap.baselineTs));
      for (const v of Object.values(snap.seen)) assert.ok(Number.isFinite(v));
    }
  });
});

// ---- manualUnreadIds ----

test('manualUnreadIds 只列仍然有效的标记，且不再截断', () => {
  // 上限已由存储层保证。这里再截一次等于让「最近标的那一条」静默消失，
  // 而那恰恰是用户最在意的一条。
  withStore(store => {
    store.setManual('a', true, T0 + 100);
    store.setManual('b', true, T0 + 100);
    store.markRead('b', T0 + 200);          // b 被盖过
    assert.deepEqual(store.manualUnreadIds(), ['a']);
  });
});

// ---- 两侧判定同义 ----

test('前端判定与后端位点对同一组事实给出同一个答案', () => {
  // 两侧各写一份合并语义是边界闸要求的（前后端不得互相 import）。这条断言是
  // 那两份实现之间唯一的连接点——没有它，两边漂了也不会有任何东西变红。
  withStore(store => {
    store.markRead('s1', T0 + 100);
    const snap = store.snapshot();
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 50, seenAt: snap.seen.s1, baselineTs: snap.baselineTs }), false);
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 200, seenAt: snap.seen.s1, baselineTs: snap.baselineTs }), true);
  });
});

// ---- 落盘 ----

test('位点落盘后能读回来，损坏时当作没有而不是让 server 起不来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-read-state-'));
  const file = join(dir, 'read-state.json');
  try {
    const a = createReadStateStore({ file, now: () => T0 });
    a.markRead('s1', T0 + 100);
    a.flushSaveSync();

    const b = createReadStateStore({ file, now: () => T0 + 1 });
    assert.equal(b.snapshot().seen.s1, T0 + 100);
    assert.equal(b.snapshot().baselineTs, T0, '基线要跟着一起读回来，不能重钉');

    rmSync(file);
    writeFileSync(file, '{ 坏 JSON');
    const c = createReadStateStore({ file, now: () => T0 + 2 });
    assert.deepEqual(c.snapshot().seen, {}, '损坏一律当作没有——它是缓存类，删掉最多重来一次');
  } finally {
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
