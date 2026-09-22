// test/unit/event-presentation.test.mjs —— 消息流准入：什么能进 #messages。
//
// 判据是「一个没用过 Codex 的人能不能把这一屏当成对话」，不是「事件有没有被处理」。
// chrome / silent / debug 都可以有副作用（刷新抽屉、更新用量环），但都不该长成聊天气泡。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEST,
  classifyAgentEvent,
} from '../../public/js/render/event-presentation.js';
import { DEFAULT_PREFERENCES } from '../../public/js/ui/ui-preferences.js';

function destOf(type, payload, prefs) {
  return classifyAgentEvent({ type, payload }, prefs).dest;
}

test('分类器对空输入不抛，缺 type 当协议噪声', () => {
  assert.equal(classifyAgentEvent(undefined).dest, DEST.DEBUG);
  assert.equal(classifyAgentEvent({}).dest, DEST.DEBUG);
  assert.equal(classifyAgentEvent({ type: 1 }).dest, DEST.DEBUG);
});

test('对话本体进消息流', () => {
  const streamTypes = [
    'user_message', 'queued_message', 'dequeued_message', 'queue_cleared',
    'text_delta', 'tool_use', 'tool_output_delta', 'tool_result',
    'approval_request', 'user_input_request', 'approval_revoked',
    'file_change', 'plan', 'reasoning',
    'mcp_use', 'mcp_result', 'search', 'diff',
    'result', 'error',
  ];
  assert.ok(streamTypes.length >= 16, '扫描面塌了：对话类型清单被删空');
  for (const type of streamTypes) {
    assert.equal(destOf(type), DEST.STREAM, `${type} 是对话本体`);
  }
});

test('状态面事件不进消息流', () => {
  const chromeTypes = [
    'device_status', 'init', 'status', 'status_line', 'instances',
    'thread_status', 'collaboration_mode', 'message_receipt',
    'needs_you_changed', 'account_login', 'account_updated',
    'usage', 'pending_devices', 'compact', 'rollback',
  ];
  assert.ok(chromeTypes.length >= 10, '扫描面塌了：状态面清单被删空');
  for (const type of chromeTypes) {
    assert.equal(destOf(type), DEST.CHROME, `${type} 有自己的表面，不该变成气泡`);
  }
});

test('基础设施广播静默，不在对话里报 thread id / 英文协议句', () => {
  const silentTypes = [
    'rate_limits', 'skills_changed', 'thread_event',
    'external_agent_config_import', 'remote_control',
  ];
  for (const type of silentTypes) {
    assert.equal(destOf(type, { event: 'archived', threadId: 'thr_abcdef' }), DEST.SILENT, type);
  }
});

test('未识别的协议 item 与实时通道不进消息流', () => {
  assert.equal(destOf('raw_item', { item: { type: 'somethingProtocolAddedLater' } }), DEST.DEBUG);
  assert.equal(destOf('realtime', { event: 'started' }), DEST.DEBUG);
  assert.equal(destOf('somethingProtocolAddedLater', { foo: 1 }), DEST.DEBUG);
});

test('MCP 过程态默认静默，故障仍进消息流', () => {
  assert.equal(destOf('mcp_status', { name: 'node_repl', status: 'starting' }), DEST.SILENT);
  assert.equal(destOf('mcp_status', { name: 'node_repl', status: 'ready' }), DEST.SILENT);
  assert.equal(
    destOf('mcp_status', { name: 'node_repl', status: 'ready', error: 'spawn ENOENT' }),
    DEST.STREAM,
  );
  assert.equal(destOf('mcp_status', { name: 'node_repl', status: 'failed' }), DEST.STREAM);
});

test('MCP 过程态不进消息流，偏好也改不了这条分界', () => {
  const prefs = { ...DEFAULT_PREFERENCES, mcpStatusMessages: true };
  assert.equal(destOf('mcp_status', { name: 'x', status: 'starting' }, prefs), DEST.SILENT);
  assert.equal(destOf('mcp_status', { name: 'x', status: 'ready' }, prefs), DEST.SILENT);
});

test('system：人能处理的失败和中断进对话，协议泄漏与重试进度不进', () => {
  assert.equal(destOf('system', { message: '已中断', isError: false }), DEST.STREAM);
  assert.equal(
    destOf('system', { message: '输入队列已满（上限 20 条），请等待当前任务完成后再发送', isError: true }),
    DEST.STREAM,
  );
  assert.equal(
    destOf('system', {
      message: 'Unsupported server request from Codex app-server: item/foo',
      isError: true,
    }),
    DEST.DEBUG,
  );
  assert.equal(
    destOf('system', {
      message: 'ChatGPT auth token refresh is not supported by this bridge; no credentials were stored or forwarded: account/chatgptAuthTokens/refresh',
      isError: true,
    }),
    DEST.DEBUG,
  );
  assert.equal(
    destOf('system', { message: 'Codex 正在重试：timeout', isError: false, willRetry: true }),
    DEST.SILENT,
  );
  assert.equal(
    destOf('system', {
      message: 'Codex app-server 拥塞，250ms 后重试 thread/start（1/5）',
      isError: false,
      code: -32001,
    }),
    DEST.SILENT,
  );
});
