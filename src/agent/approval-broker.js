import { dirname } from 'node:path';
import { appendOwnerOnlyFile, mkdirBounded } from '../files/file-security.js';
import { truncate } from '../shared/text-utils.js';

const TRUNCATE_SUFFIX = ' ... (truncated)';

const DEFAULT_DECISIONS = ['accept', 'decline'];
const TOOL_SUMMARY_CAP = 600;
const V2_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
const V1_APPROVAL_METHODS = new Set([
  'applyPatchApproval',
  'execCommandApproval',
]);
const ALL_REQUEST_METHODS = new Set([
  ...V2_APPROVAL_METHODS,
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  ...V1_APPROVAL_METHODS,
]);
const V1_DECISIONS = {
  accept: 'approved',
  acceptForSession: 'approved_for_session',
  decline: 'denied',
  cancel: 'abort',
};

export class ApprovalBroker {
  constructor({ emit, respond, pendingApprovals, auditPath }) {
    this.emit = emit;
    this.respond = respond;
    this.pendingApprovals = pendingApprovals || new Set();
    this.pending = new Map();
    this.items = new Map();
    this.auditPath = auditPath || null;
  }

  handleRequest(approvalId, method, params) {
    if (!ALL_REQUEST_METHODS.has(method)) return false;

    const id = approvalKey(approvalId);
    this.pendingApprovals.add(id);
    this.pending.set(id, { method, params: params ?? null });

    if (method === 'item/tool/requestUserInput') {
      const payload = this.buildUserInputPayload(id, method, params);
      this.emit('user_input_request', payload);
      this.audit('request', id, method, payload);
      return true;
    }

    const payload = this.buildApprovalPayload(id, method, params);
    this.emit('approval_request', payload);
    this.audit('request', id, method, payload);
    return true;
  }

  respondApproval(approvalId, decision, extra) {
    const id = approvalKey(approvalId);
    if (!this.pendingApprovals.has(id)) return false;

    const record = this.pending.get(id) || { method: 'item/commandExecution/requestApproval', params: null };
    if (!approvalTargetMatches(record.params, extra)) return false;
    const result = this.resultFor(record.method, record.params, decision || 'decline', extra);
    this.pendingApprovals.delete(id);
    this.pending.delete(id);
    this.respond(id, result);
    this.audit('decision', id, record.method, {
      decision: decision || 'decline',
      result,
    });
    return true;
  }

  handleResolved(params) {
    const requestId = params?.requestId;
    for (const approvalId of this.pendingApprovals) {
      if (String(approvalId) === String(requestId)) {
        const record = this.pending.get(approvalId);
        this.pendingApprovals.delete(approvalId);
        this.pending.delete(approvalId);
        this.emit('approval_revoked', {
          approvalId,
          requestId,
          threadId: params?.threadId || null,
        });
        this.audit('revoked', approvalId, record?.method || null, { requestId });
        return approvalId;
      }
    }
    return null;
  }

  registerItem(item) {
    if (!item?.id) return;
    this.items.set(item.id, {
      type: item.type || null,
      changes: normalizeChanges(item.changes),
    });
  }

  clearItems() {
    this.items.clear();
  }

  // dispose 时调用：未决的 server request 若没有响应，app-server 侧那个 turn 会
  // 永久等下去。clearPending 只清集合、不回包，所以另立一个。
  declinePending() {
    for (const approvalId of [...this.pendingApprovals]) {
      const record = this.pending.get(approvalId);
      const method = record?.method || 'item/commandExecution/requestApproval';
      this.pendingApprovals.delete(approvalId);
      this.pending.delete(approvalId);
      try {
        const result = this.resultFor(method, record?.params, 'decline');
        this.respond(approvalId, result);
        this.audit('decision', approvalId, method, { decision: 'decline', result });
        // 其它 clearPending 的调用点（abort、turn 终态、进程退出）都会顺带发一个
        // 能让 server.js 的 trackNeedsYou 关单的事件。不发的话这条 needs-you 记录
        // 永远停在 pending：不参与 prune，还会推给每台重连的手机。
        this.emit('approval_revoked', {
          approvalId,
          requestId: approvalId,
          threadId: record?.params?.threadId ?? null,
        });
      } catch {
        // 单个回包失败不应挡住其余的
      }
    }
  }

  clearPending() {
    this.pendingApprovals.clear();
    this.pending.clear();
  }

  buildApprovalPayload(approvalId, method, params) {
    const payload = {
      approvalId,
      kind: method,
      command: null,
      cwd: stringOrNull(params?.cwd),
      reason: stringOrNull(params?.reason),
      availableDecisions: Array.isArray(params?.availableDecisions) ? params.availableDecisions : DEFAULT_DECISIONS,
    };

    if (params?.threadId) payload.threadId = params.threadId;
    if (params?.turnId) payload.turnId = params.turnId;
    if (params?.itemId) payload.itemId = params.itemId;
    if (params?.startedAtMs) payload.startedAtMs = params.startedAtMs;
    if (params?.environmentId) payload.environmentId = params.environmentId;

    if (method === 'item/commandExecution/requestApproval') {
      payload.command = commandText(params?.command);
      return payload;
    }

    if (method === 'item/fileChange/requestApproval') {
      if (params?.grantRoot !== undefined) payload.grantRoot = params.grantRoot;
      const cached = this.items.get(params?.itemId);
      if (cached?.changes?.length) payload.changes = cached.changes;
      return payload;
    }

    if (method === 'item/permissions/requestApproval') {
      payload.permissions = permissionSummary(params?.permissions);
      return payload;
    }

    if (method === 'applyPatchApproval') {
      if (params?.conversationId) payload.conversationId = params.conversationId;
      if (params?.callId) payload.callId = params.callId;
      if (params?.grantRoot !== undefined) payload.grantRoot = params.grantRoot;
      payload.changes = changesFromFileMap(params?.fileChanges);
      return payload;
    }

    if (method === 'execCommandApproval') {
      if (params?.conversationId) payload.conversationId = params.conversationId;
      if (params?.callId) payload.callId = params.callId;
      if (params?.approvalId) payload.upstreamApprovalId = params.approvalId;
      if (params?.parsedCmd) payload.parsedCmd = params.parsedCmd;
      payload.command = commandText(params?.command);
      return payload;
    }

    return payload;
  }

  buildUserInputPayload(approvalId, method, params) {
    const payload = {
      approvalId,
      kind: method,
      questions: normalizeQuestions(params?.questions),
      autoResolutionMs: Number.isFinite(params?.autoResolutionMs) ? params.autoResolutionMs : undefined,
    };
    if (params?.threadId) payload.threadId = params.threadId;
    if (params?.turnId) payload.turnId = params.turnId;
    if (params?.itemId) payload.itemId = params.itemId;
    return payload;
  }

  resultFor(method, params, decision, extra) {
    if (method === 'item/permissions/requestApproval') {
      if (decision === 'accept' || decision === 'acceptForSession') {
        return {
          permissions: permissionSummary(params?.permissions),
          scope: decision === 'acceptForSession' ? 'session' : 'turn',
        };
      }
      return { permissions: {}, scope: 'turn' };
    }

    if (method === 'item/tool/requestUserInput') {
      return { answers: normalizeAnswers(extra?.answers) };
    }

    if (V1_APPROVAL_METHODS.has(method)) {
      return { decision: V1_DECISIONS[decision] || V1_DECISIONS.decline };
    }

    return { decision };
  }

  audit(event, approvalId, method, detail) {
    if (!this.auditPath) return;
    try {
      mkdirBounded(dirname(this.auditPath), { mode: 0o700 });
      const line = JSON.stringify({
        ts: Date.now(),
        event,
        approvalId,
        method,
        ...auditMetadata(event, detail),
      });
      appendOwnerOnlyFile(this.auditPath, line + '\n');
    } catch {
      // Audit failures must not block the protocol response path.
    }
  }
}

function auditMetadata(event, detail = {}) {
  if (event === 'request') {
    return {
      ...(Array.isArray(detail.availableDecisions)
        ? { availableDecisionCount: detail.availableDecisions.length }
        : {}),
      ...(Array.isArray(detail.questions) ? { questionCount: detail.questions.length } : {}),
      ...(Array.isArray(detail.changes) ? { changeCount: detail.changes.length } : {}),
    };
  }
  if (event === 'decision') {
    const answers = detail.result?.answers;
    const answerCount = answers && typeof answers === 'object'
      ? Object.values(answers).reduce((count, answer) => (
          count + (Array.isArray(answer?.answers) ? answer.answers.length : 0)
        ), 0)
      : 0;
    return {
      ...(typeof detail.decision === 'string' ? { decision: detail.decision } : {}),
      ...(answers ? { answerCount } : {}),
    };
  }
  return {};
}

function approvalTargetMatches(params, extra) {
  for (const key of ['threadId', 'turnId', 'itemId']) {
    if (extra?.[key] === undefined) continue;
    if (params?.[key] === undefined || String(params[key]) !== String(extra[key])) return false;
  }
  return true;
}

function commandText(value) {
  if (Array.isArray(value)) return value.join(' ');
  return typeof value === 'string' ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

function permissionSummary(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  if (value.network !== undefined) out.network = value.network;
  if (value.fileSystem !== undefined) out.fileSystem = value.fileSystem;
  return out;
}

function normalizeChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes.map(change => ({
    path: typeof change?.path === 'string' ? change.path : '',
    kind: changeKind(change),
    diff: truncate(typeof change?.diff === 'string' ? change.diff : '', TOOL_SUMMARY_CAP * 2, TRUNCATE_SUFFIX),
  }));
}

function changesFromFileMap(fileChanges) {
  if (!fileChanges || typeof fileChanges !== 'object') return [];
  return Object.entries(fileChanges).map(([path, change]) => ({
    path,
    kind: changeKind(change),
    diff: truncate(typeof change?.diff === 'string' ? change.diff : '', TOOL_SUMMARY_CAP * 2, TRUNCATE_SUFFIX),
  }));
}

function changeKind(change) {
  if (typeof change?.kind?.type === 'string') return change.kind.type;
  if (typeof change?.kind === 'string') return change.kind;
  if (typeof change?.type === 'string') return change.type;
  return 'modify';
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map(question => ({
    id: truncateString(question?.id),
    header: truncateString(question?.header),
    question: truncateString(question?.question, TOOL_SUMMARY_CAP * 2),
    isOther: question?.isOther === true,
    isSecret: question?.isSecret === true,
    options: Array.isArray(question?.options)
      ? question.options.map(option => ({
          label: truncateString(option?.label),
          description: truncateString(option?.description, TOOL_SUMMARY_CAP),
        }))
      : null,
  }));
}

function normalizeAnswers(answers) {
  const out = {};
  if (!answers || typeof answers !== 'object') return out;
  for (const [questionId, value] of Object.entries(answers)) {
    if (Array.isArray(value)) {
      out[questionId] = { answers: value.map(v => String(v)) };
    } else if (Array.isArray(value?.answers)) {
      out[questionId] = { answers: value.answers.map(v => String(v)) };
    }
  }
  return out;
}

function truncateString(value, cap = TOOL_SUMMARY_CAP) {
  return truncate(typeof value === 'string' ? value : '', cap, TRUNCATE_SUFFIX);
}

function approvalKey(value) {
  const n = Number(value);
  return Number.isNaN(n) ? String(value) : n;
}
