// ============================================================
// register-dist.js —— 编译产物（dist/）运行时的路径别名解析
//
// 为什么需要：
//   根 tsconfig.json 的 paths 指向源码 src/*。npm start 直接跑编译产物时，
//   若用 tsconfig-paths/register，@core/* 会被解析到 src 下的 .ts 源码，
//   Node 无法加载（MODULE_NOT_FOUND）——这是 dist 模式特有的问题，
//   发布包则通过自己的 tsconfig（baseUrl=./dist）规避。
//
// 这里把 baseUrl 指向 dist/，让别名解析到 dist/src/*（与发布包 tsconfig 一致），
// 使本地 `npm start`（编译版）也能正常运行。
// ============================================================

const path = require('path');
const { register } = require('tsconfig-paths');

register({
  baseUrl: path.resolve(__dirname, '..', 'dist'),
  paths: {
    '@core/*': ['./src/core/*'],
    '@agents/*': ['./src/agents/*'],
    '@app/*': ['./src/app/*'],
    '@plugins/*': ['./src/plugins/*'],
    '@services/*': ['./src/services/*'],
    '@llm/*': ['./src/core/llm/*'],
    '@utils/*': ['./src/utils/*'],
    '@shared/*': ['./src/shared/*'],
  },
});
