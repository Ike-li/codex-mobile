import { diffLineModels } from '/js/files/diff-lines.js';
import { icon } from '/js/ui/icons.js';
// 解码只留一份。本文件原先自带一个 `decodeURIComponent(escape(atob()))` 版本，
// 与 app.js 用的 TextDecoder 版行为不同（多字节 UTF-8 与非字符串输入都不一样），
// 于是同一个文件在两个面板里可能显示成两个样子。
import { decodeBase64Text } from '/js/util/client-encoding.js';
import { buildPreview, truncationNotice } from '/js/files/file-preview.js';

export function createWorkspacePanel({
  modal,
  filesTab,
  changesTab,
  filesTools,
  gitTools,
  filesBody,
  changesBody,
  pathEl,
  backBtn,
  gitBranchEl,
  socket,
  getCwd,
  escHtml,
  onMention,
} = {}) {
  let currentPath = '';
  let activeTab = 'files';

  function show() {
    if (modal) modal.hidden = false;
  }

  function hide() {
    if (modal) modal.hidden = true;
  }

  function setTab(tab) {
    activeTab = tab === 'changes' ? 'changes' : 'files';
    filesTab?.classList.toggle('active', activeTab === 'files');
    changesTab?.classList.toggle('active', activeTab === 'changes');
    if (filesBody) filesBody.hidden = activeTab !== 'files';
    if (changesBody) changesBody.hidden = activeTab !== 'changes';
    if (filesTools) filesTools.hidden = activeTab !== 'files';
    if (gitTools) gitTools.hidden = activeTab !== 'changes';
  }

  function parentPath(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    return `/${parts.slice(0, -1).join('/')}`;
  }

  function joinPath(base, name) {
    return `${String(base || '').replace(/\/+$/, '')}/${name}`;
  }

  function setMessage(target, text) {
    if (!target) return;
    target.innerHTML = `<div class="workspace-empty">${escHtml(text)}</div>`;
  }

  function loadFiles(path) {
    const cwd = getCwd();
    const targetPath = path || cwd || '/';
    currentPath = targetPath;
    if (pathEl) pathEl.textContent = targetPath;
    if (backBtn) {
      const parent = parentPath(targetPath);
      const rooted = cwd && (targetPath === cwd || !targetPath.startsWith(cwd));
      backBtn.hidden = Boolean(rooted) || !parent;
    }
    socket.emit('fs:readDirectory', { path: targetPath, cwd }, ack => {
      if (!ack?.ok) {
        setMessage(filesBody, ack?.error || '无法读取目录');
        return;
      }
      const entries = ack.entries || [];
      if (!filesBody) return;
      if (!entries.length) {
        setMessage(filesBody, '空目录');
        return;
      }
      filesBody.innerHTML = entries.map(entry => {
        const child = joinPath(targetPath, entry.fileName);
        const kind = entry.isDirectory ? 'dir' : 'file';
        const mention = entry.isDirectory
          ? ''
          : `<span class="workspace-row-action" data-mention="${escHtml(child)}">引用</span>`;
        return `<div class="workspace-row" data-kind="${kind}" data-path="${escHtml(child)}">
          <span class="workspace-entry-label">${entry.isDirectory ? icon('folder') : icon('file')} ${escHtml(entry.fileName)}</span>
          ${mention}
        </div>`;
      }).join('');
    });
  }

  function loadFile(path) {
    socket.emit('fs:readFile', { path, cwd: getCwd() }, ack => {
      if (!ack?.ok) {
        setMessage(filesBody, ack?.error || '无法读取文件');
        return;
      }
      const preview = buildPreview(decodeBase64Text(ack.dataBase64 || ''), { maxChars: 8000 });
      if (pathEl) pathEl.textContent = path;
      if (backBtn) backBtn.hidden = false;
      if (!filesBody) return;
      const notice = truncationNotice(preview);
      filesBody.innerHTML = `<pre class="workspace-preview">${escHtml(preview.body)}</pre>`
        + (notice ? `<div class="workspace-section">${escHtml(notice)}</div>` : '')
        + `<button type="button" class="workspace-mention-btn" data-mention="${escHtml(path)}">引用到输入框</button>`;
    });
  }

  function renderGitSection(title, items, side) {
    if (!items?.length) return '';
    return `<div class="workspace-section">${escHtml(title)}（${items.length}）</div>`
      + items.map(item => `<button type="button" class="workspace-row" data-git-path="${escHtml(item.path)}" data-git-side="${side || ''}">
        <span>${escHtml(item.path)}</span>
      </button>`).join('');
  }

  function loadGit() {
    socket.emit('git:status', { cwd: getCwd() }, ack => {
      if (gitBranchEl) gitBranchEl.textContent = ack?.branch || '';
      if (!changesBody) return;
      if (!ack?.ok) {
        setMessage(changesBody, ack?.error || '无法读取 git 状态');
        return;
      }
      const html = [
        renderGitSection('已暂存', ack.staged, 'staged'),
        renderGitSection('未暂存', ack.unstaged, 'unstaged'),
        renderGitSection('未跟踪', ack.untracked, ''),
        renderGitSection('冲突', ack.conflicted, ''),
      ].join('');
      changesBody.innerHTML = html || '<div class="workspace-empty">工作区干净</div>';
    });
  }

  function loadDiff(relPath, side) {
    if (!side) return;
    socket.emit('git:diff', { cwd: getCwd(), path: relPath, side }, ack => {
      if (!ack?.ok) {
        setMessage(changesBody, ack?.error || '无法读取 diff');
        return;
      }
      const lines = diffLineModels(ack.patch || '');
      changesBody.innerHTML = `<div class="workspace-section">${escHtml(relPath)}</div>`
        + lines.map(line => `<pre class="diff-line diff-${line.tone}">${escHtml(line.text)}</pre>`).join('');
    });
  }

  function handleMention(path) {
    if (typeof onMention === 'function') onMention(path);
  }

  filesBody?.addEventListener('click', event => {
    const mention = event.target.closest('[data-mention]');
    if (mention) {
      event.preventDefault();
      handleMention(mention.dataset.mention);
      return;
    }
    const row = event.target.closest('[data-kind]');
    if (!row) return;
    if (row.dataset.kind === 'dir') loadFiles(row.dataset.path);
    else loadFile(row.dataset.path);
  });

  changesBody?.addEventListener('click', event => {
    const row = event.target.closest('[data-git-path]');
    if (!row) return;
    loadDiff(row.dataset.gitPath, row.dataset.gitSide);
  });

  backBtn?.addEventListener('click', () => {
    const cwd = getCwd();
    const parent = parentPath(currentPath);
    loadFiles(parent && parent.startsWith(cwd) ? parent : cwd);
  });

  filesTab?.addEventListener('click', () => {
    setTab('files');
    loadFiles(currentPath || getCwd());
  });
  changesTab?.addEventListener('click', () => {
    setTab('changes');
    loadGit();
  });

  return {
    open(tab = 'files') {
      const next = tab === 'changes' ? 'changes' : 'files';
      setTab(next);
      show();
      if (next === 'changes') loadGit();
      else loadFiles(getCwd());
    },
    close: hide,
    refreshGit: loadGit,
    isOpen() {
      return modal ? !modal.hidden : false;
    },
  };
}
