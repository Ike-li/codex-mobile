// test/infra/check-invariant-ids.test.mjs —— 不变量编号门禁自身的四种失效形态。
//
// 为什么要测门禁：这道闸守的是一件**没有任何运行时后果**的事（文件放哪个目录）。
// 它写错了不会有任何别的东西变红，症状就是永远绿。所以四种失效形态必须各自被
// 证明能变红一次 —— 否则它只是一个占着「这里检查过了」位置的摆设。
//
// 用真实的 analyze/registryIds/guardIdOf，不手写 stub：stub 会把契约编错，
// 然后测试与实现互相印证、一起说谎。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analyze, collectGuards, registryIds, guardIdOf, INVARIANT_ID_RE,
} from '../../scripts/gates/check-invariant-ids.js';

const okInput = {
  registry: ['A2', 'DELIVER-01'],
  guards: [{ file: 'test/invariants/x.test.mjs', id: 'A2' }],
  corpus: ['... A2 ...', '... DELIVER-01 ...'],
};

test('全部合规时通过', () => {
  assert.equal(analyze(okInput).ok, true);
});

test('① invariants/ 下的文件没写守护行 → 红', () => {
  const { ok, problems } = analyze({ ...okInput, guards: [{ file: 'test/invariants/x.test.mjs', id: null }] });
  assert.equal(ok, false);
  assert.match(problems.join('\n'), /第 2 行不是守护行/);
});

test('① 之变体：写了守护行但里面没有合法编号 → 红，且与「没写」分开报', () => {
  const { ok, problems } = analyze({ ...okInput, guards: [{ file: 'test/invariants/x.test.mjs', id: '' }] });
  assert.equal(ok, false);
  assert.match(problems.join('\n'), /没有合法编号/);
});

test('② 守护行引用了登记表里没有的编号 → 红', () => {
  const { ok, problems } = analyze({ ...okInput, guards: [{ file: 'test/invariants/x.test.mjs', id: 'NOPE-99' }] });
  assert.equal(ok, false);
  assert.match(problems.join('\n'), /NOPE-99 在 test\/README\.md 的登记表里查不到/);
});

test('③ 登记表里的编号没人再提 → 红（死条目）', () => {
  const { ok, problems } = analyze({ ...okInput, corpus: ['... A2 ...'] });
  assert.equal(ok, false);
  assert.match(problems.join('\n'), /DELIVER-01 在整棵 test\/ 树里一次都没被提到/);
});

test('④ 扫描面塌陷：登记表空 → 红', () => {
  assert.equal(analyze({ ...okInput, registry: [], corpus: [] }).ok, false);
  assert.match(analyze({ ...okInput, registry: [], corpus: [] }).problems.join('\n'), /登记表一行都没解析出来/);
});

test('④ 扫描面塌陷：invariants/ 一个文件都没扫到 → 红', () => {
  const { ok, problems } = analyze({ ...okInput, guards: [] });
  assert.equal(ok, false);
  assert.match(problems.join('\n'), /一个文件都没扫到/);
});

// ---- 编号正则：上一版 /\b([A-Z]+-\d+)\b/ 的三个具体缺口 ----

test('编号正则认得单字母加数字的形态（A2 / D6）', () => {
  assert.equal(INVARIANT_ID_RE.exec('守护：A2')?.[1], 'A2');
  assert.equal(INVARIANT_ID_RE.exec('守护：D6')?.[1], 'D6');
});

test('编号正则完整吃下多段形态，不把 R-SEC-1 切成 SEC-1', () => {
  assert.equal(INVARIANT_ID_RE.exec('守护：R-SEC-1')?.[1], 'R-SEC-1');
});

test('guardIdOf 区分「不是守护行」和「守护行里没编号」', () => {
  assert.equal(guardIdOf('import test from "node:test";'), null);
  assert.equal(guardIdOf('// 守护：'), '');
  assert.equal(guardIdOf('// 守护：DELIVER-01'), 'DELIVER-01');
  assert.equal(guardIdOf('//  守护:  A2  '), 'A2', '半角冒号与多余空格都该认');
});

test('登记表只认首列，正文里的交叉引用不算登记', () => {
  const md = [
    '| 编号 | 红线 | 守它的文件 |',
    '|---|---|---|',
    '| `A2` | 与 `DELIVER-01` 的分工见下 | x.test.mjs |',
  ].join('\n');
  assert.deepEqual(registryIds(md), ['A2'], '正文里的 DELIVER-01 是交叉引用，登记进来会凭空造出一条谁也没守的编号');
});

test('真实登记表解析得出，且每条守护行都能在里面查到', () => {
  const ids = registryIds(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
  assert.ok(ids.length >= 5, `登记表只解析出 ${ids.length} 条，疑似表格格式变了而解析器没跟上`);
  const { ok, problems } = analyze({
    registry: ids,
    guards: collectGuards(),
    corpus: [readFileSync(new URL('../README.md', import.meta.url), 'utf8')],
  });
  // corpus 只喂登记表自己：守护行引用的编号必须在表里查得到（正向），
  // 而表里每条编号在表里必然出现（反向天然成立）——这条断言聚焦在正向。
  assert.equal(ok, true, problems.join('\n'));
});
