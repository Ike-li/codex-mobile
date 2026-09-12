import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmController } from '../public/js/confirm-dialog.js';

function fakeEl(initial = {}) {
  const el = {
    hidden: initial.hidden ?? true,
    className: initial.className || '',
    textContent: '',
    value: initial.value || '',
    dataset: {},
    classList: {
      add(name) { el.className = `${el.className} ${name}`.trim(); },
      remove(name) { el.className = el.className.split(/\s+/).filter(item => item && item !== name).join(' '); },
      contains(name) { return el.className.split(/\s+/).includes(name); },
    },
    focus() { el.focused = true; },
    select() { el.selected = true; },
  };
  return el;
}

function harness() {
  const modal = fakeEl();
  const titleEl = fakeEl();
  const bodyEl = fakeEl();
  const inputWrap = fakeEl();
  const inputEl = fakeEl({ value: 'old' });
  const okBtn = fakeEl();
  const cancelBtn = fakeEl();
  const controller = createConfirmController({
    modal,
    titleEl,
    bodyEl,
    inputWrap,
    inputEl,
    okBtn,
    cancelBtn,
  });
  return { modal, titleEl, bodyEl, inputWrap, inputEl, okBtn, cancelBtn, controller };
}

test('confirm resolves true on ok and false on cancel', async () => {
  const { controller, modal, inputWrap, okBtn, cancelBtn, titleEl } = harness();
  const pending = controller.confirm({ title: '删除会话', body: '不可恢复' });
  assert.equal(modal.hidden, false);
  assert.equal(titleEl.textContent, '删除会话');
  assert.equal(inputWrap.hidden, true);
  okBtn.onclick();
  assert.equal(await pending, true);
  assert.equal(modal.hidden, true);

  const cancelled = controller.confirm({ title: '再问一次' });
  cancelBtn.onclick();
  assert.equal(await cancelled, false);
});

test('prompt returns trimmed text or null and never resolves empty as a value', async () => {
  const { controller, inputWrap, inputEl, okBtn, cancelBtn } = harness();
  const pending = controller.prompt({ title: '重命名', initial: '  Draft  ' });
  assert.equal(inputWrap.hidden, false);
  assert.equal(inputEl.value, '  Draft  ');
  inputEl.value = '  Ready  ';
  okBtn.onclick();
  assert.equal(await pending, 'Ready');

  const empty = controller.prompt({ title: '空' });
  inputEl.value = '   ';
  okBtn.onclick();
  assert.equal(await empty, null);

  const cancelled = controller.prompt({ title: '取消', initial: 'keep' });
  cancelBtn.onclick();
  assert.equal(await cancelled, null);
});

// 危险确认必须看起来危险、说清楚在确认什么。两条都来自实拍：「允许完全访问？」
// 这个本应用最高风险的操作，确认按钮是黑色实心主按钮（视觉上最突出、在鼓励点击），
// 按钮文字是泛化的「确定」——调用处其实传了 confirmText: '允许完全访问'，
// 但 open() 根本不认这个参数，静默失效。
test('danger 确认把 OK 按钮标成危险态', async () => {
  const { controller, okBtn } = harness();
  const pending = controller.confirm({ title: '允许完全访问？', danger: true });
  assert.equal(okBtn.dataset.danger, 'true');
  controller.close();
  await pending;
});

test('confirmText 覆盖 OK 按钮文字，让用户看到自己在确认什么', async () => {
  const { controller, okBtn } = harness();
  const pending = controller.confirm({ title: '允许完全访问？', confirmText: '允许完全访问' });
  assert.equal(okBtn.textContent, '允许完全访问');
  controller.close();
  await pending;
});

test('没给 confirmText 时回到默认文案，不会留着上一次的', async () => {
  const { controller, okBtn } = harness();
  const first = controller.confirm({ title: '删除？', confirmText: '删除' });
  controller.close();
  await first;
  const second = controller.confirm({ title: '继续？' });
  assert.equal(okBtn.textContent, '确定');
  controller.close();
  await second;
});
