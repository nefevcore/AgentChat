// ============================================================
// segment-normalize.test.ts —— 段行 → v2 事件行等价性（cr-1306）
//
// 判据：同一 run 的 foldStepsOf 产出语义恒等——聚合直通路径（段行在场）
// vs 事件重建路径（归一化后）。比对面 = 渲染消费的步投影字段：content /
// reasoning / textBeforeTools / toolCalls（id/name/arguments/result/subcall/
// durationMs）/ aborted / reasoningMs / textMs / elapsedMs / usage / stepId / ts。
// **seq 显式豁免**：归一化 = 整文件原子重写，seq 按最终文件序重分配（writer
// 语义）；原 seq 的直播配对语义（cr-772 B2）只对在途 run 有意义。
// ============================================================
import { describe, it, expect } from 'vitest';
import { domainFactsOf } from '../src/events-core.ts';
import { foldStepsOf } from '../src/fold-core.ts';
import { segmentRowToPhaseRows } from '../src/segment-normalize.ts';
import type { LedgerRow, ProjectedStep } from '../src/records.ts';

const DOMAIN = 'alpha';
const RUN = 'run-1';

function segRow(steps: ProjectedStep[], run = RUN) {
  return {
    role: 'agent', source: 'segment', run, content: '',
    message_id: 'seg-' + run + '-1000',
    timestamp: new Date(1000).toISOString(),
    agent_id: DOMAIN, seq: 7, steps,
  } as unknown as LedgerRow & Record<string, unknown>;
}

/** 按文件序分配 seq（模拟归一化工具：writer 单调语义） */
function allocSeq(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r, i) => ({ ...r, seq: i + 1 }));
}

/** 取某 run 的步投影（段行形态） */
function stepsOfSeg(rows: Array<Record<string, unknown>>): ProjectedStep[] {
  const facts = domainFactsOf(DOMAIN, 2, rows as never, [], []);
  const rf = facts.runs.get(RUN)!;
  return foldStepsOf(rf, [])!.steps;
}

/** 取某 run 的步投影（事件行形态） */
function stepsOfRows(rows: Array<Record<string, unknown>>): ProjectedStep[] {
  const facts = domainFactsOf(DOMAIN, 2, rows as never, [], []);
  const rf = facts.runs.get(RUN)!;
  return foldStepsOf(rf, [])!.steps;
}

/** 规范形：键序无关 + seq 豁免 + 空数组归一为缺席（渲染等价：消费面恒 `x ?? []`） */
function canon(steps: ProjectedStep[]): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        if (k === 'seq') continue;
        const x = (v as Record<string, unknown>)[k];
        if (Array.isArray(x) && x.length === 0) continue;
        out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return steps.map((s) => JSON.stringify(norm(s))).join('\n');
}

describe('段行 → v2 事件行等价（cr-1306）', () => {
  it('思考 + 正文 + 工具调用（含结果）：步投影恒等', () => {
    const steps: ProjectedStep[] = [{
      content: '最终答案', reasoning: '先想一下', ts: 1000, seq: 10, reasoningMs: 500,
      usage: { prompt: 11, completion: 22 }, elapsedMs: 900, textMs: 120,
      stepId: 'run-1:0',
      toolCalls: [{ id: 't1', name: 'read', arguments: '{"p":1}', result: { ok: true }, durationMs: 30 }],
    }];
    const seg = segRow(steps);
    const conv = allocSeq(segmentRowToPhaseRows(seg).rows);
    expect(canon(stepsOfRows(conv))).toBe(canon(stepsOfSeg([seg])));
  });

  it('textBeforeTools=true：正文先于工具（事件序推导出同名字段）', () => {
    const steps: ProjectedStep[] = [{
      content: '正文在前', ts: 2000, textBeforeTools: true,
      toolCalls: [{ id: 't2', name: 'grep', arguments: '{}', result: { ok: true } }],
    }];
    const seg = segRow(steps);
    const conv = allocSeq(segmentRowToPhaseRows(seg).rows);
    const got = stepsOfRows(conv);
    expect(canon(got)).toBe(canon(stepsOfSeg([seg])));
    expect(got[0].textBeforeTools).toBe(true);
  });

  it('textBeforeTools 缺省（工具先行）：推导结果为 false/缺席', () => {
    const steps: ProjectedStep[] = [{
      content: '正文在后', ts: 3000,
      toolCalls: [{ id: 't3', name: 'ls', arguments: '{}', result: { ok: true } }],
    }];
    const seg = segRow(steps);
    const conv = allocSeq(segmentRowToPhaseRows(seg).rows);
    const got = stepsOfRows(conv);
    expect(canon(got)).toBe(canon(stepsOfSeg([seg])));
    expect(got[0].textBeforeTools).toBeUndefined();
  });

  it('纯工具步的计量不丢（合成空正文行承载 meter）', () => {
    const steps: ProjectedStep[] = [{
      content: '', ts: 4000, usage: { prompt: 5, completion: 6 }, elapsedMs: 700, aborted: true,
      toolCalls: [{ id: 't4', name: 'run_code', arguments: '{}', result: { ok: false, error: 'x' } }],
    }];
    const seg = segRow(steps);
    const r = segmentRowToPhaseRows(seg);
    expect(r.synthesizedMeterRows).toHaveLength(1); // 诊断可见
    const conv = allocSeq(r.rows);
    const got = stepsOfRows(conv);
    expect(got[0].usage).toEqual({ prompt: 5, completion: 6 });
    expect(got[0].elapsedMs).toBe(700);
    expect(got[0].aborted).toBe(true);
    expect(canon(got)).toBe(canon(stepsOfSeg([seg])));
  });

  it('多步 run：步序与跨步归属保持', () => {
    const steps: ProjectedStep[] = [
      { content: '第一步', ts: 5000, toolCalls: [] },
      { content: '第二步', reasoning: '想', ts: 6000, stepId: 'run-1:1', toolCalls: [{ id: 't5', name: 'x', arguments: '{}', result: { ok: true } }] },
    ];
    const seg = segRow(steps);
    const conv = allocSeq(segmentRowToPhaseRows(seg).rows);
    const got = stepsOfRows(conv);
    expect(got).toHaveLength(2);
    expect(canon(got)).toBe(canon(stepsOfSeg([seg])));
  });

  it('subcall 子调用：只产 result 行并分组进宿主卡', () => {
    const steps: ProjectedStep[] = [{
      content: '宿主步', ts: 7000,
      toolCalls: [
        { id: 'host1', name: 'run_code', arguments: '{}', result: { ok: true } },
        { id: 'host1#1', name: 'read', arguments: '{}', result: { ok: true }, subcall: true },
      ],
    }];
    const seg = segRow(steps);
    const conv = allocSeq(segmentRowToPhaseRows(seg).rows);
    const got = stepsOfRows(conv);
    const calls = got[0].toolCalls ?? [];
    expect(calls.map((c) => c.id)).toEqual(['host1', 'host1#1']);
    expect(calls[1].subcall).toBe(true);
  });

  it('空 run / 无 steps：不转换（converted=false）', () => {
    const base = { role: 'agent', content: '', message_id: 'm', timestamp: new Date(0).toISOString(), agent_id: DOMAIN, source: 'segment' };
    expect(segmentRowToPhaseRows({ ...base, steps: [] } as never).converted).toBe(false);
    expect(segmentRowToPhaseRows({ ...base, run: '', steps: [{ content: 'x' }] } as never).converted).toBe(false);
  });
});
