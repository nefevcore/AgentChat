// ============================================================
// ac-client-ui-layout/client/auxSidebarViews.ts —— aside 区域选区选举解析面
//（2026-11 语义定整·层级修正：aux-sidebar 席位 = 辅助侧边栏（第四区域
// 本身——语义右侧边栏；「工作区」等面板 = 选区之一，NULL 扩展位与各选区同级）
//
// 「aside-area ⤷ 选区多选一展示」：右侧区域（第四层）的选区 =
// { active 判定 + 渲染组件 + props + rail 切换条资产 }。出厂选区 =
// workspace（工作区树，ui-workspace 行）+ group（群信息抽屉，ui-group 行
// ——会话区重构自 group:drawer 席位迁入）；未来大纲/检查器等选区同轴
// 竞争。与 main 轴分立不共享（各轴 def 形状有轴内特有字段——aside 轴
// 携带 rail 资产声明，复制适配而非抽象共享，同 perspectives →
// mainViews 的既定姿势）。
//
// 当选举区解析（AuxSidebarHost 消费）：**显式选区优先**——ui.auxPanel
// 置位（切换条按钮点击）时该 id 的候选只要 active 即当选；未置位/null
// 回落 active() 谓词选举（order 小者先，workspace 恒真兜底）。显式与
// 谓词双轨让「按钮切换选区」与「域态驱动激活」共存。
//
// 注册面：owning 行直接 ctx.slots.register('aux-sidebar', { id,
// component, order, meta: { def } })；壳侧消费面 = AuxSidebarHost
//（渲染 + 右缘切换条）+ 本模块（选举解析，供测试与宿主共用）。
// ============================================================

import { ref, type Component } from 'vue';
import { clientRuntime } from 'ac-client-runtime';

/** aside 区域选区定义（aside 席位条目 meta.def 契约形状） */
export interface AuxSidebarPanelDef {
  id: string;
  /**
   * 选举序轴（缺省 100）：order 小者胜（与 main/main:perspective 同轴
   * 语义）——多选区竞争时居前者当选。
   */
  order?: number;
  /** 当前是否当选展示（多选一选举谓词；解析面安全求值） */
  active: () => boolean;
  /** 渲染组件 */
  component: Component;
  /** 传给组件的 props（惰性求值——保证取到最新 store 态；安全求值） */
  props?: () => Record<string, unknown>;
  /**
   * 辅助活动栏按钮资产（域行声明——壳零域知识）：AuxActivityBar 按
   * 各选区的该声明渲染同级按钮（图标/提示文案）；点击 = 展开该选区
   *（显式选区置位 + activate 域侧激活），当选且展开时二次点击 = 收起
   * 区域（活动栏同款交互）。无 rail 声明的选区不出现在辅助活动栏
   *（仍可经谓词选举当选）。
   */
  rail?: {
    icon: string;
    title: string;
    /** 辅助活动栏点击时的域侧激活动作（可选）：把本选区的 active()
     *  置真（如 group 选区 = drawerOpen 置位）。恒真选区（workspace）可省。 */
    activate?: () => void;
  };
  /**
   * 辅助活动栏按钮可见性谓词（可选——域态驱动：如 group 选区仅在群
   * 视角有活跃群时露出按钮）。缺省 = 恒可见；解析面安全求值。
   */
  available?: () => boolean;
  /**
   * 文档流保活旗标（同 main 轴语义）：true = 曾当选即常驻 v-show；
   * 缺省 false = 随区域收起/选举让位卸载。树体轻，出厂选区缺省即可。
   */
  keepAlive?: boolean;
  /**
   * 舒适宽声明（选区固有属性——宽度形态单源住注册处）：
   *   · number = 固定舒适宽（usage 840）
   *   · 'half'  = 半屏（preview——代码对照需横向空间）
   *   · 缺省    = 窄面板（DEFAULT_AUX 280——清单/文本类）
   * 壳的 togglePanel 与意图消费（applyAuxPanelWidth）统一按此重整——
   * 用户手动拖调不覆盖（仅选区切换时按目标形态铺开）。
   */
  comfyWidth?: number | 'half';
}

/** 席位 key（声明住 layout 件 client/index.ts） */
export const AUX_SIDEBAR_SLOT = 'aux-sidebar';

// ── 响应式：'slots/changed'（aside）→ 版本计数 → 解析面重算 ──
//（AuxSidebarHost 挂载时自订阅 bump；非组件上下文直接调用读取即时值）
export const auxSidebarPanelVersion = ref(0);

/** 安全求值 active 谓词：抛错 = 未激活 + 警告（不得击穿区域） */
function safeActive(def: AuxSidebarPanelDef): boolean {
  try {
    return def.active();
  } catch (err) {
    console.warn(`[aux-sidebar] 区域选区 "${def.id}" 的 active() 谓词抛错——按未激活跳过`, err);
    return false;
  }
}

/** 安全求值 props 工厂：抛错 = 回落空 props（缺陷 def 不击穿容器） */
export function safeAuxSidebarPanelProps(def: AuxSidebarPanelDef): Record<string, unknown> {
  try {
    return def.props?.() ?? {};
  } catch (err) {
    console.warn(`[aux-sidebar] 区域选区 "${def.id}" 的 props() 工厂抛错——回落空 props`, err);
    return {};
  }
}

/** 候选清单（order 升序——SlotRegistry entries 轴；无 runtime = 空） */
export function auxSidebarPanelDefs(): AuxSidebarPanelDef[] {
  void auxSidebarPanelVersion.value; // 依赖锚
  const ctx = clientRuntime();
  if (!ctx) return [];
  return ctx.slots.entries(AUX_SIDEBAR_SLOT)
    .map((e) => e.meta?.def as AuxSidebarPanelDef | undefined)
    .filter((d): d is AuxSidebarPanelDef => !!d && typeof d.active === 'function' && !!d.component);
}

/** 当前当选的区域选区（第一个 active 候选；无 = null——区域整体消失：
 *  占用门控内在于选举，壳不残废） */
export function activeAuxSidebarPanel(): AuxSidebarPanelDef | null {
  for (const def of auxSidebarPanelDefs()) {
    if (safeActive(def)) return def;
  }
  return null;
}

/** 当选举区（显式优先 + 谓词回落）：preferred = ui.auxPanel（辅助活动栏
 *  按钮点击置位）——显式候选 active 即当选；未置位/显式候选失活回落
 *  active() 谓词选举（order 小者先）。双轨令「按钮切换」与「域态激活」
 *  共存：如 group 选区 active = drawerOpen 域态，辅助活动栏点击置显式位 +
 *  域行把域态置真。 */
export function electedAuxSidebarPanel(preferred?: string | null): AuxSidebarPanelDef | null {
  if (preferred) {
    const p = auxSidebarPanelDefs().find((d) => d.id === preferred);
    if (p && safeActive(p)) return p;
  }
  return activeAuxSidebarPanel();
}

/** 辅助活动栏按钮清单（带 rail 资产且 available 可见——安全求值；order 升序） */
export function auxSidebarRailDefs(): AuxSidebarPanelDef[] {
  return auxSidebarPanelDefs()
    .filter((d) => !!d.rail)
    .filter((d) => {
      try {
        return d.available ? d.available() : true;
      } catch (err) {
        console.warn(`[aux-sidebar] 区域选区 "${d.id}" 的 available() 谓词抛错——切换条按钮按隐藏跳过`, err);
        return false;
      }
    });
}
