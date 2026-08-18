// ============================================================
// @agentchat/plugins/src/market/index.ts —— 市场域出口
// 注意：market-plugin 的 apply/name 与主插件行（../plugin）同名，
// barrel 里以别名导出避免歧义；cordis 装配行直接用
// '@agentchat/plugins/src/market/market-plugin' 模块路径。
// ============================================================
export * from './source';
export * from './github';
export * from './tarball';
export * from './market';
export { name as marketPluginName, apply as marketPluginApply } from './market-plugin';
