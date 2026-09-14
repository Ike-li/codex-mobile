// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

async function sendMessage(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

test.describe('P0 协议桥、审批与 Socket.IO', () => {
  test('Rich Event Rendering', async ({ page }) => {
    // 1. Open the home page with the existing baseURL and wait until #state-label is idle.
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 2. Send approve this command.
    const approvalCards = page.locator('.tool-card').filter({ hasText: '需要审批' });
    const approvalCountBeforeApprove = await approvalCards.count();
    await sendMessage(page, 'approve this command');
    const approveCard = approvalCards.nth(approvalCountBeforeApprove);
    await expect(approveCard).toBeVisible({ timeout: 10000 });
    await expect(approveCard).toContainText('approve this command');
    await expect(approveCard).toContainText('needs execution');
    await expect(approveCard.getByRole('button', { name: '批准' })).toBeVisible();
    await expect(approveCard.getByRole('button', { name: '拒绝' })).toBeVisible();

    // 3. Click approve.
    await approveCard.getByRole('button', { name: '批准' }).click();
    await expect(approveCard).toContainText('已批准');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    // 命令活动行跑完就收起：行上只留命令本身，退出码和输出折在里面。
    // 标题不再是「命令」两个字——那是卡片时代的固定表头，现在这一行写的是命令正文。
    const commandRow = page.locator('.command-card').last();
    await expect(commandRow).toHaveAttribute('data-ok', 'true');
    await commandRow.locator('.activity-toggle').click();
    await expect(commandRow.getByText('exit: 0')).toBeVisible({ timeout: 10000 });
    await expect(commandRow).toContainText('command approved and executed');

    // 4. Send approve this command again.
    const approvalCountBeforeDecline = await approvalCards.count();
    await sendMessage(page, 'approve this command');
    const declineCard = approvalCards.nth(approvalCountBeforeDecline);
    await expect(declineCard).toBeVisible({ timeout: 10000 });
    await expect(declineCard).toContainText('approve this command');
    await declineCard.getByRole('button', { name: '拒绝' }).click();
    await expect(declineCard).toContainText('已拒绝');
    await expect(page.locator('.error-msg').last()).toContainText('Approval declined by user', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 原第 5 步发 /status 等模型回话，靠的是 mock 对这段文本的特判——而 /status
    // 现在是本地命令，不再产生 turn。这条 spec 测的是富事件渲染，下面那步发普通
    // 消息已经覆盖同一条「发送→流式响应」路径，不必再造一个像消息的斜杠文本。

    // 5. Send a normal message.
    await sendMessage(page, 'rich event plain message');
    await expect(page.locator('.msg.user').last()).toContainText('rich event plain message');
    await expect(page.locator('.msg.codex').last()).toContainText('Mock response to: rich event plain message', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await sendMessage(page, 'FILE_CHANGE_FIXTURE');
    const fileCard = page.locator('.file-change-card').last();
    await expect(fileCard).toBeVisible({ timeout: 10000 });
    await expect(fileCard).toContainText('src/example.js');
    await expect(fileCard).toContainText('新增');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });
});
