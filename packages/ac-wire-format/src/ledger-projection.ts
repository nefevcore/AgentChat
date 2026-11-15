// ============================================================
// ac-wire-format/src/ledger-projection.ts —— 事件日志 append → 前端帧
// 投影（cr-976 直播管线 B 案，cr-975 §1）
//
// 纯函数：壳 ledger/event-appended 旁带帧的行全集 → 新帧族。帧不是第二
// 事实，是事件日志的视图——帧身份 = 事件身份（seq 锚直通，前端吸收/去重
// 从同锚启发式升级为同 seq 恒等）。
//
// 词汇映射（D3-3 一步切换——旧帧族同批删除）：
//   · step/* 相位行批（journalStep 切片）→ `step/journaled`（行序即步内序，
//     步末计量挂末行——cr-946 教训的直播面对应物）；
//   · step/tool-call-result 行 → `tool/result`（subcall 全文内联随行）；
//   · run-end 行 → `run/settled`（finish/usage/runMs + 同批终稿 message 行
//     的 text——收敛单事实：落盘 durable 与前端重拉同一因果链，E-2 根治）；
//   · inject 行不投影——直播注入卡由既有 session/context-injected 帧承载
//     （与 journalInject 同锚同时发射；resume 路径 cr-1111 起有落账 context 行
//     〔source='resume'〕但同样不投影——帧面未被事件行全覆盖,新增投影帧反而
//     双渲染,cr-976 裁决不变）；
//   · 入站 message/context、compaction 机制行不投影（读面重拉覆盖）。
//
// 两个时标物理承认（D3-1）：llm/delta 流帧不经落盘（微批仍在传输层）；
// 本投影只管 durable 事实面。run/settled 前消费方须强制 flush 在途批
// （收敛前零在途——清空职责在批器持有方，本模块只产出帧序）。
// ============================================================

/** 投影帧（webServer.broadcast 帧形：type + args 参数序） */
export interface ProjectedFrame {
  type: string;
  args: unknown[];
}

/** 路由 meta（旁带帧携带——agent/conversationId 寻址会话） */
export interface ProjectionMeta {
  agent?: string;
  conversationId?: string;
}

/** 前端帧词汇（新帧族——判别面单源） */
export const RUN_SETTLED_FRAME = 'run/settled';
export const STEP_JOURNALED_FRAME = 'step/journaled';
export const TOOL_RESULT_FRAME = 'tool/result';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** run-end finish 词汇映射：日志 completed → 前端 stop（after-run 旧词汇沿用） */
function finishOf(v: unknown): 'stop' | 'interrupted' | 'error' {
  return v === 'error' || v === 'interrupted' ? v : 'stop';
}

/** step/* 相位行批 → step/journaled 载荷（rows 原样直通——行序即步内序，
 *  聚合归前端；seq = 批末行，B2 水位锚） */
function stepFrame(meta: ProjectionMeta, rows: Array<Record<string, unknown>>): ProjectedFrame {
  const last = rows[rows.length - 1]!;
  return {
    type: STEP_JOURNALED_FRAME,
    args: [{
      agent: meta.agent,
      conversationId: meta.conversationId,
      run: str(last.run),
      step: num(last.step),
      ...(str(last.stepId) !== undefined ? { stepId: str(last.stepId) } : {}),
      seq: num(last.seq),
      rows,
    }],
  };
}

/** step/tool-call-result 行 → tool/result 载荷（subcall 标记/名/参随行——
 *  run_code 子调用平铺卡的直播终值面） */
function toolResultFrame(meta: ProjectionMeta, row: Record<string, unknown>): ProjectedFrame {
  return {
    type: TOOL_RESULT_FRAME,
    args: [{
      agent: meta.agent,
      conversationId: meta.conversationId,
      run: str(row.run),
      toolCallId: str(row.toolCallId),
      seq: num(row.seq),
      ...(row.result !== undefined ? { result: row.result } : {}),
      ...(num(row.durationMs) !== undefined ? { durationMs: num(row.durationMs) } : {}),
      ...(row.subcall === true ? { subcall: true } : {}),
      ...(str(row.name) !== undefined ? { name: str(row.name) } : {}),
      ...(str(row.arguments) !== undefined ? { arguments: str(row.arguments) } : {}),
      ...(num(row.ts) !== undefined ? { ts: num(row.ts) } : {}),
    }],
  };
}

/** 收束切片（settle/compaction）→ run/settled 载荷：finish/usage/runMs 取
 *  run-end 行；text 取同批 type:'message' 终稿行（缺席 = ''——机制 run
 *  与对账补投同形，终稿以重拉权威行为准）。 */
function runSettledFrame(meta: ProjectionMeta, rows: Array<Record<string, unknown>>): ProjectedFrame | null {
  const end = rows.find((r) => r.type === 'run-end');
  if (end === undefined) return null;
  const finalMsg = rows.find((r) => r.type === 'message' && r.role !== 'context');
  return {
    type: RUN_SETTLED_FRAME,
    args: [{
      agent: meta.agent,
      conversationId: meta.conversationId,
      run: str(end.run),
      seq: num(end.seq),
      finish: finishOf(end.finish),
      text: finalMsg !== undefined ? String(finalMsg.content ?? '') : '',
      ...(str(end.errorMessage) !== undefined ? { error: str(end.errorMessage) } : {}),
      ...(end.usage !== undefined ? { usage: end.usage } : {}),
      ...(str(end.model) !== undefined ? { model: str(end.model) } : {}),
      ...(num(end.runMs) !== undefined ? { runMs: num(end.runMs) } : {}),
      ...(num(end.ts) !== undefined ? { ts: num(end.ts) } : {}),
    }],
  };
}

/**
 * 落账切片 → 前端帧序列（纯函数核心，单测面）。同批多类行（settle 切片
 * = 终稿 + run-end）产单收束帧；步相位批产单步帧；tool-call-result 行
 * 逐行产帧。未知行安全忽略（判别面宽容——v2 未知 type 前向兼容沿用）。
 */
export function projectLedgerAppend(meta: ProjectionMeta, rows: Array<Record<string, unknown>>): ProjectedFrame[] {
  const out: ProjectedFrame[] = [];
  // 收束切片优先整批判（run-end 在批内即可投影，text 取同批终稿行）
  const settled = runSettledFrame(meta, rows);
  if (settled !== null) {
    out.push(settled);
    return out;
  }
  const stepRows: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const t = row.type;
    if (t === 'step/reasoning' || t === 'step/content' || t === 'step/tool-call') {
      stepRows.push(row);
    } else if (t === 'step/tool-call-result') {
      out.push(toolResultFrame(meta, row));
    }
    // inject / message / context / compaction：不投影（见文件头裁决）
  }
  if (stepRows.length > 0) out.push(stepFrame(meta, stepRows));
  return out;
}
