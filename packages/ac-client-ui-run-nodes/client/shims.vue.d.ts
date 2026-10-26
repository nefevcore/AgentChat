// 行 client 半边的 .vue 模块垫片（根 tsc——src/*/client/**/*.ts 无 Vue
// 工具链；完整类型检查由 webui vue-tsc include ../ac-*/client/** 承担）
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
