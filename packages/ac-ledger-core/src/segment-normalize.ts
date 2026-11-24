// ============================================================
// segment-normalize.ts —— 段行 → v2 相位事件行归一（cr-1306）
//
// 背景：v1 时代 settlement 把 run 的聚合轨迹物化成「段行」
//（`source:'segment'` + `steps:[ProjectedStep]`，cr-697）。迁移边 M-A 刻意
// 保留该 v1 词形（session-chain.segmentRow——v1/v2 行级读判别天然对称）。
// 代价：读侧要留一条 aggOrder 顺序簿分支（events-core 段行/注入行 →
// aggOrder；fold 按文件序还原步块与注入插位）。新代已不再产段行
//（cr-1305 实测：活跃会话 0 条，全根段行最晚 2026-11-09），本模块把
// 存量段行展开成 v2 相位事件行，使读侧可退役该分支。
//
// 等价判据：同一 run 的 foldStepsOf 产出恒等（聚合直通路径 vs 事件重建
// 路径）。实现要点三条：
//  1. 相位序（textBeforeTools）由**行序**表达——v2 事件路径按
//     `firstContentAt < firstCallAt` 推导（fold-core L110），故正文行须
//     先于工具行入文件序；seq 由调用方按最终文件序统一分配；
//  2. 步级计量（usage/elapsedMs/aborted/textMs）只能经 reasoning/content
//     行承载（placeEvent 只从这两词收 meters）——纯工具步无此类行时
//     合成空 text 的 reasoning 行承载，否则计量丢失；
//  3. subcall 子调用只产 tool-call-result 行（foldStepsOf 按 toolCallId
//     首段分组进宿主卡），不与其 tool-call 配对。
// ============================================================
import type { LedgerRow, ProjectedStep } from './records.ts';

export interface SegmentNormalizeResult {
  /** 展开出的 v2 相位事件行（行序 = 语义相位序；seq 由调用方分配） */
  rows: Array<Record<string, unknown>>;
  /** 段行是否可转换（无 run / 无 steps = 不可） */
  converted: boolean;
  /** 诊断：为承载计量而合成的空正文行步号（正常为空数组） */
  synthesizedMeterRows: number[];
}

/**
 * 段行 → v2 相位事件行（cr-1306）。stepBase = 该 run 此前已展开到的步号。
 * 返回行不含 seq（调用方按最终文件序统一分配，保 writer 单调语义）。
 */
export function segmentRowToPhaseRows(
  row: LedgerRow & Record<string, unknown>,
  stepBase = 0,
): SegmentNormalizeResult {
  const run = typeof row.run === 'string' ? row.run : '';
  const steps = Array.isArray(row.steps) ? (row.steps as ProjectedStep[]) : [];
  if (run === '' || steps.length === 0) return { rows: [], converted: false, synthesizedMeterRows: [] };
  const baseTs = Date.parse(row.timestamp) || 0; // 非法/缺席 → NaN → 0
  const rows: Array<Record<string, unknown>> = [];
  const synthesizedMeterRows: number[] = [];
  let step = stepBase;
  for (const s of steps) {
    const ts = typeof s.ts === 'number' ? s.ts : baseTs;
    const idPart = s.stepId !== undefined ? { stepId: s.stepId } : {};
    // 步级计量（placeEvent 只从 reasoning/content 收 → 挂正文优先、思考次之）
    const meter: Record<string, unknown> = {
      ...(s.usage !== undefined ? { usage: s.usage } : {}),
      ...(s.elapsedMs !== undefined ? { elapsedMs: s.elapsedMs } : {}),
      ...(s.aborted === true ? { aborted: true } : {}),
      ...(s.textMs !== undefined ? { textMs: s.textMs } : {}),
    };
    const hasMeter = Object.keys(meter).length > 0;
    const reasoningRow: Record<string, unknown> | null = typeof s.reasoning === 'string' && s.reasoning !== ''
      ? { type: 'step/reasoning', run, step, ...idPart, text: s.reasoning, ts, ...(s.reasoningMs !== undefined ? { reasoningMs: s.reasoningMs } : {}) }
      : null;
    const contentRow: Record<string, unknown> | null = typeof s.content === 'string' && s.content !== ''
      ? { type: 'step/content', run, step, ...idPart, text: s.content, ts }
      : null;
    // 工具调用行（含结果行成对；subcall 见下）
    const callRows: Array<Record<string, unknown>> = [];
    for (const tc of s.toolCalls ?? []) {
      if (tc.subcall === true) continue;
      callRows.push({ type: 'step/tool-call', run, step, ...idPart, toolCallId: tc.id, name: tc.name, arguments: tc.arguments, ts });
      if (tc.result !== undefined && tc.result !== null) {
        callRows.push({ type: 'step/tool-call-result', run, toolCallId: tc.id, result: tc.result, ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}), ts });
      }
    }
    for (const tc of s.toolCalls ?? []) {
      if (tc.subcall !== true) continue;
      callRows.push({ type: 'step/tool-call-result', run, toolCallId: tc.id, result: tc.result ?? null, ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}), subcall: true, name: tc.name, arguments: tc.arguments, ts });
    }
    // 计量挂载点：正文行优先、思考行次之；纯工具步合成空正文思考行承载
    if (hasMeter) {
      const target = contentRow ?? reasoningRow;
      if (target !== null) Object.assign(target, meter);
      else {
        synthesizedMeterRows.push(step);
        rows.push({ type: 'step/reasoning', run, step, ...idPart, text: '', ts, ...meter });
      }
    }
    if (reasoningRow !== null) rows.push(reasoningRow);
    // 相位序：textBeforeTools ⇒ 正文先于工具行入序（事件路径据此推导同名字段）
    const bodyFirst = s.textBeforeTools === true;
    if (bodyFirst && contentRow !== null) rows.push(contentRow);
    rows.push(...callRows);
    if (!bodyFirst && contentRow !== null) rows.push(contentRow);
    step++;
  }
  return { rows, converted: true, synthesizedMeterRows };
}

/** 段行数（文件级判定：是否含段行） */
export function isSegmentRow(row: Record<string, unknown>): boolean {
  return row.source === 'segment';
}
