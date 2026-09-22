/**
 * 长按手势的判定逻辑。DOM 事件绑定留在调用方，这里只回答「这次按下算不算长按」。
 *
 * moveTolerance 不是可有可无的：会话列表是可滚动的，手指按住往上滑是滚动意图。
 * 没有容差的话，滚动一下就弹出菜单。
 */
export function createLongPress({
  onLongPress,
  delayMs = 500,
  moveTolerance = 10,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  function stop() {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  return {
    // 给 click 处理用：长按之后 pointerup 照样会合成一次 click，不看这个标志
    // 就会「弹出菜单的同时把会话也打开了」。
    get fired() {
      return fired;
    },
    start(x, y) {
      stop();
      fired = false;
      startX = x;
      startY = y;
      timer = schedule(() => {
        timer = null;
        fired = true;
        onLongPress?.();
      }, delayMs);
    },
    move(x, y) {
      if (timer === null) return;
      if (Math.hypot(x - startX, y - startY) > moveTolerance) stop();
    },
    end() {
      stop();
    },
  };
}
