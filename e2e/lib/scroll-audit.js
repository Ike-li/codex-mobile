// e2e/lib/scroll-audit.js —— 滚动连续性体检：把「一跳一跳」变成会变红的断言。
//
// 【为什么需要它】已有的滚动用例断言的是**位置正确性**——流式时贴底、用户上滑后
// 不抢回、点「跳到最新」能回到底部。这些全绿的同时，滚动可以是每 ~100ms 硬跳 46px
// 的，用户一眼看出顿挫，四条断言一条都没红。
//
// 这里补的是另一个维度：不问「滚没滚到位」，问「滚得连不连贯」。
//
// 【判据为什么是静止帧占比】瞬时 scrollTop 赋值下实测 92% 的帧纹丝不动、剩下 8%
// 整齐跳 46px。跳变幅度本身不是好判据——它取决于行高和内容到达速率，换个 fixture
// 就得换阈值；而「内容在长、视口却不动的帧占多少」直接对应用户看到的顿挫，且对
// 时序不敏感：插值一旦生效，每次跳变都会摊成连续多帧的运动。
//
// 这个文件住在 e2e/lib/ 而不是 spec 里，和 layout-audit.js 同一个原因：主体是一段
// 传给 page.evaluate 的浏览器代码，需要 browser globals。

/**
 * 在浏览器里逐帧采样某个滚动容器的 scrollTop，返回运动的连续性指标。
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} scope 滚动容器的选择器
 * @param {number} durationMs 采样时长
 */
export async function sampleScrollContinuity(page, scope, durationMs) {
  return page.evaluate(async ({ scope: selector, durationMs: duration }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`scroll-audit: 找不到 ${selector}`);

    const samples = [];
    await new Promise(resolve => {
      const started = performance.now();
      const tick = () => {
        samples.push(el.scrollTop);
        if (performance.now() - started >= duration) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const steps = [];
    for (let i = 1; i < samples.length; i += 1) steps.push(samples[i] - samples[i - 1]);
    // 0.5px 以下算静止：亚像素滚动和浮点误差不该被当成运动。
    const moved = steps.filter(step => step > 0.5).sort((a, b) => a - b);

    return {
      frames: samples.length,
      totalScrolled: samples.length ? samples[samples.length - 1] - samples[0] : 0,
      stillRatio: steps.length ? (steps.length - moved.length) / steps.length : 1,
      maxStep: moved.length ? moved[moved.length - 1] : 0,
      medianStep: moved.length ? moved[Math.floor(moved.length / 2)] : 0,
    };
  }, { scope, durationMs });
}
