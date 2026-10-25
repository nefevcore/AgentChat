// ============================================================
// ac-client-ui-conversation/client/messageViews.ts —— 消息视图
// 解析面（★扩展点；M27.2-2 conversation 视图半边随件迁）
//
// 解析「turn 的 final 消息」该用哪个视图渲染（当前：user / assistant）。
// 未来新增消息形态（system / event 卡等）只需注册 match + 组件 id。
//
// M27 D9 收编（S2）：数据面经 SlotRegistry（message:final-view keyed
// seat——席位声明 + 内置出厂批次住本包 client/index.ts）。本模块 =
// 【解析面】（register → slots / resolve ← slots.entries 的 meta.def；
// runtime 未装配回落旧数组——既有测试零改动）。webui
// core/registry/messageViews.ts re-export 维持旧路径（bridge 注册面/
// main.ts bind 面/测试导入面零改动——同一模块实例）。
// ============================================================

import { ref, type Component } from 'vue';
import type { SlotEntry } from 'ac-client-slots';
import { clientRuntime } from 'ac-client-runtime';
import type { Turn, ChatMessage } from './types.ts';

export interface MessageViewDef {
  /** 视图标识（组件分支 key） */
  id: string;
  /** 匹配规则：命中则用该视图渲染 final */
  match: (turn: Turn, final: ChatMessage | null) => boolean;
  /** 同命中优先级（越大越优先），默认 0 */
  priority?: number;
  /** 动态渲染组件（插件注册时提供；内置 id 仍走 TurnDisplayItem 内建分支） */
  renderer?: Component;
}

/** 席位键（与 webui 解析面同词汇；声明 + 出厂批次住 client/index.ts） */
export const SLOT_KEY = 'message:final-view';

// ── 响应式：'slots/changed'（相关键）→ 版本计数 → resolve 重解析 ──
const version = ref(0);

/** 装配序列调用：订阅注册表变更（main.ts，紧跟 createClient） */
export function bindMessageViews(): void {
  const ctx = clientRuntime();
  ctx?.on('slots/changed', (key) => {
    if (key === SLOT_KEY) version.value++;
  });
}

/** 旧数组（runtime 未装配时的回落面——pre-boot/单测） */
const legacyViews: MessageViewDef[] = [];

function defs(): MessageViewDef[] {
  void version.value; // 依赖锚
  const ctx = clientRuntime();
  if (!ctx) return legacyViews;
  return ctx.slots.entries(SLOT_KEY).map((e) => e.meta?.def as MessageViewDef).filter(Boolean);
}

export function registerMessageView(def: MessageViewDef, renderer?: Component): () => void {
  const entry: MessageViewDef = renderer ? { ...def, renderer } : { ...def };
  const rt = clientRuntime();
  if (rt && rt.slots.declOf(SLOT_KEY)) {
    const off = rt.slots.register(SLOT_KEY, {
      id: entry.id,
      component: entry.renderer ?? { name: 'MessageViewStub', render: () => null },
      priority: entry.priority,
      meta: { def: entry },
    } satisfies SlotEntry);
    return () => void off();
  }
  const idx = legacyViews.findIndex(v => v.id === entry.id);
  if (idx >= 0) legacyViews.splice(idx, 1, entry); // 同 id 替换
  else legacyViews.push(entry);
  return () => {
    const i = legacyViews.indexOf(entry);
    if (i >= 0) legacyViews.splice(i, 1);
  };
}

/** 解析 turn 的 final 消息视图 id；未命中返回 null（调用方 fallback） */
export function resolveMessageView(turn: Turn, final: ChatMessage | null): string | null {
  const views = defs(); // 建立响应式依赖：动态注册/卸载后视图自动重解析
  let best: MessageViewDef | null = null;
  for (const v of views) {
    if (v.match(turn, final) && (!best || (v.priority ?? 0) > (best.priority ?? 0))) {
      best = v;
    }
  }
  return best?.id ?? null;
}

/** 解析视图 id → 动态渲染组件；内置 id（无 renderer）返回 null */
export function resolveMessageViewRenderer(id: string): Component | null {
  const views = defs();
  return views.find(v => v.id === id)?.renderer ?? null;
}
