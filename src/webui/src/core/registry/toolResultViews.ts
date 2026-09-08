// ============================================================
// core/registry/toolResultViews.ts —— 工具结果视图注册表门面（re-export）
//
// owning = ac-client-ui-tool/client/toolResultViews.ts（M27.2-2 视图
// 半边随件迁——useToolResult/ToolMessage 消费；席位声明 + 内置 8 卡
// 出厂批次住 tool client/index.ts）。本模块 re-export 维持旧路径——
// bridge 注册面 / main.ts bind 面 / 测试导入面零改动（同一模块实例）。
// ============================================================
export type { ToolResultViewDef } from 'ac-client-ui-tool/client/toolResultViews.ts';
export {
  SLOT_KEY,
  bindToolResultViews,
  registerToolResultView,
  resolveToolResultView,
} from 'ac-client-ui-tool/client/toolResultViews.ts';
