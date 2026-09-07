// ============================================================
// webui/src/runtime/virtual-row-clients.ts —— virtual:row-clients 垫片
//
// 仅测试环境使用（vitest 无法解析 vite 插件的 virtual 模块——测试里
// alias 到本文件）：行名 → loader 的空映射 + 测试注入口。生产构建由
// vite.config.ts 的 rowClientsPlugin 生成真实映射（行 client 模块块）。
// ============================================================

export interface RowClientLoaderMap {
  [name: string]: () => Promise<unknown>;
}

/** 测试注入口（vitest setup 里按需替换） */
export const rowClientLoaders: RowClientLoaderMap = {};
