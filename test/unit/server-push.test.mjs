import { test } from 'node:test';
import assert from 'node:assert/strict';

// 同 test/server-integration.test.mjs：server.js 的 console.log 会污染 node --test
// 的 child-v8 控制通道，改道到 stderr。这里虽然用 CODEX_SERVER_NO_START 跳过监听，
// 模块顶层的启动前检查仍会打日志。
console.log = console.error;

async function importServerWithoutStarting() {
  const prev = process.env.CODEX_SERVER_NO_START;
  process.env.CODEX_SERVER_NO_START = '1';
  try {
    return await import(`../../server.js?test=${Date.now()}-${Math.random()}`);
  } finally {
    if (prev === undefined) delete process.env.CODEX_SERVER_NO_START;
    else process.env.CODEX_SERVER_NO_START = prev;
  }
}

test('pushDecision sends approval and user input notifications but not revoked notifications', async () => {
  const { pushDecision } = await importServerWithoutStarting();

  assert.match(pushDecision({
    type: 'approval_request',
    payload: { kind: 'item/commandExecution/requestApproval', command: 'npm test', reason: 'run tests' },
  }).title, /待审批/);

  assert.match(pushDecision({
    type: 'user_input_request',
    payload: { questions: [{ question: 'Continue?' }] },
  }).title, /需要人到场/);

  assert.equal(pushDecision({ type: 'approval_revoked', payload: { approvalId: 1 } }), null);
});

test('approval push uses a stable needs-you deep link without exposing command text by default', async () => {
  const { pushDecision } = await importServerWithoutStarting();
  const notification = pushDecision({
    type: 'approval_request',
    sessionId: 'thr mobile/one',
    payload: {
      needId: 'need_abc123',
      approvalId: 42,
      command: 'rm -rf private-project',
    },
  });

  assert.equal(notification.tag, 'need:need_abc123');
  assert.deepEqual(notification.data, {
    needId: 'need_abc123',
    threadId: 'thr mobile/one',
    url: '/?thread=thr%20mobile%2Fone&need=need_abc123',
  });
  assert.doesNotMatch(notification.body, /private-project/);
});

// R-7 的缺口：此前只在待审批/需人到场/完成/出错时推送。codex 进程死掉是最需要人知道的
// 情形之一——任务停了，而手机上看到的还是「运行中」，不推的话用户会一直等一个不会来的
// 结果。只推真正的失败原因，status 事件本身很频繁，全推就是骚扰。
test('codex 进程退出要推送，普通状态变化不推', async () => {
  const { pushDecision } = await importServerWithoutStarting();

  for (const reason of ['process_exit', 'process_error']) {
    const decision = pushDecision({ type: 'status', payload: { reason, state: 'idle' } });
    assert.ok(decision, `${reason} 应当推送`);
    assert.match(decision.title, /Codex/);
    assert.match(decision.body, /退出|中断/);
  }

  for (const reason of ['turn_started', 'turn_completed', 'idle']) {
    assert.equal(pushDecision({ type: 'status', payload: { reason, state: 'running' } }), null, `${reason} 不该推送`);
  }
});

// R-13：手机可以调松审批和沙箱（§3.1——功能层设限挡不住任何人）。挡不住就必须看得见：
// 变更写审计，并推送到**全部**已注册设备。手机被盗时，你的其他设备会收到提醒。
test('策略变更要推送到全部设备', async () => {
  const { pushDecision } = await importServerWithoutStarting();
  const decision = pushDecision({
    type: 'policy_change',
    payload: { summary: '恢复宿主机默认', approvalPolicy: 'never', sandbox: 'danger-full-access' },
  });
  assert.ok(decision, '策略变更必须推送');
  assert.match(decision.title, /权限/);
  assert.match(decision.body, /恢复宿主机默认/);
});
