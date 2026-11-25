// ============================================================
// client/useTurnDisplayItems.ts —— turns → DisplayItem 渲染管线
//（会话区重构 B 路线抽取：原 DialogView / PairDialogView 各持一份的
//  逐字重复管线收拢单源）。四步：
//   ① 稳定 key：turnId 在场（投影分组行）直接作 key——键生即稳；缺席
//      （直播行/旧投影）回落 agent + 轮首时间戳 + 同刻计数序数。数组下标
//      在历史前插时全量平移，用作 key 会整列表重建（展开态/卡片内部态全
//      丢）；刻意不含 final 长度与 steps 数——两者在收束物化/步追加时变化
//      → key 变 → 整轮重挂载恰逢链栏折叠时刻（「看一半被折叠」根因）。
//   ② event / error 消息 → 特殊分隔符（非轮次渲染）；注入卡挂靠在
//      Turn.injects（buildTurns 数据层归位，2026-09-26 注入卡）——本层
//      仅消费：system 空轮（无 agent 轮可挂的降级承载）→ 独立卡 item。
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
    // 同刻消歧（P1-3 cr-1269）：同 agent 同轮首 ts 碰撞（Date.now 精度边界/
    // 同刻多轮/注入风暴）下 key 重复 → Vue 同 key 复用错乱。键源升级
    // （cr-1286 P4-1）：turnId 在场（投影分组行）直接作 key——键生即稳（不
    // 随收束物化/步追加变化，跨窗口同轮同键，上翻续拉不再整轮重挂）；
    // 缺席（直播行/旧投影——双写过渡期）回落 (agent, ts) + 计数序数消歧。
    const keySeq = new Map<string, number>();
    for (let i = 0; i < turnList.length; i++) {
      const t = turnList[i];
      // 轮首时间戳：恒取 steps[0]（final 仅在 event/error 等无步轮上兜底）。
      // 顺序不能反——final 在流式期为 null、收束物化后 = 末条有正文消息
      // （其 ts 是末步而非轮首），先取 final 会让 key 在收束瞬间变化。
      const ts = t.steps.at(0)?.assistant.timestamp ?? t.final?.timestamp ?? i;
      // 稳定 key：turnId（键生即稳）＞ agent + 轮首时间戳（启发域）。刻意
      // 不含 final 长度与 steps 数：两者在收束物化（final 0→N）/新增 LLM
      // 步骤（steps +1）时变化 → key 变 → 整轮重挂载 → 用户手动展开的链栏/
      // 工具卡/思考卡全部弹回默认折叠态（"看一半被折叠"的根因）；轮首 ts
      // 与流式内容无关，全程稳定。
      const base = t.turnId !== undefined ? `turn-${t.turnId}` : `turn-${t.agent_id}-${ts}`;
      const n = keySeq.get(base) ?? 0;
      keySeq.set(base, n + 1);
      const stableKey = n === 0 ? base : `${base}-${n}`;
      // event 消息（定时/归档/继续/重启等系统事件）→ 特殊分隔符
      if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'event') {
        const label = (t.final.content || t.final.source?.summary || '').trim();
        items.push({ type: 'event', timeText: label, timestamp: t.final.timestamp, key: `event-${ts}-${label.length}` });
        continue;
      }
      // error 消息 → 红色错误分隔符
      if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'error') {
        items.push({ type: 'error', timeText: t.final.content, timestamp: t.final.timestamp, key: `error-${ts}-${t.final.content.length}` });
        continue;
      }
      // system 空轮 + injects（buildTurns 降级承载：前后皆无 agent 轮可挂
      // 的注入卡）→ 独立降级卡 item（逐卡占位，同 ContextInjectCard 渲染）
      if (t.agent_id === 'system' && t.steps.length === 0 && !t.final && t.injects?.length) {
        for (const card of t.injects) {
          items.push({ type: 'inject', inject: card, key: card.key });
        }
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