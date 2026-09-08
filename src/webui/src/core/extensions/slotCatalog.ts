// ============================================================
// core/extensions/slotCatalog.ts —— 旧 slot 目录门面（re-export）
// owning = ac-client-ui-settings/client/slotCatalog.ts（M27.2-2
// settings 件出包随件迁——插件权限视图 highRiskOf 消费面在 settings）。
// 本模块 re-export 维持旧路径（bridge.ts assertDeclarableSlot /
// slot-catalog.test 导入面零改动——同一模块实例）。
// ============================================================
export * from 'ac-client-ui-settings/client/slotCatalog.ts';
