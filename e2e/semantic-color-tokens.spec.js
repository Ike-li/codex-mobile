// e2e/semantic-color-tokens.spec.js —— 语义色 token 的表征测试(characterization test)。
//
// 三个横幅(#conn-banner 三态、#pending-panel、#needs-you-panel)与 diff 行的
// 背景/描边/文字色原本是逐处硬编码。把它们迁到 color-mix() 派生的 token 体系是纯重构,
// 没有"新行为"可写成 red-green;这份快照的作用是把"观感不变"变成机器可验证的定义:
// 迁移前先跑绿,迁移后任何未预期的颜色漂移都会在这一个 toEqual 里整体暴露。
//
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

// getComputedStyle 对 color-mix() 的结果序列化成 `color(srgb 0.9 0.95 0.88)`,
// 对字面 hex/rgba 则序列化成 `rgb()/rgba()`。两种写法描述同一个颜色,直接比字符串
// 会把"声明写法变了"误判成"用户看到的颜色变了"。统一归一到 0–255 整数通道再断言。
async function readSemanticColors(page) {
  return page.evaluate(() => {
    const doc = globalThis.document;
    const win = doc.defaultView;

    const normalize = raw => {
      const srgb = String(raw).match(
        /^color\(srgb\s+([\d.+-eE]+)\s+([\d.+-eE]+)\s+([\d.+-eE]+)(?:\s*\/\s*([\d.+-eE]+))?\)$/,
      );
      if (!srgb) return String(raw);
      const [r, g, b] = [srgb[1], srgb[2], srgb[3]].map(v => Math.round(Number(v) * 255));
      const alpha = srgb[4] === undefined ? 1 : Number(srgb[4]);
      return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const read = (el, props) => {
      const computed = win.getComputedStyle(el);
      return Object.fromEntries(props.map(prop => [prop, normalize(computed[prop])]));
    };

    const out = {};

    // #conn-banner 三态:背景/描边/文字都由 data-tone 切换,逐态采样。
    const banner = doc.getElementById('conn-banner');
    for (const tone of ['info', 'warn', 'success']) {
      banner.dataset.tone = tone;
      out[`connBanner.${tone}`] = read(banner, ['backgroundColor', 'borderTopColor', 'color']);
    }
    delete banner.dataset.tone;

    out['pendingPanel'] = read(doc.getElementById('pending-panel'), ['backgroundColor', 'borderTopColor']);

    // .needs-you-heading 由 app.js 动态注入,静态页面里没有;临时补一个再还原。
    const needs = doc.getElementById('needs-you-panel');
    const savedNeedsHtml = needs.innerHTML;
    needs.innerHTML = '<div class="needs-you-heading"><span>需要你</span><span>1</span></div>';
    out['needsYouPanel'] = read(needs, ['backgroundColor', 'borderTopColor']);
    out['needsYouHeading'] = read(needs.querySelector('.needs-you-heading'), ['color']);
    needs.innerHTML = savedNeedsHtml;

    // .diff-add/.diff-del 由 workspace-panel.js 在 git diff 视图里生成,mock 工作区不是
    // git 仓库,拿不到真实 diff。这里直接挂上同样的 class 探针,验的是同一条 CSS 规则。
    const probe = doc.createElement('pre');
    probe.className = 'diff-line diff-add';
    doc.body.append(probe);
    out['diffAdd'] = read(probe, ['backgroundColor']);
    probe.className = 'diff-line diff-del';
    out['diffDel'] = read(probe, ['backgroundColor']);
    probe.remove();

    return out;
  });
}

async function connect(page) {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
}

test.describe('语义色 token 快照(浅色)', () => {
  // 注释里的 hex 是迁移前的手调值。三档由 --info/--warn/--success 与 --surface/--text
  // 按混比派生,多数通道 Δ≤5 不可辨;两处可辨的归位见下面标注。
  test('横幅与 diff 行的三件套配色', async ({ page }) => {
    await connect(page);
    expect(await readSemanticColors(page)).toEqual({
      'connBanner.info': {
        backgroundColor: 'rgb(230, 240, 250)', // was #e8f4ff (232,244,255)
        borderTopColor: 'rgb(193, 217, 243)', // was #c5dff5 (197,223,245)
        color: 'rgb(13, 13, 13)', // --info-text 就是 --text,不变
      },
      'connBanner.warn': {
        backgroundColor: 'rgb(251, 243, 226)', // was #fff4e0 (255,244,224)
        borderTopColor: 'rgb(242, 213, 155)', // was #f0d49a (240,212,154)
        // 归位①:was #6e4c00 (110,76,0)。它和 #9a5f22(RTT 芯片)本就是同一角色的两个
        // 不一致手调值,统一到 --warn-text 是目的;蓝通道 +14,ΔE≈4。
        color: 'rgb(110, 78, 14)',
      },
      // 2026-09-14 去绿:--success 并入中性 --accent,这一档整体从绿变灰。
      // 三个通道各自相等说明它真的落在中性轴上,没有残留色相。
      'connBanner.success': {
        backgroundColor: 'rgb(226, 226, 226)', // was 绿底 rgb(228,243,237)
        borderTopColor: 'rgb(139, 139, 139)', // was 绿边 rgb(145,208,185)
        color: 'rgb(13, 13, 13)', // was 绿字 rgb(22,108,76);现在就是 --text
      },
      pendingPanel: {
        backgroundColor: 'rgb(251, 243, 226)',
        borderTopColor: 'rgb(242, 213, 155)',
      },
      needsYouPanel: {
        backgroundColor: 'rgb(251, 243, 226)',
        borderTopColor: 'rgb(242, 213, 155)',
      },
      needsYouHeading: { color: 'rgb(110, 78, 14)' },
      // 去绿后新增行是中性灰、删除行仍是红,这一对不再对称——「全部换掉,含 diff」
      // 的已知代价,不是漏改。
      diffAdd: { backgroundColor: 'rgba(13, 13, 13, 0.12)' },
      diffDel: { backgroundColor: 'rgba(223, 28, 28, 0.1)' },
    });
  });
});

test.describe('语义色 token 快照(深色)', () => {
  test.use({ colorScheme: 'dark' });

  // 深色的三档原本是逐元素手调、彼此不在同一条混色射线上(例如 #163044 的红通道 22
  // 比中性面 #1c1c1c 的 28 还低,任何"面 + 色"的加法混合都到不了),所以这里的 Δ 比
  // 浅色略大。全部 ≤10 且集中在暗色上,感知差异很小。
  test('横幅与 diff 行的三件套配色', async ({ page }) => {
    await connect(page);
    expect(await readSemanticColors(page)).toEqual({
      'connBanner.info': {
        backgroundColor: 'rgb(32, 48, 65)', // was #163044 (22,48,68)
        borderTopColor: 'rgb(36, 70, 106)', // was #2a4a66 (42,74,102)
        color: 'rgb(242, 242, 242)', // --info-text 就是 --text,不变
      },
      'connBanner.warn': {
        backgroundColor: 'rgb(57, 47, 26)', // was #3a2c14 (58,44,20)
        borderTopColor: 'rgb(91, 68, 24)', // was #5a4520 (90,69,32)
        color: 'rgb(229, 180, 84)', // was #e0b05a (224,176,90)
      },
      // 去绿:深色档同样落到中性轴上,方向相反(亮面混进暗底)。
      'connBanner.success': {
        backgroundColor: 'rgb(54, 54, 54)', // was 绿底 rgb(30,49,38)
        borderTopColor: 'rgb(99, 99, 99)', // was 绿边 rgb(34,86,56)
        color: 'rgb(242, 242, 242)', // was 薄荷绿字 rgb(134,221,171);现在就是 --text
      },
      pendingPanel: {
        backgroundColor: 'rgb(57, 47, 26)',
        borderTopColor: 'rgb(91, 68, 24)',
      },
      needsYouPanel: {
        backgroundColor: 'rgb(57, 47, 26)',
        borderTopColor: 'rgb(91, 68, 24)',
      },
      needsYouHeading: { color: 'rgb(229, 180, 84)' },
      diffAdd: { backgroundColor: 'rgba(242, 242, 242, 0.2)' },
      diffDel: { backgroundColor: 'rgba(223, 28, 28, 0.18)' },
    });
  });
});
