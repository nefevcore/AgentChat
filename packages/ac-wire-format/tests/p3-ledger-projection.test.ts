// ============================================================
// p3-ledger-projection.test.ts —— cr-976 B 案投影层黄金对拍：
// 帧序 ≡ 事件行序（P3-1 验收 #1）。性质：任一 run 的落账批次序列经
// projectLedgerAppend 产出的帧，其携带的 seq 严格单调且与日志行序一致；
// 步相位批产单 step/journaled（rows 直通）；工具结果行产 tool/result；
// 收束批产唯一 run/settled（text 取同批终稿行，completed→stop）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { projectLedgerAppend, RUN_SETTLED_FRAME, STEP_JOURNALED_FRAME, TOOL_RESULT_FRAME } from '../src/ledger-projection.ts';

const meta = { agent: 'alpha', conversationId: 'u~alpha' };
let seq = 0;
const next = (): number => ++seq;

function fullRunBatches(): Array<Array<Record<string, unknown>>> {
  seq = 0;
  return [
    // 步 0：reasoning + 工具调用（工具先行步）
    [
      { type: 'step/reasoning', run: 'r1', step: 0, stepId: 'r1:0', text: '思考', ts: 1, seq: next() },
      { type: 'step/tool-call', run: 'r1', step: 0, stepId: 'r1:0', toolCallId: 'c1', name: 'hello', arguments: '{}', ts: 1, seq: next(), elapsedMs: 800, usage: { prompt: 10 } },
    ],
    // 工具结果（独立落账切片——tool/after-execute 时机）
    [
      { type: 'step/tool-call-result', run: 'r1', toolCallId: 'c1', result: { ok: true, output: '输出' }, durationMs: 30, ts: 2, seq: next() },
    ],
    // 步 1：正文先行步（cr-946 相位序）
    [
      { type: 'step/content', run: 'r1', step: 1, stepId: 'r1:1', text: '最终', ts: 3, seq: next() },
    ],
    // 注入行（不投影——但保持行序参与对拍）
    [
      { type: 'inject', run: 'r1', content: '插话', ts: 4, seq: next() },
    ],
    // 收束切片：终稿 + run-end
    [
      { type: 'message', role: 'agent', content: '最终+输出', run: 'r1', seq: next() },
      { type: 'run-end', run: 'r1', finish: 'completed', runMs: 5000, ts: 5, seq: next() },
    ],
  ];
}

describe('projectLedgerAppend（cr-976 投影层）', () => {
  it('黄金对拍：帧序 ≡ 事件行序（帧携带 seq 严格单调，与日志行序一致）', () => {
    const batches = fullRunBatches();
    // 日志行序（append-only 全量）
    const logSeqs = batches.flat().map((r) => r.seq as number);
    expect(logSeqs).toEqual([...logSeqs].sort((a, b) => (a as number) - (b as number)));
    void logSeqs;
    // 投影帧序
    const frames = batches.flatMap((rows) => projectLedgerAppend(meta, rows));
    expect(frames.map((f) => f.type)).toEqual([
      STEP_JOURNALED_FRAME, TOOL_RESULT_FRAME, STEP_JOURNALED_FRAME, RUN_SETTLED_FRAME,
    ]);
    // 帧锚 seq 单调（帧身份 = 事件身份——step 帧锚批末行，工具/收束帧锚本行）
    const anchors = frames.map((f) => (f.args[0] as { seq?: number }).seq);
    expect(anchors).toEqual([...anchors].sort((a, b) => (a as number) - (b as number)));
    void anchors;
    // 逐帧锚点核对：step 帧锚批末行 seq；tool/settled 帧锚本行 seq
    expect(anchors).toEqual([2, 3, 4, 7]);
  });

  it('run/settled：text 取同批终稿 message 行；completed→stop；error 载 errorMessage→error', () => {
    const ok = projectLedgerAppend(meta, [
      { type: 'message', role: 'agent', content: '终稿', run: 'r1', seq: 8 },
      { type: 'run-end', run: 'r1', finish: 'completed', runMs: 42, ts: 1, seq: 9 },
    ]);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.type).toBe(RUN_SETTLED_FRAME);
    expect(ok[0]!.args[0]).toMatchObject({ finish: 'stop', text: '终稿', runMs: 42, seq: 9 });
    const err = projectLedgerAppend(meta, [
      { type: 'message', role: 'agent', content: '', run: 'r1', seq: 10 },
      { type: 'context', role: 'context', source: 'error', content: '超时', run: 'r1', seq: 11 },
      { type: 'run-end', run: 'r1', finish: 'error', errorMessage: '连接超时', ts: 2, seq: 12 },
    ]);
    expect(err[0]!.args[0]).toMatchObject({ finish: 'error', text: '', error: '连接超时' });
  });

  it('step/journaled：rows 原样直通 + 步末计量挂末行（聚合归前端）', () => {
    const rows = [
      { type: 'step/reasoning', run: 'r1', step: 0, stepId: 'r1:0', text: '思考', reasoningMs: 900, ts: 1, seq: 1 },
      { type: 'step/content', run: 'r1', step: 0, stepId: 'r1:0', text: '正文', ts: 1, seq: 2, aborted: true, elapsedMs: 1500 },
    ];
    const out = projectLedgerAppend(meta, rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe(STEP_JOURNALED_FRAME);
    expect(out[0]!.args[0]).toMatchObject({ run: 'r1', step: 0, stepId: 'r1:0', seq: 2, rows });
  });

  it('inject / 入站 message / compaction 机制行：不投影（读面重拉覆盖）；空批零帧', () => {
    expect(projectLedgerAppend(meta, [{ type: 'inject', run: 'r1', content: 'x', seq: 1 }])).toEqual([]);
    expect(projectLedgerAppend(meta, [{ type: 'message', role: 'user', content: '入站', seq: 1 }])).toEqual([]);
    expect(projectLedgerAppend(meta, [{ type: 'compaction/start', run: 'r9', seq: 1 }])).toEqual([]);
    expect(projectLedgerAppend(meta, [])).toEqual([]);
    // 未知 type 前向兼容：安全忽略
    expect(projectLedgerAppend(meta, [{ type: 'future/thing', seq: 1 }])).toEqual([]);
  });

  it('subcall 工具结果：subcall/name/arguments 随行（run_code 平铺卡数据面——D-1 全文内联）', () => {
    const out = projectLedgerAppend(meta, [{
      type: 'step/tool-call-result', run: 'r1', toolCallId: 'r1#0', result: { ok: true },
      subcall: true, name: 'pwsh', arguments: '{"command":"ls"}', ts: 1, seq: 5,
    }]);
    expect(out[0]!.type).toBe(TOOL_RESULT_FRAME);
    expect(out[0]!.args[0]).toMatchObject({ toolCallId: 'r1#0', subcall: true, name: 'pwsh', arguments: '{"command":"ls"}' });
  });
});
