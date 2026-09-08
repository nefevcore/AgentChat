// ============================================================
// core/extensions/slotCatalog.ts —— D13 永久别名归一目录 + 公开子集校验
//
// manifest `ui.slots` 的可声明词汇 = 旧 8 UISlotId（永久双读：旧 id →
// 新席位键归一，不对第三方既有 manifest 作废）。第三方可声明集 =
// 【声明账本的显式公开子集】：组件贡献类六项映射的席位须在账本中
// 声明且 public（数据源由账本派生——各 owning 基础件的 declare 调用
//〔M27.2-1 hostLedger 代持退役：settings/tool/conversation/layout〕，
// 替代静态白名单）；ws-event / global-style
// 为常设通道（D8：非视觉缝不走 slot 注册表——manifest 授权照旧）。
//
// 高危替换 seat（D13 ⚠ 门槛：整面板 / composer 类替换——perspective
// 替换主内容区整面板）：manifest 显式声明（assertSlot 已强制）+ 安装
// 确认面明示（安装评审载荷 uiHighRiskSlots——ac-plugin-core 单源）。
//
// 服务端安装期校验（fail-closed 更早失败）：ac-plugin-core
// UI_SLOT_IDS / HIGH_RISK_UI_SLOTS（manifest 校验面同词汇表）。
// ============================================================
import type { UISlotId } from '@agentchat/protocol';
import { clientRuntime } from 'ac-client-runtime';

/** 旧 id → 新席位/常设通道 的归一映射（永久机制——slot-tree §6 收编表） */
export interface LegacySlotMapping {
  /** 映射的新席位键；standing 在场时为 null（不进 slot 注册表） */
  seatKey: string | null;
  /** 常设通道（ws-event / global-style——D8 两项非视觉缝） */
  standing?: 'ws-event' | 'global-style';
  /** 高危替换 seat（⚠ 名单：整面板/composer 类；安装确认面须明示） */
  highRisk?: boolean;
}

export const LEGACY_SLOT_CATALOG: Record<UISlotId, LegacySlotMapping> = {
  perspective: { seatKey: 'main:perspective', highRisk: true },
  'tool-result': { seatKey: 'tool-card:result-view' },
  'message-view': { seatKey: 'message:final-view' },
  'ws-event': { seatKey: null, standing: 'ws-event' },
  'settings-tab:global': { seatKey: 'settings:main-view' },
  'settings-tab:agent': { seatKey: 'agent-pane:tab' },
  'sidebar-action': { seatKey: 'sidebar:plugin-actions' },
  'global-style': { seatKey: null, standing: 'global-style' },
};

/** 组件贡献类六项（D8 收窄面——bridge 六个注册方法转发 slots.register） */
export const COMPONENT_CLASS_SLOTS: UISlotId[] = [
  'perspective',
  'tool-result',
  'message-view',
  'settings-tab:global',
  'settings-tab:agent',
  'sidebar-action',
];

/** 声明清单中的高危席位（安装确认面徽章数据源——服务端单源
 *  ac-plugin-core HIGH_RISK_UI_SLOTS 的前端镜像） */
export function highRiskOf(slots: string[] | undefined): string[] {
  return (slots ?? []).filter((s) => LEGACY_SLOT_CATALOG[s as UISlotId]?.highRisk === true);
}

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
