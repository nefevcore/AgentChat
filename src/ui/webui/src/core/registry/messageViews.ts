// ============================================================
// core/registry/messageViews.ts —— 消息视图注册表 ★扩展点
//
// 解析"turn 的 final 消息"该用哪个视图渲染（当前：user / assistant）。
// 未来新增消息形态（system / trigger 卡等）只需注册 match + 组件 id。
// ============================================================

import type { Turn, ChatMessage } from '@/types';
import { VIEWER_ID } from '@/constants';

export interface MessageViewDef {
  /** 视图标识（组件分支 key） */
  id: string;
  /** 匹配规则：命中则用该视图渲染 final */
  match: (turn: Turn, final: ChatMessage | null) => boolean;
  /** 同命中优先级（越大越优先），默认 0 */
  priority?: number;
}

const views: MessageViewDef[] = [];

export function registerMessageView(def: MessageViewDef): void {
  views.push(def);
}

/** 解析 turn 的 final 消息视图 id；未命中返回 null（调用方 fallback） */
export function resolveMessageView(turn: Turn, final: ChatMessage | null): string | null {
  let best: MessageViewDef | null = null;
  for (const v of views) {
    if (v.match(turn, final) && (!best || (v.priority ?? 0) > (best.priority ?? 0))) {
      best = v;
    }
  }
  return best?.id ?? null;
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
