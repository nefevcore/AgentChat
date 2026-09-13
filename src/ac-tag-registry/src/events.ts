// ============================================================
// ac-tag-registry/src/events.ts —— 标签域事件目录（声明合并，零运行时）
//
// 事件已住 ac-tools/events.ts（tool/registered · tool/unregistered
// ——谁 emit 谁声明），本域自身暂无新增事件；占位声明模块级契约。
// ============================================================
import type {} from '@agentchat/cordis';

declare module '@agentchat/cordis' {
  interface Events {}
}
