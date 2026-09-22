export function resolveComposerPrimaryMode({
  turnRunning = false,
  hasContent = false,
  interruptPending = false,
} = {}) {
  if (turnRunning && hasContent) {
    return {
      mode: 'send',
      enabled: interruptPending !== true,
      visible: true,
      followUpVisible: false,
      stopVisible: interruptPending !== true,
    };
  }
  if (turnRunning) {
    return {
      mode: 'stop',
      enabled: interruptPending !== true,
      visible: true,
      followUpVisible: false,
      stopVisible: false,
    };
  }
  return {
    mode: 'send',
    enabled: hasContent === true,
    visible: hasContent === true,
    followUpVisible: false,
    stopVisible: false,
  };
}
