// ============================================================
// client/useTurnDisplayItems.ts —— turns → DisplayItem 渲染管线
//（会话区重构 B 路线抽取：原 DialogView / PairDialogView 各持一份的
//  逐字重复管线收拢单源）。四步：
//   ① 稳定 key：agent + 时间戳 + 内容长度 + 步数——数组下标在历史
//      前插时全量平移，用作 key 会整列表重建（展开态/卡片内部态全丢）；
//      final 悬置期长度恒 0（流式期 key 稳定不逐 token 变化），收束
//      物化时 key 一次变化——整轮重挂载恰逢链栏折叠时刻。
//   ② event / error 消息 → 特殊分隔符（非轮次渲染）。
//   ③ run 中插播 event 观感优化（纯展示层不改派生）：同 agent 轮次
//      序列仅被 event 打断时——event 紧凑内联弱化切断感，其后延续轮
//      不再重复头像/名称（一个 run 读作连续块）。
//   ④ insertTimeSeparators 时间分隔符插入。
// 消费方：ConversationView（经 TranscriptList 渲染）。
// ============================================================

import { computed, type ComputedRef } from 'vue';
import { VIEWER_ID } from './viewer.ts';
import { insertTimeSeparators } from './format.ts';
import type { DisplayItem, Turn } from './types.ts';

/** turns（feed.getTurns 视图）→ TranscriptList 的 items */
export function useTurnDisplayItems(turns: ComputedRef<Turn[]>): ComputedRef<DisplayItem[]> {
  return computed<DisplayItem[]>(() => {
    const turnList = turns.value;
    if (turnList.length === 0) return [];
    const items: DisplayItem[] = [];
    for (let i = 0; i < turnList.length; i++) {
      const t = turnList[i];
      // 轮首时间戳：恒取 steps[0]（final 仅在 event/error 等无步轮上兜底）。
      // 顺序不能反——final 在流式期为 null、收束物化后 = 末条有正文消息
      // （其 ts 是末步而非轮首），先取 final 会让 key 在收束瞬间变化。
      const ts = t.steps[0]?.assistant.timestamp ?? t.final?.timestamp ?? i;
      // 稳定 key：agent + 轮首时间戳。刻意不含 final 长度与 steps 数：两者
      // 在收束物化（final 0→N）/新增 LLM 步骤（steps +1）时变化 → key 变
      // → 整轮重挂载 → 用户手动展开的链栏/工具卡/思考卡全部弹回默认折叠
      // 态（"看一半被折叠"的根因）；轮首 ts 与流式内容无关，全程稳定。
      const stableKey = `turn-${t.agent_id}-${ts}`;
      // event 消息（定时/归档/继续/重启等系统事件）→ 特殊分隔符
      if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'event') {
        const label = (t.final.content || t.final.source?.summary || '').trim();
        items.push({ type: 'event', timeText: label, timestamp: t.final.timestamp, key: `event-${ts}-${label.length}` });
        continue;
      }
      // error 消息 → 红色错误分隔符
      if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'error') {
        items.push({ type: 'error', timeText: t.final.content, timestamp: t.final.timestamp, key: `error-${ts}-${t.final?.content?.length ?? 0}` });
        continue;
      }
      items.push({ type: 'turn' as const, turn: t, key: stableKey });
    }
    // ── ③ run 中插播 event 的观感优化（见文件头注）──
    for (let i = 0; i < items.length; i++) {
      if (items[i].type !== 'event') continue;
      let p = i - 1;
      while (p >= 0 && items[p].type === 'event') p--;
      let n = i + 1;
      while (n < items.length && items[n].type === 'event') n++;
      const prev = p >= 0 ? items[p] : undefined;
      const next = n < items.length ? items[n] : undefined;
      if (prev?.type === 'turn' && next?.type === 'turn'
        && prev.turn?.agent_id && prev.turn.agent_id === next.turn?.agent_id
        && prev.turn.agent_id !== VIEWER_ID.value) {
        items[i].midRun = true;
        next.continuation = true;
      }
    }
    return insertTimeSeparators(items);
  });
}
