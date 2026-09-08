import {
  bindThreadFromEvent,
  eventMatchesTarget,
  outboxRequestMatchesView as requestMatchesView,
  withTarget,
} from '/js/view-routing.js';
import { clearCurrentThread, getCurrentThread, setCurrentThread } from '/js/thread-preferences.js';
import { bufferRecoveryEvent, completeRecovery, createRecoveryState } from '/js/recovery-state.js';
import { createMessageRequest, messageWirePayload } from '/js/message-request.js';
import { createMessageOutbox } from '/js/message-outbox.js';
import { createIndexedDbMessageStore } from '/js/indexeddb-outbox.js';
import {
  isDefinitelyUnattempted,
  isProvisionalInstanceOrphan,
  requiresManualDisposal,
  shouldSurfaceInOutboxView,
} from '/js/outbox-recovery.js';
import { emitWithAck } from '/js/socket-ack.js';
import {
  applyThreadStatus,
  mergeThreadList,
  threadStatusPresentation,
  needResolutionLabel,
  resolveThreadTitle,
} from '/js/thread-status.js';
import { resolveComposerPrimaryMode } from '/js/composer-mode.js';
import { projectLabel } from '/js/project-label.js';
import { compactPath, parentPath } from '/js/display-path.js';
import { loadExpandedDirs, persistExpandedDirs, toggleExpandedDir } from '/js/drawer-dirs.js';
import { renderMarkdown } from '/js/markdown.js';
import { createTranscriptStream } from '/js/transcript-stream.js';
import { commandCard, fileChangeCard } from '/js/tool-cards.js';
import { resolveConnectionBanner, resolveInsecureTransportBanner } from '/js/connection-banner.js';
import { formatRttChip, formatWorkspaceChangeBadge } from '/js/header-chrome.js';
import { createConfirmController } from '/js/confirm-dialog.js';
import { threadActionConfirm, threadActionErrorMessage } from '/js/thread-actions.js';
import { summarizeTextChange } from '/js/file-diff-summary.js';
import { summarizeTurnOutcome } from '/js/turn-outcome.js';
import { diagnoseHealth, HEALTH_LAYERS } from '/js/health-diagnosis.js';

const LAYER_LABELS = {
  browser: '这台设备的网络',
  network: '到控制台的可达性',
  gateway: '控制台进程',
  appServer: 'codex app-server 进程',
  codex: 'codex 运行状态',
  upstream: '模型上游',
};
import { detectAtMentionQuery, applyAtMentionPick, mentionPartFromSearchHit } from '/js/at-mention.js';
import { pickPastedImage, attachmentPreview } from '/js/attachments-ui.js';
import { createWorkspacePanel } from '/js/workspace-panel.js';
import {
  APPROVAL_OPTIONS,
  SANDBOX_OPTIONS,
  clampEffortForModel,
  clampServiceTierForModel,
  effectiveComposerSettings,
  formatModelBadge,
  formatPermissionBadge,
  formatComposerPermission,
  formatComposerModel,
  formatComposerEffort,
  GRANULAR_APPROVAL_KEYS,
  formatComposerMode,
  normalizeCollaborationMode,
  parseCollaborationModeSlash,
  loadCliSettings,
  modelAcceptsImages,
  reasoningOptionsForModel,
  resolveSelectedModel,
  saveCliSettings,
  sanitizeTurnOverrides,
  serviceTiersForModel,
  visibleModels,
} from '/js/cli-settings.js';
import { icon, hydrateIcons } from '/js/icons.js';
// 沿用 escHtml 这个本地名字：94 处调用点原样不动，改名不是这次搬迁的目的。
import { escapeHtml as escHtml } from '/js/html-escape.js';
import { renderAnsi } from '/js/ansi-html.js';
import { createDeviceToken, decodeBase64Text, urlBase64ToUint8Array } from '/js/client-encoding.js';

(function() {
  const $ = id => document.getElementById(id);
  const messagesEl = $('messages');
  const turnAnnouncer = $('turn-announcer');
  const inputEl = $('msg-input');
  const sendBtn = $('send-btn');
  const jumpToLatestBtn = $('jump-to-latest');
  const attachBtn = $('attach-btn');
  const fileInput = $('file-input');
  const attachTray = $('attach-tray');
  const statusDot = $('status-dot');
  const stateLabel = $('state-label');
  const sessionMetaEl = $('session-meta');
  const statusDetail = $('status-detail');
  const drawerOverlay = $('drawer-overlay');
  const drawer = $('drawer');

  const pendingPanel = $('pending-panel');
  const needsYouPanel = $('needs-you-panel');
  const nativePanel = $('native-panel');
  const authGate = $('auth-gate');
  const authForm = $('auth-form');
  const authTokenInput = $('auth-token-input');
  const authError = $('auth-error');
  const deviceAuth = $('device-auth');
  const confirmDialog = createConfirmController({
    modal: $('confirm-modal'),
    titleEl: $('confirm-title'),
    bodyEl: $('confirm-body'),
    inputWrap: $('confirm-input-wrap'),
    inputEl: $('confirm-input'),
    okBtn: $('confirm-ok'),
    cancelBtn: $('confirm-cancel'),
  });
  const connBanner = $('conn-banner');
  const connBannerText = $('conn-banner-text');
  const connBannerDetail = $('conn-banner-detail');
  const connBannerSpinner = $('conn-banner-spinner');
  const connBannerRetry = $('conn-banner-retry');
  const atMentionPopup = $('at-mention-popup');
  let connPhase = 'connecting';
  let connSince = Date.now();
  let connBannerWasVisible = false;
  let connBannerTimer = null;
  let atMentionReqId = 0;
  const deviceIdDisplay = $('device-id-display');

  // Device token
  let deviceToken = localStorage.getItem('codex_device_token');
  if (!deviceToken) {
    deviceToken = createDeviceToken();
    localStorage.setItem('codex_device_token', deviceToken);
  }
  deviceIdDisplay.textContent = deviceToken;

  const searchParams = new URLSearchParams(location.search);
  const urlToken = searchParams.get('token') || '';
  let pendingNeedsYouDeepLink = searchParams.get('thread') && searchParams.get('need')
    ? { threadId: searchParams.get('thread'), needId: searchParams.get('need') }
    : null;
  let authToken = urlToken;
  if (urlToken) {
    searchParams.delete('token');
    const nextSearch = searchParams.toString();
    history.replaceState(null, '', `${location.pathname}${nextSearch ? '?' + nextSearch : ''}${location.hash}`);
  }

  // State
  let busy = false;
  let interruptPending = false;
  let streamingEl = null;
  const TRANSCRIPT_FOLLOW_DISTANCE_PX = 80;
  let followTranscript = true;
  let activeAssistantTurnEl = null;
  const transcriptStream = createTranscriptStream({
    onStart() {
      setBusy(true);
      hideTyping();
      const bubble = document.createElement('div');
      bubble.className = 'bubble md';
      bubble.dataset.streaming = 'true';
      streamingEl = bubble;
      appendRaw(bubble, 'codex');
      scrollBottom();
    },
    onText(text) {
      if (!streamingEl) return;
      streamingEl.textContent = text;
      scrollBottom();
    },
    onFinish(text) {
      if (!streamingEl) return;
      streamingEl.innerHTML = renderMarkdown(text);
      delete streamingEl.dataset.streaming;
      streamingEl = null;
      scrollBottom();
    },
  });
  let currentSessionId = null;
  let appThreads = [];
  let sessionsByCwd = new Map();
  let expandedDirs = new Set();
  let showArchivedThreads = false;
  let features = { labs: false };
  let pendingToolCards = {}; // toolUseId -> element
  let pendingApprovalCards = {}; // approvalId -> element
  let needsYouRevision = 0;
  let needsYou = new Map();
  let queuedUserBubbles = [];
  let seenEvents = new Set();
  let sessionStatus = null;
  let serverCwd = '';
  let gatewayEpoch = null;
  let workDirs = [];
  let versions = {};
  let currentAttachments = []; // [{name, mimeType, data: base64}]
  let currentInputParts = []; // server-validated mention / skill / imageUrl descriptors
  let instanceList = [];
  let instanceSnapshotReceived = false;
  let lastConnectErrorNotice = '';
  let currentViewingId = null;
  let offlineUserBubbles = []; // [{text, el}]
  // 记「这条记录上次是以什么状态画出来的」。只记 id 的话，记录从 pending 变成
  // needs_reconcile / rejected 后气泡不会重绘——文案停在「弱网等待同步」，重试和
  // 丢弃按钮也长不出来，用户只有刷新才看得到真实状态。
  let renderedOutboxStates = new Map();
  let restoringThreadId = null;
  let activeRecovery = null;
  let targetSetupPromise = null;
  let outboxSyncPromise = null;
  let outboxSyncRequested = false;
  let threadRefreshTimer = null;

  function viewTarget() {
    return { instanceId: currentViewingId, threadId: currentSessionId };
  }

  function rememberCurrentThread(threadId) {
    currentSessionId = typeof threadId === 'string' && threadId ? threadId : null;
    if (currentSessionId) setCurrentThread(localStorage, serverCwd, currentSessionId);
    else clearCurrentThread(localStorage, serverCwd);
  }

  function applyTargetAck(ack) {
    if (!ack?.ok) return false;
    restoringThreadId = null;
    activeRecovery = null;
    if (ack.cwd) {
      serverCwd = ack.cwd;
      expandedDirs.add(ack.cwd);
      persistExpandedDirs(localStorage, expandedDirs);
      if (sessionsByCwd.has(ack.cwd)) appThreads = sessionsByCwd.get(ack.cwd);
      const sel = $('workdir-select');
      if (sel) sel.value = ack.cwd;
      renderDrawerProject();
    }
    if (Object.prototype.hasOwnProperty.call(ack, 'instanceId')) currentViewingId = ack.instanceId || null;
    if (Object.prototype.hasOwnProperty.call(ack, 'threadId')) rememberCurrentThread(ack.threadId);
    renderInstanceTabs();
    renderSessionMeta();
    return true;
  }

  function ensureViewTarget() {
    if (currentViewingId) return Promise.resolve(viewTarget());
    if (targetSetupPromise) return targetSetupPromise;
    const event = currentSessionId ? 'thread:select' : 'session:new';
    const payload = currentSessionId
      ? { threadId: currentSessionId, cwd: serverCwd, title: currentSessionId.slice(0, 8) }
      : { cwd: serverCwd };
    targetSetupPromise = new Promise((resolve, reject) => {
      socket.emit(event, payload, ack => {
        if (!applyTargetAck(ack)) return reject(new Error(ack?.error || '无法建立会话目标'));
        resolve(viewTarget());
      });
    }).finally(() => {
      targetSetupPromise = null;
    });
    return targetSetupPromise;
  }

  function restoreProvisionalOutboxTarget(instanceId) {
    return new Promise((resolve, reject) => {
      socket.emit('session:switch', { instanceId }, ack => {
        if (!applyTargetAck(ack)) return reject(new Error(ack?.error || '无法恢复消息会话目标'));
        resolve(viewTarget());
      });
    });
  }

  function restoreCurrentThreadFromPreference() {
    if (!socket.connected || currentViewingId || restoringThreadId) return false;
    const threadId = getCurrentThread(localStorage, serverCwd);
    if (!threadId) return false;
    const restoreCwd = serverCwd;
    restoringThreadId = threadId;
    socket.emit('thread:history', { threadId, cwd: restoreCwd }, history => {
      if (restoringThreadId !== threadId || serverCwd !== restoreCwd) return;
      if (!history?.ok || history.thread?.id !== threadId) {
        clearCurrentThread(localStorage, restoreCwd, threadId);
        currentSessionId = null;
        restoringThreadId = null;
        renderSessionMeta();
        syncOutboxView();
        return;
      }
      socket.emit('thread:select', {
        threadId,
        cwd: restoreCwd,
        title: history.thread?.name || history.thread?.preview || threadId.slice(0, 8),
      }, ack => {
        if (restoringThreadId !== threadId || serverCwd !== restoreCwd) return;
        restoringThreadId = null;
        if (!applyTargetAck(ack)) {
          clearCurrentThread(localStorage, restoreCwd, threadId);
          currentSessionId = null;
          appendSystem(ack?.error || 'Thread restore failed', true);
          syncOutboxView();
          return;
        }
        clearMessages();
        renderHistoryMessages(
          history.messages || [],
          history.thread?.name || history.thread?.preview || 'Native thread',
        );
        requestCatchUp();
        syncOutboxView();
      });
    });
    return true;
  }

  function requestCatchUp() {
    const target = viewTarget();
    if (!socket.connected || !target.instanceId || !target.threadId) return;
    const lastSeq = Number(localStorage.getItem(`codex_last_seq:${target.threadId}`) || 0);
    const lastEpoch = localStorage.getItem(`codex_last_epoch:${target.threadId}`) || '';
    if (lastSeq <= 0 && !lastEpoch) return;

    const state = createRecoveryState(target);
    activeRecovery = state;
    socket.emit('catch-up', {
      instanceId: target.instanceId,
      sessionId: target.threadId,
      lastSeq,
      lastEpoch,
    }, ack => {
      if (activeRecovery !== state) return;
      activeRecovery = null;
      const recovery = completeRecovery(state, ack);
      if (!recovery.accepted) return;
      if (recovery.gap && !recovery.rebuilt) {
        appendSystem(`重连恢复失败：${ack?.recoveryError || 'thread/read unavailable'}`, true);
      }
      if (recovery.rebuilt) {
        clearMessages();
        renderHistoryMessages(recovery.snapshot.messages || [], recovery.snapshot.title || 'Recovered thread');
        if (recovery.snapshot.threadStatus) {
          handleThreadStatus({ threadId: target.threadId, status: recovery.snapshot.threadStatus });
        }
        localStorage.setItem(`codex_last_seq:${target.threadId}`, String(recovery.throughSeq));
      }
      if (recovery.epoch) {
        localStorage.setItem(`codex_last_epoch:${target.threadId}`, recovery.epoch);
      }
      for (const event of recovery.events) processAgentEvent(event);
    });
  }

  // Socket
  //
  // transports 固定成 websocket，**不要**加回 polling 回退。socket.io 默认先试 polling，
  // 而浏览器对**同源** XHR 不发 Origin 头（只有跨源才发）；服务端对远程连接强制要求 Origin
  // （server-security.js 的 evaluateSocketHandshakeSecurity）。真实远程部署里页面和 socket
  // 永远同源，于是握手必然 403 origin_required，手机永远连不上 —— CODEX_ALLOWED_ORIGINS
  // 白名单也没机会被查，它匹配的那个头压根没送来。
  //
  // WebSocket 的握手不一样：RFC 6455 要求浏览器**一律**带 Origin，同源也带。所以只走
  // websocket 既修好了远程接入，又让服务端那道严格的 Origin 闸真正生效，不用放松任何检查。
  // 由 e2e/remote-origin-handshake.spec.js 守着。
  const socket = io({ autoConnect: false, transports: ['websocket'], auth: { deviceToken } });
  const isTransportConnected = () => socket.connected && navigator.onLine !== false;

  function overlayBlocksBanner() {
    return authGate?.classList.contains('show') || deviceAuth?.classList.contains('show');
  }

  function paintConnectionBanner() {
    // 明文告警是常驻状态而非事件，连接正常时也要挂着；连接出问题时让位给连接横幅，
    // 那条更紧急。
    const view = resolveConnectionBanner({
      phase: connPhase,
      elapsedMs: Date.now() - connSince,
      suppressed: overlayBlocksBanner(),
      wasVisible: connBannerWasVisible,
    }) || (overlayBlocksBanner() ? null : resolveInsecureTransportBanner({
      secureContext: window.isSecureContext,
    }));
    if (!connBanner) return;
    if (!view) {
      connBanner.hidden = true;
      return;
    }
    connBannerWasVisible = true;
    connBanner.hidden = false;
    connBanner.dataset.tone = view.tone;
    if (connBannerText) connBannerText.textContent = view.label;
    if (connBannerDetail) {
      connBannerDetail.textContent = view.detail || '';
      connBannerDetail.hidden = !view.detail;
    }
    if (connBannerSpinner) connBannerSpinner.hidden = !view.spinner;
    if (connBannerRetry) connBannerRetry.hidden = !view.retry;
  }

  function setConnectionPhase(phase) {
    if (phase !== connPhase) {
      if (phase === 'online') connBannerWasVisible = !connBanner?.hidden;
      else connBannerWasVisible = false;
      connPhase = phase;
      connSince = Date.now();
    }
    paintConnectionBanner();
    if (connBannerTimer) clearInterval(connBannerTimer);
    connBannerTimer = setInterval(paintConnectionBanner, 500);
  }

  const workspacePanel = createWorkspacePanel({
    modal: $('workspace-modal'),
    filesTab: $('workspace-tab-files'),
    changesTab: $('workspace-tab-changes'),
    filesTools: $('workspace-files-tools'),
    gitTools: $('workspace-git-tools'),
    filesBody: $('file-browse-body'),
    changesBody: $('git-changes-body'),
    pathEl: $('file-browse-path'),
    backBtn: $('file-browse-back'),
    gitBranchEl: $('git-changes-branch'),
    socket,
    getCwd: () => serverCwd,
    escHtml,
    onMention(path) {
      addInputPart({ kind: 'mention', name: path.split('/').pop() || path, path });
      workspacePanel.close();
      inputEl.focus();
    },
  });
  $('workspace-close')?.addEventListener('click', () => workspacePanel.close());
  $('git-changes-refresh')?.addEventListener('click', () => workspacePanel.refreshGit());
  $('workspace-modal')?.addEventListener('click', event => {
    if (event.target === $('workspace-modal')) workspacePanel.close();
  });
  connBannerRetry?.addEventListener('click', () => {
    if (!socket.connected) socket.connect();
  });
  const outboxStore = createIndexedDbMessageStore();
  const messageOutbox = createMessageOutbox({
    store: outboxStore,
    isConnected: isTransportConnected,
    getGatewayEpoch: () => gatewayEpoch,
    transport: async payload => {
      const ack = await emitWithAck(socket, 'user:message', payload, { timeoutMs: 10000 });
      const target = viewTarget();
      const payloadThreadId = payload?.threadId || null;
      const payloadInstanceId = payload?.instanceId || null;
      const isCurrentTarget = (
        (!target.threadId && !target.instanceId && !payloadThreadId && !payloadInstanceId)
        || (target.threadId && (payloadThreadId === target.threadId || ack?.threadId === target.threadId))
        || (!target.threadId && target.instanceId
          && (payloadInstanceId === target.instanceId || ack?.instanceId === target.instanceId))
      );
      if (ack?.ok && isCurrentTarget) applyTargetAck(ack);
      return ack;
    },
    reconcileTransport: async payload => emitWithAck(socket, 'message:reconcile', {
      ...payload,
      cwd: serverCwd,
    }, { timeoutMs: 10000 }),
  });
  const outboxReady = outboxStore.recoverInterrupted().then(() => true).catch(error => {
    appendSystem(`消息存储不可用：${error.message}`, true);
    return false;
  });

  async function drainMessageOutbox(options = {}) {
    if (!await outboxReady) return;
    try {
      await messageOutbox.drain(options);
    } catch (error) {
      appendSystem(`消息队列处理失败：${error.message}`, true);
    }
  }

  function outboxRequestMatchesView(request) {
    return requestMatchesView(request, {
      threadId: currentSessionId,
      instanceId: currentViewingId,
    });
  }

  function outboxRequestIsOrphaned(request) {
    return isProvisionalInstanceOrphan(request, {
      currentInstanceId: currentViewingId,
      instanceSnapshotReceived,
      activeInstanceIds: instanceList.map(instance => instance.instanceId),
    });
  }

  async function syncOutboxView() {
    outboxSyncRequested = true;
    if (outboxSyncPromise) return outboxSyncPromise;
    outboxSyncPromise = (async () => {
      while (outboxSyncRequested) {
        outboxSyncRequested = false;
        await syncOutboxViewOnce();
      }
    })().finally(() => {
      outboxSyncPromise = null;
    });
    return outboxSyncPromise;
  }

  async function syncOutboxViewOnce() {
    if (!await outboxReady) return;
    try {
      let requests = await outboxStore.list();
      let visibleRequests = requests.filter(outboxRequestMatchesView);
      let orphanedRequests = requests.filter(outboxRequestIsOrphaned);
      const visibleRequestIds = new Set(visibleRequests.map(request => request.clientRequestId));
      const orphanedAttemptIds = new Set(orphanedRequests
        .filter(request => !isDefinitelyUnattempted(request))
        .map(request => request.clientRequestId));
      if (isTransportConnected()) {
        await messageOutbox.reconcile({
          shouldReconcile: request => visibleRequestIds.has(request.clientRequestId)
            || orphanedAttemptIds.has(request.clientRequestId),
        });
        requests = await outboxStore.list();
        const remainingIds = new Set(requests.map(request => request.clientRequestId));
        for (const clientRequestId of [...visibleRequestIds, ...orphanedAttemptIds]) {
          if (!remainingIds.has(clientRequestId)) {
            if (!promoteOfflineBubble(clientRequestId)) promoteQueuedBubble(clientRequestId, '');
          }
        }

        if (!currentViewingId && !currentSessionId && !restoringThreadId) {
          const activeInstanceIds = new Set(instanceList.map(instance => instance.instanceId));
          const restorable = requests.find(request => (
            isDefinitelyUnattempted(request)
            && request.payload?.instanceId
            && !request.payload?.threadId
            && activeInstanceIds.has(request.payload.instanceId)
          ));
          if (restorable) {
            await restoreProvisionalOutboxTarget(restorable.payload.instanceId);
            requests = await outboxStore.list();
          }
        }

        orphanedRequests = requests.filter(outboxRequestIsOrphaned);
        const unattemptedOrphans = orphanedRequests.filter(isDefinitelyUnattempted);
        if (unattemptedOrphans.length) {
          try {
            const target = await ensureViewTarget();
            for (const request of unattemptedOrphans) {
              await messageOutbox.rebindUnattempted(request.clientRequestId, target);
            }
            requests = await outboxStore.list();
          } catch (error) {
            appendSystem(`消息目标恢复失败：${error.message}`, true);
          }
        }
      }

      visibleRequests = requests.filter(outboxRequestMatchesView);
      orphanedRequests = requests.filter(outboxRequestIsOrphaned);
      const untargetedRequests = visibleRequests.filter(request => (
        isDefinitelyUnattempted(request)
        && !request.payload?.threadId
        && !request.payload?.instanceId
      ));
      if (isTransportConnected() && untargetedRequests.length && !currentSessionId && !currentViewingId) {
        try {
          const target = await ensureViewTarget();
          for (const request of untargetedRequests) {
            await messageOutbox.rebindUnattempted(request.clientRequestId, target);
          }
          requests = await outboxStore.list();
          visibleRequests = requests.filter(outboxRequestMatchesView);
          orphanedRequests = requests.filter(outboxRequestIsOrphaned);
        } catch (error) {
          appendSystem(`消息目标恢复失败：${error.message}`, true);
        }
      }
      const orphanedRequestIds = new Set(orphanedRequests.map(request => request.clientRequestId));
      const displayRequests = requests.filter(request => shouldSurfaceInOutboxView(request, {
        matchesView: outboxRequestMatchesView(request),
        orphaned: orphanedRequestIds.has(request.clientRequestId),
      }));
      for (const request of displayRequests) {
        const renderedState = renderedOutboxStates.get(request.clientRequestId);
        if (renderedState === request.state) continue;
        if (renderedState !== undefined) dropRenderedOutboxBubble(request.clientRequestId);
        const payload = messageWirePayload(request);
        const unboundRecovery = orphanedRequestIds.has(request.clientRequestId);
        // 已失败但属于别的会话的记录也会浮到这里来（否则它会被永久藏起来）。
        // 标出来，免得用户以为是当前会话发的。
        const foreignThread = !outboxRequestMatchesView(request) && !unboundRecovery;
        if (request.state === 'queued' && !unboundRecovery) {
          appendQueuedBubble({ ...payload, ...(request.receipt || {}) }, request.state);
        } else {
          appendOfflineBubble(payload, {
            needsReconcile: request.state === 'needs_reconcile',
            unboundRecovery,
            manualDisposal: requiresManualDisposal(request, { orphaned: unboundRecovery }),
            foreignThread,
            recordState: request.state,
          });
        }
      }

      await drainMessageOutbox({
        shouldSend: outboxRequestMatchesView,
      });
    } catch (error) {
      appendSystem(`消息队列恢复失败：${error.message}`, true);
    }
  }

  syncVisualViewport();
  hydrateIcons();
  window.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('scroll', syncVisualViewport);

  socket.on('connect', () => {
    setConnectionPhase('online');
    lastConnectErrorNotice = '';
    renderConnectionState();
    requestCatchUp();
    startRttMonitor();
  });

  socket.on('disconnect', () => {
    setConnectionPhase('offline');
    renderConnectionState();
    clearRtt();
    appendSystem('已断开连接，尝试重连中...', false);
  });

  socket.on('connect_error', err => {
    setConnectionPhase(socket.connected ? 'online' : 'offline');
    renderConnectionState();
    if (err?.message === 'unauthorized') {
      socket.disconnect();
      authToken = '';
      showAuthPrompt('会话已失效，请重新输入访问口令。');
      return;
    }
    // Socket.IO 断线后会一直重连，每次失败都触发一次 connect_error。逐条往消息区堆
    // 红条会把真实对话挤出视野（实测断线 53 秒堆了 9 条），而横幅已经在显示「自动
    // 重连中」并计时——那才是这件事该待的地方。同一个错误只报一次，连上后复位，
    // 下次断线仍会提示。
    const message = err?.message || 'unknown';
    if (message === lastConnectErrorNotice) return;
    lastConnectErrorNotice = message;
    appendSystem(`连接失败：${message}`, true);
  });

  window.addEventListener('offline', () => {
    setConnectionPhase('offline');
    renderConnectionState();
  });
  window.addEventListener('online', () => {
    setConnectionPhase(socket.connected ? 'online' : 'connecting');
    renderConnectionState();
    if (socket.connected) syncOutboxView();
    else socket.connect();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    paintConnectionBanner();
    if (!socket.connected) socket.connect();
  });

  socket.on('agent:event', processAgentEvent);

  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    const nextToken = authTokenInput.value.trim();
    if (!nextToken) {
      showAuthPrompt('请输入访问口令。');
      return;
    }
    try {
      await establishAuthSession(nextToken);
      authToken = '';
      authTokenInput.value = '';
      connectSocket({ allowEmpty: true });
    } catch (error) {
      showAuthPrompt(error.message || '访问口令不正确，请重试。');
    }
  });

  bootstrapAuth();

  // Redesign - Empty state check helper
  function checkEmptyState() {
    const isEmpty = messagesEl.children.length === 0;
    $('empty-state').style.display = isEmpty ? 'flex' : 'none';
    messagesEl.style.display = isEmpty ? 'none' : 'flex';
    if (isEmpty) {
      followTranscript = true;
      jumpToLatestBtn.hidden = true;
    }
  }

  const storedCliSettings = loadCliSettings(localStorage);
  let selectedModel = storedCliSettings.model || '';
  let selectedReasoning = storedCliSettings.effort || '';
  let selectedServiceTier = storedCliSettings.serviceTier || '';
  let selectedApproval = storedCliSettings.approvalPolicy || '';
  // null = 未启用细粒度，走三个字符串档；对象 = 五个开关整体替换 approvalPolicy。
  let granularApproval = null;
  // 本轮的客观素材：聚合 diff 与已结束的命令。turn 结束时汇总成验收摘要后清空。
  let turnDiff = '';
  let turnCommands = [];
  let selectedSandbox = storedCliSettings.sandbox || '';
  let selectedMode = storedCliSettings.collaborationMode || '';
  let availableModels = [];

  const miInput = $('model-input');
  if (miInput && selectedModel) miInput.value = selectedModel;
  const permSelect = $('perm-select');
  if (permSelect) permSelect.value = selectedApproval;

  function displayModelId() {
    return selectedModel || resolveSelectedModel('', availableModels);
  }

  function currentModelRecord() {
    const id = displayModelId();
    return availableModels.find(model => (model.model || model.id) === id)
      || { model: id, displayName: id };
  }

  function modelsForPicker() {
    const visible = visibleModels(availableModels);
    if (selectedModel && !visible.some(model => (model.model || model.id) === selectedModel)) {
      return [{ model: selectedModel, displayName: selectedModel }, ...visible];
    }
    return visible;
  }

  function currentTurnSettings() {
    return sanitizeTurnOverrides({
      model: selectedModel,
      effort: selectedReasoning,
      approvalPolicy: selectedApproval,
      granularApproval: granularApproval,
      sandbox: selectedSandbox,
      serviceTier: selectedServiceTier,
      collaborationMode: selectedMode,
    });
  }

  // currentTurnSettings 只保留用户显式选过的值（持久化用它，避免把服务端默认固化进
  // localStorage）；显示与发送一律走这个补齐过的版本，两边才不会各说各话。
  function effectiveTurnSettings() {
    return effectiveComposerSettings(currentTurnSettings(), {
      status: sessionStatus,
      models: availableModels,
    });
  }

  // 覆盖值存在浏览器里，服务端要到 turn/start 才见到——那时再通知已经晚了，所以由这里上报。
  function reportPolicyChange(summary) {
    if (!isTransportConnected()) return;
    socket.emit('policy:changed', {
      summary,
      approvalPolicy: selectedApproval || null,
      sandbox: selectedSandbox || null,
      granular: granularApproval !== null,
    }, () => {});
  }

  function persistComposerSettings() {
    saveCliSettings(localStorage, currentTurnSettings());
    if (miInput) miInput.value = selectedModel;
    if (permSelect) permSelect.value = selectedApproval;
  }

  function applyCollaborationMode(mode) {
    const next = normalizeCollaborationMode(mode);
    if (!next) return;
    selectedMode = next;
    persistComposerSettings();
    renderCliSettingsPopovers();
    if (!isTransportConnected()) return;
    socket.emit('thread:collaborationMode', withTarget({
      mode: next,
      cwd: serverCwd,
    }, viewTarget()), ack => {
      if (!ack?.ok) {
        appendSystem(ack?.error || '切换会话模式失败', true);
        return;
      }
      if (ack.mode) selectedMode = ack.mode;
      persistComposerSettings();
      renderCliSettingsPopovers();
    });
  }

  function popoverIconHtml(item) {
    if (item.iconName) return icon(item.iconName);
    // 几何符(●○✓⚪)保留为文本;其余未知字符串转义后显示,避免 XSS。
    if (item.icon) return escHtml(item.icon);
    return '';
  }

  function renderPopoverItems(container, items, dataAttr, selectedId) {
    if (!container) return;
    container.innerHTML = items.map(item => `
      <div class="popover-item${item.id === selectedId ? ' selected' : ''}" data-${dataAttr}="${escHtml(item.id)}">
        <span class="popover-item-icon">${popoverIconHtml(item)}</span>
        <div class="popover-item-details">
          <span class="popover-item-title">${escHtml(item.title)}</span>
          ${item.desc ? `<span class="popover-item-desc">${escHtml(item.desc)}</span>` : ''}
        </div>
        <span class="popover-item-check">✓</span>
      </div>
    `).join('');
  }

  function renderCliSettingsPopovers() {
    const modelRecord = currentModelRecord();
    const effective = effectiveTurnSettings();
    syncAttachAffordance(modelRecord);
    renderPopoverItems($('approval-list'), APPROVAL_OPTIONS, 'approval', effective.approvalPolicy);
    renderPopoverItems($('sandbox-list'), SANDBOX_OPTIONS, 'sandbox', effective.sandbox);
    renderPopoverItems(
      $('granular-list'),
      GRANULAR_APPROVAL_KEYS.map(item => ({
        ...item,
        iconName: granularApproval?.[item.id] === true ? 'shield' : 'hand',
      })),
      'granular',
      null,
    );
    for (const node of $('granular-list')?.querySelectorAll('[data-granular]') || []) {
      node.classList.toggle('selected', granularApproval?.[node.dataset.granular] === true);
    }
    renderPopoverItems(
      $('model-list'),
      modelsForPicker().map(model => ({
        id: model.model || model.id,
        title: model.displayName || model.model || model.id,
        desc: model.model || model.id,
        iconName: model.isDefault ? 'star' : 'bot',
      })),
      'model',
      displayModelId(),
    );
    renderPopoverItems(
      $('reasoning-list'),
      reasoningOptionsForModel(modelRecord).map(option => ({
        ...option,
        icon: option.id === effective.effort ? '●' : '○',
      })),
      'reasoning',
      effective.effort,
    );
    const tiers = serviceTiersForModel(modelRecord);
    const speedLabel = $('speed-section-label');
    const speedList = $('speed-list');
    if (speedLabel) speedLabel.hidden = tiers.length === 0;
    if (speedList) {
      speedList.hidden = tiers.length === 0;
      renderPopoverItems(
        speedList,
        tiers.map(tier => ({
          id: tier.id,
          title: tier.name || tier.id,
          desc: tier.description || '',
          iconName: /fast|priority/i.test(`${tier.id} ${tier.name}`) ? 'zap' : 'circle',
        })),
        'speed',
        effective.serviceTier,
      );
    }
    const bypassList = $('bypass-list');
    if (bypassList) {
      const active = selectedApproval === 'never' && selectedSandbox === 'danger-full-access';
      bypassList.innerHTML = `
        <div class="popover-item${active ? ' selected' : ''}" data-bypass="1">
          <span class="popover-item-icon">${icon('skull')}</span>
          <div class="popover-item-details">
            <span class="popover-item-title">绕过批准和沙箱</span>
            <span class="popover-item-desc">对应 --dangerously-bypass-approvals-and-sandbox</span>
          </div>
          <span class="popover-item-check">✓</span>
        </div>`;
    }
    updateFloatingBadges();
  }

  // 模型不收图片就把入口禁掉并说明原因——让用户选完照片、上传完再失败，是最差的顺序。
  function syncAttachAffordance(modelRecord) {
    if (!attachBtn) return;
    const accepts = modelAcceptsImages(modelRecord);
    attachBtn.disabled = !accepts;
    attachBtn.title = accepts
      ? '添加附件'
      : `${modelRecord?.displayName || modelRecord?.model || '当前模型'} 不接受图片输入`;
  }

  function applyComposerModel(modelId) {
    selectedModel = modelId;
    const record = currentModelRecord();
    selectedReasoning = clampEffortForModel(selectedReasoning, record);
    selectedServiceTier = clampServiceTierForModel(selectedServiceTier, record);
    persistComposerSettings();
    renderCliSettingsPopovers();
  }

  function loadComposerModels() {
    renderCliSettingsPopovers();
    if (!socket.connected) return;
    socket.emit('models:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return;
      availableModels = ack.models || [];
      if (selectedModel) {
        selectedModel = resolveSelectedModel(selectedModel, availableModels);
        const record = currentModelRecord();
        if (selectedReasoning) selectedReasoning = clampEffortForModel(selectedReasoning, record);
        if (selectedServiceTier) selectedServiceTier = clampServiceTierForModel(selectedServiceTier, record);
        persistComposerSettings();
      }
      renderCliSettingsPopovers();
    });
  }

  function updateFloatingBadges() {
    const permTextEl = $('perm-trigger-text');
    if (permTextEl) {
      permTextEl.textContent = formatComposerPermission({
        approvalPolicy: selectedApproval || sessionStatus?.approvalPolicy || '',
        sandbox: selectedSandbox || sessionStatus?.sandbox || '',
      });
    }

    const modelTextEl = $('model-trigger-text');
    const record = currentModelRecord();
    if (modelTextEl) {
      modelTextEl.textContent = formatComposerModel({
        model: displayModelId(),
        displayName: record.displayName,
      }) || '模型';
    }

    const effortText = formatComposerEffort(selectedReasoning);
    const effortWrap = $('effort-trigger');
    const effortTextEl = $('effort-trigger-text');
    if (effortTextEl) effortTextEl.textContent = effortText;
    if (effortWrap) effortWrap.hidden = !effortText;

    const modeWrap = $('mode-trigger');
    const modeTextEl = $('mode-trigger-text');
    const modeId = normalizeCollaborationMode(selectedMode);
    if (modeTextEl) modeTextEl.textContent = formatComposerMode(modeId);
    if (modeWrap) modeWrap.hidden = modeId !== 'plan';

    const defaults = $('composer-defaults');
    if (defaults) {
      defaults.title = [
        formatComposerModel({ model: displayModelId(), displayName: record.displayName }) || '模型',
        formatPermissionBadge({
          approvalPolicy: selectedApproval || sessionStatus?.approvalPolicy || '',
          sandbox: selectedSandbox || sessionStatus?.sandbox || '',
        }),
        formatModelBadge({
          model: displayModelId(),
          effort: selectedReasoning,
          serviceTier: selectedServiceTier,
          displayName: record.displayName,
        }),
      ].filter(Boolean).join('\n');
    }

    const visibleMode = normalizeCollaborationMode(selectedMode) || 'default';
    document.querySelectorAll('#mode-list .popover-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.mode === visibleMode);
    });
  }

  const sessionSettings = $('session-settings');
  function openSessionSettings() {
    if (sessionSettings) sessionSettings.hidden = false;
  }
  function closeSessionSettings() {
    if (sessionSettings) sessionSettings.hidden = true;
  }
  $('composer-defaults')?.addEventListener('click', event => {
    event.stopPropagation();
    if (sessionSettings?.hidden === false) closeSessionSettings();
    else openSessionSettings();
  });
  $('session-settings-close')?.addEventListener('click', closeSessionSettings);
  sessionSettings?.addEventListener('click', event => {
    if (event.target === sessionSettings) closeSessionSettings();
  });

  $('approval-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-approval]');
    if (!item) return;
    selectedApproval = item.dataset.approval;
    persistComposerSettings();
    renderCliSettingsPopovers();
  });
  $('sandbox-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-sandbox]');
    if (!item) return;
    selectedSandbox = item.dataset.sandbox;
    persistComposerSettings();
    renderCliSettingsPopovers();
  });
  $('bypass-list')?.addEventListener('click', event => {
    if (!event.target.closest('[data-bypass]')) return;
    selectedApproval = 'never';
    selectedSandbox = 'danger-full-access';
    persistComposerSettings();
    renderCliSettingsPopovers();
  });
  $('granular-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-granular]');
    if (!item) return;
    const key = item.dataset.granular;
    // 第一次点开任意一项就进入细粒度模式；全部关掉则退回三个字符串档，不留一个五项全 false
    // 的空壳——那等于把审批全关，而用户以为自己只是取消了勾选。
    const next = { ...(granularApproval || {}) };
    next[key] = !next[key];
    granularApproval = GRANULAR_APPROVAL_KEYS.some(({ id }) => next[id]) ? next : null;
    persistComposerSettings();
    renderCliSettingsPopovers();
    reportPolicyChange(granularApproval ? '细粒度审批' : '审批档');
  });
  $('approval-reset')?.addEventListener('click', () => {
    // 协议里策略覆盖的语义是 for this turn and subsequent turns，会一直继承。没有这个入口，
    // 为一个任务临时调松之后所有任务都是松的，而用户不会察觉。
    selectedApproval = '';
    selectedSandbox = '';
    granularApproval = null;
    persistComposerSettings();
    renderCliSettingsPopovers();
    reportPolicyChange('恢复宿主机默认');
  });
  $('model-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-model]');
    if (!item) return;
    applyComposerModel(item.dataset.model);
  });
  $('reasoning-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-reasoning]');
    if (!item) return;
    selectedReasoning = item.dataset.reasoning;
    persistComposerSettings();
    renderCliSettingsPopovers();
  });
  $('speed-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-speed]');
    if (!item) return;
    const next = item.dataset.speed || '';
    selectedServiceTier = next;
    persistComposerSettings();
    renderCliSettingsPopovers();
  });

  $('mode-list')?.addEventListener('click', event => {
    const item = event.target.closest('[data-mode]');
    if (!item) return;
    applyCollaborationMode(item.dataset.mode);
  });

  renderCliSettingsPopovers();

  // Redesign - Slash Autocomplete trigger & control
  const slashPopup = $('slash-popup');
  inputEl.addEventListener('input', () => {
    const val = inputEl.value;
    if (val === '/') {
      showSlashPopup();
    } else if (val.startsWith('/') && !val.includes(' ')) {
      const query = val.slice(1).toLowerCase();
      let hasMatch = false;
      document.querySelectorAll('.slash-item').forEach(item => {
        const cmd = item.dataset.cmd.slice(1).toLowerCase();
        if (cmd.includes(query)) {
          item.style.display = 'flex';
          hasMatch = true;
        } else {
          item.style.display = 'none';
        }
      });
      if (hasMatch) showSlashPopup();
      else hideSlashPopup();
    } else {
      hideSlashPopup();
    }
    scheduleAtMention(val);
  });

  function showSlashPopup() { slashPopup.classList.add('show'); }
  function hideSlashPopup() { slashPopup.classList.remove('show'); }

  function hideAtMentionPopup() {
    atMentionReqId += 1;
    if (atMentionPopup) {
      atMentionPopup.classList.remove('show');
      atMentionPopup.hidden = true;
      atMentionPopup.innerHTML = '';
    }
  }

  function scheduleAtMention(value) {
    const cursor = inputEl.selectionStart ?? value.length;
    const hit = detectAtMentionQuery(value.slice(0, cursor));
    if (!hit) {
      hideAtMentionPopup();
      return;
    }
    hideSlashPopup();
    const reqId = ++atMentionReqId;
    if (atMentionPopup) {
      atMentionPopup.hidden = false;
      atMentionPopup.classList.add('show');
      atMentionPopup.innerHTML = '<div class="at-mention-item">查找文件…</div>';
    }
    socket.emit('files:search', { cwd: serverCwd, query: hit.query }, ack => {
      if (reqId !== atMentionReqId) return;
      const paths = ack?.ok ? (ack.paths || []) : [];
      if (!atMentionPopup) return;
      if (!paths.length) {
        atMentionPopup.innerHTML = `<div class="at-mention-item">${escHtml(ack?.ok ? '没有匹配的文件' : (ack?.error || '无法搜索文件'))}</div>`;
        return;
      }
      atMentionPopup.innerHTML = paths.map(path => (
        `<button type="button" class="at-mention-item" data-path="${escHtml(path)}">${escHtml(path)}</button>`
      )).join('');
    });
  }

  atMentionPopup?.addEventListener('mousedown', event => event.preventDefault());
  atMentionPopup?.addEventListener('click', event => {
    const item = event.target.closest('[data-path]');
    if (!item) return;
    const cursor = inputEl.selectionStart ?? inputEl.value.length;
    const hit = detectAtMentionQuery(inputEl.value.slice(0, cursor));
    if (!hit) return;
    const next = applyAtMentionPick(inputEl.value, {
      matchStart: hit.matchStart,
      cursorPos: cursor,
      path: item.dataset.path,
    });
    inputEl.value = next.text;
    inputEl.setSelectionRange(next.cursorPos, next.cursorPos);
    addInputPart(mentionPartFromSearchHit(item.dataset.path, serverCwd));
    hideAtMentionPopup();
    applyComposerMode();
  });

  document.querySelectorAll('.slash-item').forEach(item => {
    item.onclick = () => {
      const cmd = item.dataset.cmd;
      hideSlashPopup();
      const modeSlash = parseCollaborationModeSlash(cmd);
      if (modeSlash) {
        applyCollaborationMode(modeSlash.mode);
        inputEl.value = '';
        applyComposerMode();
        return;
      }
      inputEl.value = cmd + ' ';
      inputEl.focus();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
    };
  });

  // Hide popup on click outside
  document.addEventListener('click', e => {
    if (!slashPopup.contains(e.target) && e.target !== inputEl) {
      hideSlashPopup();
    }
    if (atMentionPopup && !atMentionPopup.contains(e.target) && e.target !== inputEl) {
      hideAtMentionPopup();
    }
  });

  // Empty state Suggestion cards
  document.querySelectorAll('.suggestion-card').forEach(card => {
    card.onclick = () => {
      inputEl.value = card.dataset.prompt || card.dataset.cmd || '';
      sendMessage();
    };
  });

  function processAgentEvent(ev) {
    if (!ev || typeof ev.type !== 'string') return;
    if (activeRecovery && bufferRecoveryEvent(activeRecovery, ev)) return;
    if (!eventMatchesTarget(ev, viewTarget())) return;
    const boundTarget = bindThreadFromEvent(viewTarget(), ev);
    if (boundTarget.threadId !== currentSessionId) {
      rememberCurrentThread(boundTarget.threadId);
    }
    if (ev.seq > 0 && ev.epoch && ev.epoch !== 'server') {
      const key = `${ev.instanceId || 'global'}:${ev.epoch}:${ev.seq}`;
      if (seenEvents.has(key)) return;
      seenEvents.add(key);
      if (seenEvents.size > 1200) seenEvents = new Set([...seenEvents].slice(-600));
      if (ev.sessionId) {
        rememberCurrentThread(ev.sessionId);
        localStorage.setItem(`codex_last_seq:${ev.sessionId}`, String(ev.seq));
        localStorage.setItem(`codex_last_epoch:${ev.sessionId}`, ev.epoch);
      }
    }

    if (ev.type === 'text_delta' || ev.type === 'tool_use' || ev.type === 'tool_output_delta') hideTyping();
    if (ev.type === 'result' || ev.type === 'error') hideTyping();

    switch (ev.type) {
      case 'device_status':
        handleDeviceStatus(ev.payload);
        break;
      case 'init':
        handleInit(ev.payload, ev);
        break;
      case 'status':
        handleStatus(ev.payload);
        break;
      case 'status_line':
        handleStatusLine(ev.payload);
        break;
      case 'instances':
        handleInstances(ev.payload);
        break;
      case 'thread_event':
        handleThreadEvent(ev.payload);
        break;
      case 'thread_status':
        handleThreadStatus(ev.payload);
        break;
      case 'collaboration_mode':
        if (ev.payload?.mode) {
          selectedMode = ev.payload.mode;
          persistComposerSettings();
          renderCliSettingsPopovers();
        }
        break;
      case 'user_message':
        finalizeStream();
        finishAssistantTurn();
        appendUserBubble(ev.payload.text, ev.payload.attachments, ev.payload.parts, ev.payload.clientRequestId);
        break;
      case 'message_receipt':
        messageOutbox.acceptReceipt(ev.payload).catch(error => {
          appendSystem(`消息确认保存失败：${error.message}`, true);
        });
        break;
      case 'queued_message':
        appendQueuedBubble(ev.payload);
        break;
      case 'dequeued_message':
        markQueuedBubble(ev.payload.clientRequestId, ev.payload.text, '发送中');
        break;
      case 'queue_cleared':
        handleQueueCleared(ev.payload);
        break;
      case 'text_delta':
        appendTextDelta(ev.payload.text);
        break;
      case 'tool_use':
        handleToolUse(ev.payload);
        break;
      case 'tool_output_delta':
        handleToolOutputDelta(ev.payload);
        break;
      case 'term_output':
        handleP3TerminalOutput(ev.payload);
        break;
      case 'term_exit':
        handleP3TerminalExit(ev.payload);
        break;
      case 'tool_result':
        handleToolResult(ev.payload);
        break;
      case 'approval_request':
        handleApprovalRequest(ev.payload, ev);
        break;
      case 'user_input_request':
        handleUserInputRequest(ev.payload, ev);
        break;
      case 'approval_revoked':
        handleApprovalRevoked(ev.payload);
        break;
      case 'needs_you_changed':
        handleNeedsYouChanged(ev.payload);
        break;
      case 'file_change':
        handleFileChange(ev.payload);
        break;
      case 'plan':
        handlePlan(ev.payload);
        break;
      case 'reasoning':
        appendReasoning(ev.payload);
        break;
      case 'account_login':
      case 'account_updated':
        break;
      case 'compact':
        handleCompact(ev.payload);
        break;
      case 'rollback':
        handleRollback(ev.payload);
        break;
      case 'rate_limits':
        handleRateLimits(ev.payload);
        break;
      case 'mcp_status':
        handleMcpStatus(ev.payload);
        break;
      case 'skills_changed':
        handleSkillsChanged(ev.payload);
        break;
      case 'external_agent_config_import':
        handleExternalAgentConfigImport(ev.payload);
        break;
      case 'realtime':
        handleP3Realtime(ev.payload);
        break;
      case 'remote_control':
        handleP3RemoteControl(ev.payload);
        break;
      case 'mcp_use':
        handleMcpUse(ev.payload);
        break;
      case 'mcp_result':
        handleMcpResult(ev.payload);
        break;
      case 'search':
        handleSearch(ev.payload);
        break;
      case 'diff':
        handleDiff(ev.payload);
        break;
      case 'result':
        handleResult(ev.payload);
        break;
      case 'error':
        finalizeStream();
        finishAssistantTurn();
        announceTurnComplete('回复失败');
        appendError(ev.payload.message);
        setBusy(false);
        break;
      case 'system':
        appendSystem(ev.payload.message, ev.payload.isError);
        break;
      case 'pending_devices':
        handlePendingDevices(ev.payload);
        break;
      case 'usage':
        handleUsage(ev.payload);
        break;
      case 'raw_item':
        handleRawItem(ev.payload);
        break;
      default:
        handleRawItem({ envelopeType: ev.type, item: ev.payload });
        break;
    }
  }

  async function bootstrapAuth() {
    if (authToken) {
      try {
        await establishAuthSession(authToken);
        authToken = '';
        connectSocket({ allowEmpty: true });
      } catch (error) {
        authToken = '';
        showAuthPrompt(error.message || '访问口令不正确，请重新输入。');
      }
      return;
    }
    sessionMetaEl.textContent = 'checking auth...';
    try {
      const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin' });
      if (response.ok) {
        connectSocket({ allowEmpty: true });
        return;
      }
      if (response.status === 401) {
        // 会话在服务端是内存态，重启即失效。已注册设备手里有专属凭证，应当静默续期，
        // 而不是每次重启都让人重新输一遍口令——那正是「口令必须长期留在手边」的成因。
        if (localStorage.getItem('codex_device_secret')) {
          try {
            await establishAuthSession('');
            connectSocket({ allowEmpty: true });
            return;
          } catch { /* 凭证已被撤销，落回口令输入 */ }
        }
        showAuthPrompt();
        return;
      }
      showAuthPrompt('无法确认认证状态，请输入访问口令。');
    } catch {
      showAuthPrompt('无法确认认证状态，请输入访问口令。');
    }
  }

  // 已注册设备优先用服务端签发的专属凭证，只有拿不到时才回落到注册口令。这样维护者轮换
  // 注册口令时只会阻断新设备，不会把这台设备踢下线。
  async function establishAuthSession(token) {
    const deviceSecret = localStorage.getItem('codex_device_secret');
    const headers = { 'x-device-token': deviceToken };
    if (deviceSecret && !token) headers['x-device-secret'] = deviceSecret;
    else headers['x-auth-token'] = token || '';

    const response = await fetch('/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
    });
    if (!response.ok) throw new Error('访问口令不正确，请重试。');
    const body = await response.json();
    // 只在注册那一次会回签。凭证泄露的代价与 deviceToken 相同，两者已经并列存在同一处。
    if (typeof body?.deviceSecret === 'string') {
      localStorage.setItem('codex_device_secret', body.deviceSecret);
    }
    return body;
  }

  function showAuthPrompt(message = '') {
    authGate.classList.add('show');
    authError.textContent = message;
    stateLabel.textContent = 'auth';
    sessionMetaEl.textContent = '需要访问口令';
    setTimeout(() => authTokenInput.focus(), 0);
  }

  function hideAuthPrompt() {
    authGate.classList.remove('show');
    authError.textContent = '';
  }

  function connectSocket({ allowEmpty = false } = {}) {
    void allowEmpty;
    socket.auth = { deviceToken };
    hideAuthPrompt();
    sessionMetaEl.textContent = 'connecting...';
    renderConnectionState();
    socket.connect();
  }

  function handleDeviceStatus(payload) {
    if (payload.status === 'pending') {
      deviceAuth.classList.add('show');
    } else if (payload.status === 'approved') {
      deviceAuth.classList.remove('show');
    } else if (payload.status === 'denied') {
      deviceAuth.classList.add('show');
      deviceIdDisplay.textContent = '已被拒绝';
    }
  }

  function handleInit(payload, event) {
    applyFeatureManifest(payload.features);
    gatewayEpoch = payload.gatewayEpoch || gatewayEpoch;
    serverCwd = payload.cwd || serverCwd;
    const incomingInstanceId = event?.instanceId || payload.instanceId || null;
    const savedThreadId = getCurrentThread(localStorage, serverCwd);
    const acceptsIncomingTarget = Boolean(incomingInstanceId)
      && (incomingInstanceId === currentViewingId || (savedThreadId && savedThreadId === payload.sessionId));
    if (acceptsIncomingTarget) {
      currentViewingId = incomingInstanceId;
      rememberCurrentThread(payload.sessionId);
    } else if (!currentViewingId) {
      currentViewingId = null;
      currentSessionId = savedThreadId;
    }
    versions = payload.versions || versions || {};
    if (payload.workDirs?.length) {
      workDirs = payload.workDirs;
      renderWorkdirSelect();
    }

    loadComposerModels();

    renderSessionMeta();
    expandedDirs = loadExpandedDirs(localStorage, serverCwd);
    renderDrawerProject();
    renderDrawerProjects();
    renderInstanceTabs();
    updateFloatingBadges();
    if (socket.connected) refreshNativeThreads();
    if (!restoreCurrentThreadFromPreference()) syncOutboxView();
    requestNeedsYouSnapshot();
    checkEmptyState();
  }

  function requestNeedsYouSnapshot() {
    if (!socket.connected) return;
    socket.emit('needs-you:snapshot', {}, ack => {
      if (!ack?.ok || !Number.isFinite(ack.revision) || ack.revision < needsYouRevision) return;
      needsYouRevision = ack.revision;
      needsYou = new Map((ack.needs || []).map(need => [need.needId, need]));
      renderNeedsYouPanel();
      openPendingNeedsYouDeepLink();
    });
  }

  function handleNeedsYouChanged(payload) {
    const need = payload?.need;
    if (!need?.needId || !Number.isFinite(payload?.revision) || payload.revision < needsYouRevision) return;
    needsYouRevision = payload.revision;
    if (need.state === 'pending' || need.state === 'unknown') needsYou.set(need.needId, need);
    else needsYou.delete(need.needId);
    if (need.state === 'unknown') {
      markNeedCardUnknown(need.needId);
    } else if (need.state !== 'pending') {
      const card = pendingApprovalCards[need.needId];
      if (card) {
        delete pendingApprovalCards[need.needId];
        const actions = card.querySelector('.approval-btns:last-child');
        // 按真实原因写文案：超时与被撤销都不是「在其他设备处理」，那句话会把用户
        // 支使到另一台设备上去找根本不存在的操作记录。
        if (actions) {
          actions.innerHTML = `<span class="tool-output tool-ok" style="background:transparent;padding:0;">${escHtml(needResolutionLabel(need.state))}</span>`;
        }
      }
    }
    renderNeedsYouPanel();
    openPendingNeedsYouDeepLink();
  }

  function openPendingNeedsYouDeepLink() {
    if (!pendingNeedsYouDeepLink) return;
    const need = needsYou.get(pendingNeedsYouDeepLink.needId);
    if (!need || need.state !== 'pending' || need.target?.threadId !== pendingNeedsYouDeepLink.threadId) return;
    pendingNeedsYouDeepLink = null;
    searchParams.delete('thread');
    searchParams.delete('need');
    const nextSearch = searchParams.toString();
    history.replaceState(null, '', `${location.pathname}${nextSearch ? '?' + nextSearch : ''}${location.hash}`);
    openNeed(need);
  }

  function renderNeedsYouPanel() {
    if (!needsYouPanel) return;
    const active = [...needsYou.values()].filter(need => need.state === 'pending' || need.state === 'unknown');
    if (!active.length) {
      needsYouPanel.hidden = true;
      needsYouPanel.innerHTML = '';
      return;
    }
    needsYouPanel.hidden = false;
    needsYouPanel.innerHTML = `<div class="needs-you-heading"><span>需要你</span><span>${active.length}</span></div>`
      + active.map(need => {
        const summary = need.kind === 'question'
          ? (need.payload?.questions?.[0]?.question || 'Codex 有问题等待回答')
          : (Array.isArray(need.payload?.command) ? need.payload.command.join(' ') : (need.payload?.command || need.payload?.reason || '有操作等待审批'));
        const action = need.state === 'unknown'
          ? '<span class="tool-output tool-err" style="background:transparent;padding:0;">结果未知，等待上游终态</span>'
          : '<button class="native-mini-btn" type="button" data-need-action="open">处理</button>';
        return `<div class="needs-you-row" data-need-id="${escHtml(need.needId)}">
          <div class="needs-you-copy">
            <div class="needs-you-summary">${escHtml(summary)}</div>
            <div class="needs-you-thread">${escHtml(need.target?.threadId || '')}</div>
          </div>
          ${action}
        </div>`;
      }).join('');
    needsYouPanel.querySelectorAll('[data-need-action="open"]').forEach(button => {
      button.onclick = () => openNeed(needsYou.get(button.closest('[data-need-id]')?.dataset.needId));
    });
  }

  function openNeed(need) {
    if (!need?.target?.threadId || need.state !== 'pending') return;
    const thread = appThreads.find(item => item.id === need.target.threadId);
    socket.emit('thread:select', {
      threadId: need.target.threadId,
      cwd: thread?.cwd || serverCwd,
      title: thread?.title || need.target.threadId.slice(0, 8),
    }, ack => {
      if (!applyTargetAck(ack)) {
        appendSystem(ack?.error || '需要你目标已失效', true);
        return;
      }
      clearMessages();
      const payload = { ...need.payload, needId: need.needId };
      const event = { instanceId: need.target.instanceId, sessionId: need.target.threadId };
      if (need.kind === 'question') handleUserInputRequest(payload, event);
      else handleApprovalRequest(payload, event);
    });
  }

  function markNeedCardUnknown(needId) {
    const card = pendingApprovalCards[needId];
    if (!card) return;
    delete pendingApprovalCards[needId];
    const actions = card.querySelector('.approval-btns:last-child');
    if (actions) {
      actions.innerHTML = '<span class="tool-output tool-err" style="background:transparent;padding:0;">结果未知，等待上游终态</span>';
    }
  }

  function applyFeatureManifest(manifest) {
    features = { labs: manifest?.labs === true };
    // 宿主配置不再是特性开关，入口常驻；Labs 仍受实验开关控制。
    const labsButton = $('native-p3-btn');
    if (labsButton) labsButton.hidden = !features.labs;
  }

  function renderWorkdirSelect() {
    const sel = document.getElementById('workdir-select');
    const container = document.getElementById('workdir-container');
    if (container) container.hidden = true;
    if (sel && workDirs.length) {
      sel.innerHTML = workDirs.map(d => {
        const name = d.split('/').pop() || d;
        return `<option value="${escHtml(d)}"${d === serverCwd ? ' selected' : ''}>${escHtml(name)}</option>`;
      }).join('');
      sel.onchange = () => handleWorkdirChange(sel.value);
    }
    renderDrawerProject();
    renderDrawerProjects();
  }

  function renderDrawerProject() {
    const name = projectLabel(serverCwd) || '项目';
    const headerProject = $('header-project');
    if (headerProject) {
      headerProject.textContent = name;
      headerProject.title = serverCwd || '';
    }
    const emptyProject = $('empty-project');
    if (emptyProject) {
      emptyProject.textContent = name ? `在 ${name}` : '';
      emptyProject.hidden = !name;
    }
    const headerContext = $('header-context');
    if (headerContext) {
      headerContext.title = serverCwd ? `工作区：${serverCwd}` : '浏览工作区文件和改动';
    }
  }

  function rememberExpandedDirs() {
    persistExpandedDirs(localStorage, expandedDirs);
  }

  function applyWorkspace(cwd, { clearChat = true } = {}) {
    if (!cwd) return;
    const changed = cwd !== serverCwd;
    if (changed) {
      serverCwd = cwd;
      restoringThreadId = null;
      activeRecovery = null;
      currentViewingId = null;
      currentSessionId = getCurrentThread(localStorage, serverCwd);
      sessionStatus = null;
      appThreads = sessionsByCwd.get(cwd) || [];
      const sel = $('workdir-select');
      if (sel) sel.value = cwd;
      if (clearChat) clearMessages();
    }
    expandedDirs.add(cwd);
    rememberExpandedDirs();
    renderDrawerProject();
  }

  function toggleDirExpand(cwd) {
    const result = toggleExpandedDir(expandedDirs, cwd);
    expandedDirs = result.set;
    rememberExpandedDirs();
    renderDrawerProjects();
    if (result.expanded) refreshThreadsForCwd(cwd);
  }

  function renderDrawerProjects() {
    const root = $('drawer-projects');
    if (!root) return;
    const dirs = workDirs.length ? workDirs : (serverCwd ? [serverCwd] : []);
    if (!dirs.length) {
      root.innerHTML = '';
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.innerHTML = '';
    for (const dir of dirs) {
      const name = projectLabel(dir) || dir;
      const expanded = expandedDirs.has(dir);
      const current = dir === serverCwd;
      const block = document.createElement('div');
      block.className = 'drawer-project-block' + (current ? ' current' : '') + (expanded ? ' expanded' : '');
      block.innerHTML = `<div class="drawer-project-item${current ? ' active' : ''}" title="${escHtml(dir)}">`
        + `<button type="button" class="dir-toggle" data-cwd="${escHtml(dir)}">`
        + `<span class="project-icon">${icon(expanded ? 'folderOpen' : 'folder')}</span>`
        + `<span class="dir-arrow${expanded ? ' rotated' : ''}">▶</span>`
        + `<span class="dir-name">${escHtml(name)}</span>`
        + `</button>`
        + `<button type="button" class="dir-new" data-new-cwd="${escHtml(dir)}" title="在此工作区新建会话">＋</button>`
        + `</div>`
        + `<div class="dir-subtree${expanded ? ' expanded' : ''}"></div>`;
      root.appendChild(block);
      if (expanded) fillDirSubtree(block.querySelector('.dir-subtree'), dir);
    }
    root.querySelectorAll('.dir-toggle').forEach(btn => {
      btn.onclick = () => toggleDirExpand(btn.dataset.cwd);
    });
    root.querySelectorAll('.dir-new').forEach(btn => {
      btn.onclick = event => {
        event.stopPropagation();
        createNewSession(btn.dataset.newCwd);
        closeDrawer();
      };
    });
  }

  function fillDirSubtree(container, cwd) {
    if (!container) return;
    const threads = (sessionsByCwd.get(cwd) || (cwd === serverCwd ? appThreads : [])).filter(item => item.id);
    if (!threads.length) {
      container.innerHTML = '<div class="session-empty">暂无会话</div>';
      return;
    }
    container.innerHTML = '';
    for (const thread of threads) container.appendChild(createSessionRow(thread));
  }

  function handleWorkdirChange(cwd) {
    if (!cwd || cwd === serverCwd) return;
    applyWorkspace(cwd, { clearChat: true });
    renderDrawerProjects();
    refreshThreadsForCwd(cwd);
  }

  function handleStatus(payload) {
    sessionStatus = payload || null;
    if (payload?.sessionId) {
      rememberCurrentThread(payload.sessionId);
    }
    setBusy(Boolean(payload?.busy));
    renderSessionMeta();
    renderInstanceTabs();
    updateFloatingBadges();
    checkEmptyState();
  }

  function handleStatusLine(payload) {
    updateStatusDetail(payload);
  }

  function handleInstances(payload) {
    instanceList = payload.instances || [];
    instanceSnapshotReceived = true;
    currentViewingId = payload.viewingInstanceId || null;
    renderInstanceTabs();
    syncOutboxView();
  }

  function renderInstanceTabs() {}

  function renderThreadTitle() {
    const titleEl = $('thread-title');
    if (!titleEl) return;
    const name = resolveThreadTitle(appThreads, currentSessionId);
    if (name === null) return;
    titleEl.textContent = name;
  }

  function goHome() {
    closeDrawer();
    currentViewingId = null;
    rememberCurrentThread(null);
    sessionStatus = null;
    restoringThreadId = null;
    activeRecovery = null;
    clearMessages();
    renderSessionMeta();
    renderDrawerProjects();
    applyComposerMode();
  }

  function createNewSession(cwd = serverCwd) {
    if (cwd) applyWorkspace(cwd, { clearChat: false });
    // 停在归档视图里新建会话,新会话不会出现在这份列表中——看起来就像没建成。
    setArchivedThreadsView(false);
    socket.emit('session:new', { cwd: cwd || serverCwd }, ack => {
      if (!applyTargetAck(ack)) {
        appendSystem(ack?.error || '新建会话失败', true);
        return;
      }
      clearMessages();
      renderDrawerProjects();
    });
  }

  // eslint-disable-next-line no-unused-vars -- drawer fork trigger is not in main chrome yet
  function forkCurrentSession() {
    socket.emit('session:fork', { instanceId: currentViewingId }, ack => {
      if (!ack?.ok) {
        appendSystem(ack?.error || '会话分叉失败', true);
        return;
      }
      applyTargetAck(ack);
      clearMessages();
      appendSystem('已分叉当前会话', false);
      refreshNativeThreads();
    });
  }

  function paintHeaderChanges(git) {
    const el = $('header-changes');
    if (!el) return;
    const label = formatWorkspaceChangeBadge(git);
    el.textContent = label;
    el.hidden = !label;
  }

  function updateStatusDetail(payload) {
    if (!payload) {
      statusDetail.textContent = '';
      paintHeaderChanges(null);
      return;
    }
    const parts = [];
    // statusDetail 走 textContent,不能塞 SVG;去掉 emoji,几何符可留。
    if (payload.project) parts.push(escHtml(payload.project));
    if (payload.sandbox) parts.push(escHtml(payload.sandbox));
    if (payload.approvalPolicy) parts.push(`✓ ${escHtml(payload.approvalPolicy)}`);
    if (payload.git) {
      const g = payload.git;
      let gitStr = `⎇ ${escHtml(g.branch || '?')}`;
      if (g.changed) gitStr += ` Δ${g.changed}`;
      if (g.ahead) gitStr += ` ↑${g.ahead}`;
      if (g.behind) gitStr += ` ↓${g.behind}`;
      if (g.insertions || g.deletions) gitStr += ` +${g.insertions}/-${g.deletions}`;
      parts.push(gitStr);
    }
    if (payload.ctx) {
      parts.push(`${(payload.ctx.totalInputTokens / 1000).toFixed(1)}k`);
    }
    if (payload.sessionId) {
      parts.push(`${(payload.sessionId || '').slice(0, 8)}`);
    }
    if (payload.state) {
      parts.push(payload.busy ? '●' : '○');
    }
    if (payload.queueLength > 0) {
      parts.push(`q:${payload.queueLength}`);
    }
    statusDetail.textContent = parts.join(' · ');
    paintHeaderChanges(payload.git);
  }

  function handleThreadEvent(payload) {
    if (!payload?.event) return;
    const labels = { archived: '已归档', unarchived: '已取消归档', deleted: '已删除', name_updated: '已重命名' };
    appendSystem(`Thread ${labels[payload.event] || payload.event}: ${(payload.threadId || '').slice(0, 8)}`, false);
    refreshNativeThreads();
  }

  function handleThreadStatus(payload) {
    if (!payload?.threadId || !payload.status) return;
    const presentation = threadStatusPresentation(payload.status);
    const incomingRevision = Number.isInteger(payload.revision) ? payload.revision : 0;
    const currentRevision = appThreads.find(thread => thread.id === payload.threadId)?.statusRevision || 0;
    const stale = incomingRevision > 0 && currentRevision > incomingRevision;
    appThreads = applyThreadStatus(appThreads, payload);
    for (const [cwd, threads] of sessionsByCwd) {
      sessionsByCwd.set(cwd, applyThreadStatus(threads, payload));
    }
    if (serverCwd && sessionsByCwd.has(serverCwd)) appThreads = sessionsByCwd.get(serverCwd);
    instanceList = instanceList.map(instance => instance.sessionId === payload.threadId
      ? { ...instance, busy: presentation.active, state: presentation.kind }
      : instance);
    if (currentSessionId === payload.threadId && !stale) {
      sessionStatus = {
        ...(sessionStatus || {}),
        threadStatus: payload.status,
        threadStatusRevision: incomingRevision || sessionStatus?.threadStatusRevision || 0,
        busy: presentation.active,
        state: presentation.kind,
      };
      setBusy(presentation.active);
      renderSessionMeta();
    }
    renderInstanceTabs();
    renderSessionList();
    if (payload.scope === 'host') scheduleThreadListRefresh();
  }

  function handleCompact(payload) {
    appendSystem(`上下文压缩完成: ${(payload?.threadId || currentSessionId || '').slice(0, 8)}`, false);
  }

  function handleRollback(payload) {
    appendSystem(`已回退 ${payload?.numTurns || 1} 轮: ${(payload?.threadId || currentSessionId || '').slice(0, 8)}`, false);
  }

  function handleRateLimits(payload) {
    const limit = payload?.rateLimits?.limitName || payload?.rateLimits?.limitId || 'rate limit';
    appendSystem(`Rate limits updated: ${limit}`, false);
  }

  function handleMcpStatus(payload) {
    appendSystem(`MCP ${payload?.name || 'server'}: ${payload?.status || 'updated'}`, Boolean(payload?.error));
  }

  function handleSkillsChanged() {
    appendSystem('Skills changed', false);
  }

  function handleExternalAgentConfigImport(payload) {
    appendSystem(`External config import ${payload?.status || 'updated'}: ${payload?.importId || ''}`, false);
  }

  function handleUsage(payload) {
    const usage = payload?.usage || {};
    const total = usage.totalTokens || usage.total_tokens || usage.total || null;
    if (total) appendSystem(`Token usage: ${total}`, false);
  }

  function renderSessionMeta() {
    const cwd = sessionStatus?.cwd || serverCwd || '';
    const policy = sessionStatus?.approvalPolicy || 'on-request';
    const sandbox = sessionStatus?.sandbox || 'workspace-write';
    const queue = sessionStatus?.queueLength || 0;
    const sid = currentSessionId ? currentSessionId.slice(0, 8) : 'new';
    const codex = versions.codex ? versions.codex.replace(/^codex-cli\s*/, '') : 'codex';
    const path = compactPath(cwd);
    sessionMetaEl.textContent = `${path || 'no workspace'} · ${sandbox} · ${policy} · q:${queue} · ${sid} · ${codex}`;
    const state = sessionStatus?.state || (socket.connected ? 'idle' : 'offline');
    stateLabel.textContent = state.replace('_', ' ');
    renderThreadTitle();
    renderConnectionState();
  }

  function syncVisualViewport() {
    const vv = window.visualViewport;
    const height = vv?.height || window.innerHeight;
    const width = vv?.width || window.innerWidth;
    const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
    document.documentElement.style.setProperty('--app-width', `${Math.round(width)}px`);
    scrollBottom();
  }

  function createSessionRow(s) {
    const el = document.createElement('div');
    el.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
    const date = new Date(s.lastUsedAt || s.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tag = s.model ? ` · ${escHtml(s.model)}` : '';
    const status = threadStatusPresentation(s.status);
    const actions = `<div class="native-row-actions">
          <button class="native-mini-btn" data-action="rename">Rename</button>
          <button class="native-mini-btn" data-action="${s.archived ? 'unarchive' : 'archive'}">${s.archived ? 'Unarchive' : 'Archive'}</button>
          <button class="native-mini-btn native-danger" data-action="delete">Delete</button>
        </div>`;
    el.innerHTML = `<div class="session-title"><span class="thread-status-dot ${status.kind}" title="${escHtml(status.label)}"></span><span class="session-title-copy">${escHtml(s.title || '未命名')}</span></div><div class="session-date">${date}${tag} · ${escHtml(status.label)}</div>${actions}`;
    el.onclick = () => {
      socket.emit('thread:select', { threadId: s.id, cwd: s.cwd, title: s.title }, ack => {
        if (!ack?.ok) {
          appendSystem(ack?.error || 'Thread select failed', true);
          return;
        }
        applyTargetAck(ack);
        clearMessages();
        loadNativeThreadHistory(s);
        renderDrawerProjects();
      });
      closeDrawer();
    };
    for (const btn of el.querySelectorAll('[data-action]')) {
      btn.onclick = event => {
        event.stopPropagation();
        handleNativeThreadAction(s, btn.dataset.action);
      };
    }
    return el;
  }

  function renderSessionList() {
    renderDrawerProjects();
    if (Date.now() - drawerOpenedAt < 1500) resetDrawerScroll();
  }

  async function handleNativeThreadAction(thread, action) {
    if (action === 'rename') {
      const name = await confirmDialog.prompt({ title: '重命名会话', body: '输入新的会话名称', initial: thread.title || '' });
      if (!name) return;
      socket.emit('thread:rename', { threadId: thread.id, name, cwd: thread.cwd }, ack => {
        if (!ack?.ok) return appendSystem(threadActionErrorMessage('rename', ack?.error), true);
        refreshNativeThreads();
      });
      return;
    }
    // archive 和 delete 都会让会话从眼前消失,先按同一份契约拦一道确认。
    const needsConfirm = threadActionConfirm(action);
    if (needsConfirm && !await confirmDialog.confirm(needsConfirm)) return;
    if (action === 'unarchive') {
      socket.emit('thread:unarchive', { threadId: thread.id, cwd: thread.cwd }, ack => {
        if (!ack?.ok) return appendSystem(threadActionErrorMessage('unarchive', ack?.error), true);
        refreshNativeThreads();
      });
      return;
    }
    if (action === 'delete') {
      socket.emit('thread:delete', { threadId: thread.id, cwd: thread.cwd }, ack => {
        if (!ack?.ok) return appendSystem(threadActionErrorMessage('delete', ack?.error), true);
        clearCurrentThread(localStorage, thread.cwd || serverCwd, thread.id);
        if (currentSessionId === thread.id) {
          currentSessionId = null;
          currentViewingId = null;
          clearMessages();
        }
        refreshNativeThreads();
      });
      return;
    }
    socket.emit('thread:archive', { threadId: thread.id, cwd: thread.cwd }, ack => {
      if (!ack?.ok) return appendSystem(threadActionErrorMessage('archive', ack?.error), true);
      refreshNativeThreads();
    });
  }

  function renderNativePanel(title, bodyHtml) {
    nativePanel.hidden = false;
    nativePanel.innerHTML = `<div class="native-panel-header"><span>${escHtml(title)}</span><button class="native-mini-btn" type="button" data-close-native>Close</button></div>${bodyHtml}`;
    const close = nativePanel.querySelector('[data-close-native]');
    if (close) close.onclick = () => { nativePanel.hidden = true; };
  }

  function scheduleThreadListRefresh() {
    if (threadRefreshTimer) clearTimeout(threadRefreshTimer);
    const requestedCwd = serverCwd;
    threadRefreshTimer = setTimeout(() => {
      threadRefreshTimer = null;
      if (socket.connected && requestedCwd === serverCwd) refreshNativeThreads();
    }, 250);
  }

  function refreshThreadsForCwd(cwd, { showPanel = false } = {}) {
    if (!cwd) return;
    // 归档与未归档是两份不同的列表,来回切开关会同时挂起两个请求。响应没有顺序保证,
    // 晚到的那份若不认领自己属于哪个视图,就会盖掉用户已经切回去的列表——
    // 开关写着「未归档」,底下却列着归档会话。同 scheduleThreadListRefresh 的 cwd 校验。
    const requestedArchived = showArchivedThreads;
    socket.emit('thread:list', { cwd, archived: requestedArchived }, ack => {
      if (requestedArchived !== showArchivedThreads) return;
      if (!ack?.ok) {
        if (cwd === serverCwd) appendSystem(ack?.error || 'Thread list failed', true);
        return;
      }
      const next = mergeThreadList(sessionsByCwd.get(cwd) || [], ack.threads || []);
      sessionsByCwd.set(cwd, next);
      if (cwd === serverCwd) appThreads = next;
      renderSessionList();
      if (cwd === serverCwd) {
        if (showPanel) renderNativeThreadList();
        renderThreadTitle();
      }
    });
  }

  function refreshNativeThreads(showPanel = false) {
    if (serverCwd) expandedDirs.add(serverCwd);
    const targets = expandedDirs.size ? [...expandedDirs] : (serverCwd ? [serverCwd] : []);
    for (const cwd of targets) {
      refreshThreadsForCwd(cwd, { showPanel: showPanel && cwd === serverCwd });
    }
  }

  function renderArchivedToggle() {
    const btn = $('drawer-archived-toggle');
    // 名字固定、只翻 aria-pressed:切换按钮的可访问名一旦跟着状态变,读屏念出的
    // 「返回未归档,已按下」就分不清「已按下」说的是哪一头。当前视图由点亮态表达。
    if (btn) btn.setAttribute('aria-pressed', showArchivedThreads ? 'true' : 'false');
  }

  function setArchivedThreadsView(next) {
    if (showArchivedThreads === next) return;
    showArchivedThreads = next;
    // 两份视图的列表不能混用。refreshNativeThreads 只刷展开着的目录,折叠目录会留着
    // 上一份视图的行——归档视图里挂着未归档会话,按钮还写着 Archive。清掉等它们各自拉回来。
    sessionsByCwd.clear();
    appThreads = [];
    renderArchivedToggle();
    refreshNativeThreads();
  }

  function toggleArchivedThreads() {
    setArchivedThreadsView(!showArchivedThreads);
  }

  function renderNativeThreadList() {
    const rows = appThreads.length
      ? appThreads.map(t => `<div class="native-list-row">
          <div class="native-row-title">${escHtml(t.title || t.id)}</div>
          <div class="native-row-meta">${escHtml((t.id || '').slice(0, 8))} · ${escHtml(t.cwd || '')}</div>
        </div>`).join('')
      : '<div class="native-list-row">No native threads</div>';
    renderNativePanel(showArchivedThreads ? 'Archived Threads' : 'Native Threads', rows);
  }

  function startCompact() {
    if (!currentSessionId) {
      appendSystem('No active thread to compact', true);
      return;
    }
    socket.emit('thread:compact', { threadId: currentSessionId, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Compact failed', true);
      appendSystem('Compact requested', false);
    });
  }

  async function rollbackThread() {
    if (!currentSessionId) {
      appendSystem('No active thread to rollback', true);
      return;
    }
    const raw = await confirmDialog.prompt({ title: '回退会话', body: '回退多少轮？', initial: '1' });
    if (raw === null) return;
    const numTurns = Math.max(1, Number.parseInt(raw, 10) || 1);
    socket.emit('thread:rollback', { threadId: currentSessionId, numTurns, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Rollback failed', true);
      appendSystem(`Rollback requested: ${numTurns}`, false);
    });
  }

  function loadNativeModels() {
    socket.emit('models:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Model list failed', true);
      const caps = ack.capabilities || {};
      const modelRows = (ack.models || []).map(model => {
        const id = model.model || model.id || '';
        const name = model.displayName || id;
        return `<div class="native-list-row">
          <div class="native-row-title">${escHtml(name)}</div>
          <div class="native-row-meta">${escHtml(id)}${model.isDefault ? ' · default' : ''}</div>
          <div class="native-row-actions"><button class="native-mini-btn" data-model-id="${escHtml(id)}">Use</button></div>
        </div>`;
      }).join('') || '<div class="native-list-row">No models</div>';
      renderNativePanel('Models', `<div class="native-list-row"><div class="native-row-meta">namespaceTools:${Boolean(caps.namespaceTools)} · image:${Boolean(caps.imageGeneration)} · web:${Boolean(caps.webSearch)}</div></div>${modelRows}`);
      nativePanel.querySelectorAll('[data-model-id]').forEach(btn => {
        btn.onclick = () => {
          applyComposerModel(btn.dataset.modelId);
        };
      });
    });
  }

  function openFileBrowser(path = serverCwd) {
    const targetPath = path || serverCwd || '/';
    socket.emit('fs:readDirectory', { path: targetPath, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Read directory failed', true);
      const parent = parentPath(targetPath);
      const rows = [
        parent ? `<button class="native-mini-btn" data-dir="${escHtml(parent)}">..</button>` : '',
        ...(ack.entries || []).map(entry => {
          const child = joinPath(targetPath, entry.fileName);
          const action = entry.isDirectory ? `data-dir="${escHtml(child)}"` : `data-file="${escHtml(child)}"`;
          return `<div class="native-list-row">
            <div class="native-row-title">${entry.isDirectory ? 'Folder' : 'File'} ${escHtml(entry.fileName)}</div>
            <div class="native-row-actions">
              <button class="native-mini-btn" ${action}>${entry.isDirectory ? 'Open' : '@ 引用'}</button>
              <button class="native-mini-btn native-danger" data-remove="${escHtml(child)}" data-remove-dir="${entry.isDirectory ? '1' : ''}">删除</button>
            </div>
          </div>`;
        })
      ].join('');
      renderNativePanel('Files', `<input class="native-input" value="${escHtml(targetPath)}" data-file-path>${rows || '<div class="native-list-row">Empty directory</div>'}`);
      const pathInput = nativePanel.querySelector('[data-file-path]');
      pathInput.onkeydown = event => {
        if (event.key === 'Enter') openFileBrowser(pathInput.value.trim());
      };
      nativePanel.querySelectorAll('[data-dir]').forEach(btn => {
        btn.onclick = () => openFileBrowser(btn.dataset.dir);
      });
      nativePanel.querySelectorAll('[data-file]').forEach(btn => {
        btn.onclick = () => readNativeFile(btn.dataset.file);
      });
      nativePanel.querySelectorAll('[data-remove]').forEach(btn => {
        btn.onclick = () => removeNativePath(btn.dataset.remove, btn.dataset.removeDir === '1', targetPath);
      });
    });
  }

  // 删除不可逆，手机误触率又远高于桌面，所以走真正的确认框而不是 window.prompt。
  // 目录的 recursive 由这里显式声明——服务端不替用户默认成 true。
  async function removeNativePath(path, isDirectory, refreshFrom) {
    const accepted = await confirmDialog.confirm({
      title: isDirectory ? '删除目录' : '删除文件',
      body: isDirectory
        ? `${path}\n\n将连同目录下的全部内容一起删除，且无法撤销。`
        : `${path}\n\n删除后无法撤销。`,
      danger: true,
    });
    if (!accepted) return;
    socket.emit('fs:remove', { path, recursive: isDirectory, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || '删除失败', true);
      appendSystem(`已删除 ${path}`, false);
      openFileBrowser(refreshFrom);
    });
  }

  function readNativeFile(path) {
    socket.emit('fs:readFile', { path, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Read file failed', true);
      const text = decodeBase64Text(ack.dataBase64 || '');
      addInputPart({ kind: 'mention', name: path.split('/').pop() || path, path });
      inputEl.focus();
      renderNativePanel('File Preview', `<div class="native-list-row">
        <div class="native-row-title">${escHtml(path)}</div>
        <div class="native-row-actions"><button class="native-mini-btn" data-edit-file type="button">编辑</button></div>
        <pre class="tool-output" style="max-height:180px;">${escHtml(text.slice(0, 2000))}</pre>
      </div>`);
      nativePanel.querySelector('[data-edit-file]').onclick = () => editNativeFile(path, text);
    });
  }

  function editNativeFile(path, original) {
    renderNativePanel('编辑文件', `<div class="native-list-row">
      <div class="native-row-title">${escHtml(path)}</div>
      <textarea class="native-input" data-file-editor rows="12" spellcheck="false">${escHtml(original)}</textarea>
      <div class="native-row-actions"><button class="native-mini-btn" data-file-save type="button">保存</button></div>
    </div>`);
    const editor = nativePanel.querySelector('[data-file-editor]');
    nativePanel.querySelector('[data-file-save]').onclick = () => saveNativeFile(path, original, editor.value);
  }

  // R-16：写入前强制看到 diff 再确认。只问「要覆盖吗」不够——用户得能看出改了什么。
  async function saveNativeFile(path, original, next) {
    const summary = summarizeTextChange(original, next);
    if (summary.unchanged) return appendSystem('内容没有变化，未写入', false);
    const preview = summary.hunk.map(line => `${line.sign}${line.text}`).join('\n');
    const accepted = await confirmDialog.confirm({
      title: '写入文件',
      body: [
        path,
        `第 ${summary.firstChangedLine} 行起：+${summary.added} 行 / -${summary.removed} 行`,
        '',
        preview + (summary.truncated ? '\n…（差异过长，仅显示开头）' : ''),
      ].join('\n'),
      danger: true,
    });
    if (!accepted) return;
    const dataBase64 = btoa(unescape(encodeURIComponent(next)));
    socket.emit('fs:writeFile', { path, dataBase64, cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || '写入失败', true);
      appendSystem(`已写入 ${path}`, false);
      readNativeFile(path);
    });
  }

  function loadAccountPanel() {
    socket.emit('account:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Account read failed', true);
      renderNativePanel('Account', `<pre class="tool-output" style="max-height:220px;">${escHtml(JSON.stringify({ account: ack.account, usage: ack.usage, rateLimits: ack.rateLimits }, null, 2))}</pre>`);
    });
  }

  // R-19：把「连不上」拆成六层，并只报最外层的坏点——修好它之前，里层的好坏无从验证。
  function loadHealthPanel() {
    const render = server => {
      const view = diagnoseHealth({
        browserOnline: navigator.onLine !== false,
        gatewayReachable: Boolean(server),
        socketConnected: isTransportConnected(),
        appServerRunning: server?.appServerRunning !== false,
        codexError: server?.codexError || null,
        upstreamError: server?.upstreamError || null,
      });
      const layers = HEALTH_LAYERS.map(name => {
        const reached = !view.layer || HEALTH_LAYERS.indexOf(name) < HEALTH_LAYERS.indexOf(view.layer);
        const mark = view.layer === name ? '✗' : (reached ? '✓' : '·');
        return `<div class="native-list-row"><div class="native-row-title">${mark} ${escHtml(LAYER_LABELS[name])}</div></div>`;
      }).join('');
      renderNativePanel('诊断', `
        <div class="native-list-row">
          <div class="native-row-title">${escHtml(view.title)}</div>
          <div class="native-row-meta">${escHtml(view.detail || '所有层都正常')}</div>
        </div>
        ${layers}
        <div class="native-list-row"><div class="native-row-meta">${escHtml(
          server ? `codex ${server.versions?.codex || '?'} · ${server.instances} 个实例 · ${server.cwd || ''}` : '控制台无响应'
        )}</div></div>`);
    };
    if (!isTransportConnected()) return render(null);
    socket.emit('health:read', { cwd: serverCwd }, ack => render(ack?.ok ? ack : null));
  }

  // D2：手机上要能看清「现在有哪些设备连着」并能踢掉其中一台。列表只拿得到 16 位引用，
  // 撤销走 devices:revoke 由服务端解析——完整 token 不下发到浏览器。
  function loadDevicesPanel() {
    socket.emit('devices:list', {}, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || '设备列表读取失败', true);
      const fmt = ts => (ts ? new Date(ts).toLocaleString() : '—');
      const rows = (ack.devices || []).map(device => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(device.deviceRef)}${device.current ? '（本机）' : ''}</div>
        <div class="native-row-meta">最近活跃 ${escHtml(fmt(device.lastSeenAt))} · 首次接入 ${escHtml(fmt(device.approvedAt))}</div>
        <div class="native-row-meta">${escHtml(device.ip || '来源未知')} · 推送${device.pushSubscribed ? '已订阅' : '未订阅'}</div>
        ${device.current ? '' : `<button class="native-mini-btn native-danger" data-revoke-device="${escHtml(device.deviceRef)}" type="button">撤销</button>`}
      </div>`).join('') || '<div class="native-list-row">暂无已接入设备</div>';
      renderNativePanel('设备', rows);
      for (const button of document.querySelectorAll('[data-revoke-device]')) {
        button.onclick = async () => {
          const deviceRef = button.dataset.revokeDevice;
          // 撤销会立刻断开那台设备并清掉它的推送绑定，不可逆，所以要确认。
          const ok = await confirmDialog.confirm({
            title: '撤销设备',
            body: `${deviceRef} 将立即断开连接，其推送订阅一并失效。需要时可重新注册。`,
            confirmText: '撤销',
            danger: true,
          });
          if (!ok) return;
          socket.emit('devices:revoke', { deviceRef }, res => {
            if (!res?.ok) return appendSystem(res?.error || '撤销失败', true);
            appendSystem(`已撤销设备 ${deviceRef}`);
            loadDevicesPanel();
          });
        };
      }
    });
  }

  function loadMcpPanel() {
    socket.emit('mcp:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'MCP read failed', true);
      const rows = (ack.servers || []).map(server => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(server.name)}</div>
        <div class="native-row-meta">${escHtml(server.authStatus || '')} · tools:${Object.keys(server.tools || {}).length}</div>
      </div>`).join('') || '<div class="native-list-row">No MCP servers</div>';
      renderNativePanel('MCP', rows);
    });
  }

  function loadSkillsPanel() {
    socket.emit('skills:read', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Skills read failed', true);
      const skills = (ack.entries || []).flatMap(entry => (entry.skills || []).map(skill => ({
        ...skill,
        cwd: entry.cwd,
      }))).filter(skill => skill.enabled === true);
      const rows = skills.map((skill, index) => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(skill.name)}</div>
        <div class="native-row-meta">${escHtml(skill.description || skill.path || skill.cwd || '')}</div>
        <div class="native-row-actions"><button class="native-mini-btn" data-skill-index="${index}">Use</button></div>
      </div>`).join('') || '<div class="native-list-row">No enabled skills</div>';
      renderNativePanel('Skills', rows);
      nativePanel.querySelectorAll('[data-skill-index]').forEach(btn => {
        btn.onclick = () => {
          const skill = skills[Number(btn.dataset.skillIndex)];
          if (!skill) return;
          addInputPart({ kind: 'skill', name: skill.name, path: skill.path });
          inputEl.focus();
        };
      });
    });
  }

  function detectExternalAgentConfig() {
    socket.emit('externalAgentConfig:detect', { cwd: serverCwd, includeHome: false }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'Detect failed', true);
      const items = ack.items || [];
      const rows = items.map((item, index) => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(item.description || 'Migration item')}</div>
        <div class="native-row-meta">${escHtml(item.cwd || 'home')}</div>
        <div class="native-row-actions"><button class="native-mini-btn" data-import-index="${index}">Import</button></div>
      </div>`).join('') || '<div class="native-list-row">No importable config</div>';
      renderNativePanel('Import', rows);
      nativePanel.querySelectorAll('[data-import-index]').forEach(btn => {
        btn.onclick = async () => {
          const item = items[Number(btn.dataset.importIndex)];
          if (!item) return;
          const accepted = await confirmDialog.confirm({ title: '导入配置', body: item.description || 'Import this config?' });
          if (!accepted) return;
          socket.emit('externalAgentConfig:import', { migrationItems: [item], cwd: serverCwd }, importAck => {
            if (!importAck?.ok) return appendSystem(importAck?.error || 'Import failed', true);
            appendSystem(`Import started: ${importAck.importId || ''}`, false);
          });
        };
      });
    });
  }

  function openP3Panel() {
    if (!features.labs) return;
    renderNativePanel('Labs', `
      <div class="native-list-row">
        <div class="native-row-title">Capabilities</div>
        <div class="native-row-actions"><button id="p3-capabilities-btn" class="native-mini-btn" type="button">Read</button></div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Terminal</div>
        <div class="native-row-actions">
          <button id="p3-terminal-spawn-btn" class="native-mini-btn" type="button">Spawn</button>
          <button id="p3-terminal-write-btn" class="native-mini-btn" type="button">Write</button>
          <button id="p3-terminal-resize-btn" class="native-mini-btn" type="button">Resize</button>
          <button id="p3-terminal-terminate-btn" class="native-mini-btn native-danger" type="button">Stop</button>
        </div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Threads</div>
        <div class="native-row-actions">
          <button id="p3-thread-turns-btn" class="native-mini-btn" type="button">Turns</button>
          <button id="p3-thread-search-btn" class="native-mini-btn" type="button">Search</button>
        </div>
      </div>
    `);
    $('p3-capabilities-btn').onclick = loadP3Capabilities;
    $('p3-terminal-spawn-btn').onclick = spawnP3Terminal;
    $('p3-terminal-write-btn').onclick = writeP3Terminal;
    $('p3-terminal-resize-btn').onclick = resizeP3Terminal;
    $('p3-terminal-terminate-btn').onclick = terminateP3Terminal;
    $('p3-thread-turns-btn').onclick = loadP3ThreadTurns;
    $('p3-thread-search-btn').onclick = searchP3Threads;
  }

  function loadP3Capabilities() {
    socket.emit('p3:capabilities', { cwd: serverCwd }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 capabilities failed', true);
      renderNativePanel('Labs', `<pre class="tool-output" style="max-height:220px;">${escHtml(JSON.stringify(ack.capabilities || {}, null, 2))}</pre>`);
    });
  }

  function spawnP3Terminal() {
    const command = promptRequired('Command', 'bash -lc "pwd"');
    if (command === null) return;
    const processId = promptRequired('Process id', `term_${Date.now()}`);
    if (processId === null) return;
    socket.emit('p3:terminalSpawn', {
      cwd: serverCwd,
      processId,
      command: ['bash', '-lc', command],
      cols: 100,
      rows: 30,
    }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 terminal spawn failed', true);
      appendSystem(`Terminal spawned: ${ack.processId || processId}`, false);
    });
  }

  function writeP3Terminal() {
    const processId = promptRequired('Process id');
    if (processId === null) return;
    const text = prompt('Input', '');
    if (text === null) return;
    socket.emit('p3:terminalWrite', { cwd: serverCwd, processId, text }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 terminal write failed', true);
      appendSystem(`Terminal write: ${processId}`, false);
    });
  }

  function resizeP3Terminal() {
    const processId = promptRequired('Process id');
    if (processId === null) return;
    socket.emit('p3:terminalResize', { cwd: serverCwd, processId, cols: 100, rows: 30 }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 terminal resize failed', true);
      appendSystem(`Terminal resized: ${processId}`, false);
    });
  }

  function terminateP3Terminal() {
    const processId = promptRequired('Process id');
    if (processId === null) return;
    socket.emit('p3:terminalTerminate', { cwd: serverCwd, processId }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 terminal terminate failed', true);
      appendSystem(`Terminal stopped: ${processId}`, false);
    });
  }

  function loadP3ThreadTurns() {
    const threadId = promptRequired('Thread id', currentSessionId || '');
    if (threadId === null) return;
    socket.emit('p3:threadTurns', { cwd: serverCwd, threadId }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 thread turns failed', true);
      renderNativePanel('Turns', `<pre class="tool-output" style="max-height:220px;">${escHtml(JSON.stringify(ack.turns || [], null, 2))}</pre>`);
    });
  }

  function searchP3Threads() {
    const query = promptRequired('Search query');
    if (query === null) return;
    socket.emit('p3:threadSearch', { cwd: serverCwd, query, limit: 20 }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || 'P3 thread search failed', true);
      const rows = (ack.results || []).map(thread => `<div class="native-list-row">
        <div class="native-row-title">${escHtml(thread.name || thread.title || thread.preview || thread.id || 'Thread')}</div>
        <div class="native-row-meta">${escHtml(thread.id || thread.sessionId || '')}</div>
      </div>`).join('') || '<div class="native-list-row">No results</div>';
      renderNativePanel('Search', rows);
    });
  }

  function handleP3TerminalOutput(payload) {
    const text = String(payload?.text || '');
    if (!text) return;
    appendSystem(`Terminal ${payload?.stream || 'stdout'} ${payload?.processId || ''}: ${text.slice(0, 600)}`, payload?.stream === 'stderr');
  }

  function handleP3TerminalExit(payload) {
    appendSystem(`Terminal exited ${payload?.processId || ''}: ${payload?.exitCode ?? 'unknown'}`, Number(payload?.exitCode) !== 0);
  }

  function handleP3Realtime(payload) {
    appendSystem(`Realtime ${payload?.event || 'event'}: ${payload?.threadId || currentSessionId || ''}`, payload?.event === 'error');
  }

  function handleP3RemoteControl(payload) {
    const status = typeof payload?.status === 'string' ? payload.status : (payload?.status?.type || 'updated');
    appendSystem(`Remote control ${status}: ${payload?.serverName || ''}`, false);
  }

  function openHostConfigPanel() {
    renderNativePanel('宿主配置', `
      <div class="native-list-row">
        <div class="native-row-meta">这些操作直接改动宿主机的 Codex 配置、插件与账号。每一项都会单独要求确认并写审计。</div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Config</div>
        <div class="native-row-actions">
          <button id="host-config-write-btn" class="native-mini-btn" type="button">Write</button>
          <button id="host-config-batch-btn" class="native-mini-btn" type="button">Batch</button>
        </div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">Plugins</div>
        <div class="native-row-actions">
          <button id="host-plugin-install-btn" class="native-mini-btn" type="button">Install</button>
          <button id="host-plugin-uninstall-btn" class="native-mini-btn" type="button">Uninstall</button>
          <button id="host-marketplace-add-btn" class="native-mini-btn" type="button">Add Market</button>
          <button id="host-marketplace-remove-btn" class="native-mini-btn" type="button">Remove Market</button>
          <button id="host-marketplace-upgrade-btn" class="native-mini-btn" type="button">Upgrade Market</button>
        </div>
      </div>
      <div class="native-list-row">
        <div class="native-row-title">MCP / Account</div>
        <div class="native-row-actions">
          <button id="host-mcp-call-btn" class="native-mini-btn native-danger" type="button">Tool Call</button>
          <button id="host-logout-btn" class="native-mini-btn native-danger" type="button">Logout</button>
        </div>
      </div>
    `);
    $('host-config-write-btn').onclick = hostConfigWrite;
    $('host-config-batch-btn').onclick = hostConfigBatchWrite;
    $('host-plugin-install-btn').onclick = hostPluginInstall;
    $('host-plugin-uninstall-btn').onclick = hostPluginUninstall;
    $('host-marketplace-add-btn').onclick = hostMarketplaceAdd;
    $('host-marketplace-remove-btn').onclick = hostMarketplaceRemove;
    $('host-marketplace-upgrade-btn').onclick = hostMarketplaceUpgrade;
    $('host-mcp-call-btn').onclick = hostMcpCall;
    $('host-logout-btn').onclick = hostAccountLogout;
  }

  const hostConfigEmitters = {
    'host:configWrite': (payload, ack) => socket.emit('host:configWrite', payload, ack),
    'host:configBatchWrite': (payload, ack) => socket.emit('host:configBatchWrite', payload, ack),
    'host:pluginInstall': (payload, ack) => socket.emit('host:pluginInstall', payload, ack),
    'host:pluginUninstall': (payload, ack) => socket.emit('host:pluginUninstall', payload, ack),
    'host:marketplaceAdd': (payload, ack) => socket.emit('host:marketplaceAdd', payload, ack),
    'host:marketplaceRemove': (payload, ack) => socket.emit('host:marketplaceRemove', payload, ack),
    'host:marketplaceUpgrade': (payload, ack) => socket.emit('host:marketplaceUpgrade', payload, ack),
    'host:mcpToolCall': (payload, ack) => socket.emit('host:mcpToolCall', payload, ack),
    'host:accountLogout': (payload, ack) => socket.emit('host:accountLogout', payload, ack),
  };

  function runHostConfigAction(eventName, buildPayload) {
    let confirmation;
    try {
      confirmation = promptRequired('Confirm action', eventName);
    } catch (err) {
      appendSystem(err.message, true);
      return;
    }
    if (confirmation === null) return;
    if (confirmation !== eventName) return appendSystem(`${eventName} confirmation mismatch`, true);
    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      appendSystem(err.message, true);
      return;
    }
    if (!payload) return;
    hostConfigEmitters[eventName]({ ...payload, cwd: serverCwd, confirmAction: confirmation }, ack => {
      if (!ack?.ok) return appendSystem(ack?.error || `${eventName} failed`, true);
      appendSystem(`${eventName} completed`, false);
    });
  }

  function promptRequired(label, initial = '') {
    const value = prompt(label, initial);
    if (value === null) return null;
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${label} required`);
    return trimmed;
  }

  function hostConfigWrite() {
    runHostConfigAction('host:configWrite', () => ({
      keyPath: promptRequired('Config keyPath', 'model'),
      value: promptRequired('Config value', 'gpt-5.5'),
      mergeStrategy: 'replace',
    }));
  }

  function hostConfigBatchWrite() {
    runHostConfigAction('host:configBatchWrite', () => ({
      edits: [{
        keyPath: promptRequired('Config keyPath', 'approval_policy'),
        value: promptRequired('Config value', 'on-request'),
        mergeStrategy: 'upsert',
      }],
      reloadUserConfig: true,
    }));
  }

  function hostPluginInstall() {
    runHostConfigAction('host:pluginInstall', () => ({ pluginName: promptRequired('Plugin name') }));
  }

  function hostPluginUninstall() {
    runHostConfigAction('host:pluginUninstall', () => ({ pluginId: promptRequired('Plugin id') }));
  }

  function hostMarketplaceAdd() {
    runHostConfigAction('host:marketplaceAdd', () => ({ source: promptRequired('Marketplace source') }));
  }

  function hostMarketplaceRemove() {
    runHostConfigAction('host:marketplaceRemove', () => ({ marketplaceName: promptRequired('Marketplace name') }));
  }

  function hostMarketplaceUpgrade() {
    runHostConfigAction('host:marketplaceUpgrade', () => ({ marketplaceName: promptRequired('Marketplace name') }));
  }

  function hostMcpCall() {
    runHostConfigAction('host:mcpToolCall', () => ({
      threadId: promptRequired('Thread id', currentSessionId || ''),
      server: promptRequired('MCP server'),
      tool: promptRequired('MCP tool'),
      arguments: JSON.parse(prompt('Arguments JSON', '{}') || '{}'),
    }));
  }

  function hostAccountLogout() {
    runHostConfigAction('host:accountLogout', () => ({}));
  }

  function joinPath(base, name) {
    return `${String(base || '/').replace(/\/+$/, '')}/${name}`.replace(/^\/\//, '/');
  }

  function loadNativeThreadHistory(s) {
    socket.emit('thread:history', { threadId: s.id, cwd: s.cwd }, data => {
      if (!data?.ok) {
        appendSystem(data?.error || 'Thread history failed', true);
        return;
      }
      renderHistoryMessages(data.messages || [], s.title || data.thread?.name || data.thread?.preview || 'Native thread');
    });
  }

  function renderHistoryMessages(msgs, title) {
    finishAssistantTurn();
    if (msgs.length === 0) {
      appendSystem('该会话无历史消息', false);
      return;
    }
    appendSystem(`${title || '历史会话'}（${msgs.length} 条消息）`, false);
    for (const m of msgs.slice(-30)) {
      if (m.kind === 'command') {
        appendRaw(renderCommandCard(commandCard(m)), 'codex');
        continue;
      }
      if (m.kind === 'file_change') {
        handleFileChange({ files: m.files || [] });
        continue;
      }
      if (m.kind === 'mcp') {
        const toolUseId = `history-mcp-${messagesEl.children.length}`;
        handleMcpUse({ ...m, toolUseId });
        handleMcpResult({ ...m, toolUseId });
        continue;
      }
      if (m.kind === 'search') {
        handleSearch(m);
        continue;
      }
      if (m.kind === 'plan') {
        handlePlan({ plan: m.plan || [] });
        continue;
      }
      if (m.kind === 'reasoning') {
        appendReasoning({ text: m.text, channel: m.channel || 'summary' });
        sealReasoning();
        continue;
      }
      if (m.kind === 'raw') {
        handleRawItem({ item: m.item });
        continue;
      }
      if (m.role === 'user') {
        appendHistoryUserBubble(m.content);
      } else {
        const bubble = document.createElement('div');
        bubble.className = 'bubble md';
        bubble.innerHTML = renderMarkdown(m.content || '');
        appendRaw(bubble, 'codex');
      }
    }
    finishAssistantTurn();
    scrollBottom();
    checkEmptyState();
  }

  function appendHistoryUserBubble(text) {
    finishAssistantTurn();
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="bubble">${escHtml(text || '')}</div>`;
    messagesEl.appendChild(el);
  }

  function appendQueuedBubble(payload, recordState = 'queued') {
    const text = payload.text || '';
    const clientRequestId = payload.clientRequestId || '';
    const offlineIndex = clientRequestId
      ? offlineUserBubbles.findIndex(item => item.clientRequestId === clientRequestId)
      : -1;
    if (offlineIndex >= 0) {
      const [{ el }] = offlineUserBubbles.splice(offlineIndex, 1);
      el.classList.remove('offline');
      el.classList.add('queued');
      const labelEl = el.querySelector('.offline-label');
      if (labelEl) {
        labelEl.className = 'queued-label';
        labelEl.textContent = `Queued #${payload.position || payload.queueLength || 1}`;
      }
      queuedUserBubbles.push({ clientRequestId, text, el });
      return;
    }
    const el = document.createElement('div');
    el.className = 'msg user queued';
    el.dataset.text = text;
    if (clientRequestId) el.dataset.clientRequestId = clientRequestId;
    el.innerHTML = `<div class="bubble">${escHtml(text)}<span class="queued-label">Queued #${payload.position || payload.queueLength || 1}</span></div>`;
    messagesEl.appendChild(el);
    if (clientRequestId) renderedOutboxStates.set(clientRequestId, recordState);
    queuedUserBubbles.push({ clientRequestId, text, el });
    scrollBottom();
    checkEmptyState();
  }

  function markQueuedBubble(clientRequestId, text, label) {
    const item = clientRequestId
      ? queuedUserBubbles.find(q => q.clientRequestId === clientRequestId)
      : queuedUserBubbles.find(q => q.text === text);
    if (!item) return false;
    const labelEl = item.el.querySelector('.queued-label');
    if (labelEl) labelEl.textContent = label;
    return true;
  }

  function promoteQueuedBubble(clientRequestId, text) {
    const idx = clientRequestId
      ? queuedUserBubbles.findIndex(q => q.clientRequestId === clientRequestId)
      : queuedUserBubbles.findIndex(q => q.text === text);
    if (idx === -1) return false;
    const [{ el }] = queuedUserBubbles.splice(idx, 1);
    el.classList.remove('queued');
    const labelEl = el.querySelector('.queued-label');
    if (labelEl) labelEl.remove();
    return true;
  }

  function handleQueueCleared(payload) {
    queuedUserBubbles.forEach(q => q.el.remove());
    queuedUserBubbles = [];
    appendSystem(`已清空 ${payload.dropped || 0} 条队列输入`, false);
    checkEmptyState();
  }

  function appendOfflineBubble(payload, { needsReconcile = false, unboundRecovery = false, manualDisposal = false, foreignThread = false, recordState = 'pending' } = {}) {
    const text = payload.text || '';
    const clientRequestId = payload.clientRequestId || '';
    if (clientRequestId && renderedOutboxStates.has(clientRequestId)) return;
    const el = document.createElement('div');
    el.className = 'msg user offline';
    el.dataset.text = text;
    if (clientRequestId) el.dataset.clientRequestId = clientRequestId;
    let html = `<div class="bubble">`;
    if (payload.attachments?.length) {
      html += `<div style="font-size:11px;opacity:.8;margin-bottom:4px;">${icon('paperclip')} ${payload.attachments.map(a => escHtml(a.name)).join(', ')}</div>`;
    }
    if (payload.parts?.length) {
      html += `<div style="font-size:11px;opacity:.8;margin-bottom:4px;">${icon('pin')} ${payload.parts.map(partDisplayName).map(escHtml).join(', ')}</div>`;
    }
    const deliveryLabel = unboundRecovery
      ? (needsReconcile
        ? '原会话目标已失效，正在按请求 ID 核对；不会自动重发'
        : (manualDisposal
          ? '原会话目标已失效且已尝试发送；不会自动重发，也不会自动恢复'
          : '原会话目标已失效，连接后将恢复到当前会话'))
      : (needsReconcile
        ? '结果未知，正在核对；不会自动重发'
        : (manualDisposal
          ? '已被运行时拒绝；丢弃后这条会话的队列才会继续'
          : '弱网等待同步 (Offline Queue)'));
    const foreignHint = foreignThread ? '<span class="offline-label">↪ 来自其他会话</span>' : '';
    html += `${escHtml(text || (payload.parts?.length ? '(结构化引用)' : '(附件)'))}${foreignHint}<span class="offline-label">${deliveryLabel}</span></div>`;
    el.innerHTML = html;
    if (needsReconcile && clientRequestId) {
      const retryButton = document.createElement('button');
      retryButton.className = 'unknown-retry-btn';
      retryButton.type = 'button';
      retryButton.textContent = '确认后重试';
      retryButton.onclick = async () => {
        const accepted = await confirmDialog.confirm({
          title: '确认后重试',
          body: '无法确认上一请求是否已执行；再次发送可能重复执行工具或修改。',
          danger: true,
        });
        if (!accepted) return;
        try {
          const target = await ensureViewTarget();
          const replacement = await messageOutbox.retryAfterConfirmation(clientRequestId, { target });
          if (!replacement) return;
          const bubbleIndex = offlineUserBubbles.findIndex(item => item.clientRequestId === clientRequestId);
          if (bubbleIndex >= 0) offlineUserBubbles.splice(bubbleIndex, 1);
          renderedOutboxStates.delete(clientRequestId);
          el.dataset.clientRequestId = replacement.clientRequestId;
          renderedOutboxStates.set(replacement.clientRequestId, 'pending');
          offlineUserBubbles.push({ clientRequestId: replacement.clientRequestId, text, el });
          const label = el.querySelector('.offline-label');
          if (label) label.textContent = '已确认重试，等待发送';
          retryButton.remove();
          await drainMessageOutbox({
            shouldSend: outboxRequestMatchesView,
          });
        } catch (error) {
          appendSystem(`消息重试失败：${error.message}`, true);
        }
      };
      el.querySelector('.bubble')?.appendChild(retryButton);
    }
    if (manualDisposal && clientRequestId) {
      const discardButton = document.createElement('button');
      discardButton.className = 'outbox-discard-btn';
      discardButton.type = 'button';
      discardButton.textContent = '丢弃';
      discardButton.onclick = async () => {
        const accepted = await confirmDialog.confirm({
          title: '丢弃这条消息',
          body: '无法确认它是否已在服务端执行过；丢弃后本地不再保留，也不会再重试。',
          danger: true,
        });
        if (!accepted) return;
        try {
          await messageOutbox.discard(clientRequestId);
        } catch (error) {
          appendSystem(`丢弃失败：${error.message}`, true);
          return;
        }
        const bubbleIndex = offlineUserBubbles.findIndex(item => item.clientRequestId === clientRequestId);
        if (bubbleIndex >= 0) offlineUserBubbles.splice(bubbleIndex, 1);
        renderedOutboxStates.delete(clientRequestId);
        el.remove();
        checkEmptyState();
        // 被拒绝的队首会让 drain 停下，丢弃后要立刻推一次，后面的消息才能继续。
        await drainMessageOutbox({
          shouldSend: outboxRequestMatchesView,
        });
      };
      el.querySelector('.bubble')?.appendChild(discardButton);
    }
    messagesEl.appendChild(el);
    if (clientRequestId) renderedOutboxStates.set(clientRequestId, recordState);
    offlineUserBubbles.push({ clientRequestId, text, el });
    scrollBottom();
    checkEmptyState();
  }

  // 状态变了要重画，先把上一版气泡连同它的登记一起拆掉。
  function dropRenderedOutboxBubble(clientRequestId) {
    if (!clientRequestId) return;
    for (const list of [offlineUserBubbles, queuedUserBubbles]) {
      const idx = list.findIndex(item => item.clientRequestId === clientRequestId);
      if (idx >= 0) {
        list[idx].el?.remove();
        list.splice(idx, 1);
      }
    }
    renderedOutboxStates.delete(clientRequestId);
  }

  function promoteOfflineBubble(clientRequestId) {
    if (!clientRequestId) return false;
    const idx = offlineUserBubbles.findIndex(q => q.clientRequestId === clientRequestId);
    if (idx === -1) return false;
    const [{ el }] = offlineUserBubbles.splice(idx, 1);
    el.classList.remove('offline');
    const labelEl = el.querySelector('.offline-label');
    if (labelEl) labelEl.remove();
    return true;
  }

  function renderCommandCard(model) {
    const card = document.createElement('div');
    card.className = 'tool-card command-card';
    if (model.ok === true) card.dataset.ok = 'true';
    else if (model.ok === false) card.dataset.ok = 'false';
    const command = model.command || 'streaming output';
    const exit = model.exitCode == null
      ? ''
      : `<div class="tool-exit ${model.ok ? 'tool-ok' : 'tool-err'}">exit: ${escHtml(String(model.exitCode))}</div>`;
    card.innerHTML = `<div class="tool-name">${escHtml(model.title)}</div>`
      + `<details${model.running ? ' open' : ''}><summary class="tool-cmd">${escHtml(command)}</summary></details>`
      + `<div class="tool-output live-output${model.ok === false ? ' tool-err' : model.ok === true ? ' tool-ok' : ''}">${model.output ? renderAnsi(model.output) : ''}</div>`
      + exit;
    return card;
  }

  function handleToolUse(payload) {
    finalizeStream();
    const model = commandCard({ command: payload.inputSummary || '', running: true });
    const card = renderCommandCard(model);
    appendRaw(card, 'codex');
    pendingToolCards[payload.toolUseId] = card;
    scrollBottom();
  }

  function ensureToolOutputCard(toolUseId) {
    let card = pendingToolCards[toolUseId];
    if (!card) {
      const model = commandCard({ command: 'streaming output', running: true });
      card = renderCommandCard(model);
      appendRaw(card, 'codex');
      pendingToolCards[toolUseId] = card;
    }
    let out = card.querySelector('.live-output');
    if (!out) {
      out = document.createElement('div');
      out.className = 'tool-output live-output';
      card.appendChild(out);
    }
    return out;
  }

  function handleToolOutputDelta(payload) {
    if (!payload.text) return;
    const out = ensureToolOutputCard(payload.toolUseId || 'unknown');
    out.innerHTML += renderAnsi(payload.text);
    out.scrollTop = out.scrollHeight;
    scrollBottom();
  }

  function handleToolResult(payload) {
    const card = pendingToolCards[payload.toolUseId];
    const existingCommand = card?.querySelector('.tool-cmd')?.textContent || '';
    const model = commandCard({
      command: existingCommand,
      output: payload.outputSummary || (payload.ok ? '(完成)' : '(出错)'),
      exitCode: payload.exitCode ?? (payload.ok ? 0 : null),
      status: payload.status || 'completed',
    });
    // 攒给本轮的验收摘要用。只有拿到退出码的才算数——还在跑的没有结论。
    if (Number.isInteger(model.exitCode)) {
      turnCommands.push({ command: existingCommand, exitCode: model.exitCode });
    }
    if (card) {
      card.classList.add('command-card');
      if (model.ok === true) card.dataset.ok = 'true';
      else if (model.ok === false) card.dataset.ok = 'false';
      let out = card.querySelector('.live-output');
      if (!out) {
        out = document.createElement('div');
        card.appendChild(out);
      }
      out.className = 'tool-output live-output ' + (model.ok ? 'tool-ok' : 'tool-err');
      const resultHtml = renderAnsi(model.output);
      if (out.innerText.trim()) out.innerHTML += '<br>' + resultHtml;
      else out.innerHTML = resultHtml;
      let exit = card.querySelector('.tool-exit');
      if (!exit && model.exitCode != null) {
        exit = document.createElement('div');
        exit.className = 'tool-exit ' + (model.ok ? 'tool-ok' : 'tool-err');
        exit.textContent = `exit: ${model.exitCode}`;
        card.appendChild(exit);
      } else if (exit && model.exitCode != null) {
        exit.className = 'tool-exit ' + (model.ok ? 'tool-ok' : 'tool-err');
        exit.textContent = `exit: ${model.exitCode}`;
      }
      delete pendingToolCards[payload.toolUseId];
    }
    scrollBottom();
  }

  function handleResult(payload) {
    finalizeStream();
    finishAssistantTurn();
    announceTurnComplete(payload?.ok === false ? '回复失败' : '回复完成');
    renderTurnOutcome();
    setBusy(false);
    refreshNativeThreads();
    checkEmptyState();
  }

  // R-20：完成时给出客观的验收摘要——改了哪些文件、跑过哪些验证、哪些失败了。这些都从
  // 本轮的聚合 diff 与命令退出码导出，不依赖模型自述。
  function renderTurnOutcome() {
    const outcome = summarizeTurnOutcome({ diff: turnDiff, commands: turnCommands });
    turnDiff = '';
    turnCommands = [];
    if (!outcome.hasChanges && outcome.checks.length === 0) return;

    const lines = [];
    if (outcome.hasChanges) {
      lines.push(`改动 ${outcome.files.length} 个文件 · +${outcome.added} / -${outcome.removed}`);
      lines.push(outcome.files.slice(0, 8).join('\n') + (outcome.files.length > 8 ? `\n…还有 ${outcome.files.length - 8} 个` : ''));
    }
    if (outcome.checks.length) {
      lines.push(outcome.allPassed
        ? `跑过 ${outcome.checks.length} 项验证，全部通过`
        : `跑过 ${outcome.checks.length} 项验证，${outcome.failed.length} 项失败`);
      for (const item of outcome.failed) lines.push(`✗ ${item.command} (exit ${item.exitCode})`);
    } else if (outcome.hasChanges) {
      // 没跑过验证就说没跑过，不能让「没有失败」看起来像「验证通过」。
      lines.push('本轮没有运行任何验证命令');
    }

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">${icon('clipboard')} 本轮结果</div>`
      + `<pre class="tool-cmd" style="white-space:pre-wrap;font-size:11px;">${escHtml(lines.join('\n'))}</pre>`;
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function handleApprovalRequest(payload, event) {
    finalizeStream();
    const requestTarget = {
      instanceId: event?.instanceId || null,
      threadId: event?.sessionId || payload.threadId || null,
    };
    const decisions = payload.availableDecisions || [];
    const deny = decisions.includes('decline') ? 'decline' : (decisions.includes('cancel') ? 'cancel' : 'decline');
    const sessionDecision = decisions.includes('acceptForSession') ? `<button class="approve-btn" data-d="acceptForSession">本会话批准</button>` : '';
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">${icon('warning')} 需要审批</div>`
      + `<div class="tool-cmd">${escHtml(payload.command || payload.kind || '需要确认的操作')}</div>`
      + renderApprovalDetails(payload)
      + `<div class="approval-btns">`
      + `<button class="approve-btn" data-d="accept">批准</button>`
      + sessionDecision
      + `<button class="deny-btn" data-d="${deny}">拒绝</button></div>`;
    appendRaw(card, 'codex');
    const cardKey = payload.needId || String(payload.approvalId);
    pendingApprovalCards[cardKey] = card;
    const btns = card.querySelector('.approval-btns');
    btns.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        btns.querySelectorAll('button').forEach(button => { button.disabled = true; });
        socket.emit('user:approval', withTarget({
          needId: payload.needId,
          approvalId: payload.approvalId,
          decision: b.dataset.d,
          turnId: payload.turnId,
          itemId: payload.itemId,
        }, requestTarget), ack => {
          if (!ack?.ok) {
            if (ack?.resultUnknown) {
              markNeedCardUnknown(cardKey);
              appendSystem('审批结果未知，等待上游终态；不会自动重试', true);
              return;
            }
            btns.querySelectorAll('button').forEach(button => { button.disabled = false; });
            appendSystem(ack?.error || '审批失败，请刷新后重试', true);
            return;
          }
          delete pendingApprovalCards[cardKey];
          needsYou.delete(payload.needId);
          renderNeedsYouPanel();
          btns.innerHTML = `<span class="tool-output tool-ok" style="background:transparent;padding:0;">已${b.dataset.d === 'accept' ? '批准' : '拒绝'}</span>`;
        });
      };
    });
    scrollBottom();
  }

  function renderApprovalDetails(payload) {
    let html = '';
    if (payload.reason) {
      html += `<div class="tool-output" style="opacity:.8;background:transparent;color:var(--text-muted);">${escHtml(payload.reason)}</div>`;
    }
    if (payload.permissions && (payload.permissions.network !== undefined || payload.permissions.fileSystem !== undefined)) {
      const lines = [];
      if (payload.permissions.network !== undefined) lines.push(`network: ${JSON.stringify(payload.permissions.network)}`);
      if (payload.permissions.fileSystem !== undefined) lines.push(`fileSystem: ${JSON.stringify(payload.permissions.fileSystem)}`);
      html += `<div class="tool-cmd">${escHtml(lines.join('\n'))}</div>`;
    }
    if (Array.isArray(payload.changes) && payload.changes.length) {
      html += payload.changes.map(change => {
        const title = `${kindLabel(change.kind)}: ${change.path || ''}`;
        const diff = change.diff ? `<pre class="tool-output" style="max-height:220px;">${escHtml(change.diff)}</pre>` : '';
        return `<details open><summary class="tool-cmd">${escHtml(title)}</summary>${diff}</details>`;
      }).join('');
    }
    if (payload.grantRoot) {
      html += `<div class="tool-cmd">grantRoot: ${escHtml(payload.grantRoot)}</div>`;
    }
    return html;
  }

  function kindLabel(k) {
    return ({ add: '新增', modify: '修改', update: '修改', delete: '删除', rename: '重命名' }[k] || k || 'modify');
  }

  function handleUserInputRequest(payload, event) {
    finalizeStream();
    const requestTarget = {
      instanceId: event?.instanceId || null,
      threadId: event?.sessionId || payload.threadId || null,
    };
    const questions = payload.questions || [];
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">${icon('question')} 需要回答</div>`
      + questions.map(q => renderQuestion(q)).join('')
      + (payload.autoResolutionMs ? `<div class="tool-output" style="opacity:.7;background:transparent;color:var(--text-muted);">autoResolutionMs: ${escHtml(String(payload.autoResolutionMs))}</div>` : '')
      + `<div class="approval-btns"><button class="approve-btn answer-submit" type="button">提交</button><button class="deny-btn answer-cancel" type="button">跳过</button></div>`;
    appendRaw(card, 'codex');
    const cardKey = payload.needId || String(payload.approvalId);
    pendingApprovalCards[cardKey] = card;

    card.querySelectorAll('.answer-option').forEach(btn => {
      btn.onclick = () => btn.classList.toggle('selected');
    });
    const submitAnswers = (answers, successLabel) => {
      const actionButtons = card.querySelectorAll('.approval-btns:last-child button');
      actionButtons.forEach(button => { button.disabled = true; });
      socket.emit('user:approval', withTarget({
        needId: payload.needId,
        approvalId: payload.approvalId,
        answers,
        turnId: payload.turnId,
        itemId: payload.itemId,
      }, requestTarget), ack => {
        if (!ack?.ok) {
          if (ack?.resultUnknown) {
            markNeedCardUnknown(cardKey);
            appendSystem('回答结果未知，等待上游终态；不会自动重试', true);
            return;
          }
          actionButtons.forEach(button => { button.disabled = false; });
          appendSystem(ack?.error || '回答提交失败，请刷新后重试', true);
          return;
        }
        needsYou.delete(payload.needId);
        renderNeedsYouPanel();
        markInputCardDone(card, cardKey, successLabel);
      });
    };
    card.querySelector('.answer-submit').onclick = () => {
      submitAnswers(collectAnswers(card, questions), '已提交');
    };
    card.querySelector('.answer-cancel').onclick = () => {
      submitAnswers({}, '已跳过');
    };
    scrollBottom();
  }

  function renderQuestion(q) {
    const options = Array.isArray(q.options) ? q.options : [];
    const header = q.header || q.id || 'Question';
    const optionHtml = options.length
      ? `<div class="approval-btns">${options.map(o => `<button type="button" class="approve-btn answer-option" data-q="${escHtml(q.id)}" data-value="${escHtml(o.label)}">${escHtml(o.label)}</button>`).join('')}</div>`
      : `<input class="tool-cmd answer-input" data-q="${escHtml(q.id)}" type="${q.isSecret ? 'password' : 'text'}" placeholder="Answer">`;
    return `<div class="tool-cmd" style="white-space:normal;"><strong>${escHtml(header)}</strong><br>${escHtml(q.question || '')}</div>${optionHtml}`;
  }

  function collectAnswers(card, questions) {
    const answers = {};
    questions.forEach(q => {
      const qid = String(q.id || '');
      const selected = [...card.querySelectorAll(`.answer-option[data-q="${cssEscape(qid)}"].selected`)].map(btn => btn.dataset.value);
      const input = card.querySelector(`.answer-input[data-q="${cssEscape(qid)}"]`);
      const typed = input?.value?.trim();
      const values = selected.length ? selected : (typed ? [typed] : []);
      answers[qid] = values;
    });
    return answers;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return value.replace(/"/g, '\\"');
  }

  function markInputCardDone(card, cardKey, label) {
    delete pendingApprovalCards[cardKey];
    const btns = card.querySelector('.approval-btns:last-child');
    if (btns) btns.innerHTML = `<span class="tool-output tool-ok" style="background:transparent;padding:0;">${escHtml(label)}</span>`;
  }

  function handleApprovalRevoked(payload) {
    const key = String(payload?.approvalId ?? payload?.requestId ?? '');
    const card = pendingApprovalCards[key];
    if (!card) return;
    delete pendingApprovalCards[key];
    card.remove();
    scrollBottom();
  }

  function handleFileChange(payload) {
    finalizeStream();
    const model = fileChangeCard({ files: payload.files || [] });
    if (!model.files.length) return;
    const card = document.createElement('div');
    card.className = 'tool-card file-change-card';
    card.innerHTML = `<div class="tool-name">${escHtml(model.title)}</div>`
      + model.files.map(file => {
        const line = `${file.kindLabel}: ${file.path}`;
        if (!file.expandable) return `<div class="tool-cmd">${escHtml(line)}</div>`;
        return `<details><summary class="tool-cmd">${escHtml(line)}</summary><pre class="tool-output">${escHtml(file.diff)}</pre></details>`;
      }).join('');
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function handleRawItem(payload) {
    finalizeStream();
    const card = document.createElement('div');
    card.className = 'tool-card';
    const label = payload?.item?.type || payload?.envelopeType || 'raw';
    card.innerHTML = `<div class="tool-name">${icon('receipt')} Raw</div>`
      + `<details><summary class="tool-cmd">${escHtml(label)}</summary><pre class="tool-output">${escHtml(JSON.stringify(payload.item || payload, null, 2))}</pre></details>`;
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function handlePlan(payload) {
    finalizeStream();
    const plan = payload.plan || [];
    if (!plan.length) return;
    const planStatusIcon = s => ({
      completed: icon('check'),
      inProgress: icon('hourglass'),
      in_progress: icon('hourglass'),
      pending: icon('square'),
    }[s] || '•');
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">${icon('clipboard')} 计划</div>`
      + plan.map(p => `<div class="tool-cmd">${planStatusIcon(p.status)} ${escHtml(p.step || '')}</div>`).join('');
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function appendReasoning(payload) {
    const data = typeof payload === 'string' ? { text: payload, channel: 'summary' } : (payload || {});
    const channel = payload && payload.channel === 'full' ? 'full' : 'summary';
    if (!data.text && data.kind !== 'summary_part_added') return;
    if (!appendReasoning.card) {
      const card = document.createElement('div');
      card.className = 'tool-card reasoning-card';
      card.dataset.streaming = 'true';
      card.innerHTML = '<details class="reasoning-fold"><summary class="reasoning-toggle"><span class="reasoning-label">思考中</span></summary><div class="reasoning-stack"></div></details>';
      appendRaw(card, 'codex');
      appendReasoning.card = card;
      appendReasoning.sections = {};
    }
    const section = ensureReasoningSection(channel);
    if (data.kind === 'summary_part_added' && section.textContent.trim()) {
      section.textContent += '\n\n';
    }
    if (data.text) section.textContent += data.text;
    scrollBottom();
  }

  function ensureReasoningSection(channel) {
    const key = channel === 'full' ? 'full' : 'summary';
    if (appendReasoning.sections?.[key]) return appendReasoning.sections[key];
    const wrap = document.createElement('div');
    wrap.className = key === 'full'
      ? 'reasoning-section reasoning-full'
      : 'reasoning-section reasoning-summary';
    wrap.innerHTML = `${key === 'full' ? '<div class="reasoning-channel">完整推理</div>' : ''}<pre class="reasoning-body"></pre>`;
    appendReasoning.card.querySelector('.reasoning-stack')?.appendChild(wrap);
    const out = wrap.querySelector('.reasoning-body');
    appendReasoning.sections[key] = out;
    return out;
  }

  // MCP tool cards
  const pendingMcpCards = {};
  function handleMcpUse(payload) {
    finalizeStream();
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">${icon('tools')} ${escHtml(payload.serverName)}/${escHtml(payload.toolName)}</div><div class="tool-cmd">${escHtml(payload.inputSummary || '')}</div>`;
    appendRaw(card, 'codex');
    pendingMcpCards[payload.toolUseId] = card;
    scrollBottom();
  }

  function handleMcpResult(payload) {
    const card = pendingMcpCards[payload.toolUseId];
    if (card) {
      const out = document.createElement('div');
      out.className = 'tool-output ' + (payload.ok ? 'tool-ok' : 'tool-err');
      out.textContent = payload.outputSummary || (payload.ok ? '(完成)' : '(出错)');
      card.appendChild(out);
      delete pendingMcpCards[payload.toolUseId];
    }
    scrollBottom();
  }

  // Search results card
  function handleSearch(payload) {
    finalizeStream();
    const results = payload.results || [];
    if (!payload.query && !results.length) return;
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">${icon('search')} 搜索: ${escHtml(payload.query || '')}</div>`
      + results.map(r => `<div class="tool-cmd" style="margin-bottom:4px;"><a href="${escHtml(r.url)}" target="_blank" style="color:var(--accent-text);text-decoration:none;font-weight:600;">${escHtml(r.title)}</a><br><span class="tool-output" style="background:transparent;color:var(--text-muted);padding:4px 0 0;">${escHtml(r.snippet || '')}</span></div>`).join('');
    appendRaw(card, 'codex');
    scrollBottom();
  }

  // Cumulative diff card
  function handleDiff(payload) {
    if (!payload.diff) return;
    turnDiff = payload.diff;
    finalizeStream();
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<div class="tool-name">${icon('chart')} 变更摘要</div><pre class="tool-cmd" style="white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto;">${escHtml(payload.diff)}</pre>`;
    appendRaw(card, 'codex');
    scrollBottom();
  }

  function handlePendingDevices(payload) {
    const devices = payload.devices || [];
    if (devices.length === 0) {
      pendingPanel.classList.remove('show');
      pendingPanel.innerHTML = '';
      return;
    }
    pendingPanel.classList.add('show');
    pendingPanel.innerHTML = devices.map(d =>
      `<div class="pending-device">
        <div class="pending-device-info">设备 ${d.deviceId.slice(0, 12)}… 来自 ${d.ip}</div>
        <div class="pending-btns">
          <button class="approve-btn" data-id="${escHtml(d.deviceId)}">批准</button>
          <button class="deny-btn" data-id="${escHtml(d.deviceId)}">拒绝</button>
        </div>
      </div>`
    ).join('');
    pendingPanel.querySelectorAll('.approve-btn').forEach(btn => {
      btn.onclick = () => socket.emit('user:approveDevice', { deviceId: btn.dataset.id });
    });
    pendingPanel.querySelectorAll('.deny-btn').forEach(btn => {
      btn.onclick = () => socket.emit('user:denyDevice', { deviceId: btn.dataset.id });
    });
  }

  // Streaming text
  function appendTextDelta(text) {
    if (appendReasoning.card) sealReasoning();
    transcriptStream.append(text);
  }

  function finalizeStream() {
    transcriptStream.finish();
    sealReasoning();
  }

  function sealReasoning() {
    const label = appendReasoning.card?.querySelector('.reasoning-label');
    if (label) label.textContent = '思考过程';
    if (appendReasoning.card) delete appendReasoning.card.dataset.streaming;
    appendReasoning.card = null;
    appendReasoning.sections = null;
  }

  function partDisplayName(part) {
    if (part?.kind === 'skill') return `$${part.name || 'skill'}`;
    if (part?.kind === 'mention') return `@${part.name || 'file'}`;
    return '[Image]';
  }

  function appendUserBubble(text, attachments, parts, clientRequestId) {
    if (promoteOfflineBubble(clientRequestId)) {
      scrollBottom();
      setBusy(true);
      showTyping();
      return;
    }
    if (promoteQueuedBubble(clientRequestId, text)) {
      scrollBottom();
      setBusy(true);
      showTyping();
      return;
    }
    const el = document.createElement('div');
    el.className = 'msg user';
    let html = `<div class="bubble">`;
    if (attachments?.length) {
      html += `<div style="font-size:11px;opacity:.8;margin-bottom:4px;">${icon('paperclip')} ${attachments.map(a => escHtml(a.name)).join(', ')}</div>`;
    }
    if (parts?.length) {
      html += `<div style="font-size:11px;opacity:.8;margin-bottom:4px;">${icon('pin')} ${parts.map(partDisplayName).map(escHtml).join(', ')}</div>`;
    }
    html += `${escHtml(text || (parts?.length ? '(结构化引用)' : '(附件)'))}</div>`;
    el.innerHTML = html;
    messagesEl.appendChild(el);
    scrollBottom();
    setBusy(true);
    showTyping();
    checkEmptyState();
  }

  let typingEl = null;
  function showTyping() {
    if (typingEl) return;
    const el = document.createElement('div');
    el.className = 'msg codex';
    el.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
    typingEl = el;
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  function ensureAssistantTurn() {
    if (activeAssistantTurnEl) return activeAssistantTurnEl;
    const turn = document.createElement('div');
    turn.className = 'msg codex assistant-turn';
    turn.dataset.active = 'true';
    turn.setAttribute('aria-busy', 'true');
    messagesEl.appendChild(turn);
    activeAssistantTurnEl = turn;
    checkEmptyState();
    return turn;
  }

  function finishAssistantTurn() {
    if (!activeAssistantTurnEl) return;
    delete activeAssistantTurnEl.dataset.active;
    activeAssistantTurnEl.removeAttribute('aria-busy');
    activeAssistantTurnEl = null;
  }

  function announceTurnComplete(message) {
    turnAnnouncer.textContent = '';
    requestAnimationFrame(() => {
      turnAnnouncer.textContent = message;
    });
  }

  function appendRaw(el, role) {
    if (role === 'codex') {
      const turn = ensureAssistantTurn();
      turn.appendChild(el);
      return turn;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'msg ' + role;
    wrapper.appendChild(el);
    messagesEl.appendChild(wrapper);
    checkEmptyState();
    return wrapper;
  }

  function appendSystem(msg, isError) {
    const el = document.createElement('div');
    el.className = 'msg system-msg' + (isError ? ' error-msg' : '');
    el.innerHTML = `<div class="bubble">${escHtml(msg)}</div>`;
    messagesEl.appendChild(el);
    scrollBottom();
    checkEmptyState();
  }

  function appendError(msg) {
    const el = document.createElement('div');
    el.className = 'msg system-msg error-msg';
    el.innerHTML = `<div class="bubble">${icon('x')} ${escHtml(msg)}</div>`;
    messagesEl.appendChild(el);
    scrollBottom();
    checkEmptyState();
  }

  function clearMessages() {
    finalizeStream();
    finishAssistantTurn();
    messagesEl.innerHTML = '';
    pendingToolCards = {};
    pendingApprovalCards = {};
    queuedUserBubbles = [];
    offlineUserBubbles = [];
    renderedOutboxStates = new Map();
    followTranscript = true;
    jumpToLatestBtn.hidden = true;
    setBusy(false);
    checkEmptyState();
  }

  // Connection UI states
  function composerHasContent() {
    return Boolean(inputEl.value.trim() || currentAttachments.length || currentInputParts.length);
  }

  function applyComposerMode() {
    if (!sendBtn) return;
    const state = resolveComposerPrimaryMode({
      turnRunning: busy,
      hasContent: composerHasContent(),
      interruptPending,
    });
    sendBtn.dataset.mode = state.mode;
    sendBtn.disabled = !state.enabled;
    sendBtn.hidden = !state.visible;
    const sendWrap = $('send-btn-container');
    if (sendWrap) sendWrap.hidden = !state.visible;
    sendBtn.title = state.mode === 'stop'
      ? (state.enabled ? '中断' : '正在停止')
      : '发送';
    sendBtn.setAttribute('aria-label', sendBtn.title);
    const followUpBtn = $('followup-btn');
    if (followUpBtn) followUpBtn.hidden = !state.followUpVisible;
  }

  function interruptCurrentTurn() {
    if (interruptPending) return;
    interruptPending = true;
    applyComposerMode();
    socket.emit('user:interrupt', withTarget({
      turnId: sessionStatus?.turnId || undefined,
    }, viewTarget()), ack => {
      if (ack?.ok) return;
      interruptPending = false;
      applyComposerMode();
      appendSystem(ack?.error || '中断失败', true);
    });
  }

  function setBusy(b) {
    busy = b;
    if (!b) interruptPending = false;
    renderConnectionState();
    const spinner = $('mini-status-spinner');
    if (spinner) spinner.style.display = b ? 'inline-block' : 'none';
    if (!b) hideTyping();
    applyComposerMode();
  }

  function renderConnectionState() {
    const state = sessionStatus?.state || (busy ? 'running' : 'idle');
    const dotState = state === 'awaiting_approval' ? 'awaiting' : (state === 'running' ? 'busy' : state);
    const connected = isTransportConnected();
    statusDot.className = connected ? `connected ${dotState}` : '';
    if (stateLabel) stateLabel.textContent = connected ? state.replace('_', ' ') : 'offline';
    paintConnectionBanner();
  }

  let rttTimer = null;
  let rttInFlight = false;

  function paintRtt(ms) {
    const el = $('conn-rtt');
    if (!el) return;
    const view = formatRttChip(ms);
    if (!view.visible) {
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('data-tone');
      return;
    }
    el.hidden = false;
    el.textContent = view.label;
    el.dataset.tone = view.tone;
  }

  function measureRtt() {
    if (!socket.connected || rttInFlight) return;
    rttInFlight = true;
    const startedAt = performance.now();
    socket.timeout(3000).emit('conn:ping', {}, error => {
      rttInFlight = false;
      if (error || !socket.connected) return;
      paintRtt(performance.now() - startedAt);
    });
  }

  function stopRttMonitor() {
    if (rttTimer) clearInterval(rttTimer);
    rttTimer = null;
    rttInFlight = false;
  }

  function startRttMonitor() {
    stopRttMonitor();
    measureRtt();
    rttTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      measureRtt();
    }, 5000);
  }

  function clearRtt() {
    stopRttMonitor();
    paintRtt(NaN);
  }

  function transcriptDistanceFromBottom() {
    return Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight - messagesEl.scrollTop);
  }

  function paintJumpToLatest() {
    const hasOverflow = messagesEl.scrollHeight > messagesEl.clientHeight + 1;
    jumpToLatestBtn.hidden = followTranscript || !hasOverflow;
  }

  function scrollBottom(force = false) {
    if (!force && !followTranscript) {
      paintJumpToLatest();
      return;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    followTranscript = true;
    paintJumpToLatest();
  }

  messagesEl.addEventListener('scroll', () => {
    followTranscript = transcriptDistanceFromBottom() <= TRANSCRIPT_FOLLOW_DISTANCE_PX;
    paintJumpToLatest();
  });

  jumpToLatestBtn.addEventListener('click', () => {
    followTranscript = true;
    scrollBottom(true);
  });

  sendBtn.onclick = () => {
    if (sendBtn.dataset.mode === 'stop') interruptCurrentTurn();
    else sendMessage();
  };
  $('followup-btn').onclick = sendMessage;
  $('native-thread-refresh').onclick = () => refreshNativeThreads(true);
  $('native-compact-btn').onclick = startCompact;
  $('native-rollback-btn').onclick = rollbackThread;
  $('native-models-btn').onclick = loadNativeModels;
  $('native-files-btn').onclick = () => openFileBrowser(serverCwd);
  $('native-account-btn').onclick = loadAccountPanel;
  $('native-mcp-btn').onclick = loadMcpPanel;
  $('native-health-btn').onclick = loadHealthPanel;
  $('native-devices-btn').onclick = loadDevicesPanel;
  $('native-skills-btn').onclick = loadSkillsPanel;
  $('native-import-btn').onclick = detectExternalAgentConfig;
  $('native-p3-btn').onclick = openP3Panel;
  $('native-host-config-btn').onclick = openHostConfigPanel;
  // 工具按钮在抽屉里:点任一按钮后关闭抽屉,让主区的数据面板可见
  const nativeControlsRegion = $('native-controls');
  if (nativeControlsRegion) {
    nativeControlsRegion.addEventListener('click', (e) => {
      if (e.target.closest('.native-control-btn')) closeDrawer();
    });
  }
  inputEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (composerHasContent()) sendMessage();
    else if (sendBtn.dataset.mode === 'stop') interruptCurrentTurn();
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
    applyComposerMode();
  });

  async function sendMessage() {
    if (interruptPending) return;
    const modeSlash = parseCollaborationModeSlash(inputEl.value);
    if (modeSlash) {
      applyCollaborationMode(modeSlash.mode);
      inputEl.value = modeSlash.rest;
      applyComposerMode();
      if (!modeSlash.rest && !currentAttachments.length && !currentInputParts.length) return;
    }
    const text = inputEl.value.trim();
    const hasAttachments = currentAttachments.length > 0;
    const hasParts = currentInputParts.length > 0;
    if (!text && !hasAttachments && !hasParts) return;

    let target = viewTarget();
    if (isTransportConnected()) {
      try {
        target = await ensureViewTarget();
      } catch (error) {
        appendSystem(error.message || '无法建立会话目标', true);
        return;
      }
    }

    const attachments = hasAttachments
      ? currentAttachments.map(attachment => ({ ...attachment }))
      : undefined;
    const parts = hasParts
      ? currentInputParts.map(part => ({ ...part }))
      : undefined;
    const turn = effectiveTurnSettings();
    const request = createMessageRequest({ text, attachments, parts, target, turn });
    try {
      if (!await outboxReady) throw new Error('IndexedDB outbox unavailable');
      await messageOutbox.enqueue(request);
    } catch (error) {
      appendSystem(`消息未保存，未发送：${error.message}`, true);
      return;
    }

    inputEl.value = '';
    inputEl.style.height = 'auto';
    hideSlashPopup();
    if (hasAttachments) {
      currentAttachments = [];
    }
    if (hasParts) currentInputParts = [];
    renderAttachTray();
    applyComposerMode();
    appendOfflineBubble(messageWirePayload(request), { recordState: request.state });
    // drain 里可能把这条记录改成 needs_reconcile / rejected（比如 ACK 超时、被运行时
    // 拒绝）。状态变了必须回来重画一次，否则气泡会一直停在「弱网等待同步」，重试和
    // 丢弃按钮也长不出来——用户只有刷新才看得到真实状态。
    // 这个调用点在 syncOutboxViewOnce 之外，不会和它末尾的 drain 递归。
    drainMessageOutbox({
      shouldSend: outboxRequestMatchesView,
    }).then(() => syncOutboxView());
  }

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    inputEl.focus();
    return ok;
  }

  // ---- Web Push ----
  const pushBtn = document.getElementById('push-subscribe-btn');
  async function initPush() {
    if (!pushBtn) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.register('/js/sw.js', { scope: '/' });
      const sub = await reg.pushManager.getSubscription();
      if (sub) pushBtn.style.display = 'none'; // already subscribed
      else pushBtn.style.display = '';
    } catch { /* SW registration failed */ }
    pushBtn.onclick = async () => {
      try {
        const resp = await fetch('/push/vapid-public-key');
        if (!resp.ok) { alert('推送未配置'); return; }
        const { key } = await resp.json();
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        });
        const subscribeResponse = await fetch('/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'x-device-token': deviceToken,
          },
          body: JSON.stringify(sub)
        });
        if (!subscribeResponse.ok) {
          await sub.unsubscribe().catch(() => {});
          const failure = await subscribeResponse.json().catch(() => ({}));
          throw new Error(failure.error || `Push subscription failed (${subscribeResponse.status})`);
        }
        pushBtn.innerHTML = `${icon('bellOff')} 已订阅`;
        pushBtn.title = '已订阅推送';
        pushBtn.onclick = null;
      } catch (e) {
        console.warn('[push] subscribe failed:', e.message);
      }
    };
  }
  initPush();

  // ---- 附件 ----
  attachBtn.onclick = () => fileInput.click();

  inputEl.addEventListener('paste', async event => {
    const item = pickPastedImage(event.clipboardData);
    if (!item?.getAsFile) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    currentAttachments = currentAttachments.concat(await readFileAsAttachment(file));
    renderAttachTray();
  });

  $('attach-preview-modal')?.addEventListener('click', () => {
    $('attach-preview-modal').hidden = true;
  });

  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    fileInput.value = '';
    const newAttachments = await Promise.all(files.map(readFileAsAttachment));
    currentAttachments = currentAttachments.concat(newAttachments);
    renderAttachTray();
  };

  function readFileAsAttachment(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result.split(',')[1];
        resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', data });
      };
      reader.readAsDataURL(file);
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1048576).toFixed(1) + 'MB';
  }

  function addInputPart(part) {
    const key = `${part?.kind || ''}:${part?.path || part?.url || ''}`;
    const exists = currentInputParts.some(candidate => (
      `${candidate?.kind || ''}:${candidate?.path || candidate?.url || ''}` === key
    ));
    if (!exists) currentInputParts.push({ ...part });
    renderAttachTray();
  }

  function renderAttachTray() {
    if (currentAttachments.length === 0 && currentInputParts.length === 0) {
      // 先清空再隐藏：只隐藏的话最后一个 chip 会连同它那个指向旧下标的 onclick 闭包
      // 一起留在 DOM 里。
      attachTray.innerHTML = '';
      attachTray.hidden = true;
      applyComposerMode();
      return;
    }
    attachTray.hidden = false;
    attachTray.innerHTML = '';
    const approxBytes = a => Math.round(a.data.length * 0.75);
    for (let i = 0; i < currentAttachments.length; i++) {
      const a = currentAttachments[i];
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.innerHTML = `<span class="attach-chip-name">${escHtml(a.name)}</span>`
        + `<span class="attach-chip-size">${formatBytes(approxBytes(a))}</span>`
        + `<button class="attach-chip-remove" data-idx="${i}">✕</button>`;
      chip.querySelector('.attach-chip-remove').onclick = event => {
        event.stopPropagation();
        currentAttachments.splice(i, 1);
        renderAttachTray();
      };
      chip.onclick = () => {
        const preview = attachmentPreview(a);
        if (preview.kind !== 'image') return;
        const modal = $('attach-preview-modal');
        const img = $('attach-preview-img');
        if (img) img.src = preview.src;
        if (modal) modal.hidden = false;
      };
      attachTray.appendChild(chip);
    }
    for (let i = 0; i < currentInputParts.length; i++) {
      const part = currentInputParts[i];
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      const prefix = part.kind === 'skill'
        ? '$'
        : (part.kind === 'imageUrl' ? `${icon('image')} ` : '@');
      chip.innerHTML = `<span class="attach-chip-name">${prefix}${escHtml(part.name || part.url || part.path || '')}</span>`
        + `<button class="attach-chip-remove" data-part-idx="${i}">✕</button>`;
      chip.querySelector('.attach-chip-remove').onclick = () => {
        currentInputParts.splice(i, 1);
        renderAttachTray();
      };
      attachTray.appendChild(chip);
    }
    applyComposerMode();
  }

  // Session drawer
  function resetDrawerScroll() {
    const body = $('drawer-body');
    if (body) body.scrollTop = 0;
    const active = document.querySelector('#drawer-projects .drawer-project-block.active');
    if (active && body && active.offsetTop > 48) body.scrollTop = active.offsetTop - 8;
  }

  let drawerOpenedAt = 0;
  $('menu-btn').onclick = () => {
    drawerOpenedAt = Date.now();
    expandedDirs = loadExpandedDirs(localStorage, serverCwd);
    refreshNativeThreads();
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
    resetDrawerScroll();
  };

  function closeDrawer() {
    drawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
  }
  drawerOverlay.onclick = closeDrawer;
  $('drawer-close').onclick = closeDrawer;
  $('drawer-archived-toggle').onclick = toggleArchivedThreads;

  $('header-context').onclick = () => {
    workspacePanel.open();
  };
  $('header-home').onclick = goHome;
  $('header-new').onclick = () => {
    createNewSession();
    closeDrawer();
  };
  $('confirm-modal')?.addEventListener('click', event => {
    if (event.target === $('confirm-modal')) confirmDialog.close();
  });
  messagesEl.addEventListener('click', event => {
    const copyBtn = event.target.closest('.code-copy-btn');
    if (!copyBtn) return;
    const code = copyBtn.closest('.code-block-wrap')?.querySelector('code')?.textContent || '';
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code);
    else fallbackCopyText(code);
  });

  applyComposerMode();
  renderDrawerProject();
  renderDrawerProjects();
  renderArchivedToggle();
  setConnectionPhase('connecting');

  // Helper for push VAPID key

})();
