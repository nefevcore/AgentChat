// ============================================================
// ac-client-ui-conversation/client/injectCardViews.ts —— 注入卡视图
// 解析面（cr-765 #4/§1.8：inject-card:view keyed 席位）
//
// 注入卡（context 行）按 kind 走注册表：conversation 出厂一张通用卡
//（ContextInjectCard）兜底，域行可注册专用卡（问答卡第一例——
// ac-client-ui-ask 注册 kind: durable-interaction）。匹配链与
// toolResultViews 同构：精确 kind → 未命中 null（调用方回落通用卡）。
// ============================================================

import { ref, type Component } from 'vue';
import type { SlotEntry } from 'ac-client-slots';
import { clientRuntime } from 'ac-client-runtime';

/** 注入卡视图 def（精确 kind + 优先级——选举语义） */
export interface InjectCardViewDef {
  /** 注入卡 kind（= 存储 source 决策词：durable-interaction / skill / …） */
  match: string;
  component: Component;
  /** 同命中时优先级，默认 0（越大越优先） */
  priority?: number;
}

/** 席位键 */
export const INJECT_VIEW_SLOT = 'inject-card:view';

const version = ref(0);
let bound = false;

/** 装配序列调用（conversation client apply 内）：订阅注册表变更 */
export function bindInjectCardViews(): void {
  if (bound) return;
  bound = true;
  const ctx = clientRuntime();
  ctx?.on('slots/changed', (key) => {
    if (key === INJECT_VIEW_SLOT) version.value++;
  });
}

const legacyViews: InjectCardViewDef[] = [];

function defs(): InjectCardViewDef[] {
  void version.value;
  const ctx = clientRuntime();
  if (!ctx) return legacyViews;
  return ctx.slots.entries(INJECT_VIEW_SLOT).map((e) => e.meta?.def as InjectCardViewDef).filter(Boolean);
}

/** 注册注入卡专用视图（域行贡献面；幂等：同 match 替换） */
export function registerInjectCardView(match: string, component: Component, opts?: { priority?: number }): () => void {
  const def: InjectCardViewDef = { match, component, priority: opts?.priority ?? 0 };
  const rt = clientRuntime();
  if (rt && rt.slots.declOf(INJECT_VIEW_SLOT)) {
    const off = rt.slots.register(INJECT_VIEW_SLOT, {
      id: match,
      component,
      priority: def.priority,
      meta: { def },
    } satisfies SlotEntry);
    return () => void off();
  }
  const idx = legacyViews.findIndex(v => v.match === match);
  if (idx >= 0) legacyViews.splice(idx, 1, def);
  else legacyViews.push(def);
  return () => {
    const i = legacyViews.indexOf(def);
    if (i >= 0) legacyViews.splice(i, 1);
  };
}

/** 解析注入卡 kind → 专用视图（未命中 null——调用方回落通用卡） */
export function resolveInjectCardView(kind?: string): Component | null {
  const views = defs();
  if (!kind) return null;
  let best: InjectCardViewDef | null = null;
  for (const v of views) {
    if (v.match === kind) {
      if (!best || (v.priority ?? 0) > (best.priority ?? 0)) best = v;
    }
  }
  return best?.component ?? null;
}
