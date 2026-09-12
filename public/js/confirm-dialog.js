export function createConfirmController({
  modal,
  titleEl,
  bodyEl,
  inputWrap,
  inputEl,
  okBtn,
  cancelBtn,
} = {}) {
  let pending = null;

  function finish(value) {
    if (modal) modal.hidden = true;
    const resolve = pending;
    pending = null;
    if (resolve) resolve(value);
  }

  // 泛化的「确定」让用户在点下去的瞬间不知道自己在确认什么，危险操作尤其如此。
  // 调用处一直在传 confirmText，只是从没被读过——静默失效，没有任何东西会报错。
  const DEFAULT_OK_TEXT = '确定';

  function open({
    title = '', body = '', mode = 'confirm', initial = '', danger = false,
    confirmText = DEFAULT_OK_TEXT,
  } = {}) {
    if (pending) finish(mode === 'prompt' ? null : false);
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = body || '';
    if (inputWrap) inputWrap.hidden = mode !== 'prompt';
    if (inputEl) {
      inputEl.value = mode === 'prompt' ? String(initial ?? '') : '';
      if (mode === 'prompt') {
        inputEl.focus?.();
        inputEl.select?.();
      }
    }
    if (okBtn) {
      okBtn.dataset.danger = danger ? 'true' : 'false';
      // 每次都写，不能只在传了 confirmText 时写：否则上一次的「删除」会留在按钮上。
      okBtn.textContent = confirmText || DEFAULT_OK_TEXT;
    }
    if (modal) modal.hidden = false;
    return new Promise(resolve => {
      pending = resolve;
    });
  }

  if (okBtn) {
    okBtn.onclick = () => {
      if (inputWrap && !inputWrap.hidden) {
        const value = String(inputEl?.value ?? '').trim();
        finish(value || null);
        return;
      }
      finish(true);
    };
  }
  if (cancelBtn) cancelBtn.onclick = () => finish(inputWrap && !inputWrap.hidden ? null : false);

  return {
    confirm(options = {}) {
      return open({ ...options, mode: 'confirm' });
    },
    prompt(options = {}) {
      return open({ ...options, mode: 'prompt' });
    },
    close() {
      finish(inputWrap && !inputWrap.hidden ? null : false);
    },
  };
}
