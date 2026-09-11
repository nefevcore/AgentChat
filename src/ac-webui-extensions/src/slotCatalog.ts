// ============================================================
// ac-webui-extensions/src/slotCatalog.ts —— D13 永久别名归一目录
//（纯数据面；M28 P3/T9：自 ac-client-ui-settings/client/slotCatalog.ts
// 拆迁——第三方 manifest 声明词汇表与其注册面同宿主〔webui-extensions
// 行〕；clientRuntime 依赖的公开子集校验/assertDeclarableSlot 留
// 浏览器侧模块〔settings re-export 维持旧路径〕）
//
// manifest `ui.slots` 的可声明词汇 = 旧 8 UISlotId（永久双读：旧 id →
// 新席位键归一，不对第三方既有 manifest 作废）。高危替换 seat（D13 ⚠
// 门槛：整面板/composer 类）：manifest 显式声明 + 安装确认面明示
//（安装评审载荷 uiHighRiskSlots——ac-plugin-core 单源镜像）。
// ============================================================

/** 旧 8 UISlotId（与 webui shims/@agentchat/protocol 同一词汇——服务端
 *  包本地持有防浏览器 shim 依赖；ac-plugin-core UI_SLOT_IDS 同源） */
export type UISlotId =
  | 'perspective'
  | 'tool-result'
  | 'message-view'
  | 'ws-event'
  | 'settings-tab:global'
  | 'settings-tab:agent'
  | 'sidebar-action'
  | 'global-style';

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
  'sidebar-action': { seatKey: 'activity-bar:plugin-actions' }, // 2026-11 席位键随区域席改名（D5 首段 = 宿主件 ActivityBar）；第三方 manifest 词汇不变
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
