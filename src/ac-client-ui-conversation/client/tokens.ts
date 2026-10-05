// ============================================================
// tokens.ts —— token 估算（前端展示口径）
//
// 与后端 ac-text-budget estimateTokens 同款启发式：CJK 0.6 / 其他 0.3，
// 逐字符串向上取整。用于 Token 详情弹层的固定开销拆分（系统提示/工具
// 定义）——展示口径与后端归档估算一致，仅提示"≈"（与 provider 实际
// 计费 token 有偏差）。KV 缓存走势（cr-231）的 rpc 拉取薄壳同住本域。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';

const CJK = /[\u4e00-\u9fff]/;

/** 估算文本 token 数（CJK 0.6 / 其他 0.3，近似值用于展示） */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += CJK.test(ch) ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

/**
 * token 数 K/M 级约化（展示）：≥999.5K 进 M 档（一位小数、≥100M 取整）、
 * ≥1K 进 K 档（一位小数、≥100K 取整）、<1K 原样（未命中明细等小值
 * 约化反而失真）。示例：313 → '313'；12,345 → '12.3K'；196,025 → '196K'；
 * 1,000,000 → '1M'；1,500,000 → '1.5M'。
 */
export function fmtTokenCount(n: number): string {
  if (n >= 999_500) {
    // K 档舍入会到 1000K——直接进 M 档
    const m = n / 1_000_000;
    return `${m >= 100 ? Math.round(m) : Number(m.toFixed(1))}M`;
  }
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}K`;
}

/** KV 缓存走势点（session/kv-timeline 返回形；cr-232 步粒度：每点 = 一次
 *  有计量的 LLM 调用——hit+miss=0 的步无计量不入序列） */
export interface KvTimelinePoint {
  /** 步收束时刻（epoch ms；旧形态 run 合计回退点 = run 时间戳） */
  ts: number;
  hit: number;
  miss: number;
}

/** 会话步级 KV 缓存序列（全量；弹层打开时懒加载） */
export async function fetchKvTimeline(
  conversationId: string,
  rpc: RpcClientFace,
): Promise<KvTimelinePoint[]> {
  const r = await rpc.call<{ points?: KvTimelinePoint[] }>('session/kv-timeline', { conversationId });
  return r.points ?? [];
}

