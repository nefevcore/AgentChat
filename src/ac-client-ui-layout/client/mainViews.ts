// ============================================================
// ac-client-ui-layout/client/mainViews.ts —— 主区视图选举解析面
//（2026-11 主区语义纯化：main 席位 keyed 选举多选一）
//
// 「main-area ⤷ 会话/运行矩阵/其他 多选一」：主区视图 = { active 判定 +
// 渲染组件 + props + keepAlive 生命周期旗标 }，与 main:perspective
// 视角选举同轴语义（order 小者胜、active 谓词选举、解析面安全求值）。
// 分层：main 选举「主区视图」（chat=视角容器 / tracking=运行矩阵 / …），
// chat 内部再经 main:perspective 选举「会话视角」（pair/talk/group/
// single）——矩阵不是视角（非会话视图），不混轴。
//
// 注册面：owning 行直接 ctx.slots.register('main', { id, component,
// order, meta: { def } })——与视角行的注册姿势一致（无独立 register
// API）；壳侧消费面 = MainViewHost（渲染）+ 本模块（选举解析，供测试
// 与宿主共用）。原 main:tracking 专座收编为本席位条目（让位协议随
// active() 谓词住 owning 行——壳零域知识）。
// ============================================================

import { ref, type Component } from 'vue';
import { clientRuntime } from 'ac-client-runtime';

/** 主区视图定义（main 席位条目 meta.def 契约形状） */
export interface MainViewDef {
  id: string;
  /**
   * 选举序轴（缺省 100）：order 小者胜——覆盖类视图（运行矩阵等）居前，
   * chat 出厂 order 100 恒真兜底（与 main:perspective 同轴语义）。
   */
  order?: number;
  /** 当前是否应占据主区（多选一选举谓词；解析面安全求值） */
  active: () => boolean;
  /** 渲染组件 */
  component: Component;
  /** 传给组件的 props（惰性求值——保证取到最新 store 态；安全求值） */
  props?: () => Record<string, unknown>;
  /**
   * 文档流保活旗标：true = 曾赢得选举即常驻（v-show——DOM 常驻则
   * scrollTop 天然保留、流式帧持续上屏）；缺省 false = v-if 随选举
   * 挂卸（离开即卸载，后台零轮询）。chat 必须保活（会话视图局部态：
   * 草稿/滚动跟随/卡片展开——机制裁决见 MainViewHost）。
   */
  keepAlive?: boolean;
}

/** 席位 key（声明住 layout 件 client/index.ts） */
export const MAIN_VIEW_SLOT = 'main';

// ── 响应式：'slots/changed'（main）→ 版本计数 → 解析面重算 ──
//（MainViewHost 挂载时自订阅 bump；非组件上下文直接调用读取即时值）
export const mainViewVersion = ref(0);

/** 安全求值 active 谓词：抛错 = 未激活 + 警告（不得击穿主区——
 *  同 perspectives safeActive 纪律：缺陷 def 只失去选举资格） */
function safeActive(def: MainViewDef): boolean {
  try {
    return def.active();
  } catch (err) {
    console.warn(`[main-view] 主区视图 "${def.id}" 的 active() 谓词抛错——按未激活跳过`, err);
    return false;
  }
}

/** 安全求值 props 工厂：抛错 = 回落空 props（缺陷 def 不击穿容器） */
export function safeMainViewProps(def: MainViewDef): Record<string, unknown> {
  try {
    return def.props?.() ?? {};
  } catch (err) {
    console.warn(`[main-view] 主区视图 "${def.id}" 的 props() 工厂抛错——回落空 props`, err);
    return {};
  }
}

/** 候选清单（order 升序——SlotRegistry entries 轴；无 runtime = 空） */
export function mainViewDefs(): MainViewDef[] {
  void mainViewVersion.value; // 依赖锚（组件内经 computed 消费时建立响应）
  const ctx = clientRuntime();
  if (!ctx) return [];
  return ctx.slots.entries(MAIN_VIEW_SLOT)
    .map((e) => e.meta?.def as MainViewDef | undefined)
    .filter((d): d is MainViewDef => !!d && typeof d.active === 'function' && !!d.component);
}

/** 当前当选的主区视图（第一个 active 候选；无 = null——主区空态） */
export function activeMainView(): MainViewDef | null {
  for (const def of mainViewDefs()) {
    if (safeActive(def)) return def;
  }
  return null;
}
