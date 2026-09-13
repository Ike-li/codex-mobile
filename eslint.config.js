// eslint.config.js —— ESLint 9 flat config。
// 分组：Node 后端/脚本/测试（ESM）、Service Worker（经典脚本）和浏览器 ESM。
// public/index.html 只保留外部脚本入口，应用代码由 public/js/app.js 覆盖。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      // 工具在这里开 git worktree（.claude/worktrees/<name>/），里面是整个仓库的
      // 另一份 checkout —— 连 public/vendor 的 min.js 一起被扫，实测一下多出 224 条报错。
      '.claude/**',
      'playwright-report/**',
      'data/**',
      'public/vendor/**',
      '_shot.mjs',
      'tmp-ui-shots/**',
    ],
  },
  js.configs.recommended,
  {
    // Node 后端、脚本、测试、Playwright 配置(项目为 type:module,.js 即 ESM)。
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['public/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 浏览器 Service Worker(经典脚本,非 module)。
    files: ['public/js/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
  {
    // 浏览器端可复用 ESM；Service Worker 由上一组按经典脚本检查。
    files: ['public/js/**/*.js'],
    ignores: ['public/js/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, io: 'readonly' },
    },
  },
  {
    // e2e 的截图辅助模块：文件本身是 Node 侧的 ESM，但主体是一段传给
    // page.evaluate 的函数，在浏览器上下文里执行，用 document / window。
    // 两套 globals 都放开，代价是这个文件里 Node 部分误用浏览器 API 抓不到。
    files: ['e2e/lib/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
