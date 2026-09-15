// test/unit/rpc-log-redaction.test.mjs —— RPC 日志的打码。
//
// 这一族原先是 agent-appserver.js 底部的模块私有函数：不导出、**没有任何测试直接调过**，
// 只能靠「写一条日志再 grep 里面有没有出现密钥」间接验证。变异跑出 31 个存活。
//
// 它守的是唯一把 API key、用户 prompt、家目录绝对路径挡在**落盘日志**之外的那道闸。
// 日志文件是 0600 的，但它仍然会进备份、进 issue 附件、进用户截图。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRpcLogEntry,
  isDeltaNotification,
  redactRpcError,
  redactRpcString,
  redactRpcValue,
} from '../../src/agent/rpc-log-redaction.js';

// 键名像凭证 → **整个值**换成占位符，一个字节都不留。
// 这一条和下一条的区别要紧：凭证不能留长度（长度本身就是线索），正文可以。
test('键名像凭证时整个值被抹掉，无论它是什么类型', () => {
  const secretish = ['token', 'accessToken', 'refreshToken', 'apiKey', 'api_key', 'API-KEY',
    'secret', 'password', 'passwd', 'credential', 'authorization',
    'privateKey', 'private_key', 'chatgptAuthTokens', 'dataBase64'];
  for (const key of secretish) {
    assert.equal(redactRpcValue('sk-proj-abcdefghijklmnop', key), '<redacted>', key);
    assert.equal(redactRpcValue({ nested: 'x' }, key), '<redacted>', `${key}（对象也整个抹掉）`);
    assert.equal(redactRpcValue([1, 2, 3], key), '<redacted>', `${key}（数组也整个抹掉）`);
    assert.equal(redactRpcValue(12345, key), '<redacted>', `${key}（数字也抹掉）`);
  }
  // 键名里**包含**敏感词就算，不要求完全相等——上游字段名千变万化。
  assert.equal(redactRpcValue('x', 'userApiKeyForThing'), '<redacted>');
});

// 正文只留长度：诊断时「有多长」有用，内容本身不该落盘。
test('键名是正文时只留长度，不留内容', () => {
  // instructions 是 review/start 的自定义审查指令——用户自由输入的一句话，
  // 和 prompt 同类。它跟着 /review 一起进 RPC，不能原样落盘。
  for (const key of ['text', 'input', 'prompt', 'content', 'delta', 'aggregatedOutput', 'output', 'diff', 'data', 'instructions']) {
    assert.equal(redactRpcValue('hello world', key), '<redacted:11 chars>', key);
    assert.equal(redactRpcValue([1, 2, 3, 4], key), '<redacted:4 items>', `${key}（数组留条数）`);
  }
  // 正文这一类要求**完全匹配**键名，否则 `outputPath` 这种会被误当成正文。
  // （值仍然过路径清洗，所以 /tmp 会变成 <tmp>——那是下一条测的事。）
  assert.equal(redactRpcValue('some-file.txt', 'outputPath'), 'some-file.txt');
  assert.doesNotMatch(redactRpcValue('/tmp/x', 'outputPath'), /redacted/,
    'outputPath 不是正文键，不该只剩长度');
});

// 普通字符串仍然要过 sanitize（抹掉密钥形态）与 sanitizePath（抹掉家目录）。
// 键名不敏感不代表值不敏感——密钥经常出现在自由文本里。
test('普通字符串仍然过密钥形态与路径的清洗', () => {
  const key = ['sk', 'proj', 'abcdefghijklmnopqrstuvwx'].join('-');
  assert.doesNotMatch(redactRpcString(`failed with ${key}`, 'message'), /sk-proj-/,
    '键名不敏感不代表值里没有密钥');

  assert.match(redactRpcString('/Users/someone/private-project', 'cwd'), /<home>/, 'cwd 抹家目录');
  assert.match(redactRpcString('/Users/someone/x', 'path'), /<home>/, 'path 抹家目录');
  // 键名不是 cwd/path，但值长得像绝对路径时也抹——路径经常出现在错误消息里。
  assert.match(redactRpcString('/Users/someone/x not found', 'message'), /<home>/);
  assert.doesNotMatch(redactRpcString('relative/path', 'message'), /<home>/, '相对路径不动');
});

test('超长字符串被截断，日志一行不会无界增长', () => {
  const long = 'a'.repeat(5000);
  const out = redactRpcString(long, 'message');
  assert.ok(out.length < 400, `实际 ${out.length} 字符——单行无界会把保留窗口里有用的记录挤出去`);
});

// 结构的宽度与深度都要有界：上游一条 result 可能带着几千个条目。
test('数组与对象都有条数上界，嵌套里的敏感键同样被抹', () => {
  const bigArray = redactRpcValue(Array.from({ length: 100 }, (_, i) => i));
  assert.equal(bigArray.length, 30, '数组最多留 30 项');

  const bigObject = redactRpcValue(Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`k${i}`, i])));
  assert.equal(Object.keys(bigObject).length, 40, '对象最多留 40 个键');

  // 嵌套两层里的凭证不能漏。
  assert.deepEqual(
    redactRpcValue({ outer: { inner: { apiKey: 'sk-live-xxx', ok: 1 } } }),
    { outer: { inner: { apiKey: '<redacted>', ok: 1 } } });
});

// 方法名本身敏感时，params 与 result **整个**抹掉——那种方法的每个字段都可能是凭证。
test('方法名敏感时 params 与 result 整个抹掉，但 error 仍然分字段处理', () => {
  const entry = buildRpcLogEntry({
    direction: 'outbound',
    frame: 'request',
    id: 1,
    method: 'account/chatgptAuthTokens/refresh',
    params: { anything: 'at all' },
    result: { also: 'everything' },
    error: { code: -1, message: 'boom' },
  });
  assert.equal(entry.params, '<redacted>');
  assert.equal(entry.result, '<redacted>');
  assert.equal(entry.error.code, -1, '错误码要留着——它是排查的主要线索，且不含机密');
  assert.equal(entry.error.message, 'boom');
});

test('日志条目的骨架字段齐全，缺失的给 null 而不是 undefined', () => {
  const entry = buildRpcLogEntry({ frame: 'notification' });
  assert.equal(entry.direction, null);
  assert.equal(entry.id, null);
  assert.equal(entry.method, null);
  assert.equal(entry.instanceId, null);
  assert.equal(entry.sessionId, null);
  assert.equal(entry.frame, 'notification');
  assert.ok(Number.isInteger(entry.ts));
  // 没给的字段不能凭空出现——JSONL 每行的键集合应当反映真实收到了什么。
  assert.equal('params' in entry, false);
  assert.equal('result' in entry, false);
  assert.equal('error' in entry, false);

  // id 为 0 是合法的 RPC id，不能被当成"没有"。
  assert.equal(buildRpcLogEntry({ frame: 'response', id: 0 }).id, 0);
});

test('非对象的错误也给得出可读结构', () => {
  assert.deepEqual(redactRpcError('plain failure'), { message: 'plain failure' });
  assert.deepEqual(redactRpcError(null), { message: '' });
  assert.deepEqual(redactRpcError(undefined), { message: '' });
  // data 里的凭证同样要抹——但注意是**逐键**抹，不是把整个 data 抹掉。
  // CONTENT_RPC_KEY_RE 只作用于字符串和数组；对象会继续递归下去，
  // 于是结构保留、里面的凭证按各自的键名处理。这个不对称是有意的：
  // 保留结构对排查有用，而真正的机密由键名判据挡住。
  assert.deepEqual(redactRpcError({ code: 5, data: { token: 'abc', ok: 1 } }),
    { code: 5, data: { token: '<redacted>', ok: 1 } });
  // data 是字符串时才只留长度。
  assert.deepEqual(redactRpcError({ code: 5, data: 'raw text' }),
    { code: 5, data: '<redacted:8 chars>' });
});

// delta 通知不落盘：它们的正文早已被打码成占位符，诊断价值接近零，
// 却能占掉 96% 的日志体积，把真正有用的 request/response/error 挤出保留窗口。
test('只有 delta 类的通知跳过落盘，别的帧一律记', () => {
  assert.equal(isDeltaNotification('notification', 'item/agentMessageDelta'), true);
  assert.equal(isDeltaNotification('notification', 'turn/delta'), true);
  assert.equal(isDeltaNotification('notification', 'turn/started'), false, '不是 delta');
  assert.equal(isDeltaNotification('request', 'item/agentMessageDelta'), false,
    '请求即使方法名带 Delta 也要记——它是我们自己发出去的，条数不多');
  assert.equal(isDeltaNotification('response', 'item/agentMessageDelta'), false);
  assert.equal(isDeltaNotification('notification', undefined), false, '方法名缺失时不跳过');
  assert.equal(isDeltaNotification('notification', 'deltaThing'), false,
    '只认结尾是 Delta 或 /delta 的，不能因为名字里有 delta 就丢掉');
});
