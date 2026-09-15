export function resolveComposerPrimaryMode({
  turnRunning = false,
  hasContent = false,
  interruptPending = false,
} = {}) {
  if (turnRunning) {
    return {
      mode: 'stop',
      enabled: interruptPending !== true,
      visible: true,
      followUpVisible: hasContent === true && interruptPending !== true,
    };
  }
  return {
    mode: 'send',
    enabled: hasContent === true,
    visible: hasContent === true,
    followUpVisible: false,
  };
}
