// src/shared/serial-writer.js —— 串行落盘：防抖 + 在飞合并 + 退出前 fence。
//
// 解决两个真实的写竞争：
//   ① 两次异步写重叠时，**rename 的顺序不保证**——旧快照可能覆盖新态，而两次写都报成功。
//   ② 退出路径的同步写不 fence 在飞的异步写，那笔异步写会在 flush 之后落地，把刚写的
//      权威态盖回旧的。症状是「退出前保存了，重启回来还是旧的」。
//
// 用法：writer.schedule() 请求一次落盘；writer.fence() 作废所有在飞的写。

export function createSerialWriter({ write, delayMs = 200, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  let inFlight = null;
  let generation = 0;

  async function run(myGeneration) {
    try {
      await write();
    } catch { /* 落盘失败不该冒泡到调用方——位点是缓存类，丢一次不致命 */ }
    if (myGeneration === generation) inFlight = null;
  }

  return {
    /** 请求一次落盘。窗口内的多次请求合并成一次。 */
    schedule() {
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        const myGeneration = generation;
        inFlight = run(myGeneration);
      }, delayMs);
    },

    /**
     * 作废所有在飞与待发的写。
     *
     * 退出路径必须先 fence 再做同步权威写，否则在飞的那笔会后落地、盖回旧态。
     */
    fence() {
      if (timer) { clearTimer(timer); timer = null; }
      generation += 1;
      inFlight = null;
    },

    /** 仅测试用：等在飞的写落完。 */
    async drain() {
      if (timer) { clearTimer(timer); timer = null; inFlight = run(generation); }
      await inFlight;
    },
  };
}
