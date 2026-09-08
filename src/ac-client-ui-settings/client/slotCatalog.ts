// ============================================================
// ac-client-ui-settings/client/slotCatalog.ts —— D13 永久别名归一目录
// + 公开子集校验（浏览器半边）
//
// M28 P3/T9：纯数据面（LEGACY_SLOT_CATALOG/highRiskOf/
// COMPONENT_CLASS_SLOTS/UISlotId）迁 ac-webui-extensions/src/
// slotCatalog.ts（第三方 manifest 声明词汇表与注册面同宿主）——本模块
// re-export 维持旧路径 + 保留 clientRuntime 依赖的公开子集校验
//（publicLegacySlots/assertDeclarableSlot——浏览器侧注册前校验面）。
//
// 第三方可声明集 = 【声明账本的显式公开子集】：组件贡献类六项映射的
// 席位须在账本中声明且 public（数据源由账本派生——各 owning 基础件的
// declare 调用，替代静态白名单）；ws-event / global-style 为常设通道
//（D8：非视觉缝不走 slot 注册表——manifest 授权照旧）。
// ============================================================
import { clientRuntime } from 'ac-client-runtime';
import {
  LEGACY_SLOT_CATALOG, COMPONENT_CLASS_SLOTS,
  type UISlotId, type LegacySlotMapping,
} from 'ac-webui-extensions/src/slotCatalog.ts';

export { LEGACY_SLOT_CATALOG, COMPONENT_CLASS_SLOTS, highRiskOf } from 'ac-webui-extensions/src/slotCatalog.ts';
export type { UISlotId, LegacySlotMapping } from 'ac-webui-extensions/src/slotCatalog.ts';

/** 当前账本公开子集（调试/诊断面：旧 id 形式列出可声明集） */
export function publicLegacySlots(): UISlotId[] {
  const ctx = clientRuntime();
  return COMPONENT_CLASS_SLOTS.filter((id) => {
    const seat = LEGACY_SLOT_CATALOG[id].seatKey;
    return seat ? ctx?.slots.declOf(seat)?.public === true : false;
  });
}

/**
 * 注册前校验（bridge 六方法调用）：
 *   ① manifest 显式声明该 id（运行时不超声明——既有语义）；
 *   ② id ∈ 永久目录（未知 id = 未公开，拒绝）；
 *   ③ 组件类 id 的映射席位须在账本声明且 public（公开子集 fail-closed）；
 *   ④ 高危 seat：诊断信息明示（manifest 显式声明是门槛本身）。
 * 违反即抛可诊断错误（install 外层捕获回滚）。
 */
export function assertDeclarableSlot(descriptor: { name: string; slots?: UISlotId[] }, slot: UISlotId): void {
  const declared = (descriptor.slots ?? []).includes(slot);
  if (!declared) {
    throw new Error(
      `[ui-ext] 插件 "${descriptor.name}" 未在 manifest.ui.slots 中声明 "${slot}"，拒绝注册`,
    );
  }
  const mapping: LegacySlotMapping | undefined = LEGACY_SLOT_CATALOG[slot];
  if (!mapping) {
    throw new Error(
      `[ui-ext] 插件 "${descriptor.name}" 声明的 "${slot}" 不在公开子集（可声明：${publicLegacySlots().join('/') || '当前无公开席位'}；目录见 slot-tree §6 收编表）`,
    );
  }
  if (mapping.standing) return; // 常设通道：授权照旧（不进 slot 注册表）
  const ctx = clientRuntime();
  const decl = mapping.seatKey ? ctx?.slots.declOf(mapping.seatKey) : undefined;
  if (!decl) {
    throw new Error(
      `[ui-ext] 插件 "${descriptor.name}" 目标席位 "${mapping.seatKey}"（"${slot}" 的归一位）未在声明账本中 declare——fail-closed 拒绝`,
    );
  }
  if (!decl.public) {
    throw new Error(
      `[ui-ext] 插件 "${descriptor.name}" 目标席位 "${mapping.seatKey}"（"${slot}" 的归一位）未公开（public 子集之外）——拒绝注册（D13 开口策略）`,
    );
  }
}
