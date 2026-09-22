// e2e/critical-flows.spec.js —— 关键用户旅程 E2E 测试。
import { test, expect } from '@playwright/test';
import { sampleScrollContinuity } from './lib/scroll-audit.js';

function latestApprovalCard(page) {
  return page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
}

test.describe('关键用户旅程', () => {

  test('创建任务 + 流式输出', async ({ page }) => {
    await page.goto('/');

    // Wait for the page to load and socket to connect
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // Type a message and send
    const input = page.locator('#msg-input');
    await input.fill('hello world');
    await page.locator('#send-btn').click();

    // User message bubble should appear
    await expect(page.locator('.msg.user').filter({ hasText: 'hello world' }).last()).toBeVisible();

    // Codex response should stream in (mock returns "Mock response to: hello world")
    await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: hello world' }).last()).toBeVisible({ timeout: 10000 });

    // Status should return to idle
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  // 这条过去断言的是「发 /status 给模型、模型回一句话」——那是 bug 期的行为：
  // app-server 不解析斜杠命令，那一发只是往对话里塞了句 "/status"。
  test('斜杠命令 /status 打开会话设置，而不是发给模型', async ({ page }) => {
    await page.goto('/');

    // Wait for connection and idle state
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const input = page.locator('#msg-input');
    await input.fill('/status');
    await page.locator('#send-btn').click();

    await expect(page.locator('#session-settings')).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(page.locator('.msg.user')).toHaveCount(0);
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  test('发送中断信号', async ({ page }) => {
    await page.goto('/');

    // Wait for connection and idle
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // Send a message
    const input = page.locator('#msg-input');
    // 必须用 SLOW_TURN（mock 里 sleep 6000）而不是任意文本：通用路径的回应是
    // `Mock response to: <input>`，逐字符 10ms 流式推送，整个 turn 只有约 270ms。
    // 这条用例要在那之内走完「断言离开 idle → 断言按钮变 stop → 点击」三步，
    // 窗口一关 turn 就自然结束、按钮翻回 send，那一下点成了发送——于是
    // state-label 是 idle 但「已中断」永远不出现。在 macOS/Chromium 上勉强够快，
    // 在 Linux WebKit 上必然输掉。本文件其余点 stop 的用例一直用的就是 SLOW_TURN。
    await input.fill('SLOW_TURN');
    await page.locator('#send-btn').click();

    // Wait for state to leave idle (message sent)
    await expect(page.locator('#state-label')).not.toHaveText('idle', { timeout: 5000 });

    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'stop');
    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await expect(page.getByText('已中断').last()).toBeVisible({ timeout: 10000 });
  });

  test('进行中可追加一条，停止钮仍可中断', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('SLOW_TURN');
    await page.locator('#send-btn').click();
    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'stop', { timeout: 5000 });
    await expect(page.locator('#followup-btn')).toBeHidden();

    await page.locator('#msg-input').fill('FOLLOW_UP');
    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'send');
    await expect(page.locator('#followup-btn')).toBeVisible();
    await expect(page.locator('#followup-btn')).toHaveAttribute('data-mode', 'stop');
    await page.locator('#send-btn').click();

    await expect(page.locator('.msg.user').filter({ hasText: 'FOLLOW_UP' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('已向当前运行任务追加指令').last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#followup-btn')).toBeHidden();
    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'stop');

    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  test('页面加载后显示 header 元素', async ({ page }) => {
    await page.goto('/');

    // Header should be visible
    await expect(page.locator('#header')).toBeVisible();
    await expect(page.locator('#header-context')).toBeVisible();
    // session-meta is hidden by default (CSS display:none), only shown on tap
    await expect(page.locator('#session-meta')).toBeAttached();
  });

  test('助手回复按 Markdown 渲染', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('MARKDOWN_FIXTURE');
    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const bubble = page.locator('.msg.codex .bubble.md').last();
    await expect(bubble.locator('strong')).toHaveText('bold');
    await expect(bubble.locator('code')).toHaveText('code');
    await expect(bubble.locator('li')).toHaveCount(2);
  });

  // 这条过去断言的是「流式期间 strong/code/li 计数为 0」——即全程显示 markdown
  // 源码，收尾才渲染。那是 fd84592 的决策，动机是避免 markdown 结构边流边翻转。
  //
  // 动机成立，但「稳定」和「渲染」并不互斥：被空行闭合的块后续文本改不了它，
  // 提前渲染同样稳定。splitStreamingMarkdown 把文本切成这样的 stable 前缀和
  // active 尾部，前者渲染一次不再重建（单调性由 test/markdown-stream.test.mjs
  // 逐字回放守着），后者才随写随更新。收益是整轮结束时不再有源码→渲染的突变。
  test('流式阶段就渲染已定型的 Markdown，不等整轮结束', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('STREAMING_MARKDOWN_FIXTURE');
    await page.locator('#send-btn').click();

    const bubble = page.locator('.msg.codex .bubble.md').last();
    const turn = bubble.locator('..');
    await expect(bubble).toHaveAttribute('data-streaming', 'true', { timeout: 10000 });
    await expect(turn).toHaveAttribute('aria-busy', 'true');

    // fixture 的第一段被空行闭合后就进 stable。这里要的是它**在流式途中**
    // 已经是渲染态：紧跟的 aria-busy 断言负责证明那一刻还没收尾。
    await expect(bubble.locator('strong')).toHaveText('bold', { timeout: 10000 });
    await expect(bubble.locator('code')).toHaveText('code');
    await expect(turn).toHaveAttribute('aria-busy', 'true');

    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await expect(bubble).not.toHaveAttribute('data-streaming', 'true');
    await expect(turn).not.toHaveAttribute('aria-busy', 'true');
    await expect(bubble.locator('strong')).toHaveText('bold');
    await expect(bubble.locator('code')).toHaveText('code');
    await expect(bubble.locator('li')).toHaveCount(2);
  });

  // 入场动画只给**实时发送**的气泡，不给历史回放——切会话时几十条一起滑入是灾难。
  // 两者本来就是分开的代码路径（appendUserBubble 与 appendHistoryUserBubble），
  // 动画类只挂在前者上。
  test('新发送的用户气泡有入场动画', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('hello motion');
    await page.locator('#send-btn').click();

    const bubble = page.locator('.msg.user').filter({ hasText: 'hello motion' }).last();
    await expect(bubble).toBeVisible();

    const anim = await bubble.evaluate(el => {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      return { name: cs.animationName, duration: cs.animationDuration };
    });
    expect(anim.name).toBe('slideUp');
    expect(parseFloat(anim.duration)).toBeGreaterThan(0);
  });

  // 判据是「有多少帧是静止的」：内容在长、视口却纹丝不动的那些帧，就是用户看到
  // 的顿挫。瞬时 scrollTop = scrollHeight 下实测 92% 的帧静止，剩下 8% 整齐地跳
  // 46px（两行高）—— 约 10fps 的跳动。这条测的是运动的连续性，不是滚动的正确性,
  // 后者由下面那条「不抢回滚动位置」守。
  test('流式跟随是连续滚动，不是一跳一跳', async ({ page, browserName }) => {
    // WebKit 上不跑：不是它有 bug，也不是我们不在乎它——是这个环境里**没有可测对象**。
    // 滚动跟随用 rAF 插值实现（见 20ad2c7），而 Linux 的 Playwright WebKit 几乎不产帧。
    // 实测（playwright:v1.61.1-noble 官方镜像，与 CI 同族），rAF 空转 1 秒的帧数：
    //   macOS WebKit 61  ·  Linux WebKit 1
    // 于是插值推不动、采样器也一起饿死：同一条用例 totalScrolled 在 macOS 上是 1046，
    // 在 Linux 上是 22（阈值 200）。headed + xvfb 只把它抬到 96，仍然不够。
    // 把阈值调到 22 能过等于不再测任何东西——判据测的是运动的连续性，而那里没有运动。
    //
    // ⚠ 代价要说清楚：产品主设备是 iPhone，排除之后滚动跟随的连续性只在 Chromium 上
    // 有覆盖，真机顺不顺只能人工验。这一条已登记进 playwright.config.js 里
    // 「WebKit 验不了什么」那张清单，不是可以忘掉的事。
    test.skip(browserName === 'webkit', 'Linux WebKit 的 rAF 约 1fps，动画连续性在此无法测量');
    await page.setViewportSize({ width: 390, height: 520 });
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('SCROLL_STREAM_FIXTURE');
    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).not.toHaveText('idle', { timeout: 10000 });

    // fixture 是 90 行 × 35ms ≈ 3.1s，采 2s 落在流式中段。
    const motion = await sampleScrollContinuity(page, '#messages', 2000);
    expect(motion.totalScrolled).toBeGreaterThan(200); // 先确认真的在滚，否则下面的比例没有意义
    expect(motion.stillRatio).toBeLessThan(0.7);
  });

  test('用户上滑阅读时流式输出不抢回滚动位置', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 520 });
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('SCROLL_STREAM_FIXTURE');
    await page.locator('#send-btn').click();

    const bubble = page.locator('.msg.codex .bubble.md').last();
    await expect(bubble).toContainText('line-030', { timeout: 10000 });
    await page.locator('#messages').evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });

    await expect(page.locator('#jump-to-latest')).toBeVisible();
    await expect(bubble).toContainText('line-050', { timeout: 10000 });
    await expect.poll(() => page.locator('#messages').evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2);
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  // 从上面那条拆出来的。两段测的是不同行为，而且**只有这一段依赖动画帧**：
  // 上面测「不滚动」，不需要帧；这里测「点完之后要一路跟上还在增长的内容」，
  // 靠的是 rAF 插值（scrollBottom 那一下是瞬时的，之后交给 followRaf 续着跟）。
  //
  // 合在一条里的代价是实测出来的：2026-09-22 CI 上这条连红两轮，而本地容器怎么跑
  // 都过。拿到 CI 的失败截图才看清——「有新内容」按钮仍然亮着、正文停在 line-070
  // 而流已经走到更后面，距底 581/742px。成因与「流式跟随是连续滚动」同一个：
  // Linux WebKit 的 rAF 约 1fps（macOS 61），插值追不上内容增长的速度。
  // 不拆的话，webkit 上会连带失去上面那段本来好好的覆盖。
  test('点「有新内容」后重新贴底，并收起该入口', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Linux WebKit 的 rAF 约 1fps，流式期间的贴底跟随无法收敛');
    await page.setViewportSize({ width: 390, height: 520 });
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('SCROLL_STREAM_FIXTURE');
    await page.locator('#send-btn').click();

    const bubble = page.locator('.msg.codex .bubble.md').last();
    await expect(bubble).toContainText('line-030', { timeout: 10000 });
    await page.locator('#messages').evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator('#jump-to-latest')).toBeVisible();

    await page.locator('#jump-to-latest').click();
    await expect.poll(() => page.locator('#messages').evaluate(element => (
      element.scrollHeight - element.clientHeight - element.scrollTop
    ))).toBeLessThanOrEqual(2);
    await expect(page.locator('#jump-to-latest')).toBeHidden();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  test('同一 turn 的正文和工具按事件顺序组合展示', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('TURN_GROUP_FIXTURE');
    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const turns = page.locator('#messages > .assistant-turn');
    await expect(turns).toHaveCount(1);
    const turn = turns.first();
    await expect(turn.locator(':scope > .bubble.md')).toHaveCount(2);
    await expect(turn.locator(':scope > .bubble.md').first()).toContainText('Before the tool.');
    await expect(turn.locator(':scope > .tool-card')).toContainText('printf grouped');
    await expect(turn.locator(':scope > .bubble.md').last()).toContainText('After the tool.');
    await expect(turn).not.toHaveAttribute('data-active', 'true');

    // turn 收尾会在活动区和最终回复之间插一条「用时 N 秒」，末尾再挂一排操作按钮。
    // 这条守的仍是正文与工具的相对顺序——divider 和操作条单独分类，免得它们被
    // 归进 'text' 之后，顺序断言看起来还是对的，实际上已经分不清谁是谁。
    const order = await turn.locator(':scope > *').evaluateAll(elements => elements.map(element => {
      if (element.classList.contains('tool-card')) return 'tool';
      if (element.classList.contains('worked-for')) return 'divider';
      if (element.classList.contains('turn-actions')) return 'actions';
      return 'text';
    }));
    expect(order).toEqual(['text', 'tool', 'divider', 'text', 'actions']);
  });

  test('reasoning 默认紧凑且尊重用户展开状态', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('REASONING_STREAM_FIXTURE');
    await page.locator('#send-btn').click();

    const fold = page.locator('.assistant-turn .reasoning-fold').last();
    await expect(fold).toBeAttached({ timeout: 10000 });
    await expect(fold).not.toHaveAttribute('open', '');
    await expect(fold.locator('.reasoning-label')).toHaveText('正在思考');

    await fold.locator('.reasoning-toggle').click();
    await expect(fold).toHaveAttribute('open', '');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await expect(fold).toHaveAttribute('open', '');
    // 完成态带耗时（「已思考 4秒」）；mock 下这一轮可能不到一秒，那时退回
    // 「已完成思考」。两种都以「已」开头——这条守的是时态从现在时切到了过去时，
    // 钉死某个秒数只会变成一条随机红的用例。
    await expect(fold.locator('.reasoning-label')).toHaveText(/^已(思考 .+|完成思考)$/);
  });

  test('输入区域元素存在', async ({ page }) => {
    await page.goto('/');

    // Input area elements
    await expect(page.locator('#msg-input')).toBeVisible();
    await expect(page.locator('#send-btn')).toBeHidden();
    await expect(page.locator('#interrupt-btn')).toHaveCount(0);
    await expect(page.locator('#attach-btn')).toBeVisible();
  });

  test('移动端视口布局正确', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // Header should be visible
    await expect(page.locator('#header')).toBeVisible();

    // Input area should be at the bottom
    const inputArea = page.locator('#input-area');
    await expect(inputArea).toBeVisible();

    // Messages container should exist
    await expect(page.locator('#messages')).toBeAttached();
  });

  test('软键盘弹起时布局自适应', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 520 }); // Simulate keyboard up
    await page.goto('/');

    // Input should still be visible
    await expect(page.locator('#msg-input')).toBeVisible();
    await expect(page.locator('#attach-btn')).toBeVisible();
  });

  test('会话恢复：刷新后重新连接', async ({ page }) => {
    await page.goto('/');

    // Wait for connection
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // Send a message first
    const input = page.locator('#msg-input');
    await input.fill('before refresh');
    await page.locator('#send-btn').click();

    // Wait for response
    await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: before refresh' }).last()).toBeVisible({ timeout: 10000 });

    // Refresh the page
    await page.reload();

    // Should reconnect
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('.msg.user').filter({ hasText: 'before refresh' }).last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: before refresh' }).last()).toBeVisible({ timeout: 10000 });
  });

  test('审批流程：发送需要审批的命令并批准', async ({ page }) => {
    await page.goto('/');

    // Wait for connection and idle
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // Send a message that triggers approval (mock recognizes 'approve' keyword)
    const input = page.locator('#msg-input');
    await input.fill('approve this command');
    await page.locator('#send-btn').click();

    // Wait for approval card to appear (uses .approve-btn class)
    const approveCard = latestApprovalCard(page);
    await expect(approveCard).toBeVisible({ timeout: 10000 });

    // Click the approve button
    await approveCard.getByRole('button', { name: '批准' }).click();

    // Wait for the turn to complete (command executed after approval)
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 15000 });

    // 命令跑完后活动行会收起，退出码折在里面。成功不在行上留标记是有意的：
    // 成功是常态，每条都缀一个 ✓ 只会淹没真正需要注意的失败（失败走 data-ok=false，
    // 行首变红并缀「· 失败」）。所以这里点开再验退出码。
    const row = page.locator('.command-card').last();
    await expect(row).toHaveAttribute('data-ok', 'true', { timeout: 10000 });
    await row.locator('.activity-toggle').click();
    await expect(row.getByText('exit: 0')).toBeVisible({ timeout: 10000 });
  });

  test('审批流程：拒绝审批', async ({ page }) => {
    await page.goto('/');

    // Wait for connection and idle
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // Send a message that triggers approval
    const input = page.locator('#msg-input');
    await input.fill('approve this command');
    await page.locator('#send-btn').click();

    // Wait for approval card to appear
    const declineCard = latestApprovalCard(page);
    await expect(declineCard).toBeVisible({ timeout: 10000 });

    // Click the decline button (uses .deny-btn class)
    await declineCard.getByRole('button', { name: '拒绝' }).click();

    // Wait for the turn to complete (declined)
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 15000 });

    // Should see decline message
    await expect(page.locator('.msg.system-msg, .msg.error-msg').filter({ hasText: 'declined' }).last()).toBeVisible({ timeout: 10000 });
  });

});
