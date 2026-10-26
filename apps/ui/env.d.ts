/// <reference types="unplugin-icons/types/vue" />
/// <reference types="vite/client" />

// 8.5b 第二批（cr-531）：主线 apps/ui/src/env.d.ts 同款垫片（.vue 链进类型程序后
// import.meta.env / ~icons/* / *.vue 需声明面；preview vitest 配置的 virtual 同款）
declare module 'virtual:row-clients' {
  export const rowClientLoaders: Record<string, () => Promise<unknown>>;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
