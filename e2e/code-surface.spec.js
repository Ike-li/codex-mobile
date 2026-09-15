// e2e/code-surface.spec.js —— 代码块与终端输出的表面色。
//
// 这两处过去硬编码 #1e1e1e，浅色界面里是一整块纯黑，视觉上像挖了个洞。
// ChatGPT 桌面端的做法是跟随主题：--codex-diffs-surface 取的就是 var(--color-surface)，
// 靠 color-mix(in oklab, … 50%, transparent) 拉开层次，浅色主题下落在 #ececec 那一档。
//
// 判据是绝对的（多浅算浅、对比度够不够），不是快照——颜色是有意改的，
// 快照式断言在这里只会拦住改动本身。
//
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';
import { contrastRatio, luminanceOf } from './lib/contrast.js';

const ANSI_NAMES = ['bold', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'muted'];

// 这些元素都由 app.js 在运行时生成，静态页面里没有；临时补出同样的结构再还原，
// 手法同 semantic-color-tokens.spec.js。
async function readCodeSurfaces(page) {
  return page.evaluate(names => {
    const doc = globalThis.document;
    const win = doc.defaultView;
    const host = doc.getElementById('messages');

    // class 必须和真实 DOM 一致：命令输出是 `tool-output live-output tool-ok`
    // （app.js:3165）。只写 .tool-output 的话，.live-output 上那条后定义、
    // 同特异性的 color 就测不到——它正是 2026-09-15 那次「输出整块隐形」的原因。
    const toolOutput = doc.createElement('div');
    toolOutput.className = 'tool-output live-output tool-ok';
    host.appendChild(toolOutput);

    const errOutput = doc.createElement('div');
    errOutput.className = 'tool-output live-output tool-err';
    host.appendChild(errOutput);

    const ansi = {};
    for (const name of names) {
      const span = doc.createElement('span');
      span.className = `ansi-${name}`;
      span.textContent = 'x';
      toolOutput.appendChild(span);
      ansi[name] = win.getComputedStyle(span).color;
    }

    const turn = doc.createElement('div');
    turn.className = 'msg codex';
    const bubble = doc.createElement('div');
    bubble.className = 'bubble md';
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    // 真实结构里这个 class 是 language-*（enhanceCodeBlocks 从 marked 的输出带过来的），
    // 不是 .hljs——所以 hljs 主题里那条 .hljs{background} 在本项目其实从不生效，
    // 代码块的底色一直由 pre 决定。
    code.className = 'language-js';
    pre.appendChild(code);
    bubble.appendChild(pre);
    turn.appendChild(bubble);
    host.appendChild(turn);

    const outputStyle = win.getComputedStyle(toolOutput);
    const errStyle = win.getComputedStyle(errOutput);
    const preStyle = win.getComputedStyle(pre);
    const result = {
      toolOutput: { bg: outputStyle.backgroundColor, fg: outputStyle.color },
      toolErr: { bg: errStyle.backgroundColor, fg: errStyle.color },
      codeBlock: { bg: preStyle.backgroundColor, fg: preStyle.color },
      ansi,
    };

    toolOutput.remove();
    errOutput.remove();
    turn.remove();
    return result;
  }, ANSI_NAMES);
}

test.describe('代码块与终端输出的表面色', () => {
  test('浅色主题下不是黑底', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    const surfaces = await readCodeSurfaces(page);
    expect(luminanceOf(surfaces.toolOutput.bg), '终端输出在浅色主题下应是浅底').toBeGreaterThan(0.5);
    expect(luminanceOf(surfaces.codeBlock.bg), '代码块在浅色主题下应是浅底').toBeGreaterThan(0.5);
  });

  test('深色主题下仍是深底', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    const surfaces = await readCodeSurfaces(page);
    expect(luminanceOf(surfaces.toolOutput.bg), '终端输出在深色主题下应是深底').toBeLessThan(0.1);
    expect(luminanceOf(surfaces.codeBlock.bg), '代码块在深色主题下应是深底').toBeLessThan(0.1);
  });

  // ANSI 九色原本全部为深底挑的（.ansi-bold 是纯白），浅底上必须换一套，
  // 否则「读不了」会取代「不好看」成为新问题。4.5:1 是 WCAG AA 的正文档。
  for (const scheme of ['light', 'dark']) {
    test(`${scheme} 主题下 ANSI 九色在终端底上都过 AA`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/');
      await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

      const surfaces = await readCodeSurfaces(page);
      const bg = surfaces.toolOutput.bg;
      const failures = [];
      for (const [name, fg] of Object.entries(surfaces.ansi)) {
        const ratio = contrastRatio(fg, bg);
        if (ratio < 4.5) failures.push(`ansi-${name}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
      }
      expect(failures, failures.join('\n')).toHaveLength(0);
    });

    // 输出块自己的正文色和失败态的红，和 ANSI 同等重要——2026-09-15 隐形的
    // 正是前者（.live-output 硬编码 #f1f1f1，压在改浅后的底上 1.1:1）。
    test(`${scheme} 主题下输出正文与失败态都读得了`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/');
      await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

      const surfaces = await readCodeSurfaces(page);
      const body = contrastRatio(surfaces.toolOutput.fg, surfaces.toolOutput.bg);
      const err = contrastRatio(surfaces.toolErr.fg, surfaces.toolErr.bg);
      expect(body, `输出正文 ${surfaces.toolOutput.fg} on ${surfaces.toolOutput.bg} = ${body.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);
      expect(err, `失败态 ${surfaces.toolErr.fg} on ${surfaces.toolErr.bg} = ${err.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);
    });
  }
});
