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
];
