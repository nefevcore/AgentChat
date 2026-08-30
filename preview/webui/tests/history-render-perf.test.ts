// ============================================================
// 历史数据前端管线耗时测量（诊断用基准，非断言测试）
//
// 背景：偶发"点击其他 Agent 卡在『正在加载历史消息…』"。本基准量化
// 前端纯数据管线（响应映射 → 分页合并 → turns 派生 → 时间分隔）的
// 耗时，用于与后端查询耗时比对、排除/定位前端瓶颈。
//
// 不含 DOM/markdown 渲染（TurnDisplayItem/virtual list 成本与消息数
// 和内容长度线性相关，且首屏页大小固定 5 轮，量级由页大小约束）。
// ============================================================
import { describe, expect, it } from 'vitest';
import { mergeHistoryPage, buildTurnsIncremental, type TurnsMemo } from '../src/utils/feed';
import { insertTimeSeparators } from '../src/utils/format';
import type { ChatMessage } from '../src/types';

/** 合成长度可控的伪正文（含 markdown 结构，模拟真实回复） */
function filler(kb: number): string {
  const para = '这是一段用于测量的正文内容，包含常见词汇与标点。'.repeat(8); // ≈0.5KB
  return para.repeat(Math.max(1, Math.round(kb * 2)));
}

let idSeq = 0;
function histMsg(agentId: string, content: string, tsMin: number, extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id: `perf-${++idSeq}`,
    role: 'agent',
    agent_id: agentId,
    content,
    timestamp: Date.UTC(2026, 0, 1, 0, tsMin),
    persistedMsgId: `pid-${idSeq}`,
    ...extra,
  };
}

/** 生成一页历史：turns 轮 × 每轮 [user, thinking+tool, assistant] */
function genPage(turns: number, assistantKb: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    const base = t * 10;
    msgs.push(histMsg('user', `用户消息 ${t}：` + filler(0.2), base));
    msgs.push(histMsg('alpha', '', base + 1, {
      thinking: filler(assistantKb / 2), reasoning_content: filler(assistantKb / 2),
      toolCalls: [{ id: `tc-${t}`, name: 'read', arguments: { p: '/x' }, result: 'ok', label: 'read' }],
      isStreaming: false,
    }));
    msgs.push(histMsg('alpha', `回复 ${t}：` + filler(assistantKb), base + 2));
  }
  return msgs;
}

function ms(ns: bigint): string { return `${(Number(ns) / 1e6).toFixed(2)}ms`; }

describe('历史渲染管线耗时测量', () => {
  it('典型页（5 轮 / 15 条）与续拉（50 轮 / 150 条）各阶段耗时', () => {
    const sizes: Array<{ label: string; turns: number; assistantKb: number }> = [
      { label: '典型页 5轮×3条(2KB/条)', turns: 5, assistantKb: 2 },
      { label: '加大页 50轮×3条(2KB/条)', turns: 50, assistantKb: 2 },
      { label: '长回复 5轮×3条(20KB/条)', turns: 5, assistantKb: 20 },
    ];
    for (const { label, turns, assistantKb } of sizes) {
      const page = genPage(turns, assistantKb);

      let t0 = process.hrtime.bigint();
      const { merged } = mergeHistoryPage(page, [], true, 'user');
      let t1 = process.hrtime.bigint();
      const mergeFirst = t1 - t0;

      t0 = process.hrtime.bigint();
      let memo: TurnsMemo | null = null;
      memo = buildTurnsIncremental(memo, merged);
      t1 = process.hrtime.bigint();
      const turnsFirst = t1 - t0;

      t0 = process.hrtime.bigint();
      const items = merged.map((tm, i) => ({
        type: 'turn' as const, turn: (memo as TurnsMemo).turns[i], index: i,
        key: `k-${i}`,
      }));
      insertTimeSeparators(items as any);
      t1 = process.hrtime.bigint();
      const separators = t1 - t0;

      // 流式增量路径：最后一条 assistant 追加 delta（最高频操作，每 token 一次）
      const streaming = [...merged];
      const last = streaming[streaming.length - 1];
      streaming[streaming.length - 1] = { ...last, content: last.content + '新增增量文本' };
      t0 = process.hrtime.bigint();
      const memo2 = buildTurnsIncremental(memo, streaming);
      t1 = process.hrtime.bigint();
      const turnsDelta = t1 - t0;

      // 续拉前插（loadMoreHistory：更早一页 + 已有消息合并）
      const older = genPage(turns, assistantKb).map((m, i) => ({ ...m, id: `old-${m.id}`, persistedMsgId: `opid-${i}`, timestamp: m.timestamp - 7 * 24 * 3600 * 1000 }));
      t0 = process.hrtime.bigint();
      mergeHistoryPage(older, streaming, false, 'user');
      t1 = process.hrtime.bigint();
      const mergePrepend = t1 - t0;

      console.log(
        `[perf] ${label} | merge首屏 ${ms(mergeFirst)} | turns首派生 ${ms(turnsFirst)}` +
        ` | turns增量(流式) ${ms(turnsDelta)} | merge续拉前插 ${ms(mergePrepend)} | 时间分隔 ${ms(separators)}`,
      );
      expect(merged.length).toBe(turns * 3);
      expect(memo.turns.length).toBeGreaterThan(0);
      expect(memo2.turns.length).toBe(memo.turns.length);
    }
  });

  it('极端比对：单次全量派生 500 轮（1500 条，非分页上限、仅量级参照）', () => {
    const big = genPage(500, 2);
    const t0 = process.hrtime.bigint();
    const memo = buildTurnsIncremental(null, big);
    const t1 = process.hrtime.bigint();
    console.log(`[perf] 500轮全量派生(1500条) ${ms(t1 - t0)}（结构性变更才会触发；分页/流式均为增量路径）`);
    expect(memo.turns.length).toBeGreaterThan(0);
  });
});
