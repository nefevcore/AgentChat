// ============================================================
// reader-core.ts —— 账本读面纯词（cr-1245 B1 自 ac-ledger reader.ts 拆入）
// —— 子调用卡注入与尾段序数；fs 读面留 ac-ledger reader.ts。
// ============================================================
import type { JournalToolResult, ProjectedStep } from './records.ts';

/**
 * 档案子调用卡 → 宿主卡后注入（cr-803 读侧平铺复原；宿主缺席如实丢弃
 *  ——无渲染锚，与 journal 投影同语义）。存量内联形态防重：宿主卡组内
 *  已含 subcall 卡即整组跳过。
 */
export function injectSubcallCards(steps: ProjectedStep[], subcalls: JournalToolResult[]): void {
  const byHost = new Map<string, JournalToolResult[]>();
  for (const k of subcalls) {
    // 旧轨道存量档案行宽容：toolCallId 缺席/无 # 前缀（无宿主锚）跳过
    if (typeof k.toolCallId !== 'string') continue;
    const hash = k.toolCallId.indexOf('#');
    if (hash <= 0) continue;
    const host = k.toolCallId.slice(0, hash);
    const bucket = byHost.get(host);
    if (bucket !== undefined) bucket.push(k);
    else byHost.set(host, [k]);
  }
  for (const s of steps) {
    if (s.toolCalls === undefined) continue;
    for (let i = 0; i < s.toolCalls.length; i++) {
      const group = [s.toolCalls[i]!];
      let j = i + 1;
      while (j < s.toolCalls.length && s.toolCalls[j]!.subcall === true) { group.push(s.toolCalls[j]!); j++; }
      const kids = byHost.get(s.toolCalls[i]!.id);
      if (kids === undefined) { i = j - 1; continue; }
      if (group.length > 1) { i = j - 1; continue; } // 存量内联防重
      kids.sort((a, b) => (a.seq ?? idTailSeq(a.toolCallId)) - (b.seq ?? idTailSeq(b.toolCallId)));
      s.toolCalls.splice(i + 1, 0, ...kids.map((k) => ({
        id: k.toolCallId,
        name: k.name ?? '(unknown)',
        arguments: k.arguments ?? '{}',
        result: k.result,
        subcall: true as const,
      })));
      i += kids.length;
    }
  }
}

/** 子调用 toolCallId 尾段序数（<hostId>#<seq> 的 seq——无 seq 存量回退） */
export function idTailSeq(toolCallId: string): number {
  const hash = toolCallId.indexOf('#');
  const tail = Number(hash > 0 ? toolCallId.slice(hash + 1) : NaN);
  return Number.isFinite(tail) ? tail : 0;
}
