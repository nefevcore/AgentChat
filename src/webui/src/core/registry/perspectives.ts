// ============================================================
// core/registry/perspectives.ts —— 视角注册表 ★顶层扩展点
//
// 设计哲学："视图即筛选" —— 主界面是统一状态下的视角容器，
// 每个视角 = { active 判定 + 渲染组件 + props }。
// 当前注册：talk（direct 会话）/ group（群聊）—— 二者共享 DialogView 内核，
// 只是数据 selector（group prop）不同。未来社区流/星图/过程工作台 = 新增注册项。
//
// M27 S1 增量：
//   · D18 门控三件套：bail 事件权限（宿主/权限面可拒绝；PerspectiveHost
//     经客户端 ctx.bail('activity/perspective', p) 咨询——无监听即放行，
//     默认拒绝形态待权限面）+ fields 数据就绪门控（对象层键就绪前隐藏，
//     §0.3 层 2）+ 卸载导航（redirectTo：本视角卸载且激活时的回退动作）；
//   · D13 双轨：注册面同步转发进 SlotRegistry（main:perspective 别名席，
//     消费面仍读本注册表——D9 于 S2 收编为 keyed 选举）。
// ============================================================

import { ref, type Component } from 'vue';
import type { SlotEntry } from 'ac-client-slots';
import { clientRuntime } from '@/runtime/clientRuntime';

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
  /** D18-1 bail 权限：宿主/权限面经 'activity/perspective' bail 事件拒绝（null/未监听 = 放行） */
  bail?: { event: 'activity/perspective' };
  /** D18-2 数据就绪门控：所需对象层键（未就绪 → 视角隐藏；§0.3 层 2） */
  fields?: string[];
  /** D18-3 卸载导航：本视角注册撤销时若正激活，执行该回退动作（如收起矩阵/清选择） */
  redirectTo?: () => void;
}

/** D18-2 字段就绪判定（对象层键存在即就绪；无运行时 = 无门控） */
function fieldsReady(p: Perspective): boolean {
  if (!p.fields || p.fields.length === 0) return true;
  const ctx = clientRuntime();
  if (!ctx) return true;
  return p.fields.every((k) => ctx.objects.get(k) !== undefined);
}

const views: Perspective[] = [];

/** 注册表版本号：每次 register/unregister 自增，供组件 computed 建立响应式依赖 */
export const perspectiveVersion = ref(0);

/** D13 别名席（声明住 clients/base/layout.ts 的 main:perspective） */
const SLOT_KEY = 'main:perspective';

export function registerPerspective(p: Perspective): () => void {
  const idx = views.findIndex(v => v.id === p.id);
  if (idx >= 0) {
    views.splice(idx, 1, p); // 同 id 替换，保持位置
  } else {
    views.push(p);
  }
  perspectiveVersion.value++;
  // D13 双轨：转发 SlotRegistry（meta 携带注册表 def；运行时未装配 = 单测跳过）
  const rt = clientRuntime();
  let slotOff: (() => void) | undefined;
  if (rt && rt.slots.declOf(SLOT_KEY)) {
    const entry: SlotEntry = { id: p.id, component: p.component, order: idx >= 0 ? undefined : 100, meta: { def: p } };
    const off = rt.slots.register(SLOT_KEY, entry);
    slotOff = () => void off();
  }
  return () => {
    const i = views.indexOf(p);
    if (i >= 0) {
      views.splice(i, 1);
      perspectiveVersion.value++;
      // D18-3 卸载导航：正激活的视角被撤销 → 回退动作（如收起只读视角）
      if (p.active()) p.redirectTo?.();
    }
    slotOff?.();
  };
}

/** 当前激活的视角（按注册顺序取第一个 active 且过 D18 门控的） */
export function activePerspective(): Perspective | null {
  for (const p of views) {
    if (p.active() && fieldsReady(p)) return p;
  }
  return null;
}
