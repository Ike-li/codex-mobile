#!/usr/bin/env node
// scripts/mock-codex-app-server.js —— Mock codex app-server for E2E testing.
// Simulates JSON-RPC 2.0 over stdio protocol without spawning real codex.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let threadId = 'mock_thread_001';
let turnCount = 0;
let activeTurnId = null;
const pendingApprovals = new Map(); // id → { resolve }
const threadHistory = new Map();
// 归档态必须留在 mock 里:thread/list 若忽略 archived 参数,前端「显示已归档」这条
// 往返链路就无法回归——两份视图会永远返回同一批会话,任何过滤 bug 都测不出来。
const archivedThreads = new Set();

// marked 开着 gfm: true,真实回复里表格/标题/引用/分隔线都会出现。这份 fixture 刻意让
// 表格宽到超过 720px 阅读栏,用来守护"宽表格自己横向滚动、不撑破整条消息"。
const RICH_MARKDOWN = [
  '# 顶层标题',
  '',
  '## 次级标题',
  '',
  '> 引用块:验证左边框与 muted 文字色。',
  '',
  '---',
  '',
  // 单元格里放不可断行的长 token(路径、命令行),表格的 min-content 宽度会直接超过
  // 720px 阅读栏 —— 这才是真实会破版的形态,纯中文说明会自己换行,构不成守护。
  '| 文件 | 命令 | 门禁 | 说明 |',
  '| --- | --- | --- | --- |',
  '| `public/js/workspace-panel.js` | `npm run test:e2e -- --project=mobile-chrome` | `lint` | 一段足够长的中文说明文本，继续把这张表格撑宽 |',
  '| `scripts/mock-codex-app-server.js` | `node --test --test-concurrency=1 test/*.test.mjs` | `protocol:check` | 另一段同样很长的中文说明文本，确保必须横向滚动 |',
  '',
  '- 列表项一',
  '- 列表项二',
].join('\n');

// 代码块单独一个 fixture 而不是并进 RICH_MARKDOWN：那一份被 markdown-typography
// 和 markdown-sanitization 拿来量排版，往里塞东西会改掉它们量的对象。
const CODE_BLOCK_MARKDOWN = [
  '给你一段实现：',
  '',
  '```js',
  'export function summarizeTurnOutcome({ diff = "", commands = [] } = {}) {',
  '  const { files, added, removed } = parseUnifiedDiff(diff);',
  '  return { files, added, removed, hasChanges: files.length > 0 };',
  '}',
  '```',
].join('\n');

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ method, params }) + '\n');
}

function summarizeInputs(inputs) {
  return (Array.isArray(inputs) ? inputs : []).map(input => {
    if (input?.type === 'text') return input.text || '';
    if (input?.type === 'mention') return `@${input.name || input.path || 'file'}`;
    if (input?.type === 'skill') return `$${input.name || 'skill'}`;
    if (input?.type === 'localImage') return '[local image]';
    if (input?.type === 'image') return '[image URL]';
    return '';
  }).filter(Boolean).join(' ');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 真实 Codex 在一个 turn 内每次调模型都推一次 tokenUsage：实测日志里
// 101 条 thread/tokenUsage/updated 对 7 个 turn（约每轮 14 条）。
// mock 每轮发 3 条就足以暴露「把状态当事件 append」的渲染问题。
const MOCK_CONTEXT_WINDOW = 272000;
let mockContextTokens = 0;

function notifyTokenUsage(targetThreadId, turnId) {
  mockContextTokens += 12000;
  const breakdown = {
    totalTokens: mockContextTokens,
    inputTokens: Math.max(0, mockContextTokens - 500),
    cachedInputTokens: Math.floor(mockContextTokens * 0.7),
    cacheWriteInputTokens: 200,
    outputTokens: 500,
    reasoningOutputTokens: 120,
  };
  notify('thread/tokenUsage/updated', {
    threadId: targetThreadId,
    turnId,
    tokenUsage: {
      last: breakdown,
      total: { ...breakdown, totalTokens: mockContextTokens * 2 },
      modelContextWindow: MOCK_CONTEXT_WINDOW,
    },
  });
}

async function simulateSlowTurn(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  activeTurnId = turnId;
  notify('turn/started', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'inProgress' },
  });
  await sleep(6000);
  notify('item/agentMessage/delta', {
    threadId: targetThreadId, turnId, itemId: `msg_${turnCount}`, delta: 'SLOW_TURN_OK',
  });
  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: { type: 'agentMessage', id: `msg_${turnCount}`, text: 'SLOW_TURN_OK' },
  });
  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' },
  });
  activeTurnId = null;
  threadHistory.set(targetThreadId, {
    input,
    responseText: 'SLOW_TURN_OK',
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      { type: 'agentMessage', text: 'SLOW_TURN_OK' },
    ],
  });
}

async function simulateTurn(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  activeTurnId = turnId;

  if (input.includes('PRE_ACK_STREAM')) {
    notify('turn/started', {
      threadId: targetThreadId,
      turn: { id: turnId, status: 'inProgress' }
    });
  }

  // Simulate streaming response
  const responseText = input.includes('SCROLL_STREAM_FIXTURE')
    ? Array.from({ length: 90 }, (_, index) => `line-${String(index + 1).padStart(3, '0')} streaming transcript content`).join('\n')
    : input.includes('REAL_BROWSER_OK')
    ? 'REAL_BROWSER_OK'
    : input.includes('PRE_ACK_STREAM')
      ? 'PRE_ACK_STREAM_OK'
    // RICH 分支必须排在 MARKDOWN_FIXTURE 之前:后者是前者的子串。
    : input.includes('RICH_MARKDOWN_FIXTURE')
      ? RICH_MARKDOWN
    : input.includes('CODE_BLOCK_FIXTURE')
      ? CODE_BLOCK_MARKDOWN
    : input.includes('MARKDOWN_FIXTURE')
      ? 'Here is **bold** and `code`.\n\n- item one\n- item two'
      // 这里曾有条 /status 分支，模拟「模型收到 /status 这段文本并回话」。
      // 斜杠命令现在在前端就被分发掉了，留着它只会让人以为 /status 该发给模型。
      : `Mock response to: ${input}`;
  const streamDelayMs = input.includes('STREAMING_MARKDOWN_FIXTURE')
    ? 40
    : input.includes('SCROLL_STREAM_FIXTURE')
      ? 35
    : input.includes('RICH_MARKDOWN_FIXTURE')
      ? 1
      : 10;
  const streamChunks = input.includes('SCROLL_STREAM_FIXTURE') || input.includes('RICH_MARKDOWN_FIXTURE')
    ? responseText.split('\n').map((line, index, lines) => index < lines.length - 1 ? `${line}\n` : line)
    : [...responseText];

  // Stream text delta
  for (const char of streamChunks) {
    notify('item/agentMessage/delta', {
      threadId: targetThreadId, turnId, itemId: `msg_${turnCount}`, delta: char
    });
    await sleep(streamDelayMs);
  }

  // Complete the message
  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: { type: 'agentMessage', id: `msg_${turnCount}`, text: responseText }
  });

  // 一个 turn 内多次用量更新（工具循环的每一步都会推）
  notifyTokenUsage(targetThreadId, turnId);
  notifyTokenUsage(targetThreadId, turnId);
  notifyTokenUsage(targetThreadId, turnId);

  // Complete the turn
  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' }
  });
  if (activeTurnId === turnId) activeTurnId = null;
  threadHistory.set(targetThreadId, {
    input,
    responseText,
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      { type: 'agentMessage', id: `msg_${turnCount}`, text: responseText },
    ],
  });
}

async function simulateTurnGroup(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  const itemId = `cmd_group_${turnCount}`;
  activeTurnId = turnId;
  notify('turn/started', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'inProgress' },
  });
  for (const char of 'Before the tool.') {
    notify('item/agentMessage/delta', {
      threadId: targetThreadId, turnId, itemId: `msg_before_${turnCount}`, delta: char,
    });
    await sleep(15);
  }
  notify('item/started', {
    threadId: targetThreadId,
    turnId,
    item: { type: 'commandExecution', id: itemId, command: 'printf grouped', status: 'inProgress' },
  });
  notify('item/commandExecution/outputDelta', {
    threadId: targetThreadId, turnId, itemId, delta: 'grouped\n', stream: 'stdout',
  });
  notify('item/completed', {
    threadId: targetThreadId,
    turnId,
    item: { type: 'commandExecution', id: itemId, command: 'printf grouped', aggregatedOutput: 'grouped\n', exitCode: 0, status: 'completed' },
  });
  for (const char of 'After the tool.') {
    notify('item/agentMessage/delta', {
      threadId: targetThreadId, turnId, itemId: `msg_after_${turnCount}`, delta: char,
    });
    await sleep(15);
  }
  notify('turn/completed', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'completed' },
  });
  activeTurnId = null;
  threadHistory.set(targetThreadId, {
    input,
    responseText: 'Before the tool. After the tool.',
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      { type: 'agentMessage', text: 'Before the tool.' },
      { type: 'commandExecution', id: itemId, command: 'printf grouped', aggregatedOutput: 'grouped\n', exitCode: 0, status: 'completed' },
      { type: 'agentMessage', text: 'After the tool.' },
    ],
  });
}

async function simulateReasoningTurn(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  const reasoningItemId = `reasoning_${turnCount}`;
  activeTurnId = turnId;
  notify('turn/started', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'inProgress' },
  });
  for (const delta of ['Inspecting ', 'the current ', 'streaming ', 'layout.']) {
    notify('item/reasoning/summaryTextDelta', {
      threadId: targetThreadId, turnId, itemId: reasoningItemId, delta,
    });
    await sleep(140);
  }
  for (const char of 'Reasoning fixture complete.') {
    notify('item/agentMessage/delta', {
      threadId: targetThreadId, turnId, itemId: `msg_${turnCount}`, delta: char,
    });
    await sleep(20);
  }
  notify('turn/completed', {
    threadId: targetThreadId,
    turn: { id: turnId, status: 'completed' },
  });
  activeTurnId = null;
  threadHistory.set(targetThreadId, {
    input,
    responseText: 'Reasoning fixture complete.',
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      { type: 'reasoning', summary: ['Inspecting the current streaming layout.'] },
      { type: 'agentMessage', text: 'Reasoning fixture complete.' },
    ],
  });
}

async function simulateApproval(command, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  const approvalId = turnCount + 100;

  // Send approval request as a server→client request (has id)
  const requestPromise = new Promise(resolve => {
    pendingApprovals.set(approvalId, { resolve });
  });

  process.stdout.write(JSON.stringify({
    method: 'item/commandExecution/requestApproval',
    id: approvalId,
    params: {
      threadId: targetThreadId, turnId, itemId: `cmd_${turnId}`,
      command,
      cwd: '/tmp/mock-workdir',
      reason: 'needs execution',
      availableDecisions: ['accept', 'decline']
    }
  }) + '\n');

  // Wait for client response (with timeout)
  const timeout = setTimeout(() => {
    if (pendingApprovals.has(approvalId)) {
      pendingApprovals.get(approvalId).resolve({ decision: 'decline' });
      pendingApprovals.delete(approvalId);
    }
  }, 10000);

  const { decision } = await requestPromise;
  clearTimeout(timeout);

  if (decision === 'decline') {
    // Turn failed - declined
    notify('turn/failed', {
      threadId: targetThreadId, turn: { id: turnId, error: { message: 'Approval declined by user' } }
    });
    return;
  }

  // Simulate command execution
  notify('item/started', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'commandExecution', id: `cmd_${turnId}`,
      command, aggregatedOutput: '', exitCode: null, status: 'in_progress'
    }
  });

  await sleep(200);

  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'commandExecution', id: `cmd_${turnId}`,
      command, aggregatedOutput: 'command approved and executed\n', exitCode: 0, status: 'completed'
    }
  });

  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' }
  });
}

// 一次推出四种此前 mock 从来造不出来的卡片：计划、MCP 调用、搜索结果，以及
// 协议里没见过的 item 走 raw 降级。agent-appserver.js 按 item.type 分派
// （mcpToolCall / webSearch / default→raw_item），turn/plan/updated 出计划卡。
//
// 加这个 fixture 是因为 docs/UI_SURFACE.md 把这四张卡列成了界面上存在的东西，
// 而在此之前没有任何 E2E 或截图能证明它们真的渲染得出来。
async function simulateToolCards(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  activeTurnId = turnId;
  notify('turn/started', {
    threadId: targetThreadId, turn: { id: turnId, status: 'inProgress' },
  });

  notify('turn/plan/updated', {
    threadId: targetThreadId, turnId,
    plan: [
      { step: '读取工作区结构', status: 'completed' },
      { step: '定位失败的测试', status: 'inProgress' },
      { step: '提交修复', status: 'pending' },
    ],
  });

  // started 出 mcp_use（参数），completed 出 mcp_result（结果），两条并成一张卡。
  const mcpItem = {
    type: 'mcpToolCall',
    id: `mcp_${turnId}`,
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: 'src/app.js' },
  };
  notify('item/started', { threadId: targetThreadId, turnId, item: mcpItem });
  await sleep(20);
  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: { ...mcpItem, result: 'export {}\n' },
  });

  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'webSearch',
      id: `search_${turnId}`,
      query: 'playwright screenshot clip',
      results: [
        {
          title: 'Page | Playwright',
          url: 'https://playwright.dev/docs/api/class-page',
          snippet: 'screenshot() 支持 clip 参数，按矩形区域裁剪截图。',
        },
        {
          title: 'Screenshots | Playwright',
          url: 'https://playwright.dev/docs/screenshots',
          snippet: '整页截图、元素截图与遮罩的用法说明。',
        },
      ],
    },
  });

  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'somethingProtocolAddedLater',
      id: `raw_${turnId}`,
      note: '未识别的 item 不再进对话；这条只留给 UNKNOWN_ITEM_FIXTURE 守准入',
    },
  });

  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' },
  });
  activeTurnId = null;
}

// 单独一轮、只有未识别 item：混在 TOOL_CARDS 里会被折进 <details>，DOM 计数才看得到，
// 用户却看不见。单独放才能守「消息流里没有 Raw 卡」这条外部可观察的准入。
async function simulateUnknownItem(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  activeTurnId = turnId;
  notify('turn/started', {
    threadId: targetThreadId, turn: { id: turnId, status: 'inProgress' },
  });
  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'somethingProtocolAddedLater',
      id: `raw_${turnId}`,
      note: 'protocol residue must not become a chat bubble',
    },
  });
  notify('item/agentMessage/delta', {
    threadId: targetThreadId, turnId, itemId: `msg_${turnCount}`, delta: 'unknown item ignored',
  });
  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' },
  });
  activeTurnId = null;
}

async function simulateFileChange(input, targetThreadId = threadId) {
  turnCount++;
  const turnId = `turn_${turnCount}`;
  notify('item/completed', {
    threadId: targetThreadId, turnId,
    item: {
      type: 'fileChange',
      id: `file_${turnId}`,
      status: 'completed',
      changes: [
        { path: 'src/example.js', kind: { type: 'add' }, diff: '+export const ok = true\n' },
        { path: 'src/readme.md', kind: { type: 'modify' }, diff: '-old\n+new\n' },
      ],
    },
  });
  notify('turn/diff/updated', {
    threadId: targetThreadId, turnId,
    diff: [
      'diff --git a/src/example.js b/src/example.js',
      '--- a/src/example.js',
      '+++ b/src/example.js',
      '+export const ok = true',
    ].join('\n'),
  });
  notify('turn/completed', {
    threadId: targetThreadId, turn: { id: turnId, status: 'completed' }
  });
  threadHistory.set(targetThreadId, {
    input,
    responseText: '',
    turnId,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] },
      {
        type: 'fileChange',
        id: `file_${turnId}`,
        status: 'completed',
        changes: [
          { path: 'src/example.js', kind: { type: 'add' }, diff: '+export const ok = true\n' },
          { path: 'src/readme.md', kind: { type: 'modify' }, diff: '-old\n+new\n' },
        ],
      },
    ],
  });
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Handle approval responses (id + result, no method)
  if (msg.id !== undefined && msg.result && !msg.method) {
    const pending = pendingApprovals.get(msg.id);
    if (pending) {
      pending.resolve(msg.result);
      pendingApprovals.delete(msg.id);
      return;
    }
  }

  // Handle requests (have id)
  if (msg.id !== undefined && msg.method) {
    switch (msg.method) {
      case 'initialize':
        respond(msg.id, {
          serverInfo: { name: 'mock-codex-app-server', version: '0.1.0' },
          capabilities: {}
        });
        break;

      case 'thread/start':
        threadId = `mock_thread_${Date.now()}`;
        respond(msg.id, {
          thread: { id: threadId, status: 'active' }
        });
        break;

      case 'thread/settings/update': {
        const mode = msg.params?.collaborationMode?.mode || 'default';
        respond(msg.id, {});
        notify('thread/settings/updated', {
          threadId: msg.params?.threadId || threadId,
          threadSettings: {
            collaborationMode: msg.params?.collaborationMode || { mode, settings: { developer_instructions: null } },
          },
        });
        break;
      }

      case 'thread/resume':
        threadId = msg.params?.threadId || threadId;
        respond(msg.id, {
          thread: { id: threadId, status: { type: 'idle' } }
        });
        break;

      case 'thread/read': {
        const requestedThreadId = msg.params?.threadId || threadId;
        const saved = threadHistory.get(requestedThreadId);
        respond(msg.id, {
          thread: {
            id: requestedThreadId,
            name: 'Mock thread',
            preview: saved?.input || '',
            cwd: process.cwd(),
            status: { type: 'idle' },
            turns: saved ? [{
              id: saved.turnId,
              items: saved.items || [
                { type: 'userMessage', content: [{ type: 'text', text: saved.input, text_elements: [] }] },
                { type: 'agentMessage', text: saved.responseText }
              ]
            }] : []
          }
        });
        break;
      }

      case 'thread/list': {
        const wantArchived = msg.params?.archived === true;
        respond(msg.id, {
          data: [...threadHistory.keys()]
            .filter(id => archivedThreads.has(id) === wantArchived)
            .map(id => ({
              id,
              name: 'Mock thread',
              preview: threadHistory.get(id)?.input || '',
              cwd: process.cwd(),
              createdAt: Math.floor(Date.now() / 1000),
              updatedAt: Math.floor(Date.now() / 1000),
              status: { type: 'idle' }
            })),
          nextCursor: null
        });
        break;
      }

      case 'thread/archive':
        archivedThreads.add(msg.params?.threadId);
        respond(msg.id, {});
        break;

      case 'thread/unarchive':
        archivedThreads.delete(msg.params?.threadId);
        respond(msg.id, {});
        break;

      case 'turn/start': {
        const inputs = Array.isArray(msg.params?.input) ? msg.params.input : [];
        if (inputs.some(input => input?.type === 'text' && !Array.isArray(input.text_elements))) {
          process.stdout.write(JSON.stringify({
            id: msg.id,
            error: { code: -32602, message: 'text input requires text_elements' }
          }) + '\n');
          break;
        }
        const input = summarizeInputs(inputs);
        const targetThreadId = msg.params?.threadId || threadId;
        if (input.includes('PRE_ACK_STREAM')) {
          await simulateTurn(input, targetThreadId);
        }
        respond(msg.id, {
          turn: {
            id: `turn_${input.includes('PRE_ACK_STREAM') ? turnCount : turnCount + 1}`,
            status: 'inProgress'
          }
        });

        // Simulate async turn processing
        if (input.includes('PRE_ACK_STREAM')) {
          break;
        } else if (input.includes('REASONING_STREAM_FIXTURE')) {
          simulateReasoningTurn(input, targetThreadId).catch(() => {});
        } else if (input.includes('TURN_GROUP_FIXTURE')) {
          simulateTurnGroup(input, targetThreadId).catch(() => {});
        } else if (input.includes('SLOW_TURN')) {
          simulateSlowTurn(input, targetThreadId).catch(() => {});
        } else if (input.includes('TOOL_CARDS_FIXTURE')) {
          simulateToolCards(input, targetThreadId).catch(() => {});
        } else if (input.includes('UNKNOWN_ITEM_FIXTURE')) {
          simulateUnknownItem(input, targetThreadId).catch(() => {});
        } else if (input.includes('FILE_CHANGE_FIXTURE')) {
          simulateFileChange(input, targetThreadId).catch(() => {});
        } else if (input.includes('approve') || input.includes('echo')) {
          simulateApproval(input, targetThreadId).catch(() => {});
        } else {
          simulateTurn(input, targetThreadId).catch(() => {});
        }
        break;
      }

      case 'turn/steer': {
        const inputs = Array.isArray(msg.params?.input) ? msg.params.input : [];
        const input = summarizeInputs(inputs);
        const turnId = msg.params?.expectedTurnId || activeTurnId || `turn_${turnCount}`;
        respond(msg.id, {
          turn: { id: turnId, status: 'inProgress' },
        });
        notify('item/agentMessage/delta', {
          threadId: msg.params?.threadId || threadId,
          turnId,
          itemId: `steer_${turnCount}`,
          delta: ` [steer:${input}]`,
        });
        break;
      }

      // inline review：审查结果就是当前 thread 上的一个普通 turn，
      // 所以这里响应完直接走 simulateTurn，前端不需要为它另开一条流。
      case 'review/start': {
        const target = msg.params?.target || {};
        const targetThreadId = msg.params?.threadId || threadId;
        respond(msg.id, {
          turn: { id: `turn_${turnCount + 1}`, status: 'inProgress' },
          reviewThreadId: targetThreadId,
        });
        const label = target.type === 'custom' ? `按指令审查 ${target.instructions}` : '未提交改动审查';
        simulateTurn(`REVIEW_FIXTURE ${label}`, targetThreadId).catch(() => {});
        break;
      }

      case 'turn/interrupt':
        activeTurnId = null;
        respond(msg.id, { ok: true });
        notify('turn/completed', {
          threadId, turn: { id: `turn_${turnCount}`, status: 'interrupted' }
        });
        break;

      case 'account/read':
        respond(msg.id, { account: { type: 'chatgpt', email: 'mock@example.com', planType: 'plus' }, requiresOpenaiAuth: false });
        break;
      case 'account/usage/read':
        respond(msg.id, { summary: { lifetimeTokens: 123000 } });
        break;
      case 'account/rateLimits/read':
        respond(msg.id, { rateLimits: { limitName: 'Codex', planType: 'plus' } });
        break;
      case 'configRequirements/read':
        respond(msg.id, { requirements: null });
        break;
      case 'config/read':
        respond(msg.id, { config: { approval_policy: 'on-request', approvals_reviewer: 'user',
          sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: false, writable_roots: [] } },
        origins: {}, layers: null });
        break;
      case 'model/list':
        respond(msg.id, {
          data: [
            {
              id: 'gpt-5.6-sol',
              model: 'gpt-5.6-sol',
              displayName: 'GPT-5.6',
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'high',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster' },
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'high', description: 'Deeper' },
                { reasoningEffort: 'xhigh', description: 'Extra high' },
                { reasoningEffort: 'max', description: 'Maximum' },
              ],
              // 真实 Codex 只列加速档，"标准"是它隐式的未设置态。以前这里两档都列，
              // 于是测试永远看不到真机上那个孤零零只有 Fast 的面板。
              serviceTiers: [
                { id: 'fast', name: 'Fast', description: '1.5x speed, increased usage' },
              ],
              defaultServiceTier: 'standard',
              inputModalities: ['text', 'image'],
            },
            {
              id: 'gpt-5.5',
              model: 'gpt-5.5',
              displayName: 'GPT-5.5',
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster' },
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'high', description: 'Deeper' },
                { reasoningEffort: 'xhigh', description: 'Extra high' },
              ],
              serviceTiers: [],
              defaultServiceTier: null,
              inputModalities: ['text', 'image'],
            },
            {
              id: 'gpt-5.4',
              model: 'gpt-5.4',
              displayName: 'GPT-5.4',
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster' },
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'high', description: 'Deeper' },
              ],
              // 另一条分支：上游自己就把默认档列了出来，这时不能再补一条重复的。
              serviceTiers: [
                { id: 'standard', name: 'Standard', description: 'Default speed' },
                { id: 'fast', name: 'Fast', description: '1.5x speed, increased usage' },
              ],
              defaultServiceTier: 'standard',
              inputModalities: ['text', 'image'],
            },
            {
              id: 'gpt-5.4-mini',
              model: 'gpt-5.4-mini',
              displayName: 'GPT-5.4-Mini',
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: 'low',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster' },
                { reasoningEffort: 'medium', description: 'Balanced' },
              ],
              serviceTiers: [],
              defaultServiceTier: null,
              inputModalities: ['text'],
            },
          ],
          nextCursor: null,
        });
        break;

      case 'modelProvider/capabilities/read':
        respond(msg.id, {
          namespaceTools: true,
          imageGeneration: false,
          webSearch: true,
        });
        break;

      case 'mcpServerStatus/list': {
        const detail = msg.params?.detail;
        if (detail != null && detail !== 'full' && detail !== 'toolsAndAuthOnly') {
          process.stdout.write(JSON.stringify({
            id: msg.id,
            error: {
              code: -32602,
              message: `Invalid request: unknown variant \`${detail}\`, expected \`full\` or \`toolsAndAuthOnly\``,
            },
          }) + '\n');
          break;
        }
        respond(msg.id, {
          data: [
            'codex-security',
            'codex_app',
            'codex_apps',
            'computer-use',
            'cua_repl',
            'github',
            'node_repl',
          ].map(name => ({
            name,
            serverInfo: null,
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: 'notLoggedIn',
          })),
          nextCursor: null,
        });
        break;
      }

      default:
        respond(msg.id, {});
    }
  }

  // Handle notifications (no id)
  if (msg.method && msg.id === undefined) {
    // Client notifications like 'initialized' — acknowledge silently
  }
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
