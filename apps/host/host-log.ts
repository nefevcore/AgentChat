// ============================================================
// host-log.ts —— 宿主控制台格式化出口（cr-742）
//
// 宿主/编排面的手写诊断行统一走本出口：HH:mm:ss LVL [src] msg。
// 与 cordis logger 行（yyyy-MM-dd hh:mm:ss [I] name msg）视觉协调：
// 同列时间戳 + 同位置级别位，来源段 [host]/[orchestrator]/[shell:agent]
// 直读可辨。只管格式——落盘/转发语义仍归各调用方（tee 的 host-*.log
// 原样收留这些行，格式化后的时间前缀使日志内同样可读）。
// ============================================================

export type ConsoleLevel = 'I' | 'W' | 'E';

/**
 * 格式化并写宿主 stderr（一行）。
 * @param level I/W/E——与 cordis 行的 [I]/[W]/[E] 同词表。
 * @param src 来源段：host / orchestrator / shell:<agentId>。
 */
export function hostLog(level: ConsoleLevel, src: string, msg: string): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  process.stderr.write(`${hh}:${mm}:${ss} [${level}] [${src}] ${msg}\n`);
}
