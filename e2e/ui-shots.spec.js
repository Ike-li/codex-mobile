// e2e/ui-shots.spec.js —— 生成 docs/UI_SURFACE.md 的编号标注截图。
// coverage: docs/TESTING.md
//
// 这不是一条「顺手产图」的脚本，是一道门禁：每个编号都要先在界面上命中一个有面积的
// 元素，annotate() 才会画上去。选择器失效就抛错，图不会静默过期成一张骗人的旧图。
//
// 两条约定，都是实拍之后定的：
//
// 1. 编号严格对应 UI_SURFACE.md 表格的行序。表格里合并成一行的东西（「会话按钮 +
//    状态点」）就是一个编号，不拆——拆了图和表就对不上，读者得自己做映射。
// 2. 自带可见文字标签的元素不标编号。第一版给工具面板 12 个按钮都打了编号，结果
//    气泡把按钮文字盖成了「Th①ds」「Co②ct」，图比表格还难懂。那些按钮的名字本身
//    就是标签，圈出整块区域即可。编号只留给纯图标、没文字的元素。
//
// 图片提交进版本库（docs/assets/ui/），所以刻意压了 deviceScaleFactor：
// Pixel 5 默认 2.75 会截出 1081×1999、约 150KB 一张，dpr 2 降到约一半而 GitHub 上
// 的显示尺寸不变。再叠上按区域裁剪，单张普遍在 20–60KB。
import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.js';
import { auditLayout, formatIssues } from './lib/layout-audit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'docs/assets/ui';

// 默认只验证、不落盘；`npm run shots` 才真正重写 docs/assets/ui。
//
// 为什么不每次 e2e 都写：28 张里有 7 张每跑一次就变——项目名来自
// mkdtempSync 的随机临时目录（ccm-e2e-XXXXXX）、延迟胶囊的毫秒数、thread id 的
// 时间戳、跨 test 累积的 token 数。让 `npm run test:e2e` 每次吐出 7 张图的 diff，
// 结果是养成「无脑 git checkout docs/assets/ui」的习惯，那时这道门禁就形同虚设。
//
// 拆开之后两边都还在：选择器失效仍然由 annotate 抛错拦下（那才是门禁），
// 图则只在人确认要更新时重写一次。代价是 UI 只改了颜色或文案、选择器没动时，
// 图会滞后到下次手动重跑——这种情况没有任何自动手段能发现，只能靠人。
const WRITE_SHOTS = process.env.UI_SHOTS === 'write';

test.use({ deviceScaleFactor: 2 });

// WebKit 跑一遍只会把同名文件覆盖成像素略有差异的另一张，不产生新信息，还让
// 入库的图取决于哪个 project 最后跑完。截图固定由 chromium 产出。
test.skip(({ browserName }) => browserName !== 'chromium', '截图只在 mobile-chrome 产出');

async function connect(page) {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
}

async function send(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

async function idle(page) {
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 20000 });
}

/**
 * 等元素的位置真正停下来，返回它稳定后的 box。
 *
 * 抽屉和各个 sheet 都是 transform 滑入的：`toBeVisible()` 在动画第一帧就返回，
 * 那一刻 #drawer-tools 的 x 还是 -300（实测），于是 clip 从屏幕外开始裁、编号气泡
 * 也钉在错误坐标上——第一版的工具面板图左边一整列按钮就是这么被切掉的。
 *
 * 判据是连续两次采样的 box 完全相同。不用 waitForTimeout 猜时长：动画时长改了，
 * 猜出来的数字不会报错，只会又悄悄截出一张错位的图。
 */
async function settle(page, target) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  let prev = null;
  for (let i = 0; i < 40; i++) {
    const box = await loc.boundingBox();
    if (
      box && prev &&
      box.x === prev.x && box.y === prev.y &&
      box.width === prev.width && box.height === prev.height
    ) return box;
    prev = box;
    await page.waitForTimeout(50);
  }
  throw new Error(`${target} 的位置在 2s 内没有稳定下来，截图会错位`);
}

/**
 * 裁到指定区域再截图。传选择器数组时取它们的联合包围盒。
 *
 * 不裁的话，手机视口 393×727 里顶栏只占顶部一条、输入区只占底部一条，中间全是
 * 空白——读者要放大才看得清标注指向谁。pad 默认上下留 24px 容纳溢出到元素外的编号气泡。
 */
/**
 * 给 Playwright 定位到的元素打一个临时属性，让 annotate 能用原生选择器找到它。
 *
 * annotate 在页面里跑 querySelectorAll，只认标准 CSS——`:has-text()` 这类
 * Playwright 专有伪类在那里一律失配。凡是要靠文本或 nth 才能定位的元素，先 tag 再标注。
 */
async function tag(locator, name) {
  await locator.evaluate((el, value) => el.setAttribute('data-ui-shot', value), name);
  return `[data-ui-shot="${name}"]`;
}

async function shotArea(page, name, selectors, pad = {}) {
  const { top = 24, right = 10, bottom = 24, left = 10 } = pad;
  const list = Array.isArray(selectors) ? selectors : [selectors];

  const boxes = [];
  for (const sel of list) {
    const box = await settle(page, sel);
    expect(box, `${sel} 没有 layout box，截不出 ${name}`).toBeTruthy();
    boxes.push(box);
  }

  const view = page.viewportSize();
  const left0 = Math.min(...boxes.map(b => b.x));
  const top0 = Math.min(...boxes.map(b => b.y));
  const right0 = Math.max(...boxes.map(b => b.x + b.width));
  const bottom0 = Math.max(...boxes.map(b => b.y + b.height));

  const x = Math.max(0, left0 - left);
  const y = Math.max(0, top0 - top);

  // 布局体检。挂在这里而不是单独写用例，是因为这 25 个 test 已经把界面驱动到了
  // 29 个状态——体检点因此自动跟着截图长，新增一张图就自动多守一块区域，
  // 不需要谁记得补一条对应的体检用例。
  for (const sel of list) {
    const { issues } = await auditLayout(page, sel);
    expect(issues, `截图 ${name}：${formatIssues(sel, issues)}`).toEqual([]);
  }

  // 到这里为止的 settle / annotate / 体检 / 断言都已经跑过，门禁效果与写盘无关。
  if (!WRITE_SHOTS) return;

  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x,
      y,
      width: Math.min(view.width - x, right0 - left0 + left + right),
      height: Math.min(view.height - y, bottom0 - top0 + top + bottom),
    },
  });
}

test.describe('UI_SURFACE 截图', () => {
  // §1 顶栏。表格第 6 行「工作区下拉」只在配置了多个 WORK_DIRS 时出现，
  // mock 只给一个工作区，界面上不存在，因此没有第 6 个编号。
  test('01 顶栏', async ({ page }) => {
    await connect(page);
    await expect(page.locator('#conn-rtt')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#workdir-container')).toBeHidden();

    await annotate(page, [
      { sel: '#menu-btn', n: 1, place: 'bl' },
      { sel: '#conn-rtt', n: 2, place: 'bl' },
      { sel: '#header-context', n: 3, place: 'bl' },
      { sel: '#header-home', n: 4, place: 'bl' },
      { sel: '#header-new', n: 5, place: 'br' },
    ]);
    await shotArea(page, '01-header', '#header', { top: 6, bottom: 26 });
  });

  // §2.1 会话列表
  test('02 抽屉：会话列表', async ({ page }) => {
    await connect(page);
    await send(page, '第一个会话的对话');
    await idle(page);
    await page.locator('#header-new').click();
    await send(page, '第二个会话的对话');
    await idle(page);

    await page.locator('#menu-btn').click();
    await expect(page.locator('#drawer')).toBeVisible();
    await expect(page.locator('#drawer-projects')).not.toBeEmpty();
    // 滑入动画没停就标注，气泡会钉在屏幕外的坐标上。
    await settle(page, '#drawer');

    await annotate(page, [
      { sel: '#drawer-archived-toggle', n: 1, place: 'tr' },
      { sel: '.session-item', n: 2, place: 'tl' },
      { sel: '.session-item .native-row-actions', n: 3, place: 'br' },
    ]);
    // 下界固定取第 2 条会话，不取 last()：整轮 e2e 共享同一个 mock server，跑在
    // 前面的 spec 会把会话堆到十几条，last() 会把图拉成长条、还混进无关会话。
    await shotArea(
      page,
      '02-drawer-threads',
      ['#drawer-archived-bar', page.locator('.session-item').nth(1)],
      { top: 10, bottom: 14, left: 4, right: 4 },
    );
  });

  // §2.2 工具面板。12 个按钮的名字就印在按钮上，只圈区域不打编号。
  test('03 抽屉：工具面板', async ({ page }) => {
    await connect(page);
    await page.locator('#menu-btn').click();
    await expect(page.locator('#native-controls')).toBeVisible();
    const buttons = page.locator('#native-controls .native-control-btn');
    await expect(buttons).toHaveCount(12);
    await settle(page, '#drawer');

    await annotate(page, [{ sel: '#native-controls' }]);
    await shotArea(page, '03-drawer-tools', '#drawer-tools', { top: 14, bottom: 14 });
  });

  // §3.1 空会话
  test('04 空会话', async ({ page }) => {
    await connect(page);
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('.suggestion-card')).toHaveCount(4);

    await annotate(page, [
      { sel: '#empty-heading', n: 1, place: 'tl' },
      { sel: '.suggestions-grid', n: 2, place: 'tl' },
    ]);
    await shotArea(page, '04-empty-state', '#empty-state', { top: 20, bottom: 20 });
  });

  // §4 输入区的常驻元素。turn 进行中才出现的追加/停止/加载另出一张。
  test('05 输入区', async ({ page }) => {
    await connect(page);
    // 上下文表要收到用量事件才出现，先跑一轮把它逼出来。
    await send(page, '让上下文表出现');
    await idle(page);
    await expect(page.locator('#context-meter')).toBeVisible({ timeout: 8000 });
    await page.locator('#msg-input').fill('接下来我们该写什么代码');

    await annotate(page, [
      { sel: '#msg-input', n: 1, place: 'tl' },
      { sel: '#composer-defaults', n: 2, place: 'bl' },
      { sel: '#context-meter', n: 3, place: 'tr' },
      { sel: '#attach-btn', n: 4, place: 'tl' },
      { sel: '#send-btn', n: 5, place: 'tr' },
    ]);
    await shotArea(page, '05-composer', '#input-area', { top: 26, bottom: 10 });
  });

  // §4 输入区里只在 turn 进行中出现的三个控件。
  test('06 输入区：turn 进行中', async ({ page }) => {
    await connect(page);
    // SLOW_TURN 会挂住这一轮，给截图留出窗口；否则 mock 的回合几十毫秒就结束了。
    await send(page, 'SLOW_TURN');
    // 追加按钮的条件是 turnRunning && hasContent（composer-mode.js）——发送会清空
    // 输入框，所以这里必须再填一次。清空发生在 click() 返回之后，先等它清完再填，
    // 否则填进去的内容会被那次清空一起抹掉。
    await expect(page.locator('#msg-input')).toHaveValue('');
    await page.locator('#msg-input').fill('把这条追加进当前任务');
    await expect(page.locator('#followup-btn')).toBeVisible({ timeout: 8000 });

    await annotate(page, [
      { sel: '#followup-btn', n: 6, place: 'tl' },
      { sel: '#send-btn', n: 7, place: 'tr' },
      { sel: '#mini-status-spinner', n: 8, place: 'tl' },
    ]);
    await shotArea(page, '06-composer-running', '#input-area', { top: 26, bottom: 10 });
  });

  // §4 输入时触发的两个浮层。命令名和说明都印在面板上，只圈区域。
  test('07 斜杠命令面板', async ({ page }) => {
    await connect(page);
    await page.locator('#msg-input').pressSequentially('/');
    await expect(page.locator('#slash-popup')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#slash-popup .slash-item')).toHaveCount(7);

    await annotate(page, [{ sel: '#slash-popup' }]);
    await shotArea(page, '07-slash-popup', ['#slash-popup', '#input-area'], { top: 14, bottom: 10 });
  });

  test('08 @ 工作区文件搜索', async ({ page }) => {
    await connect(page);
    await page.locator('#msg-input').pressSequentially('@');
    await expect(page.locator('#at-mention-popup')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#at-mention-popup')).not.toBeEmpty();

    await annotate(page, [{ sel: '#at-mention-popup' }]);
    await shotArea(page, '08-at-mention', ['#at-mention-popup', '#input-area'], {
      top: 14,
      bottom: 10,
    });
  });

  // §3.2 消息流。编号沿用 UI_SURFACE.md 第 3.2 节表格的行序，跨图唯一。
  //
  // 富 Markdown 比一屏长得多，塞进一张图的结果是气泡开头滚出视口、编号全被夹到
  // 顶栏上。拆成两张，各自先滚到目标再标注。
  test('09 消息流：气泡与 Markdown', async ({ page }) => {
    await connect(page);
    await send(page, 'RICH_MARKDOWN_FIXTURE');
    await idle(page);
    const bubble = page.locator('.msg.codex').last();
    await expect(bubble.locator('table')).toBeVisible({ timeout: 10000 });

    // 裁剪基准取 #messages 而不是气泡本身：用户气泡是右对齐的窄条，以它为基准
    // 裁出来的是一条竖窄图，左边的助手正文全被切掉。
    await page.locator('.msg.user').last().scrollIntoViewIfNeeded();
    await annotate(page, [
      { sel: '.msg.user', n: 1, place: 'tl' },
      { sel: '.msg.codex', n: 2, place: 'tl' },
    ]);
    await shotArea(page, '09-message-markdown', '#messages', { top: 4, bottom: 4 });

    // 第 4 行「宽表格 | 自己横向滚动，不撑破气泡」——单元格里放的是不可断行的长路径，
    // 表格的 min-content 宽度超过阅读栏，这张图要看的就是它没有把气泡撑破。
    const table = bubble.locator('table');
    await table.scrollIntoViewIfNeeded();
    await annotate(page, [{ sel: '.msg.codex table', n: 4, place: 'tl' }]);
    await shotArea(page, '09b-wide-table', '#messages', { top: 4, bottom: 4 });
  });

  // §3.2 第 5 行：thinking / reasoning，默认收起。
  test('10 thinking 折叠块', async ({ page }) => {
    await connect(page);
    await send(page, 'REASONING_STREAM_FIXTURE');
    const fold = page.locator('.assistant-turn .reasoning-fold').last();
    await expect(fold).toBeAttached({ timeout: 10000 });
    await idle(page);

    await annotate(page, [{ sel: '.reasoning-fold', n: 5, place: 'tr' }]);
    await shotArea(page, '10-reasoning-collapsed', '.reasoning-fold', { top: 20, bottom: 14 });

    await fold.locator('.reasoning-toggle').click();
    await expect(fold).toHaveAttribute('open', '');
    await annotate(page, [{ sel: '.reasoning-fold', n: 5, place: 'tr' }]);
    await shotArea(page, '10b-reasoning-expanded', '.reasoning-fold', { top: 20, bottom: 14 });
  });

  // §3.3 审批卡：批准前。
  test('11 命令审批卡', async ({ page }) => {
    await connect(page);
    await send(page, 'approve this command');
    const card = page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    await expect(card).toBeVisible({ timeout: 10000 });

    await annotate(page, [{ sel: '.tool-card' }]);
    await shotArea(page, '11-approval-card', '.tool-card', { top: 20, bottom: 14 });

    // 截完就处理掉。整轮 e2e 共享一个 mock server，挂着不管的审批会堆进「需要你」
    // 面板，出现在后面每一张截图的顶部——深色模式那张就被两条陈年待办占了三分之一。
    await card.getByRole('button', { name: '拒绝' }).click();
    await idle(page);
  });

  // §3.2 第 6 行：命令卡片，批准后执行完的形态（命令、退出码、输出）。
  test('12 命令卡片', async ({ page }) => {
    await connect(page);
    await send(page, 'approve this command');
    const card = page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.getByRole('button', { name: '批准' }).click();
    await expect(page.locator('.command-card').last()).toBeVisible({ timeout: 10000 });
    await idle(page);

    await annotate(page, [{ sel: '.command-card', n: 6, place: 'tr' }]);
    await shotArea(page, '12-command-card', '.command-card', { top: 20, bottom: 14 });
  });

  // §3.2 第 12 行：系统消息。批准成功走的是助手文本，不产生系统消息——拒绝才会，
  // 所以这张图走拒绝路径，截到的是红色那一档。
  test('12b 系统消息（拒绝审批）', async ({ page }) => {
    await connect(page);
    await send(page, 'approve this command');
    const card = page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.getByRole('button', { name: '拒绝' }).click();
    await expect(page.locator('.error-msg').last()).toBeVisible({ timeout: 10000 });
    await idle(page);

    await annotate(page, [{ sel: '.error-msg', n: 12, place: 'tr' }]);
    await shotArea(page, '12b-system-message', '.error-msg', { top: 20, bottom: 14 });
  });

  // §3.2 第 7 行：文件变更卡片。
  test('13 文件变更卡片', async ({ page }) => {
    await connect(page);
    await send(page, 'FILE_CHANGE_FIXTURE');
    const card = page.locator('.file-change-card').last();
    await expect(card).toBeVisible({ timeout: 10000 });
    await idle(page);

    await annotate(page, [{ sel: '.file-change-card', n: 7, place: 'tr' }]);
    await shotArea(page, '13-file-change-card', '.file-change-card', { top: 20, bottom: 14 });
  });

  // §5 会话设置面板。权限四项、模型、思考强度、速度、会话模式都自带文字，只圈分区。
  test('14 会话设置', async ({ page }) => {
    await connect(page);
    await page.locator('#composer-defaults').click();
    await expect(page.locator('#session-settings')).toBeVisible();
    await expect(page.locator('#permission-list .popover-item').first()).toBeVisible();
    await settle(page, '#session-settings .sheet-card');

    await annotate(page, [
      { sel: '#permission-list', n: 1, place: 'tr' },
      { sel: '#permission-state', n: 2, place: 'tr' },
      { sel: '#model-list', n: 3, place: 'tr' },
    ]);
    await shotArea(page, '14-session-settings', ['#permission-list', '#model-list'], {
      top: 34,
      bottom: 14,
    });
  });

  // §5 高级设置，默认折叠，展开后才有内容。
  test('15 高级设置', async ({ page }) => {
    await connect(page);
    await page.locator('#composer-defaults').click();
    await expect(page.locator('#session-settings')).toBeVisible();
    await settle(page, '#session-settings .sheet-card');
    await page.locator('#settings-advanced summary').click();
    await expect(page.locator('#settings-advanced')).toHaveAttribute('open', '');
    await page.locator('#approval-list').scrollIntoViewIfNeeded();
    await expect(page.locator('#approval-list .popover-item').first()).toBeVisible();

    await annotate(page, [
      { sel: '#approval-list', n: 1, place: 'tr' },
      { sel: '#reviewer-list', n: 2, place: 'tr' },
    ]);
    await shotArea(page, '15-settings-advanced', ['#approval-list', '#reviewer-list'], {
      top: 34,
      bottom: 14,
    });
  });

  // §6 工作区面板的两个标签页。
  test('16 工作区：文件', async ({ page }) => {
    await connect(page);
    await page.locator('#header-context').click();
    await expect(page.locator('#workspace-modal')).toBeVisible();
    await settle(page, '#workspace-modal .sheet-card');
    await expect(page.locator('#file-browse-body')).not.toBeEmpty();

    await annotate(page, [
      { sel: '#workspace-tab-files', n: 1, place: 'tl' },
      { sel: '#workspace-tab-changes', n: 2, place: 'tr' },
      { sel: '#file-browse-path', n: 3, place: 'tr' },
      { sel: '#file-browse-body', n: 4, place: 'tr' },
    ]);
    await shotArea(page, '16-workspace-files', '#workspace-modal .sheet-card', {
      top: 20,
      bottom: 10,
    });
  });

  test('17 工作区：改动', async ({ page }) => {
    await connect(page);
    await page.locator('#header-context').click();
    await expect(page.locator('#workspace-modal')).toBeVisible();
    await settle(page, '#workspace-modal .sheet-card');
    await page.locator('#workspace-tab-changes').click();
    // loadGit() 是 socket 往返，回调里才填分支名和分组列表。只等容器 toBeVisible
    // 会在数据到达前就截图，分支名那一格是空的（annotate 因此报「命中了但没有面积」）。
    await expect(page.locator('#git-changes-branch')).not.toBeEmpty();
    await expect(page.locator('#git-changes-body .workspace-section').first()).toBeVisible();

    await annotate(page, [
      { sel: '#git-changes-branch', n: 1, place: 'tr' },
      { sel: '#git-changes-refresh', n: 2, place: 'tr' },
      { sel: '#git-changes-body', n: 3, place: 'tr' },
    ]);
    await shotArea(page, '17-workspace-changes', '#workspace-modal .sheet-card', {
      top: 20,
      bottom: 10,
    });
  });

  // §4 第 9 行附件托盘 + §7 附件预览。
  //
  // 托盘里没有缩略图：chip 是「文件名 + 大小 + ✕」（app.js renderAttachTray）。
  // 开预览要点 chip 本身，且只对图片类附件生效——所以上传的是一张真图。
  // 第一版这里写成「找 .attach-chip-thumb，找到才截预览」，那个选择器根本不存在，
  // 于是预览图静默没生成而测试全绿。有条件的截图分支一律不留。
  test('18 附件托盘与预览', async ({ page }) => {
    await connect(page);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#attach-btn').click();
    await (await chooser).setFiles(join(ROOT, 'public/icons/apple-touch-icon-180.png'));

    const tray = page.locator('#attach-tray');
    await expect(tray).toBeVisible({ timeout: 8000 });
    await expect(tray.locator('.attach-chip-name')).toContainText('apple-touch-icon-180.png');

    await annotate(page, [{ sel: '#attach-tray', n: 9, place: 'tl' }]);
    await shotArea(page, '18-attach-tray', ['#attach-tray', '#input-area'], {
      top: 26,
      bottom: 10,
    });

    await tray.locator('.attach-chip').first().click();
    await expect(page.locator('#attach-preview-modal')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#attach-preview-img')).toHaveAttribute('src', /.+/);
    await settle(page, '#attach-preview-img');
    await shotArea(page, '18b-attach-preview', '#attach-preview-img', { top: 14, bottom: 14 });
  });

  // §3.4 需要你面板：有未处理审批时出现在消息流上方。
  test('19 需要你面板', async ({ page }) => {
    await connect(page);
    await send(page, 'approve this command');
    await expect(page.locator('#needs-you-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#needs-you-panel')).not.toBeEmpty();

    await annotate(page, [{ sel: '#needs-you-panel' }]);
    await shotArea(page, '19-needs-you', '#needs-you-panel', { top: 14, bottom: 14 });

    // 同 11：截完立刻消掉这条待办，别让它挂到后面的截图里。
    await page.locator('.tool-card').filter({ hasText: '需要审批' }).last()
      .getByRole('button', { name: '拒绝' }).click();
    await expect(page.locator('#needs-you-panel')).toBeHidden({ timeout: 8000 });
  });

  // §3.4 有新内容 ↓：滚动位置不在底部且有新消息时出现。
  test('20 有新内容按钮', async ({ page }) => {
    await connect(page);
    // 90 行的流式内容。必须等它流完再滚：paintJumpToLatest 的条件是
    // followTranscript===false && 消息区真的溢出，流到一半时内容还没超过一屏，
    // scrollTo(0,0) 等于原地不动，followTranscript 一直是 true。
    await send(page, 'SCROLL_STREAM_FIXTURE');
    await expect(page.locator('.msg.codex').last()).toBeVisible({ timeout: 10000 });
    await idle(page);
    await page.locator('#messages').evaluate(el => el.scrollTo(0, 0));
    await expect(page.locator('#jump-to-latest')).toBeVisible({ timeout: 8000 });

    await annotate(page, [{ sel: '#jump-to-latest' }]);
    await shotArea(page, '20-jump-to-latest', ['#jump-to-latest', '#input-area'], {
      top: 20,
      bottom: 10,
    });
  });

  // §7 确认 sheet：切到「完全访问」会要求二次确认。
  test('21 确认 sheet', async ({ page }) => {
    await connect(page);
    await page.locator('#composer-defaults').click();
    await expect(page.locator('#session-settings')).toBeVisible();
    await settle(page, '#session-settings .sheet-card');
    await page.locator('#permission-list .popover-item').filter({ hasText: '完全访问' }).click();

    await expect(page.locator('#confirm-modal')).toBeVisible({ timeout: 5000 });
    await settle(page, '#confirm-modal .sheet-card');

    await annotate(page, [{ sel: '#confirm-modal .sheet-card' }]);
    await shotArea(page, '21-confirm-sheet', '#confirm-modal .sheet-card', { top: 14, bottom: 14 });
  });

  // §3.2 第 3 行：代码块（语法高亮 + 复制按钮，暗底）。
  test('23 代码块', async ({ page }) => {
    await connect(page);
    await send(page, 'CODE_BLOCK_FIXTURE');
    await idle(page);
    const pre = page.locator('.msg.codex pre').last();
    await expect(pre).toBeVisible({ timeout: 10000 });
    await pre.scrollIntoViewIfNeeded();

    await annotate(page, [{ sel: '.msg.codex pre', n: 3, place: 'tl' }]);
    // 这轮消息很短，用 #messages 会带出大半屏空白；裁到两个气泡的联合包围盒。
    await shotArea(page, '23-code-block', ['.msg.user', '.msg.codex'], { top: 20, bottom: 14 });
  });

  // §3.2 第 8–11 行：MCP 调用、搜索结果、计划、Raw 降级，四张卡一次推出来。
  test('24 工具卡片：MCP / 搜索 / 计划 / Raw', async ({ page }) => {
    await connect(page);
    await send(page, 'TOOL_CARDS_FIXTURE');
    await idle(page);

    const cards = page.locator('.tool-card');
    const plan = cards.filter({ hasText: '计划' }).last();
    const mcp = cards.filter({ hasText: 'read_file' }).last();
    const search = cards.filter({ hasText: '搜索:' }).last();
    const raw = cards.filter({ hasText: 'Raw' }).last();
    for (const card of [plan, mcp, search, raw]) {
      await expect(card).toBeVisible({ timeout: 10000 });
    }

    // 四张卡加起来正好在一屏内，一张图收完，不必拆。
    await plan.scrollIntoViewIfNeeded();
    await annotate(page, [
      { sel: await tag(mcp, 'mcp'), n: 8, place: 'tl' },
      { sel: await tag(search, 'search'), n: 9, place: 'tl' },
      { sel: await tag(plan, 'plan'), n: 10, place: 'tl' },
      { sel: await tag(raw, 'raw'), n: 11, place: 'tl' },
    ]);
    await shotArea(page, '24-tool-cards', '#messages', { top: 4, bottom: 4 });
  });

  // §8 深色模式跟随系统。
  test('22 深色模式', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await connect(page);
    await send(page, 'RICH_MARKDOWN_FIXTURE');
    await idle(page);
    await page.locator('.msg.user').last().scrollIntoViewIfNeeded();

    await shotArea(page, '22-dark-mode', ['#header', '#messages'], { top: 4, bottom: 4 });
  });

  // §3.3 深色下的卡片分档。22 那张只有 Markdown 正文，看不到 data-card 的色带，
  // 于是分档在深色模式下长期只有探针数据、没有一张能用肉眼核对的图。
  // 审批卡先发、工具卡后发，再把审批卡滚到视口顶部，四档才会自上而下依次入画。
  test('22b 深色模式：卡片分档色带', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await connect(page);
    // 开一条干净会话再发：整轮 e2e 共享一个 mock server，跑到这里时当前 thread
    // 已经堆了前面 25 个用例的 turn，直接发会撞上「已中断 / 已被运行时拒绝」。
    await page.locator('#header-new').click();
    await expect(page.locator('#empty-state')).toBeVisible({ timeout: 8000 });

    // 工具卡必须先发：审批挂起时再发消息会中断当前 turn，审批卡随即变成
    // 「已超时失效」，decision 档就截不到了（第一版就是这么失败的）。
    await send(page, 'TOOL_CARDS_FIXTURE');
    // 等最后一张卡真正渲染出来，而不是等 #state-label 变 idle：后者在 turn 中途
    // 会短暂回到 idle，接着发下一条就会把这个 turn 打断，实测只渲染出计划和 MCP
    // 两张卡就「已中断」。判据要落在用户看得见的产物上。
    await expect(page.locator('.tool-card').filter({ hasText: 'Raw' })).toBeVisible({ timeout: 15000 });
    await idle(page);
    await send(page, 'approve this command');
    const approval = page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    // 等决策按钮出现，而不是等卡片可见：卡片会先以加载态出现在视口边缘，
    // 那一刻截图只能拍到它顶部的一条色带。
    await expect(approval.locator('.deny-btn')).toBeVisible({ timeout: 10000 });
    await approval.evaluate(el => el.scrollIntoView({ block: 'end' }));
    await settle(page, approval);

    await shotArea(page, '22b-dark-card-accents', '#messages', { top: 4, bottom: 4 });

    // 截完就处理掉：挂着不管的审批会堆进「需要你」，把 needs-you-recovery 搅乱。
    await approval.locator('.deny-btn').click();
  });
});
