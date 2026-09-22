import { createHash } from 'node:crypto';

// 终态记录仍要短暂保留，重开同一 need 才能判出 duplicate / conflict；但不能永久保留，
// 否则 trackNeedsYou 每个 result / error 都要扫的这张表会单调增长。
const RECLAIMABLE_STATES = new Set(['resolved', 'revoked', 'expired']);
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class NeedsYouRegistry {
  #records = new Map();
  #byInstance = new Map(); // instanceId -> Set<needId>，避免按 instance 关单时全表扫描
  #revision = 0;
  #ttlMs;
  #now;

  constructor({ ttlMs, now } = {}) {
    this.#ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
    this.#now = typeof now === 'function' ? now : () => Date.now();
  }

  open({ kind, target, payload = {}, createdAt = this.#now() } = {}) {
    this.prune();
    const normalizedTarget = normalizeTarget(target);
    const normalizedKind = kind === 'question' ? 'question' : 'approval';
    const needId = needIdFor(normalizedKind, normalizedTarget);
    const fingerprint = fingerprintOf({ kind: normalizedKind, target: normalizedTarget, payload });
    const existing = this.#records.get(needId);
    if (existing) {
      return {
        kind: existing.openFingerprint === fingerprint ? 'duplicate' : 'conflict',
        changed: false,
        revision: this.#revision,
        need: toDto(existing),
      };
    }

    const revision = ++this.#revision;
    const record = {
      needId,
      revision,
      kind: normalizedKind,
      state: 'pending',
      target: normalizedTarget,
      payload: clone(payload),
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      openFingerprint: fingerprint,
      resolutionFingerprint: null,
      terminalAt: null,
    };
    this.#records.set(needId, record);
    this.#index(record);
    return { kind: 'opened', changed: true, revision, need: toDto(record) };
  }

  snapshot() {
    return {
      revision: this.#revision,
      needs: [...this.#records.values()]
        .filter(record => record.state === 'pending' || record.state === 'unknown')
        .sort((a, b) => a.createdAt - b.createdAt || a.needId.localeCompare(b.needId))
        .map(toDto),
    };
  }

  async resolve(query, resolution, responder) {
    const record = this.#find(query);
    if (!record || !targetMatches(record.target, query)) {
      return { kind: 'stale', changed: false, revision: this.#revision };
    }
    const resolutionFingerprint = fingerprintOf(resolution || {});
    if (record.state === 'resolved') {
      return {
        kind: record.resolutionFingerprint === resolutionFingerprint ? 'duplicate' : 'conflict',
        changed: false,
        revision: this.#revision,
        need: toDto(record),
      };
    }
    if (record.state === 'resolving') {
      return { kind: 'in_progress', changed: false, revision: this.#revision, need: toDto(record) };
    }
    if (record.state !== 'pending') {
      return { kind: 'stale', changed: false, revision: this.#revision, need: toDto(record) };
    }

    record.state = 'resolving';
    record.updatedAt = this.#now();
    try {
      const accepted = await responder(toDto(record));
      if (accepted !== true) {
        record.state = 'revoked';
        record.updatedAt = this.#now();
        record.terminalAt = record.updatedAt;
        record.revision = ++this.#revision;
        return { kind: 'stale', changed: true, revision: this.#revision, need: toDto(record) };
      }
      record.state = 'resolved';
      record.resolutionFingerprint = resolutionFingerprint;
      record.resolvedAt = this.#now();
      record.updatedAt = record.resolvedAt;
      record.terminalAt = record.resolvedAt;
      record.revision = ++this.#revision;
      return { kind: 'resolved', changed: true, revision: this.#revision, need: toDto(record) };
    } catch (error) {
      record.state = 'unknown';
      record.updatedAt = this.#now();
      record.revision = ++this.#revision;
      return {
        kind: 'unknown',
        changed: true,
        revision: this.#revision,
        need: toDto(record),
        error,
      };
    }
  }

  close(query, { state = 'revoked', reason = null } = {}) {
    const closed = [];
    for (const record of this.#candidates(query)) {
      if (!queryMatches(record.target, query)) continue;
      if (!['pending', 'resolving', 'unknown'].includes(record.state)) continue;
      record.state = state === 'expired' ? 'expired' : 'revoked';
      record.updatedAt = this.#now();
      record.terminalAt = record.updatedAt;
      record.payload = { ...record.payload, ...(reason ? { closeReason: String(reason) } : {}) };
      record.revision = ++this.#revision;
      closed.push(toDto(record));
    }
    return { changed: closed.length > 0, revision: this.#revision, needs: closed };
  }

  prune() {
    const cutoff = this.#now() - this.#ttlMs;
    for (const record of this.#records.values()) {
      if (!RECLAIMABLE_STATES.has(record.state)) continue;
      if (record.terminalAt === null || record.terminalAt > cutoff) continue;
      this.#remove(record);
    }
  }

  stats() {
    return { size: this.#records.size };
  }

  clear() {
    this.#records.clear();
    this.#byInstance.clear();
    this.#revision = 0;
  }

  #find(query = {}) {
    if (typeof query.needId === 'string' && query.needId) return this.#records.get(query.needId) ?? null;
    const matches = this.#candidates(query).filter(record => queryMatches(record.target, query));
    return matches.length === 1 ? matches[0] : null;
  }

  // 带 instanceId 的查询走索引；其余情况才退回全表。
  #candidates(query = {}) {
    const instanceId = query?.instanceId;
    if (typeof instanceId !== 'string' || !instanceId) return [...this.#records.values()];
    const needIds = this.#byInstance.get(instanceId);
    if (!needIds) return [];
    return [...needIds].map(needId => this.#records.get(needId)).filter(Boolean);
  }

  #index(record) {
    const key = record.target.instanceId;
    let needIds = this.#byInstance.get(key);
    if (!needIds) {
      needIds = new Set();
      this.#byInstance.set(key, needIds);
    }
    needIds.add(record.needId);
  }

  #remove(record) {
    this.#records.delete(record.needId);
    const needIds = this.#byInstance.get(record.target.instanceId);
    if (!needIds) return;
    needIds.delete(record.needId);
    if (needIds.size === 0) this.#byInstance.delete(record.target.instanceId);
  }
}

function normalizeTarget(target = {}) {
  return {
    instanceId: requiredId(target.instanceId, 'instanceId'),
    threadId: requiredId(target.threadId, 'threadId'),
    turnId: requiredId(target.turnId, 'turnId'),
    itemId: requiredId(target.itemId, 'itemId'),
    requestId: requiredRequestId(target.requestId),
  };
}

function requiredId(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  return value;
}

function requiredRequestId(value) {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError('requestId is required');
}

function needIdFor(kind, target) {
  return `need_${createHash('sha256')
    .update(fingerprintOf({ kind, target }))
    .digest('hex')
    .slice(0, 24)}`;
}

function targetMatches(target, query = {}) {
  return queryMatches(target, query, true);
}

function queryMatches(target, query = {}, requireComplete = false) {
  const pairs = [
    ['instanceId', query.instanceId],
    ['threadId', query.threadId],
    ['turnId', query.turnId],
    ['itemId', query.itemId],
    ['requestId', query.requestId ?? query.approvalId],
  ];
  if (requireComplete && pairs.some(([, value]) => value === undefined || value === null || value === '')) {
    return false;
  }
  let compared = 0;
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    compared += 1;
    if (target[key] !== value) return false;
  }
  return compared > 0;
}

function fingerprintOf(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}

function toDto(record) {
  return {
    needId: record.needId,
    revision: record.revision,
    kind: record.kind,
    state: record.state,
    target: { ...record.target },
    payload: clone(record.payload),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
