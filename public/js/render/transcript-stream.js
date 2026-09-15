export function createTranscriptStream({
  delayMs = 40,
  schedule = setTimeout,
  cancel = clearTimeout,
  onStart = () => {},
  onText = () => {},
  onFinish = () => {},
} = {}) {
  let active = false;
  let text = '';
  let paintedText = '';
  let timer = null;

  function flush() {
    timer = null;
    if (!active || paintedText === text) return;
    paintedText = text;
    onText(text);
  }

  return {
    append(delta) {
      const chunk = String(delta ?? '');
      if (!chunk) return text;
      if (!active) {
        active = true;
        text = '';
        paintedText = '';
        onStart();
      }
      text += chunk;
      if (timer === null) timer = schedule(flush, delayMs);
      return text;
    },

    finish() {
      if (!active) return '';
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      flush();
      const completedText = text;
      onFinish(completedText);
      active = false;
      text = '';
      paintedText = '';
      return completedText;
    },
  };
}
