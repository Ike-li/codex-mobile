// e2e/lib/contrast.js —— WCAG 对比度计算。
//
// 判据是绝对的，不是快照：语义色那份 spec 用 toEqual 锁住「观感不变」，适合纯重构；
// 这里守的是「这个前景色在这个背景上读不读得了」，在颜色**有意改变**时仍然成立。
//
// 纯函数，不碰 DOM——颜色由 spec 从浏览器读出来再传进来，所以这个文件不需要
// browser globals，e2e/*.spec.js 可以直接 import。

/** 把 getComputedStyle 给出的 rgb()/rgba() 解析成 [r, g, b]（0–255）。 */
export function parseRgb(value) {
  const match = String(value).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!match) throw new Error(`contrast: 解析不了颜色 ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG 2.x 相对亮度。0 = 纯黑，1 = 纯白。 */
export function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map(channel => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度，1:1 到 21:1。 */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(parseRgb(foreground));
  const b = relativeLuminance(parseRgb(background));
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** 亮度便捷式，用来断言「这个面是浅的还是深的」。 */
export function luminanceOf(value) {
  return relativeLuminance(parseRgb(value));
}
