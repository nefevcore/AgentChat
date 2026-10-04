// ============================================================
// client/runNodes.ts —— feed turns → run 节点推导（cr-230）
//
// 节点 = 每 run 的用户消息（turn.agent_id === viewer 的轮；不含 event/
// error 分隔轮——它们无 final 交互语义）。多 run 并行（run_code 程序内
// 发消息）按序全收；时间戳取轮首步时刻（与 useTurnDisplayItems 稳定 key
// 同源——reveal 定位键由此对齐）。运行中标记 = 本节点之后仍有 agent 轮
// 在流式（turns 尾向扫描，无 run 边界帧可依时的保守判定）。
// ============================================================
import { VIEWER_ID } from 'ac-client-runtime';
import type { Turn } from 'ac-client-ui-conversation/client/types.ts';

/** 面板节点（run 骨架的用户消息侧投影） */
export interface RunNode {
  /** 定位用消息 id（feed 消息 id） */
  id: string;
  /** 轮首时间戳（reveal key = `turn-<viewer>-<ts>` 与渲染管线同源） */
  ts: number;
  /** 正文摘要（首行；空 = 本 run 无文字输入——如纯附件/纯手势） */
  text: string;
  /** 本 run 是否仍在运行（其后存在流式 agent 轮） */
  running: boolean;
}

function firstLine(s: string | undefined | null): string {
  const t = (s ?? '').trim();
  if (!t) return '';
  const i = t.indexOf('\n');
  return (i === -1 ? t : t.slice(0, i)).slice(0, 80);
}

/** turns → 节点清单（新→旧，尾向扫描序——消费方按需 reverse 得正序时间线） */
export function runNodesOf(turns: Turn[]): RunNode[] {
  const out: RunNode[] = [];
  let running = false; // 尾向扫描：已见流式 agent 轮 → 其前的用户轮标记 running
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.agent_id !== VIEWER_ID.value) {
      if (t.steps.some((s) => s.isStreaming)) running = true;
      continue;
    }
    // viewer 轮：无 final 的占位（排队回显等）不产生节点
    if (!t.final) continue;
    out.push({
      id: t.final.id,
      ts: t.steps.at(0)?.assistant.timestamp ?? t.final.timestamp,
      text: firstLine(t.final.content),
      running,
    });
    running = false;
  }
  return out;
}
