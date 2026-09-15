import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeLabel,
  summarizeActivities,
  workedForLabel,
  repeatedCallsLabel,
  groupSummary,
  thoughtLabel,
} from '../../public/js/render/agent-activity.js';

// 文案对齐 ChatGPT 桌面端 zh-CN 包里的 localConversation.agentActivity.*：
// 进行中用现在时（"正在运行"），完成后用过去时（"运行了命令"）。两套分开，
// 因为一行灰字要同时承担「现在发生什么」和「刚才做过什么」两种读法。

test('正在跑的命令用现在时，并带上命令正文', () => {
  assert.equal(activeLabel({ type: 'command', command: 'npm test' }), '正在运行 npm test');
});

test('命令正文拿不到时退回通用文案，而不是渲染成「正在运行 undefined」', () => {
  assert.equal(activeLabel({ type: 'command' }), '正在运行命令');
});

test('网页搜索带查询词', () => {
  assert.equal(activeLabel({ type: 'search', query: 'BTC 价格' }), '正在网络上搜索 BTC 价格');
});

test('网页搜索没有查询词时只说在搜', () => {
  assert.equal(activeLabel({ type: 'search' }), '正在搜索网页');
});

test('改文件没有「正在编辑 {path}」这一档，上游给的是批量 diff', () => {
  assert.equal(activeLabel({ type: 'file-change' }), '正在编辑文件');
});

test('MCP 调用显示服务器与工具名', () => {
  assert.equal(
    activeLabel({ type: 'mcp', serverName: 'filesystem', toolName: 'read_file' }),
    'filesystem/read_file',
  );
});

// 一轮里跑了 12 条命令就堆 12 张卡，是这次要解决的问题。ChatGPT 的做法是按类型
// 归并成一句话，条数进计数而不是进行数。

test('只有一类活动时，摘要就是那一类的过去时说法', () => {
  assert.equal(summarizeActivities([{ type: 'search' }]), '已搜索网页');
});

test('同一类活动合并成一条，不按次数重复', () => {
  assert.equal(
    summarizeActivities([{ type: 'command' }, { type: 'command' }, { type: 'command' }]),
    '运行了命令',
  );
});

test('多类活动按首次出现顺序用顿号连起来', () => {
  assert.equal(
    summarizeActivities([{ type: 'search' }, { type: 'command' }, { type: 'search' }]),
    '已搜索网页、运行了命令',
  );
});

test('编辑文件按文件数分单复数，而不是按事件数', () => {
  assert.equal(summarizeActivities([{ type: 'file-change', count: 1 }]), '编辑了一个文件');
  assert.equal(summarizeActivities([{ type: 'file-change', count: 3 }]), '编辑了文件');
  // 两次事件各改一个文件，累计仍是复数
  assert.equal(
    summarizeActivities([{ type: 'file-change', count: 1 }, { type: 'file-change', count: 1 }]),
    '编辑了文件',
  );
});

// zh-CN 包里 editedFiles 的句首版是「编辑了文件」、句中版是「编辑了多个文件」——
// 英文那两条只差首字母大小写，中文却给了不同措辞。照抄，但记下这更像翻译产物
// 而不是设计意图，将来要统一措辞时不必当成 ChatGPT 的刻意区分来保。
test('句中的编辑文件说法比句首更明确', () => {
  assert.equal(
    summarizeActivities([{ type: 'search' }, { type: 'file-change', count: 2 }]),
    '已搜索网页、编辑了多个文件',
  );
});

test('句首和句中的说法不同——读取文件是中文里真有区别的那一类', () => {
  assert.equal(summarizeActivities([{ type: 'read' }]), '已读取文件');
  assert.equal(
    summarizeActivities([{ type: 'search' }, { type: 'read' }]),
    '已搜索网页、读取文件',
  );
});

test('工具调用按次数分单复数', () => {
  assert.equal(summarizeActivities([{ type: 'mcp' }]), '调用了一个工具');
  assert.equal(summarizeActivities([{ type: 'mcp' }, { type: 'mcp' }]), '调用了工具');
});

test('没有活动就没有摘要', () => {
  assert.equal(summarizeActivities([]), '');
});

// 时长的中英空格规则直接照抄 zh-CN 包：「4秒」不带空格，「2 分钟」带。不一致，
// 但那是线上在用的写法，自己改一套只会和截图对不上。

test('不到一分钟只报秒，秒数四舍五入', () => {
  assert.equal(workedForLabel(4200), '用时 4秒');
  assert.equal(workedForLabel(4600), '用时 5秒');
});

test('超过一分钟拆成分和秒', () => {
  assert.equal(workedForLabel(80_000), '用时 1分 20 秒');
});

test('整分钟不拖一个「0 秒」尾巴', () => {
  assert.equal(workedForLabel(120_000), '用时 2 分钟');
});

test('超过一小时拆成小时和分', () => {
  assert.equal(workedForLabel(3_900_000), '用时 1 小时 5 分');
});

test('整小时不拖分', () => {
  assert.equal(workedForLabel(7_200_000), '用时 2小时');
});

test('同一个工具被反复调用时合并成一行带计数', () => {
  assert.equal(repeatedCallsLabel('read_file', 3), 'read_file · 3 次调用');
});

// 折叠一组活动时的标题。整组是同一个工具的话，「调用了工具」把最有用的信息
// （是哪个工具、调了几次）丢了，这时改用计数说法。

test('整组都是同一个工具时，摘要用计数说法', () => {
  assert.equal(
    groupSummary([
      { type: 'mcp', label: 'filesystem/read_file' },
      { type: 'mcp', label: 'filesystem/read_file' },
      { type: 'mcp', label: 'filesystem/read_file' },
    ]),
    'filesystem/read_file · 3 次调用',
  );
});

test('组内标签不一致时退回按类型归并', () => {
  assert.equal(
    groupSummary([
      { type: 'mcp', label: 'filesystem/read_file' },
      { type: 'command', label: 'npm test' },
    ]),
    '调用了一个工具、运行了命令',
  );
});

test('同一类但不同标签的活动不算重复调用', () => {
  assert.equal(
    groupSummary([
      { type: 'command', label: 'npm test' },
      { type: 'command', label: 'npm run lint' },
    ]),
    '运行了命令',
  );
});

test('单条活动不套计数说法', () => {
  assert.equal(groupSummary([{ type: 'search', label: '已搜索网页：BTC' }]), '已搜索网页');
});

// 思考块三态，对应 reasoningItem.thinking / thoughtWithElapsed / thought。
// 原先只有两态（思考中 / 思考过程），完成后不报耗时，读者无从判断这轮想了多久。

test('思考结束时报出耗时', () => {
  assert.equal(thoughtLabel(4200), '已思考 4秒');
});

test('耗时为零说明没量到，只说完成，不报「已思考 0秒」', () => {
  assert.equal(thoughtLabel(0), '已完成思考');
});
