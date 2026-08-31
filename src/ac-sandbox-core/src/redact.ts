// ============================================================
// ac-sandbox-core/src/redact.ts —— 输出脱敏纯函数（src security/redact 平移）
//
// 密钥保护防线之一：无论工具从哪条路径读到密钥，返回给 LLM 前统一替换
// 为掩码。清单来源（参数化——调用方装配，本库不读凭据库）：
//   · 明文凭据值集合（精确匹配；ac-security 行从 ctx.credentials 装配）
//   · 通用密钥模式（sk-xxx / api_key= 赋值等）
// preview 落点：transform-result waterfall（after 是纯通知，
// 改了没人消费——地图 §3.4 安全域明示）。
// ============================================================

/** 通用密钥模式（AI 厂商 key / 配置赋值 / 常见密钥命名）
 *  （修正 src 潜在 bug：赋值模式的尾部引号吞吃会让 JSON 回环产出非法
 *   JSON——此处不消费尾引号；配合下方结构化深走，双保险） */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI/DeepSeek 风格
  /(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[=:]\s*['"]?[A-Za-z0-9_\-./+]{16,}/gi,
];

/**
 * 构建脱敏器（纯函数形态；secrets 为精确敏感值集合）。
 * 1. 精确值替换（过短值 <4 跳过，避免误伤）
 * 2. 通用模式替换（保留赋值前缀，只掩码值部分）
 */
export function makeSecretRedactor(secrets: Iterable<string>): (content: string) => string {
  return (content: string): string => {
    if (!content) return content;
    let out = content;

    // 1. 精确值替换
    for (const v of secrets) {
      if (v.length < 4) continue; // 过短不替换，避免误伤
      out = out.split(v).join('***');
    }

    // 2. 通用模式替换（保留赋值前缀，只掩码值部分）
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, (m) => {
        const eq = m.search(/[=:]\s*['"]?/);
        return eq > 0 ? m.slice(0, eq + 1) + '***' : '***';
      });
    }
    return out;
  };
}

/**
 * 递归脱敏任意详情载荷（结构化深走：字符串直接替换；对象/数组逐层
 *  重建——不经 JSON 序列化回环，杜绝"脱敏产出非法 JSON 被静默吞掉"
 *  的失效路径，键名不脱敏只脱值）。
 */
export function redactSecretValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return value ? redact(value) : value;
  if (Array.isArray(value)) return value.map((v) => redactSecretValue(v, redact));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecretValue(v, redact);
    }
    return out;
  }
  return value;
}
