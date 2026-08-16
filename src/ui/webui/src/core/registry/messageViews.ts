// ============================================================
// core/registry/messageViews.ts —— 消息视图注册表 ★扩展点
//
// 解析"turn 的 final 消息"该用哪个视图渲染（当前：user / assistant）。
// 未来新增消息形态（system / event 卡等）只需注册 match + 组件 id。
// ============================================================

import { ref, type Component } from 'vue';
import type { Turn, ChatMessage } from '@/types';
import { VIEWER_ID } from '@/constants';

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

const views: MessageViewDef[] = [];

/** 注册表版本号：每次 register/unregister 自增，供 computed 建立响应式依赖 */
export const messageViewVersion = ref(0);

export function registerMessageView(def: MessageViewDef, renderer?: Component): () => void {
  const entry: MessageViewDef = renderer ? { ...def, renderer } : { ...def };
  const idx = views.findIndex(v => v.id === entry.id);
  if (idx >= 0) {
    views.splice(idx, 1, entry); // 同 id 替换
  } else {
    views.push(entry);
  }
  messageViewVersion.value++;
  return () => {
    const i = views.indexOf(entry);
    if (i >= 0) {
      views.splice(i, 1);
      messageViewVersion.value++;
    }
  };
}

export function unregisterMessageView(id: string): void {
  const idx = views.findIndex(v => v.id === id);
  if (idx >= 0) {
    views.splice(idx, 1);
    messageViewVersion.value++;
  }
}

/** 解析 turn 的 final 消息视图 id；未命中返回 null（调用方 fallback） */
export function resolveMessageView(turn: Turn, final: ChatMessage | null): string | null {
  messageViewVersion.value; // 建立响应式依赖：动态注册/卸载后视图自动重解析
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
  messageViewVersion.value;
  return views.find(v => v.id === id)?.renderer ?? null;
}

// ── 内置注册 ──
registerMessageView({
  id: 'user',
  match: (turn) => turn.agent_id === VIEWER_ID.value,
});
registerMessageView({
  id: 'assistant',
  match: () => true, // 兜底：其他一律 assistant 视图
});
