import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitStreamingMarkdown } from '../public/js/markdown-stream.js';

// 这个文件测的是**切分判据**，不是渲染。splitStreamingMarkdown 只回答一个问题：
// 流式文本到目前为止，哪一段前缀已经定型、可以渲染成 DOM 之后再也不动。
// 渲染由 renderMarkdown 负责，两者的接线在 app.js。

test('closed paragraph goes stable, unfinished tail stays active', () => {
  const { stable, active } = splitStreamingMarkdown('第一段已经写完。\n\n第二段正在写');
  assert.equal(stable, '第一段已经写完。\n\n');
  assert.equal(active, '第二段正在写');
});

// 围栏内的空行不是块分隔符。切在那里会把半截代码当正文渲染 —— 用户会看到
// 代码块「裂开」，后半截以普通段落的字体流出来，闭合时再跳回去。
test('unfinished code fence is never split, even across blank lines', () => {
  const text = '这是说明。\n\n```js\nconst a = 1;\n\nconst b = 2;';
  const { stable, active } = splitStreamingMarkdown(text);
  assert.equal(stable, '这是说明。\n\n');
  assert.equal(active, '```js\nconst a = 1;\n\nconst b = 2;');
});

// 松散列表的项间空行同样不是安全切点，但原因和围栏不同：marked 对
// `1. a\n\n2. b` 整体渲染成 <li><p>a</p></li>（松散），切开后两半各自变成
// <li>a</li>（紧凑）。序号不会错（后半是 <ol start="2">），但 <p> 的有无
// 改变行高，收尾重渲染时整个列表会跳一下。
test('blank line inside a loose list is not a cut point', () => {
  const text = '说明：\n\n1. 第一项\n\n2. 第二项正在写';
  const { stable, active } = splitStreamingMarkdown(text);
  assert.equal(stable, '说明：\n\n');
  assert.equal(active, '1. 第一项\n\n2. 第二项正在写');
});

// 列表**写完之后**那个空行是安全的：前面是列表项、后面是新段落,
// 整个列表因此能整块进 stable，不再每帧重渲染。
test('list becomes stable once a non-list block follows it', () => {
  const text = '- 甲\n\n- 乙\n\n后续段落正在写';
  const { stable, active } = splitStreamingMarkdown(text);
  assert.equal(stable, '- 甲\n\n- 乙\n\n');
  assert.equal(active, '后续段落正在写');
});

// 增量渲染的地基：stable 一旦渲染成 DOM 就不再重建，所以它**只能往前长**。
// 若某一帧的 stable 不是下一帧 stable 的前缀，已经画好的 DOM 就和文本对不上，
// 用户会看到内容闪回。这里逐字回放整段流式过程来钉死这条性质。
test('stable prefix never retreats as text streams in', () => {
  const full = '开头段落。\n\n- 甲\n\n- 乙\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n收尾段落。';
  let prevStable = '';
  for (let i = 1; i <= full.length; i += 1) {
    const text = full.slice(0, i);
    const { stable, active } = splitStreamingMarkdown(text);
    assert.equal(stable + active, text, `切分丢字于第 ${i} 帧`);
    assert.ok(
      stable.startsWith(prevStable),
      `stable 在第 ${i} 帧回退：${JSON.stringify(prevStable)} -> ${JSON.stringify(stable)}`,
    );
    prevStable = stable;
  }
});
