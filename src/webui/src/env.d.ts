/// <reference types="unplugin-icons/types/vue" />
/// <reference types="vite/client" />

// M27 S3：boot graph 静态映射（vite rowClientsPlugin 生成的 virtual 模块）
declare module 'virtual:row-clients' {
  export const rowClientLoaders: Record<string, () => Promise<unknown>>;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
