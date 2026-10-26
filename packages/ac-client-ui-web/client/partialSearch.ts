// ============================================================
// client/partialSearch.ts —— 历史截断形部分恢复（纯库，cr-466 抽库）
//
// run_code 子调用的完整结果只由收束行 steps 携带；历史面的补行被截断
// 时（{__truncated,bytes,head}），web_search 卡拿不到 results 数组。
// head 是完整 JSON 的前缀——截断点必在 results 数组内部：逐元素扫描
// 恢复出几条结果就显示几条（标记「部分结果」），N 条结果永远好过空卡。
// 住独立模块（零 vue/pinia 依赖，node 直测；原住 SFC 内零覆盖）。
// ============================================================

/** 部分恢复出的搜索输出（字段宽松：截断点任意，可缺） */
export interface PartialSearchOutput {
  provider?: string;
  query?: string;
  answer?: string;
  results: unknown[];
}

/** data.__truncated 形状判定：非截断形（或 head 缺失）直接 null（零解析开销） */
function truncatedHeadOf(data: Record<string, unknown>): string {
  const t = data as { __truncated?: unknown; head?: unknown };
  return t.__truncated === true && typeof t.head === 'string' ? t.head : '';
}

/** head 前缀 → 可解析的部分 output（无 results 数组到达 = null）。
 *  results 前字段（provider/query/answer）：完整引号闭合的才取
 * （转义感知——串内 \" 不算闭合）。 */
function parsePreamble(pre: string): PartialSearchOutput {
  const out: PartialSearchOutput = { results: [] };
  for (const key of ['provider', 'query', 'answer'] as const) {
    const m = pre.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
    if (m) out[key] = m[1];
  }
  return out;
}

/** 工具卡 data → 部分搜索输出；非截断形 / 截断在 results 之前 = null */
export function partialSearchOf(data: Record<string, unknown>): PartialSearchOutput | null {
  const head = truncatedHeadOf(data);
  if (!head) return null;
  const outIdx = head.indexOf('"output":');
  if (outIdx === -1) return null;
  const body = head.slice(outIdx + '"output":'.length);
  if (!body.startsWith('{')) return null;
  const rIdx = body.indexOf('"results":[');
  if (rIdx === -1) return null; // 截断在 results 数组之前——无从恢复
  const out = parsePreamble(body.slice(0, rIdx));
  // 逐元素扫描（字符串转义感知）：从 "results":[ 起逐个提取完整 {} 元素，
  // 截断点落在元素内即丢弃该元素——任意截断位置都安全。
  let i = rIdx + '"results":['.length;
  const results: unknown[] = [];
  while (i < body.length) {
    while (i < body.length && (body[i] === ',' || body[i] === ' ' || body[i] === '\n')) i++;
    if (i >= body.length || body[i] === ']' || body[i] !== '{') break;
    let depth = 0, j = i, inStr = false;
    for (; j < body.length; j++) {
      const ch = body[j];
      if (inStr) {
        if (ch === '\\') { j++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0 || j >= body.length) break; // 截断在元素内——丢弃
    try { results.push(JSON.parse(body.slice(i, j + 1))); } catch { break; }
    i = j + 1;
  }
  out.results = results;
  return out;
}
