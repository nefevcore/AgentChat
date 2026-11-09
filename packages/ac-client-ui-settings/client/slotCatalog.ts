// ============================================================
// ac-client-ui-settings/client/slotCatalog.ts —— D13 永久别名归一目录
// + 公开子集校验（浏览器半边）
//
// M28 P3/T9：纯数据面（LEGACY_SLOT_CATALOG/highRiskOf/
// COMPONENT_CLASS_SLOTS/UISlotId）迁 ac-webui-extensions/src/
// slotCatalog.ts（第三方 manifest 声明词汇表与注册面同宿主）——本模块
// re-export 维持旧路径（cr-955：assertDeclarableSlot 注册前校验随 webui-v3
// cutover 的 bridge 链退役一并删除——全仓零调用；publicLegacySlots 诊断口
// 已于 2026-10-15 删除）。
//
// 第三方可声明集 = 【声明账本的显式公开子集】：组件贡献类六项映射的
// 席位须在账本中声明且 public（数据源由账本派生——各 owning 基础件的
// declare 调用，替代静态白名单）；ws-event / global-style 为常设通道
//（D8：非视觉缝不走 slot 注册表——manifest 授权照旧）。
// ============================================================
import { clientRuntime } from 'ac-client-runtime';
import {
  LEGACY_SLOT_CATALOG,
  type UISlotId, type LegacySlotMapping,
} from 'ac-webui-extensions/src/slotCatalog.ts';

export { LEGACY_SLOT_CATALOG, COMPONENT_CLASS_SLOTS, highRiskOf } from 'ac-webui-extensions/src/slotCatalog.ts';
export type { UISlotId, LegacySlotMapping } from 'ac-webui-extensions/src/slotCatalog.ts';
