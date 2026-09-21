// ESLint 单规则守则：本项目 lint 面刻意最小化——只挂与类型系统联动的
// 逻辑正确性规则，不铺风格规则面（风格经统一格式化约定承担）。
//
// no-unnecessary-condition：抓「在类型系统看来恒真/恒假的条件」。要防的：
//   1. ComputedRef 裸用做真值判定（对象恒真——presetRetired 漏 .value
//      事故，2026-09-21 ChatInput placeholder 误显退役文案）
//   2. 函数引用误当调用结果判定；可选链/?? 施加在非空值上
// 工程归属：根 tsconfig 覆盖服务面 .ts；src/webui/tsconfig 覆盖 client
// 面 .vue（其 include 含 ../ac-*/client/**）——projectService 按目录就近
// 找 tsconfig，client .vue 向上找不到含它的工程，故显式 project 数组。
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import vueParser from 'vue-eslint-parser';

export default [
  {
    // 源文件里存在指向未启用规则的既有 eslint-disable 注释（历史遗留，
    // 本配置只挂单规则不铺规则面）——不提示未用指令，避免无谓 warning。
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/*.mjs',
      'desktop/**',
      'dist/**',
      '.tmp/**',
      'workspace/**',
      'data/**',
      'bin/**',
      'scripts/**',
      'src/webui/dist/**',
      'src/vendor/**',
      // tests/scripts/templates 面：未纳入任何 tsconfig（类型检查本就不覆盖），
      // 类型感知 lint 无从解析——lint 面与 typecheck 面对齐；后续若纳入
      // typecheck 再同步放开。
      'src/webui/tests/**',
      'src/*/tests/**',
      'src/*/src/tests/**',
      'src/scripts/**',
      'src/templates/**',
      'src/webui/vite.config.ts',
    ],
  },
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
        project: ['tsconfig.json', 'src/webui/tsconfig.json'],
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
];