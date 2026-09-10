import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // 跑任何用例之前先确认后端接的是 mock：reuseExistingServer 在本地为 true，
  // 复用到一个接了真 Codex CLI 的实例会让整轮 E2E 消耗模型额度。
  globalSetup: './e2e/assert-mock-backend.js',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3232',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    // 产品主设备是手机，而此前浏览器侧只覆盖 Chrome —— iOS Safari 是零。
    // WebKit 比 Firefox 更接近 iPhone，所以要加就先加它。
    //
    // ⚠ 它验不了 iOS 真机上最容易挂的那几件事：PWA 安装（iOS 的路径是分享→添加到
    // 主屏幕）、真实 Web Push（要 16.4+ 且已添加主屏）、软键盘几何、Safari 的存储驱逐。
    // 那些只能在 iOS 真机上人工验证，别把这条 project 当成它们的替代。
    {
      name: 'mobile-webkit',
      use: { ...devices['iPhone 13'] },
      // remote-origin-handshake 靠 Chromium 的 `--host-resolver-rules` 把一个非 loopback
      // 主机名映射到 127.0.0.1（那是不要 root 权限就能走到"远程"分支的唯一办法）。
      // WebKit 没有等价参数，导航直接报 network connection was lost。
      //
      // 排除它不是妥协：那两条测的是服务端的 Origin 判定分支，与浏览器引擎无关，
      // 在 WebKit 上重跑一遍不产生新信息。
      testIgnore: /remote-origin-handshake\.spec\.js/,
    },
  ],
  webServer: {
    command: 'node scripts/mock-server.js',
    port: 3232,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
