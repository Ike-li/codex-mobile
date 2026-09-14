// e2e/layout-sanity.spec.js —— 布局体检的绊线用例。
//
// coverage: docs/TESTING.md
//
// 这里放的是「读不读得了」那一类判据，和 markdown-typography.spec.js 的「会不会崩」
// 互补。后者曾经四条断言全绿，而宽表格的中文列被挤到 49px 宽、压成一根竖条。
import { test, expect } from '@playwright/test';
import { auditLayout, formatIssues, overlayAllowlist } from './lib/layout-audit.js';

async function sendAndRender(page, prompt, ready) {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  await page.locator('#msg-input').fill(prompt);
  await page.locator('#send-btn').click();
  await expect(ready(page)).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
}

test('宽表格的每一列都读得了，没有被挤成竖条的正文', async ({ page }) => {
  await sendAndRender(page, 'RICH_MARKDOWN_FIXTURE', p => p.locator('.msg.codex .bubble.md table').last());

  const { scanned, issues } = await auditLayout(page, '.msg.codex .bubble.md');

  expect(issues, formatIssues('.msg.codex .bubble.md', issues)).toEqual([]);
  // 这块区域确实满是文字，扫到 0 个就是失明。auditLayout 内部也会把这种情况报成
  // scan-collapsed，这里再钉一次是因为 fixture 一旦被改空，上面那条会平凡地通过。
  expect(scanned, '富文本气泡里应该扫到大量文本元素').toBeGreaterThan(10);
});

test('允许遮挡正文的浮层，每条都写明了理由', async () => {
  const allow = overlayAllowlist();
  // 扫到 0 条和「每条都合规」在断言上无法区分，而前者意味着清单被整个删空了。
  expect(allow.size, '豁免清单是空的——要么真的没有豁免，要么这道检查失明了').toBeGreaterThan(0);

  for (const [sel, reason] of allow) {
    // 「因为它遮挡」不是理由。要求足够长，逼人写出为什么这个遮挡是有意的、
    // 以及试过什么别的做法——否则这个表会变成堆放「懒得修」的地方。
    expect(reason?.length ?? 0, `${sel} 的豁免理由太短，说不清为什么这个遮挡是有意的`)
      .toBeGreaterThan(40);
  }
});

test('消息流的卡片按优先级分档，四档的左边框色两两不同', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  // 先要一批工具卡（action / outcome / meta），再要一张审批卡（decision）。
  await page.locator('#msg-input').fill('TOOL_CARDS_FIXTURE');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 20000 });
  await page.locator('#msg-input').fill('approve this command');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card').filter({ hasText: '需要审批' })).toBeVisible({ timeout: 10000 });

  const r = await page.evaluate(() => {
    const all = [...globalThis.document.querySelectorAll('.tool-card')];
    const byKind = new Map();
    const missing = [];
    const borderedRows = [];
    for (const c of all) {
      const kind = c.dataset.card;
      if (!kind) { missing.push((c.textContent || '').trim().slice(0, 16)); continue; }
      // 活动行是统一的低权重过程，不参与分色——它们的左边框必须是 0。
      if (c.classList.contains('activity-row')) {
        if (parseFloat(globalThis.getComputedStyle(c).borderLeftWidth) > 0) {
          borderedRows.push((c.textContent || '').trim().slice(0, 16));
        }
        continue;
      }
      if (!byKind.has(kind)) byKind.set(kind, globalThis.getComputedStyle(c).borderLeftColor);
    }
    return { total: all.length, missing, borderedRows, kinds: Object.fromEntries(byKind) };
  });

  expect(r.total, '没渲染出卡片，这条用例什么都没验到').toBeGreaterThan(3);
  // 新增一类卡片却忘了分档时在这里红——默认值落在「必须显式分档」那一侧。
  // 活动行同样要带 data-card，所以这条仍覆盖全部 .tool-card。
  expect(r.missing, `这些卡片没有 data-card 分档：${r.missing.join(' / ')}`).toEqual([]);

  // 工具活动压成一行灰字之后，「过程」这一层就不该再有颜色语义了——给某一类活动行
  // 单独描个边，等于把刚降下去的视觉权重又提回来。
  expect(r.borderedRows, `这些活动行带了左边框，破坏了过程层的统一低权重：${r.borderedRows.join(' / ')}`)
    .toEqual([]);

  // 剩下的卡片（审批、计划、变更摘要）必须真的产生视觉差异。只断言「属性值不同」
  // 是不够的——CSS 没写时属性齐全而颜色全一样，那正是这条规则要防的状态。
  //
  // 阈值从 >2 降到 >=2：过程类不再分档之后，有边框的就只剩 decision 和 outcome 两档。
  // 这不是放松，是档位总数真的变少了。
  const kinds = Object.keys(r.kinds);
  expect(kinds.length, `只出现了 ${kinds.length} 档卡片，覆盖不足`).toBeGreaterThanOrEqual(2);
  const colors = Object.values(r.kinds);
  expect(new Set(colors).size, `分档 ${JSON.stringify(r.kinds)} 的左边框色有重复——分了档但看不出来`)
    .toBe(colors.length);

  // 审批必须就地处理掉：整轮 e2e 共享一个 mock server，挂着不管的审批会堆进
  // 「需要你」，把 needs-you-recovery 里「精确恢复某一条」的前提搅乱——实测漏掉
  // 这一步后，那个 spec 在全量跑里稳定变红，而它自己单独跑是绿的。
  await page.locator('.tool-card').filter({ hasText: '需要审批' }).last()
    .locator('.deny-btn').click();
});

test('终端输出块贴到卡片边缘，不被三层 padding 连续吃掉宽度', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  await page.locator('#msg-input').fill('TOOL_CARDS_FIXTURE');
  await page.locator('#send-btn').click();
  // 判据要落在本轮的产物上。只等 #state-label 变 idle 是不够的——发送后它还没
  // 转成 busy 时这条就立即通过了，后面的测量会跑在一个还没渲染任何东西的页面上
  // （实测 .tool-output 一个都扫不到，用例平凡地失败在可见性上而不是宽度上）。
  // 「用时 N 秒」是 turn 收完尾才插入的，等它同时保证了内容齐全和 turn 结束。
  await expect(page.locator('.worked-for').last()).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 20000 });

  // 活动行收起后终端块没有 layout box，量不到宽度。这条量的是 CSS 布局不是交互，
  // 所以直接把所有折叠层摊开——逐层模拟点击要处理「组里套行」两级嵌套，
  // 碎在选择器上不产生任何关于宽度的信息。
  await page.evaluate(() => {
    for (const d of globalThis.document.querySelectorAll('#messages details')) d.open = true;
    // .msg 带 content-visibility: auto：视口外的子树整个跳过渲染，量出来的宽度是 0，
    // 而且滚进视口后要等一帧才解冻。量尺寸之前先解冻——这不改变元素真实进入视口后的
    // 布局，只是让测量不依赖渲染时序。
    for (const m of globalThis.document.querySelectorAll('#messages .msg')) {
      m.style.contentVisibility = 'visible';
    }
  });
  // 取本轮最后一个终端块，不取 first()：整轮 e2e 共享 mock server，goto 会把前面
  // spec 的历史一起恢复，first() 会落在视口外的历史消息上——那里的 .msg 带
  // content-visibility: auto，跳过渲染的子树没有 layout box，连滚过去都做不到。
  //
  // 排除 .tool-json 是因为它是 JSON dump，字号比终端块大一档，拿它算列数
  // 量的不是同一个东西。
  const out = page.locator('#messages .tool-output:not(.tool-json)').last();
  await out.scrollIntoViewIfNeeded();
  await expect(out).toBeVisible({ timeout: 10000 });

  const m = await page.evaluate(() => {
    const list = globalThis.document.querySelectorAll('#messages .tool-output:not(.tool-json)');
    const out = list[list.length - 1];
    const card = out.closest('.tool-card');
    const cs = globalThis.getComputedStyle(out);
    const probe = globalThis.document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;font:${cs.font}`;
    probe.textContent = '0'.repeat(80);
    globalThis.document.body.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 80;
    probe.remove();
    const contentW = out.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return {
      cardW: Math.round(card.getBoundingClientRect().width),
      outW: Math.round(out.getBoundingClientRect().width),
      cols: Math.floor(contentW / ch),
    };
  });

  // 终端块应当基本占满卡片宽度（含卡片自身的 1px + 3px 边框，留 8px 容差）。
  // 改之前它缩在卡片 padding 里，比卡片窄 30px。
  expect(m.outW, `终端块 ${m.outW}px 明显窄于卡片 ${m.cardW}px，宽度被中间层 padding 吃掉了`)
    .toBeGreaterThan(m.cardW - 12);
  // 列数是用户真正感知的量，但它受字体渲染影响，跨浏览器不是同一个数：实测
  // chromium 50 列、webkit 48 列（Menlo 的字符比 chromium 默认等宽略宽）。
  // 所以这条只守「不退回改之前的水平」（chromium 改前 46 列），不追某个绝对值——
  // 钉死 50 会让 webkit 恒红，而那不是缺陷。
  // 注意：393px 视口下 11px 等宽最多约 53 列，达不到终端惯用的 80 列，那是物理限制。
  expect(m.cols, `每行只能显示 ${m.cols} 个等宽字符，退回了改动之前的水平`)
    .toBeGreaterThanOrEqual(46);
});

test('卡片里的自然语言不套用代码样式', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  await page.locator('#msg-input').fill('TOOL_CARDS_FIXTURE');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 20000 });

  const r = await page.evaluate(() => {
    const bodyFont = globalThis.getComputedStyle(globalThis.document.body).fontFamily;
    const pick = el => {
      const cs = globalThis.getComputedStyle(el);
      return {
        text: (el.textContent || '').trim().slice(0, 22),
        mono: /mono/i.test(cs.fontFamily),
        breakAll: cs.wordBreak === 'break-all',
        sansLikeBody: cs.fontFamily === bodyFont,
      };
    };
    // 计划步骤：自然语言的待办项，不是命令。
    const plan = [...globalThis.document.querySelectorAll('.tool-card')]
      .find(c => (c.querySelector('.tool-name')?.textContent || '').includes('计划'));
    // 搜索结果摘要：一句话说明，不是终端输出。搜索改成活动行之后标题挪进了
    // .activity-label，原来的 .tool-name 只剩计划这类卡片还在用。
    const snippet = [...globalThis.document.querySelectorAll('.tool-card')]
      .find(c => (c.querySelector('.activity-label')?.textContent || '').includes('已搜索网页'));
    return {
      planSteps: plan ? [...plan.children].slice(1).map(pick) : [],
      snippets: snippet ? [...snippet.querySelectorAll('.tool-note, .tool-output')].map(pick) : [],
    };
  });

  expect(r.planSteps.length, '没找到计划步骤，用例什么都没验到').toBeGreaterThan(0);
  expect(r.snippets.length, '没找到搜索摘要，用例什么都没验到').toBeGreaterThan(0);

  for (const item of [...r.planSteps, ...r.snippets]) {
    // 等宽的价值是对齐（代码缩进、终端列）。给句子用等宽只换来「技术感」，
    // 代价是移动端小字号下辨识度下降。
    expect(item.mono, `「${item.text}」是自然语言，却用了等宽字体`).toBe(false);
    // .tool-cmd 的 break-all 对路径是必需的，对句子会把英文单词从中间劈开。
    expect(item.breakAll, `「${item.text}」用了 word-break: break-all，英文单词会被劈开`).toBe(false);
  }
});

test('turn 跑起来时输入区不窜高：控件挤不下要横向让位，不是换行', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  // 先跑一轮，让上下文表出现——它只在拿到用量之后才渲染，而它正是把这一行挤爆的那一个。
  await page.locator('#msg-input').fill('让上下文表出现');
  await page.locator('#send-btn').click();
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 20000 });
  await expect(page.locator('#context-meter')).toBeVisible({ timeout: 8000 });

  const rowHeight = () => page.locator('.input-controls-row')
    .evaluate(el => Math.round(el.getBoundingClientRect().height));
  const idleHeight = await rowHeight();

  // 最坏情况由 JS 直接摆出来，不去等真实 turn 的时序：这条测的是「CSS 在控件全部
  // 在场时还能不能保持单行」，而按时序抓这一瞬极易变成偶发红（实测 #state-label
  // 在 turn 真正开始前就已经是 idle）。
  //
  // 关键是**同时**留着上下文表：turn 进行中它本来会被收起，胶囊区只剩一个元素、
  // 怎么排都不会换行，于是这条断言测不到 composer-chips 的 flex 布局——第一版就是
  // 这样，把 display:flex 摘掉仍然全绿。这里显式把它放回场上，让胶囊区真的放不下。
  await page.locator('#msg-input').fill('打字中的内容');
  await page.evaluate(() => {
    const doc = globalThis.document;
    doc.querySelector('#input-area').toggleAttribute('data-turn-busy', true);
    doc.querySelector('#mini-status-spinner').style.display = 'flex';
    doc.querySelector('#followup-btn').hidden = false;
    doc.querySelector('#send-btn-container').hidden = false;
    const send = doc.querySelector('#send-btn');
    send.hidden = false;
    send.disabled = false;
    send.dataset.mode = 'stop';
  });

  const crowdedHeight = await page.evaluate(() => {
    const doc = globalThis.document;
    const meter = doc.querySelector('#context-meter');
    const restore = meter.style.display;
    meter.style.display = 'inline-flex';
    const h = Math.round(doc.querySelector('.input-controls-row').getBoundingClientRect().height);
    meter.style.display = restore;
    return h;
  });
  // 改动前这里会从 40px 变成 80px：composer-chips 曾经是 block 容器，里面两个
  // inline-flex 胶囊放不下就换行，把整个输入区顶高一截。
  expect(crowdedHeight, `控件行从 ${idleHeight}px 窜到 ${crowdedHeight}px——胶囊换行了`)
    .toBe(idleHeight);

  const busyHeight = await rowHeight();
  expect(busyHeight, '收起上下文表之后仍然应当是单行').toBe(idleHeight);

  // 而且不能剩半个胶囊露在外面被右侧控件切掉：放不下就整个收起。
  const meterClipped = await page.evaluate(() => {
    const m = globalThis.document.querySelector('#context-meter');
    const box = m.getBoundingClientRect();
    if (!box.width) return false; // 已收起，符合预期
    const chips = globalThis.document.querySelector('#composer-chips').getBoundingClientRect();
    return box.right > chips.right + 1;
  });
  expect(meterClipped, '上下文表只剩半个露在胶囊区外，被右侧控件切掉了').toBe(false);
});
