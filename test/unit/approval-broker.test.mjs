import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from '../../approval-broker.js';

function makeBroker(options = {}) {
  const events = [];
  const responses = [];
  const pendingApprovals = new Set();
  const broker = new ApprovalBroker({
    emit: (type, payload) => events.push({ type, payload }),
    respond: (approvalId, result) => responses.push({ approvalId, result }),
    pendingApprovals,
    ...options,
  });
  return { broker, events, responses, pendingApprovals };
}

const byType = (events, type) => events.filter(e => e.type === type);

test('commandExecution approval tolerates missing command cwd and reason', () => {
  const { broker, events, responses, pendingApprovals } = makeBroker();

  assert.equal(broker.handleRequest(11, 'item/commandExecution/requestApproval'), true);

  assert.deepEqual(responses, []);
  assert.equal(pendingApprovals.has(11), true);
  const approval = byType(events, 'approval_request').at(-1);
  assert.ok(approval);
  assert.equal(approval.payload.approvalId, 11);
  assert.equal(approval.payload.kind, 'item/commandExecution/requestApproval');
  assert.equal(approval.payload.command, null);
  assert.equal(approval.payload.cwd, null);
  assert.equal(approval.payload.reason, null);
  assert.deepEqual(approval.payload.availableDecisions, ['accept', 'decline']);
});

test('fileChange approval joins changes from the in-progress item cache and degrades on miss', () => {
  const { broker, events } = makeBroker();
  broker.registerItem({
    type: 'fileChange',
    id: 'item_file_1',
    changes: [
      { path: '/work/a.txt', kind: { type: 'add' }, diff: '+hello\n' },
      { path: '/work/b.txt', kind: 'modify', diff: '-old\n+new\n' },
    ],
  });

  assert.equal(broker.handleRequest(21, 'item/fileChange/requestApproval', {
    threadId: 'thr',
    turnId: 'turn',
    itemId: 'item_file_1',
    reason: 'review diff',
    grantRoot: '/work',
  }), true);

  let approval = byType(events, 'approval_request').at(-1);
  assert.equal(approval.payload.kind, 'item/fileChange/requestApproval');
  assert.equal(approval.payload.command, null);
  assert.equal(approval.payload.reason, 'review diff');
  assert.equal(approval.payload.grantRoot, '/work');
  assert.deepEqual(approval.payload.changes, [
    { path: '/work/a.txt', kind: 'add', diff: '+hello\n' },
    { path: '/work/b.txt', kind: 'modify', diff: '-old\n+new\n' },
  ]);

  assert.equal(broker.handleRequest(22, 'item/fileChange/requestApproval', {
    itemId: 'missing_item',
    reason: 'no cache',
    grantRoot: '/work',
  }), true);

  approval = byType(events, 'approval_request').at(-1);
  assert.equal(approval.payload.reason, 'no cache');
  assert.equal(approval.payload.grantRoot, '/work');
  assert.equal(approval.payload.changes, undefined);
});

test('permissions approval describes requested permissions and maps decisions to the permissions response model', () => {
  for (const [decision, expected] of [
    ['accept', { permissions: { network: { allow: true }, fileSystem: { write: ['/work'] } }, scope: 'turn' }],
    ['acceptForSession', { permissions: { network: { allow: true }, fileSystem: { write: ['/work'] } }, scope: 'session' }],
    ['decline', { permissions: {}, scope: 'turn' }],
  ]) {
    const { broker, events, responses } = makeBroker();
    assert.equal(broker.handleRequest(30, 'item/permissions/requestApproval', {
      threadId: 'thr',
      turnId: 'turn',
      itemId: 'perm_1',
      environmentId: 'env_1',
      cwd: '/work',
      reason: 'needs broader access',
      permissions: { network: { allow: true }, fileSystem: { write: ['/work'] } },
    }), true);

    const approval = byType(events, 'approval_request').at(-1);
    assert.equal(approval.payload.kind, 'item/permissions/requestApproval');
    assert.equal(approval.payload.cwd, '/work');
    assert.equal(approval.payload.reason, 'needs broader access');
    assert.deepEqual(approval.payload.permissions, { network: { allow: true }, fileSystem: { write: ['/work'] } });

    assert.equal(broker.respondApproval(30, decision), true);
    assert.deepEqual(responses.at(-1), { approvalId: 30, result: expected });
  }
});

test('requestUserInput emits user_input_request and returns answers by question id', () => {
  const { broker, events, responses } = makeBroker();
  assert.equal(broker.handleRequest(40, 'item/tool/requestUserInput', {
    threadId: 'thr',
    turnId: 'turn',
    itemId: 'tool_input_1',
    questions: [{
      id: 'q1',
      header: 'Choice',
      question: 'Which branch?',
      isOther: false,
      isSecret: false,
      options: [{ label: 'main', description: 'Use main branch' }],
    }],
    autoResolutionMs: 1500,
  }), true);

  const request = byType(events, 'user_input_request').at(-1);
  assert.ok(request);
  assert.equal(request.payload.approvalId, 40);
  assert.equal(request.payload.kind, 'item/tool/requestUserInput');
  assert.equal(request.payload.autoResolutionMs, 1500);
  assert.deepEqual(request.payload.questions, [{
    id: 'q1',
    header: 'Choice',
    question: 'Which branch?',
    isOther: false,
    isSecret: false,
    options: [{ label: 'main', description: 'Use main branch' }],
  }]);

  assert.equal(broker.respondApproval(40, null, { answers: { q1: ['main'] } }), true);
  assert.deepEqual(responses.at(-1), {
    approvalId: 40,
    result: { answers: { q1: { answers: ['main'] } } },
  });
});

test('v1 applyPatchApproval and execCommandApproval map mobile decisions to ReviewDecision strings', () => {
  for (const method of ['applyPatchApproval', 'execCommandApproval']) {
    for (const [mobileDecision, reviewDecision] of [
      ['accept', 'approved'],
      ['acceptForSession', 'approved_for_session'],
      ['decline', 'denied'],
      ['cancel', 'abort'],
    ]) {
      const { broker, events, responses } = makeBroker();
      const params = method === 'applyPatchApproval'
        ? {
            conversationId: 'thr',
            callId: 'patch_call',
            fileChanges: { '/work/a.txt': { type: 'add', diff: '+a\n' } },
            reason: 'apply patch',
            grantRoot: '/work',
          }
        : {
            conversationId: 'thr',
            callId: 'exec_call',
            approvalId: 'legacy_exec',
            command: ['npm', 'test'],
            cwd: '/work',
            reason: 'run tests',
            parsedCmd: { name: 'npm' },
          };

      assert.equal(broker.handleRequest(50, method, params), true);
      const approval = byType(events, 'approval_request').at(-1);
      assert.equal(approval.payload.kind, method);
      if (method === 'applyPatchApproval') {
        assert.deepEqual(approval.payload.changes, [{ path: '/work/a.txt', kind: 'add', diff: '+a\n' }]);
      } else {
        assert.equal(approval.payload.command, 'npm test');
      }

      assert.equal(broker.respondApproval(50, mobileDecision), true);
      assert.deepEqual(responses.at(-1), {
        approvalId: 50,
        result: { decision: reviewDecision },
      });
    }
  }
});

test('v2 command and fileChange approvals pass through decision strings exactly', () => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    for (const decision of ['accept', 'acceptForSession', 'decline', 'cancel']) {
      const { broker, responses } = makeBroker();
      assert.equal(broker.handleRequest(60, method, { command: 'npm test', itemId: 'missing' }), true);
      assert.equal(broker.respondApproval(60, decision), true);
      assert.deepEqual(responses.at(-1), {
        approvalId: 60,
        result: { decision },
      });
    }
  }
});

test('resolved and repeated approval decisions are idempotent', () => {
  const { broker, events, responses, pendingApprovals } = makeBroker();
  assert.equal(broker.handleRequest(70, 'item/commandExecution/requestApproval', { command: 'npm test' }), true);
  assert.equal(broker.respondApproval(70, 'accept'), true);
  assert.equal(broker.respondApproval(70, 'decline'), false);
  assert.equal(responses.length, 1);
  assert.equal(pendingApprovals.has(70), false);

  assert.equal(broker.handleRequest(71, 'item/commandExecution/requestApproval', { command: 'npm test' }), true);
  assert.equal(broker.handleResolved({ requestId: '71', threadId: 'thr' }), 71);
  assert.equal(broker.respondApproval(71, 'accept'), false);
  assert.equal(responses.length, 1);

  const revoked = byType(events, 'approval_revoked').at(-1);
  assert.equal(revoked.payload.approvalId, 71);
  assert.equal(revoked.payload.requestId, '71');
  assert.equal(revoked.payload.threadId, 'thr');
  assert.equal(broker.handleResolved({ requestId: '71', threadId: 'thr' }), null);
});

test('approval audit is owner-only and records metadata without commands, questions, or answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-broker-'));
  const auditPath = join(dir, 'approval-audit.jsonl');
  try {
    const { broker } = makeBroker({ auditPath });
    assert.equal(broker.handleRequest(80, 'item/commandExecution/requestApproval', {
      command: 'printf command-secret',
      cwd: '/private/work-secret',
      reason: 'reason-secret',
    }), true);
    assert.equal(broker.respondApproval(80, 'decline'), true);
    assert.equal(broker.handleRequest(81, 'item/tool/requestUserInput', {
      questions: [{ id: 'secret-q', question: 'question-secret', isSecret: true }],
    }), true);
    assert.equal(broker.respondApproval(81, null, {
      answers: { 'secret-q': ['answer-secret'] },
    }), true);

    const mode = statSync(auditPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines[0].event, 'request');
    assert.equal(lines[0].approvalId, 80);
    assert.equal(lines[0].method, 'item/commandExecution/requestApproval');
    assert.equal(lines[1].event, 'decision');
    assert.equal(lines[1].decision, 'decline');
    assert.equal(lines[2].questionCount, 1);
    assert.equal(lines[3].answerCount, 1);
    const audit = readFileSync(auditPath, 'utf8');
    for (const secret of [
      'command-secret',
      '/private/work-secret',
      'reason-secret',
      'question-secret',
      'answer-secret',
    ]) {
      assert.doesNotMatch(audit, new RegExp(secret));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declinePending emits a revocation so the gateway can close the need', () => {
  // clearPending 的其它调用点（abort、turn 完成、进程退出）都会顺带发一个能让
  // server.js 的 trackNeedsYou 关单的事件。declinePending 原本只回包不发事件，
  // 于是那条 needs-you 记录永远停在 pending：不参与 prune，还会推给每台重连的手机。
  const emitted = [];
  const responded = [];
  const broker = new ApprovalBroker({
    emit: (type, payload) => emitted.push({ type, payload }),
    respond: (id, result) => responded.push({ id, result }),
    pendingApprovals: new Set(),
  });

  broker.handleRequest(7, 'item/commandExecution/requestApproval', {
    threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', command: ['rm', '-rf', '/tmp/x'],
  });
  emitted.length = 0;

  broker.declinePending();
  assert.deepEqual(responded.map(entry => entry.result), [{ decision: 'decline' }]);
  assert.deepEqual(emitted.map(entry => entry.type), ['approval_revoked']);
  assert.equal(emitted[0].payload.approvalId, 7);
  assert.equal(broker.pendingApprovals.size, 0);
});

// ---- 变异补漏：批 4（APPROVAL） ----

// approvalTargetMatches 是「手机上按下的这个『同意』，对应的确实是服务端等的那一次审批」
// 的唯一判据。一行 6 个变异全部存活——说明匹配与不匹配这两个方向都没有断言。
//
// 判反的后果很具体：手机上停留在一个旧页面（旧 turnId），用户按「同意」，
// 服务端把它当成对**当前**那次审批的同意 —— agent 拿到了一个用户从没看过的授权。
test('审批应答必须匹配它对应的那次请求的目标', () => {
  const request = { threadId: 'thr-1', turnId: 'turn-1', itemId: 'item-1', command: ['ls'] };

  {
    const { broker, responses, pendingApprovals } = makeBroker();
    broker.handleRequest('a1', 'item/commandExecution/requestApproval', request);
    assert.equal(
      broker.respondApproval('a1', 'accept', { threadId: 'thr-1', turnId: 'turn-1', itemId: 'item-1' }),
      true, '三个目标全部对上，必须放行',
    );
    assert.deepEqual(responses, [{ approvalId: 'a1', result: { decision: 'accept' } }]);
    assert.equal(pendingApprovals.size, 0, '处理完就不再是未决');
  }

  // 只给一部分目标也算数：手机端不一定三个都拿得到。
  {
    const { broker, responses } = makeBroker();
    broker.handleRequest('a2', 'item/commandExecution/requestApproval', request);
    assert.equal(broker.respondApproval('a2', 'accept', { turnId: 'turn-1' }), true);
    assert.equal(responses.length, 1);
  }
  {
    const { broker, responses } = makeBroker();
    broker.handleRequest('a3', 'item/commandExecution/requestApproval', request);
    assert.equal(broker.respondApproval('a3', 'accept', {}), true, '什么都不给等于不校验');
    assert.equal(responses.length, 1);
  }

  const mismatches = [
    ['线程对不上', { threadId: 'thr-OTHER' }],
    ['轮次对不上', { turnId: 'turn-OTHER' }],
    ['条目对不上', { itemId: 'item-OTHER' }],
    ['其中一个对不上就不算匹配', { threadId: 'thr-1', turnId: 'turn-OTHER' }],
  ];
  for (const [label, extra] of mismatches) {
    const { broker, responses, pendingApprovals } = makeBroker();
    broker.handleRequest('a4', 'item/commandExecution/requestApproval', request);
    assert.equal(broker.respondApproval('a4', 'accept', extra), false, `${label}：必须拒绝`);
    assert.deepEqual(responses, [], `${label}：不能给上游任何回包`);
    assert.equal(pendingApprovals.has('a4'), true,
      `${label}：这次审批仍然未决，等正确的应答——消耗掉的话真正的应答就再也送不进来了`);
  }

  // 请求本身没带某个目标，而应答硬给了一个：也是对不上。
  {
    const { broker, responses } = makeBroker();
    broker.handleRequest('a5', 'item/commandExecution/requestApproval', { command: ['ls'] });
    assert.equal(broker.respondApproval('a5', 'accept', { turnId: 'turn-1' }), false);
    assert.deepEqual(responses, []);
  }
});

test('未知方法不被受理，也不会留下未决记录', () => {
  const { broker, events, pendingApprovals } = makeBroker();
  assert.equal(broker.handleRequest('x1', 'item/unknown/requestApproval', {}), false);
  assert.deepEqual(events, [], '不该发出任何审批事件');
  assert.equal(pendingApprovals.size, 0, '不受理就不该占一个未决位');
  assert.equal(broker.respondApproval('never-requested', 'accept'), false, '没请求过的 id 应答不了');
});

// 审批载荷里的每个字段都是用户判断「要不要同意」的依据，也是回包给上游时的对齐依据。
// 这几行 `if (params?.x) payload.x = params.x` 的条件被取反后，字段要么全丢、要么凭空出现。
test('审批载荷如实带上上游给的关联字段，缺的不伪造', () => {
  const cases = [
    ['applyPatchApproval', {
      conversationId: 'conv-1', callId: 'call-1', grantRoot: true,
      fileChanges: { 'a.js': { kind: 'add', diff: 'x' } },
    }, payload => {
      assert.equal(payload.conversationId, 'conv-1');
      assert.equal(payload.callId, 'call-1');
      assert.equal(payload.grantRoot, true);
      assert.deepEqual(payload.changes, [{ path: 'a.js', kind: 'add', diff: 'x' }]);
    }],
    ['execCommandApproval', {
      conversationId: 'conv-2', callId: 'call-2', approvalId: 'up-1',
      parsedCmd: [{ type: 'read' }], command: ['ls', '-l'],
    }, payload => {
      assert.equal(payload.conversationId, 'conv-2');
      assert.equal(payload.callId, 'call-2');
      assert.equal(payload.upstreamApprovalId, 'up-1');
      assert.deepEqual(payload.parsedCmd, [{ type: 'read' }]);
      assert.equal(payload.command, 'ls -l');
    }],
  ];

  for (const [method, params, check] of cases) {
    const { broker, events } = makeBroker();
    broker.handleRequest('p1', method, params);
    const [event] = byType(events, 'approval_request');
    check(event.payload);

    // 上游没给的字段不能凭空出现。
    const bare = makeBroker();
    bare.broker.handleRequest('p2', method, {});
    const [bareEvent] = byType(bare.events, 'approval_request');
    for (const key of ['conversationId', 'callId', 'upstreamApprovalId', 'parsedCmd']) {
      assert.equal(key in bareEvent.payload, false, `${method}：上游没给 ${key} 就不该出现`);
    }
  }

  // grantRoot 是布尔值：false 和「没给」是两回事，按真假判断会把 false 一起丢掉。
  const { broker, events } = makeBroker();
  broker.handleRequest('p3', 'applyPatchApproval', { grantRoot: false, fileChanges: {} });
  assert.equal(byType(events, 'approval_request')[0].payload.grantRoot, false,
    'grantRoot=false 必须原样带上——按真假判断会把它当成「没给」丢掉');

  const noGrant = makeBroker();
  noGrant.broker.handleRequest('p4', 'applyPatchApproval', { fileChanges: {} });
  assert.equal('grantRoot' in byType(noGrant.events, 'approval_request')[0].payload, false);
});

test('需人输入的载荷带上它的线程/轮次/条目定位', () => {
  const { broker, events } = makeBroker();
  broker.handleRequest('u1', 'item/tool/requestUserInput', {
    threadId: 'thr-1', turnId: 'turn-1', itemId: 'item-1',
    questions: [{ id: 'q1', question: '继续吗' }],
  });
  const [event] = byType(events, 'user_input_request');
  assert.equal(event.payload.threadId, 'thr-1');
  assert.equal(event.payload.turnId, 'turn-1');
  assert.equal(event.payload.itemId, 'item-1');

  const bare = makeBroker();
  bare.broker.handleRequest('u2', 'item/tool/requestUserInput', { questions: [] });
  const [bareEvent] = byType(bare.events, 'user_input_request');
  for (const key of ['threadId', 'turnId', 'itemId']) {
    assert.equal(key in bareEvent.payload, false, `上游没给 ${key} 就不该出现`);
  }
});

// 结构归一化的三处入口共用同一个形态：`if (!value || typeof value !== 'object') return 空`。
// 改成 && 之后，字符串会被当成对象去遍历——permissionSummary('admin') 会去取
// 'admin'.network，得到一堆无意义的键，而这些键是要展示给用户看的授权范围。
test('权限与变更集的归一化只接受对象，字符串与数组不当对象遍历', () => {
  for (const permissions of ['admin', 42, null, undefined, true]) {
    const { broker, events } = makeBroker();
    broker.handleRequest('n1', 'item/permissions/requestApproval', { permissions });
    assert.deepEqual(byType(events, 'approval_request')[0].payload.permissions, {},
      `permissions=${String(permissions)} 不是对象，应当归一成空`);
  }

  const { broker, events } = makeBroker();
  broker.handleRequest('n2', 'item/permissions/requestApproval', {
    permissions: { network: 'allow', fileSystem: 'read', other: 'ignored' },
  });
  assert.deepEqual(byType(events, 'approval_request')[0].payload.permissions,
    { network: 'allow', fileSystem: 'read' }, '只透出这两个已知字段');

  for (const fileChanges of ['patch', 7, null, undefined]) {
    const patch = makeBroker();
    patch.broker.handleRequest('n3', 'applyPatchApproval', { fileChanges });
    assert.deepEqual(byType(patch.events, 'approval_request')[0].payload.changes, [],
      `fileChanges=${String(fileChanges)} 不是对象，应当归一成空数组`);
  }
});

// 需人输入的答案只认两种形状：数组，或 { answers: [...] }。
// 判反会让「已经是数组」的那种被丢掉，用户填的答案静默消失。
test('需人输入的答案接受裸数组与 { answers } 两种形状，其余丢弃', () => {
  const { broker, responses } = makeBroker();
  broker.handleRequest('q1', 'item/tool/requestUserInput', { questions: [] });
  broker.respondApproval('q1', 'accept', {
    answers: {
      bare: ['是', 1],
      wrapped: { answers: ['否'] },
      junk: 'not an answer',
      alsoJunk: { nope: [] },
    },
  });

  assert.deepEqual(responses[0].result.answers, {
    bare: { answers: ['是', '1'] },
    wrapped: { answers: ['否'] },
  }, '两种合法形状都要收下并统一成 { answers: [字符串] }，其余丢弃');

  const bad = makeBroker();
  bad.broker.handleRequest('q2', 'item/tool/requestUserInput', { questions: [] });
  bad.broker.respondApproval('q2', 'accept', { answers: 'nope' });
  assert.deepEqual(bad.responses[0].result.answers, {}, '答案整体不是对象时归一成空');
});
