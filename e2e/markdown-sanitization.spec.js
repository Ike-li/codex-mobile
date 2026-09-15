// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts
//
// agent 的输出不是可信输入：它会读任意文件、抓网页、执行命令，产出的 markdown 会被
// renderMarkdown 渲染进手机的 DOM。这条路是这个项目唯一把外部内容变成页面结构的地方。
//
// 为什么必须在真浏览器里测：test/markdown.test.mjs 用的是测试文件里手写的正则消毒器，
// 另外两条直接用 `sanitize: value => value`（原样返回）。那些用例验证的是替身的行为，
// 不是 DOMPurify 的。而生产代码里 enhanceCodeBlocks 跑在 sanitize **之后**——消毒完成
// 后又对 HTML 字符串做了一轮拼接——在「压根没有消毒」的替身下，这种消毒后注入根本
// 无法被发现。
//
// 判据是「脚本执行了没有」，只有真浏览器答得了。SANITIZE_CONFIG 被改、操作顺序被调、
// 或者 vendor 里的 DOMPurify/marked 升级，这里都会红。
import { test, expect } from '@playwright/test';

// [名称, markdown 输入, 渲染后不得出现的东西]
const PAYLOADS = [
  ['裸 script 标签', '<script>window.__xss=1</script>', /<script/i],
  ['img onerror', '<img src=x onerror="window.__xss=1">', /onerror/i],
  ['svg onload', '<svg onload="window.__xss=1"></svg>', /onload/i],
  ['details ontoggle', '<details open ontoggle="window.__xss=1">x</details>', /ontoggle/i],
  ['iframe srcdoc', '<iframe srcdoc="<script>window.__xss=1</script>"></iframe>', /<iframe/i],
  ['javascript: 链接', '[click](javascript:window.__xss=1)', /javascript:/i],
  // 下面三条针对 enhanceCodeBlocks 的消毒后拼接：代码块内容必须保持转义，
  // 围栏语言串不能钻进 class 属性，伪造的 </code></pre> 不能提前闭合我们自己拼的结构。
  ['代码块里的 script', '```\n<script>window.__xss=1</script>\n```', /<script/i],
  ['围栏语言串注入属性', '```js onmouseover=window.__xss=1\ncode\n```', /onmouseover/i],
  ['伪造 code-block 闭合', '```\n</code></pre><img src=x onerror="window.__xss=1">\n```', /<img/i],
  // UI 劫持：这几项 DOMPurify 默认允许，是 SANITIZE_CONFIG 额外挡掉的。
  ['form 劫持', '<form action="//evil.example"><button>发送</button></form>', /<form|<button/i],
  ['label 指向真实按钮', '<label for="send-btn">点我</label>', /<label|\sfor=/i],
  ['style 全屏覆盖', '<p style="position:fixed;inset:0;z-index:9999">x</p>', /\sstyle=/i],
];

test.describe('agent 输出渲染的消毒边界', () => {
  test('恶意 markdown 既不执行脚本，也不留下可用于劫持的标签和属性', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });

    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const results = await page.evaluate(async payloads => {
      const { renderMarkdown } = await import('/js/render/markdown.js');
      const host = globalThis.document.createElement('div');
      host.id = 'xss-probe-host';
      globalThis.document.body.appendChild(host);
      const out = [];
      for (const [name, markdown] of payloads) {
        // 真的插进 DOM：只看返回的字符串会漏掉「插入时才触发」的那一类。
        host.innerHTML = renderMarkdown(markdown, globalThis);
        out.push({ name, html: host.innerHTML });
      }
      host.remove();
      return out;
    }, PAYLOADS.map(([name, markdown]) => [name, markdown]));

    for (const [index, [name, , forbidden]] of PAYLOADS.entries()) {
      expect(results[index].name, `payload 顺序错位：${name}`).toBe(name);
      expect(
        results[index].html,
        `「${name}」渲染后仍含 ${forbidden}——渲染的是 agent 输出，而 agent 会读任意文件和网页`,
      ).not.toMatch(forbidden);
    }

    // 最终判据：不是「字符串里没有 onerror」，而是「什么都没执行」。
    expect(await page.evaluate(() => globalThis.__xss ?? null), '有 payload 真的执行了').toBeNull();
    expect(dialogs, '有 payload 弹出了对话框').toEqual([]);
  });

  test('正常 markdown 该渲染的照常渲染，消毒不是把内容全删了', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const html = await page.evaluate(async () => {
      const { renderMarkdown } = await import('/js/render/markdown.js');
      return renderMarkdown('**粗体** 与 `行内代码`\n\n```js\nconst ok = 1\n```\n\n[链接](https://example.com)', globalThis);
    });

    expect(html).toMatch(/<strong>粗体<\/strong>/);
    expect(html).toMatch(/<code>行内代码<\/code>/);
    expect(html).toMatch(/code-block-wrap/);
    expect(html).toMatch(/code-copy-btn/);
    expect(html).toMatch(/hljs/);
    // 外链必须带 noopener：不带的话新标签页能通过 window.opener 改写原页面。
    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).toMatch(/target="_blank"/);
  });
});
