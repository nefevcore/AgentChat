// ============================================================
// tokens.ts —— token 估算（前端展示口径）
//
// 与后端 ac-text-budget estimateTokens 同款启发式：CJK 0.6 / 其他 0.3，
// 逐字符串向上取整。用于 Token 详情弹层的固定开销拆分（系统提示/工具
// 定义）——展示口径与后端归档估算一致，仅提示"≈"（与 provider 实际
// 计费 token 有偏差）。
// ============================================================

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
