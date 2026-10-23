// ============================================================
// confirm.ts —— 确认状态机（协议规格 A2：落账即确认）
//
// 信封生命周期：send → [通道] → acquire → delivered(落账) → acked → settled
//   acquire   接收方收到，requestId 入准入表（内存）
//   delivered 消息行落盘本端账本——**此刻即 ack**，ack 信封可回
//   acked     投递方收到 ack（或超时窗口内未见重复投递即视为达）
//   settled   本端 run 若被触发且收束——投递方无需等待
// 重投：投递方未收 ack 超时（缺省 30s 量级）重发同 requestId；接收方
// 去重（重复即丢 + 补发 ack）。
// ============================================================

export type EnvelopePhase = 'acquire' | 'delivered' | 'acked' | 'settled';

/** 状态机判定结果 */
export type PhaseTransition =
  | { ok: true; phase: EnvelopePhase }
  | { ok: false; reason: 'illegal-transition' };

const ORDER: Readonly<Record<EnvelopePhase, number>> = { acquire: 0, delivered: 1, acked: 2, settled: 3 };

/** 单信封投递跟踪器（接收方视角：acquire → settled 单向推进） */
export class EnvelopeTracker {
  private phase: EnvelopePhase = 'acquire';

  /** 阶段推进（单向；跳阶段合法——传输层直收时 acquire+delivered 同步；
   * 回退非法；delivered 重入 = 重投补发 ack，不降阶段） */
  advance(to: EnvelopePhase): PhaseTransition {
    if (ORDER[to] < ORDER[this.phase]) return { ok: false, reason: 'illegal-transition' };
    this.phase = to;
    return { ok: true, phase: this.phase };
  }

  current(): EnvelopePhase {
    return this.phase;
  }
}

/** 重投判定（投递方视角）：超时未 ack 即可重发（30s 量级，R-3） */
export const RESEND_TIMEOUT_MS = 30_000;

export function shouldResend(sentAt: number, now: number, acked: boolean): boolean {
  return !acked && now - sentAt >= RESEND_TIMEOUT_MS;
}
