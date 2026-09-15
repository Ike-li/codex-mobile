// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

async function openDrawer(page) {
  const drawer = page.locator('#drawer');
  const isOpen = await drawer.evaluate(el => el.classList.contains('open')).catch(() => false);
  if (!isOpen) {
    await page.locator('#menu-btn').click();
    await expect(drawer).toHaveClass(/open/);
  }
  return drawer;
}

// 造一行真实会话:mock app-server 的 thread/list 只回放跑过 turn 的会话。
async function seedOneThread(page) {
  await page.locator('#msg-input').fill('hello');
  await page.locator('#send-btn').click();
  await expect(page.locator('#messages .bubble').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: hello' }).last()).toBeVisible({ timeout: 10000 });
  // 必须等这一轮真的结束:turn 收尾会再触发一次列表刷新,不等它就会拿到中间态的行数。
  // (mock server 跨用例共享 threadHistory,基线取错会让相对计数整条崩掉。)
  await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'send', { timeout: 10000 });
}

async function firstSessionRow(page) {
  await openDrawer(page);
  const expander = page.locator('#drawer-projects .dir-toggle').first();
  const alreadyOpen = await page.locator('#drawer-projects .dir-subtree.expanded').count();
  if (!alreadyOpen) await expander.click();
  const row = page.locator('#drawer-projects .session-item').first();
  await expect(row).toBeVisible({ timeout: 10000 });
  // 等新建的当前会话进入列表；旧会话先可见时不能提前记录行数基线。
  await expect(page.locator('#drawer-projects .session-item.active')).toBeVisible({ timeout: 10000 });
  return row;
}

// 长按：按住不动超过阈值。用 mouse 而不是 tap——tap 是瞬时的，产生不了
// pointerdown 与 pointerup 之间的那段停顿。
//
// 先 hover 再取坐标不是多此一举：boundingBox() + page.mouse 绕过了 Playwright
// 的 actionability 检查，而抽屉是滑入的，toBeVisible() 在动画途中就会通过。
// 直接取 box 会拿到还在视口左侧之外的坐标（实测 x = -177），鼠标点到屏幕外，
// 事件一个都派发不出去。hover() 会等到元素**位置稳定**才返回。
async function longPress(page, locator, ms = 600) {
  await locator.hover();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function openThreadMenu(page, row) {
  await longPress(page, row);
  const menu = page.locator('#thread-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('抽屉里的会话操作', () => {
  test('长按会话弹出操作菜单，列表里不再常驻按钮', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await seedOneThread(page);

    const row = await firstSessionRow(page);
    // 条目本身只剩标题和时间：三个按钮撑得每条 ~100px，一屏看不到几条。
    await expect(row.locator('[data-action]')).toHaveCount(0);

    const menu = await openThreadMenu(page, row);
    await expect(menu.locator('[data-action="rename"]')).toBeVisible();
    await expect(menu.locator('[data-action="archive"]')).toBeVisible();
    await expect(menu.locator('[data-action="delete"]')).toBeVisible();
  });

  test('从抽屉拉起的确认框盖在抽屉之上,而不是躲在它后面', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await seedOneThread(page);

    const row = await firstSessionRow(page);
    const menu = await openThreadMenu(page, row);
    await menu.locator('[data-action="delete"]').click();

    const modal = page.locator('#confirm-modal');
    await expect(modal).toBeVisible();

    // 判据是合成后的命中测试,不是 z-index 数值:抽屉停靠在左侧 300px,
    // 确认卡片铺满宽度。若 sheet 排在抽屉下面,左侧这一列点到的就会是抽屉。
    const card = page.locator('#confirm-modal .sheet-card');
    const box = await card.boundingBox();
    expect(box, '确认卡片应已完成布局').toBeTruthy();
    const probeX = Math.round(box.x + 40); // 落在抽屉覆盖的横向区间内
    const probeY = Math.round(box.y + box.height / 2);
    const owner = await page.evaluate(([x, y]) => {
      const el = globalThis.document.elementFromPoint(x, y);
      return el?.closest('#drawer') ? 'drawer' : (el?.closest('#confirm-modal') ? 'confirm' : 'other');
    }, [probeX, probeY]);
    expect(owner, '确认卡片左半边不能被抽屉夺走命中').toBe('confirm');

    // 取消后确认框收起,会话仍在原地。
    await page.locator('#confirm-cancel').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#drawer-projects .session-item').first()).toBeVisible();
  });

  test('Archive 先问一句再动手,取消后会话还在', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await seedOneThread(page);

    const row = await firstSessionRow(page);
    const menu = await openThreadMenu(page, row);
    await menu.locator('[data-action="archive"]').click();

    // 归档过去是静默执行的,会话直接从列表消失。现在必须先出现一张说明卡。
    const modal = page.locator('#confirm-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#confirm-title')).toHaveText(/归档/);
    await expect(page.locator('#confirm-body')).toContainText('显示已归档');

    await page.locator('#confirm-cancel').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#drawer-projects .session-item').first()).toBeVisible();
  });

  test('抽屉常驻「已归档」开关,名字不随状态变,只翻 aria-pressed', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await openDrawer(page);

    const toggle = page.locator('#drawer-archived-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toContainText('已归档');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // 切换按钮的可访问名跟着状态变,读屏念出的「已按下」就分不清指哪一头。
    await expect(toggle).toContainText('已归档');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toContainText('已归档');
  });

  test('归档→找回是一条真的闭环,不是单程票', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await seedOneThread(page);

    const rows = page.locator('#drawer-projects .session-item');
    const toggle = page.locator('#drawer-archived-toggle');

    // 同一个 mock 进程跨用例累积会话,所以一律用相对量,不钉死绝对条数。
    await firstSessionRow(page);
    const liveBefore = await rows.count();
    expect(liveBefore).toBeGreaterThan(0);

    await toggle.click();
    // count() 是即时取值，不等列表真的切完就会读到上一视图的残留。原来担任这个
    // 等待的是「列表里没有 Archive 按钮」，按钮进菜单后它恒成立、等不住了。
    await expect(page.locator('#drawer-projects .session-item:not([data-archived="true"])'))
      .toHaveCount(0, { timeout: 10000 });
    const archivedBefore = await rows.count();
    await toggle.click();
    await expect.poll(() => rows.count(), { timeout: 10000 }).toBe(liveBefore);

    // 「未归档的行只提供归档、归档的行只提供取消归档」这条语义，过去是靠数列表里
    // 的按钮（toHaveCount(0)）来断言的。按钮收进菜单后列表里恒为 0，那种写法会变成
    // 永远通过的假绿，所以改成直接查菜单在这个位置给的是哪一项。
    let menu = await openThreadMenu(page, rows.first());
    await expect(menu.locator('#thread-menu-archive')).toHaveText('归档');

    // 确认后真的归档:未归档视图少一行。
    await menu.locator('[data-action="archive"]').click();
    await page.locator('#confirm-ok').click();
    await expect.poll(() => rows.count(), { timeout: 10000 }).toBe(liveBefore - 1);

    // 按确认框许诺的那条路找回来——这正是那句文案的兑现。
    await toggle.click();
    await expect.poll(() => rows.count(), { timeout: 10000 }).toBe(archivedBefore + 1);

    menu = await openThreadMenu(page, rows.first());
    await expect(menu.locator('#thread-menu-archive')).toHaveText('取消归档');
    await menu.locator('[data-action="unarchive"]').click();
    await expect.poll(() => rows.count(), { timeout: 10000 }).toBe(archivedBefore);
    await toggle.click();
    await expect.poll(() => rows.count(), { timeout: 10000 }).toBe(liveBefore);
  });

  test('切到归档视图不会把顶栏标题谎报成新会话', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await seedOneThread(page);
    await firstSessionRow(page);

    // 先落到一个有名字的会话上,再切视图。正文还挂着这段对话,顶栏就不能改口。
    const title = page.locator('#thread-title');
    await expect(title).toHaveText('Mock thread', { timeout: 10000 });

    const toggle = page.locator('#drawer-archived-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // 当前会话不在归档列表里,列表刷新完也不该把标题抹成「新会话」。
    // 这一句的作用是**等列表真的切完**（socket 往返是异步的），不是语义断言——
    // 过去写成「列表里没有 Archive 按钮」，按钮收进菜单后那个计数恒为 0，
    // 等待作用会一起失效，于是改用条目自己标的归档状态。
    await expect(page.locator('#drawer-projects .session-item:not([data-archived="true"])')).toHaveCount(0, { timeout: 10000 });
    await expect(title, '当前会话不在归档列表里,不代表用户回到了新会话').toHaveText('Mock thread');
  });
});
