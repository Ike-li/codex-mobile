export class MessageReceiptLedger {
  constructor(options = {}) {
    this.entries = new Map();
    this.runtimeIndex = new Map();
    this.maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : 10000;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0
      ? options.ttlMs
      : 24 * 60 * 60 * 1000;
    // 停在 queued 的条目的宽限期。默认取 ttl 的 7 倍（一周）：远长于任何真实 turn，
    // 所以不会误删还在排队的消息；又是有限的，不会让被遗弃的条目把账本占死。
    this.abandonedTtlMs = Number.isFinite(options.abandonedTtlMs) && options.abandonedTtlMs >= 0
      ? options.abandonedTtlMs
      : this.ttlMs * 7;
    this.now = options.now || (() => Date.now());
  }

  claim({ identity, requestId, fingerprint }) {
    this.prune();
    const key = `${identity}\0${requestId}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      return { kind: 'duplicate', handle: existing.handle };
    }
    if (this.entries.size >= this.maxEntries) return { kind: 'full' };

    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const handle = Object.freeze({ key });
    const entry = {
      handle,
      fingerprint,
      phase: 'pending',
      result: null,
      latestReceipt: null,
      runtimeKey: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      settledAt: null,
      ready,
      resolveReady,
    };
    this.entries.set(key, entry);
    return { kind: 'owner', handle };
  }

  settle(handle, result) {
    const entry = this.#entryOf(handle);
    if (!entry || entry.phase !== 'pending') return false;
    const receipt = selectLatestReceipt(result?.receipt, entry.latestReceipt);
    entry.phase = receiptPhase(receipt);
    entry.result = applyReceipt(result, receipt);
    entry.updatedAt = this.now();
    entry.settledAt = entry.updatedAt;
    entry.resolveReady();
    if (
      !receipt
      && result?.ok === false
      && result.retryable === true
      && result.resultUnknown !== true
    ) {
      this.removeEntry(entry);
    }
    return true;
  }

  bindRuntime(handle, { instanceId, clientRequestId }) {
    const entry = this.#entryOf(handle);
    if (!entry || !instanceId || !clientRequestId) return false;
    const runtimeKey = `${instanceId}\0${clientRequestId}`;
    const existing = this.runtimeIndex.get(runtimeKey);
    if (existing && existing !== entry) return false;
    if (entry.runtimeKey && entry.runtimeKey !== runtimeKey) {
      this.runtimeIndex.delete(entry.runtimeKey);
    }
    entry.runtimeKey = runtimeKey;
    this.runtimeIndex.set(runtimeKey, entry);
    return true;
  }

  advanceRuntime({ instanceId, clientRequestId, receipt }) {
    const entry = this.runtimeIndex.get(`${instanceId}\0${clientRequestId}`);
    if (!entry || !receipt) return false;
    const current = entry.latestReceipt || entry.result?.receipt || null;
    if (!canAdvanceReceipt(current, receipt)) return false;
    entry.latestReceipt = { ...(current || {}), ...receipt };
    if (entry.result) entry.result = applyReceipt(entry.result, entry.latestReceipt);
    entry.updatedAt = this.now();
    if (entry.settledAt !== null) entry.settledAt = entry.updatedAt;
    if (entry.phase !== 'pending') entry.phase = receiptPhase(entry.latestReceipt);
    return true;
  }

  async replay(handle) {
    const entry = this.#entryOf(handle);
    if (!entry) return null;
    await entry.ready;
    return entry.result;
  }

  async replayByRequest({ identity, requestId }) {
    this.prune();
    const entry = this.entries.get(`${identity}\0${requestId}`);
    if (!entry) return null;
    await entry.ready;
    return entry.result;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    const abandonedCutoff = this.now() - this.abandonedTtlMs;
    for (const entry of this.entries.values()) {
      // pending 的 ready promise 还有人等着，删了会把 replay 永久挂住。服务端的
      // dispatch 包在 try/catch 里且必定 settle，所以 pending 不会长期堆积；进程
      // 死掉时整张表一起没了，也不需要回收。
      if (entry.phase === 'pending') continue;

      // waiting 是还排在 runtime 队列里、尚未执行的消息。近期的必须留着：删掉它的
      // 回执会让 reconcile 查不到而重复发送。但终态回执由 agent 的事件驱动，实例被
      // 空闲回收、codex 退出或 thread 被关掉时它永远不会到来，条目就此卡死。
      //
      // 原先的实现无条件跳过 waiting，于是这些条目**永不回收**：攒够 maxEntries 之后
      // 所有带 clientRequestId 的消息一律收到 receipt_ledger_full，而服务端给的文案是
      // 「请稍后重试」—— 一句永远不会兑现的话，只有重启进程才能恢复。给它一个远长于
      // 正常 turn、但有限的宽限期：过了这个点，消息确定不在队列里了，让 reconcile
      // 重发才是用户要的结果。
      if (entry.phase === 'waiting') {
        if (entry.updatedAt > abandonedCutoff) continue;
        this.removeEntry(entry);
        continue;
      }

      // 回收依据是 settledAt——「结算过没有」，而不是「是不是终态」。
      // 曾经按终态回收，于是 dispatch_failed 形状（retryable + resultUnknown）的条目
      // 永不回收，攒够 maxEntries 后所有带 clientRequestId 的消息一律收到
      // receipt_ledger_full，只有重启能恢复。这一行是那次事故的修法，别改回去。
      if (entry.settledAt === null || entry.settledAt > cutoff) continue;
      this.removeEntry(entry);
    }
  }

  clear() {
    this.entries.clear();
    this.runtimeIndex.clear();
  }

  // handle 只是 key 的一层封装，所以不需要第二张表来做 handle→entry：多一张就要手工保持
  // 同步，removeEntry 漏删一边就是泄漏。
  #entryOf(handle) {
    return handle ? this.entries.get(handle.key) : undefined;
  }

  stats() {
    return { size: this.entries.size };
  }

  removeEntry(entry) {
    this.entries.delete(entry.handle.key);
    if (entry.runtimeKey) this.runtimeIndex.delete(entry.runtimeKey);
  }
}

function receiptRank(receipt) {
  if (receipt?.state === 'queued') return 1;
  if (receipt?.state === 'submitted' || receipt?.state === 'steered' || receipt?.state === 'rejected') {
    return 2;
  }
  return 0;
}

function canAdvanceReceipt(current, next) {
  const currentRank = receiptRank(current);
  const nextRank = receiptRank(next);
  if (nextRank < currentRank) return false;
  if (currentRank >= 2 && nextRank >= 2 && current?.state !== next?.state) return false;
  return true;
}

function selectLatestReceipt(current, latest) {
  if (!latest) return current || null;
  if (!current) return latest;
  return canAdvanceReceipt(current, latest) ? { ...current, ...latest } : current;
}

// phase 只有三种，而且只有 'pending' 与 'waiting' 会被读：
//   pending —— 还在派发，prune 不能碰（有人 await 着它的 ready）
//   waiting —— 停在 queued，由 abandonedTtlMs 管
//   settled —— 其余一切已结算的，由 ttlMs 管
//
// 曾经还有第四种 'terminal'，与 'settled' 的唯一区别体现在一个叫 terminalAt 的字段上，
// 而那个字段写了三处、一处也没读（prune 的依据是 settledAt）。更糟的是它半可靠：
// dispatch_failed 形状的条目算 'settled'，terminalAt 恒为 null——谁按它写回收逻辑，
// 就会重现上面 prune 注释里那次事故。所以整个区分被删掉了，不要再加回来。
function receiptPhase(receipt) {
  return receipt?.state === 'queued' ? 'waiting' : 'settled';
}

function applyReceipt(result, receipt) {
  if (!receipt) return result;
  const next = { ...(result || {}), receipt: { ...receipt } };
  if (receipt.state === 'rejected') {
    next.ok = false;
    next.errorCode = receipt.errorCode || 'dispatch_rejected';
    next.error = receipt.error || '消息未被 Codex runtime 接受';
  }
  return next;
}
