// ============================================================
// ac-client-ui-layout/client/perspectives.ts —— 视角注册表 ★顶层扩展点
//（M27.2-2 layout 件出包随件迁——main:perspective 席位 owning 件的
// 解析面；webui core/registry/perspectives.ts re-export 维持旧路径）
//
// 设计哲学："视图即筛选" —— 主界面是统一状态下的视角容器，
// 每个视角 = { active 判定 + 渲染组件 + props }。
//
// M27 D9 收编（S2）：数据面改经 SlotRegistry（main:perspective 视角
// 专座——D13 别名席，layout 基础件声明）。本模块保留为【解析面】：
//   · register → ctx.slots.register（meta 携带 def；active 谓词选举
//     语义保留在解析面——宿主 PerspectiveHost 逻辑不动）；
//     runtime 未装配（pre-boot/单测）→ 旧数组；
//   · activePerspective ← ctx.slots.entries 的 meta.def（版本计数
//     响应式；无 runtime 回落旧数组）；
//   · 内置四视角出厂批次（M28 P0-2 起随 owning 行贡献：talk →
//     conversation〔slots.inject 声明存活期效应——席位声明晚于该件
//     装载〕；group/single/pair → ui-group/ui-singles/ui-runview 行
//     client〔domain 批次，席位已声明〕；AppFrame 内置注册批次退役）。
// D18 门控三件套（bail/fields/redirectTo）随 def 携带（PerspectiveHost
// 咨询面不变）。
// ============================================================

import { ref, type Component } from 'vue';
import type { SlotEntry } from 'ac-client-slots';
import { clientRuntime } from 'ac-client-runtime';

export interface Perspective {
  id: string;
  label: string;
  icon?: string;
  /** 当前是否激活（主界面同时只有一个视角激活） */
  active: () => boolean;
  /** 渲染组件 */
  component: Component;
  /** 传给组件的 props（惰性求值，保证取到最新 store 状态） */
  props?: () => Record<string, unknown>;
  /**
   * 选举序轴（M28 P0-2）：entries 排序用 order 值——内置四视角显式定序
   * （pair 10 < talk 20 < group 30 < single 40，保持原 AppFrame 注册序
   * 语义：pair 最先、群先于单）；缺省 100（第三方/动态贡献居内置之后）。
   */
  order?: number;
  /** D18-1 bail 权限：宿主/权限面经 'activity/perspective' bail 事件拒绝（null/未监听 = 放行） */
  bail?: { event: 'activity/perspective' };
  /** D18-2 数据就绪门控：所需对象层键（未就绪 → 视角隐藏；§0.3 层 2） */
  fields?: string[];
  /** D18-3 卸载导航：本视角注册撤销时若正激活，执行该回退动作（如收起矩阵/清选择） */
  redirectTo?: () => void;
}

/** D9 别名席（声明住 clients/base/layout.ts 的 main:perspective） */
export const SLOT_KEY = 'main:perspective';

// ── 响应式：'slots/changed'（相关键）→ 版本计数 → 解析面重算 ──
export const perspectiveVersion = ref(0);

/** 装配序列调用：订阅注册表变更（main.ts，紧跟 createClient） */
export function bindPerspectives(): void {
  const ctx = clientRuntime();
  ctx?.on('slots/changed', (key) => {
    if (key === SLOT_KEY) perspectiveVersion.value++;
  });
}

/** 旧数组（runtime 未装配时的回落面——pre-boot/单测） */
const legacyViews: Perspective[] = [];

function defs(): Perspective[] {
  void perspectiveVersion.value; // 依赖锚
  const ctx = clientRuntime();
  if (!ctx) return legacyViews;
  return ctx.slots.entries(SLOT_KEY).map((e) => e.meta?.def as Perspective).filter(Boolean);
}

/** D18-2 字段就绪判定（对象层键存在即就绪；无运行时 = 无门控） */
function fieldsReady(p: Perspective): boolean {
  if (!p.fields || p.fields.length === 0) return true;
  const ctx = clientRuntime();
  if (!ctx) return true;
  return p.fields.every((k) => ctx.objects.get(k) !== undefined);
}

export function registerPerspective(p: Perspective): () => void {
  const rt = clientRuntime();
  if (rt && rt.slots.declOf(SLOT_KEY)) {
    const off = rt.slots.register(SLOT_KEY, {
      id: p.id,
      component: p.component,
      order: p.order,
      meta: { def: p },
    } satisfies SlotEntry);
    return () => {
      // D18-3 卸载导航：正激活的视角被撤销 → 回退动作（如收起只读视角）
      if (p.active()) p.redirectTo?.();
      void off();
    };
  }
  const idx = legacyViews.findIndex(v => v.id === p.id);
  if (idx >= 0) {
    legacyViews.splice(idx, 1, p); // 同 id 替换，保持位置
  } else {
    legacyViews.push(p);
  }
  perspectiveVersion.value++;
  return () => {
    const i = legacyViews.indexOf(p);
    if (i >= 0) {
      legacyViews.splice(i, 1);
      perspectiveVersion.value++;
      if (p.active()) p.redirectTo?.();
    }
  };
}

/** 当前激活的视角（按注册顺序取第一个 active 且过 D18 门控的） */
export function activePerspective(): Perspective | null {
  for (const p of defs()) {
    if (p.active() && fieldsReady(p)) return p;
  }
  return null;
}
