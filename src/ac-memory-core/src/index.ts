// ============================================================
// ac-memory-core/src/index.ts —— 记忆时间线渲染/解析纯库
//
// 记忆时间线重构（src/docs/memory-timeline-plan.md）：单文件
// files/<agentId>/memory/timeline.md，条目 = 头注释（宿主铸造：时间戳 /
// origin=写入时会话标识 / peers / tags）+ 正文；seq = 条目在文件中的
// 序号（1-based，位置派生）——零计数器状态。
//
// 本库只做纯计算（零 cordis 依赖）：条目头铸造/容错解析、快照确定性
// 渲染（整数条截断 + 预算内最近 M 条）、grep 过滤轴语义、delta 渲染。
// I/O（读写文件/origin 铸造）住 ac-memory 服务。
//
// 容错（fs 裸写破坏头）：头解析失败 → 条目降级为纯文本行（grep/渲染
// 不崩，丢失元数据轴）。协议正确性不依赖头的真实性（H<S 自愈、seq
// 位置派生）。
// ============================================================
import { estimateTokens } from 'ac-text-budget';

/** 记忆条目（解析产物；seq 位置派生 1-based） */
export interface MemoryEntry {
  /** 条目序号（文件内 1-based，位置派生） */
  seq: number;
  /** 头注释铸造时间（ISO 串；容错降级行为 undefined） */
  at?: string;
  /** 写入时会话标识（1v1 对键 / g:群id / gid~member 等；降级缺失） */
  origin?: string;
  /** 关联端点（逗号分隔，Agent 侧可选提供） */
  peers?: string[];
  /** 分类标签（Agent 侧可选提供） */
  tags?: string[];
  /** 正文（头注释行之后的全部行，trim 尾空白） */
  content: string;
  /** 头解析失败（降级行——元数据轴不可用，正文仍可渲染） */
  degraded?: boolean;
}

/** 头注释行形如：<!-- 2026-12-08T14:32 | origin:g:前端群 | peers:alice,bob | tags:约定 --> */
const HEADER_RE = /^<!--\s*([^>]*)\s*-->$/;

/** 头内字段分隔：k:v 键值对以 | 分隔 */
function parseHeaderFields(inner: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of inner.split("|")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out.set(key, value);
  }
  return out;
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined || !value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * 解析时间线全文为条目流。
 *   · 以头注释行分界：头注释行开启新条目，其后正文行累积至下一头；
 *   · 无头前导正文（人工编辑/损坏）→ 各行各自成为降级条目；
 *   · 头字段格式坏（时间戳非 ISO 等）→ 条目降级（at 缺失，正文保留）。
 */
export function parseTimeline(text: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let current: MemoryEntry | null = null;
  const push = (entry: MemoryEntry): void => {
    // tags 轴权威 = 正文前缀（`[date] [tag|tag] 正文`——Agent 直写通道）：首行
    // 带前缀标签段则提升覆盖；无前缀段保留头注释 tags（存量形态兼容）。
    const m = entry.content.match(/^\[\d{4}-\d{2}-\d{2}\]\s+\[([^\]\n]+)\]/);
    if (m) entry.tags = m[1].split("|").map((t) => t.trim()).filter(Boolean);
    entry.seq = entries.length + 1;
    entries.push(entry);
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const m = HEADER_RE.exec(line);
    if (m) {
      if (current) push(current);
      const fields = parseHeaderFields(m[1]);
      const at = fields.get("at") ?? fields.get("timestamp");
      const origin = fields.get("origin");
      if (at === undefined && origin === undefined && fields.size === 0) {
        // 空/坏头：降级条目（正文照常累积）
        current = { seq: 0, content: "", degraded: true };
      } else {
        current = {
          seq: 0,
          at: at !== undefined && !Number.isNaN(Date.parse(at)) ? at : undefined,
          origin,
          peers: csv(fields.get("peers")),
          tags: csv(fields.get("tags")),
          content: "",
          degraded: at === undefined ? true : undefined,
        };
      }
      continue;
    }
    if (!line.trim()) {
      // 空行：条目间分隔（丢）或正文内空行（保留在条目内）
      if (current) current.content += (current.content ? "\n" : "") + "";
      continue;
    }
    // 无头区（fs 裸写/人工编辑）：带 [date] 前缀的行 = 独立 log 条（前缀即边界，
    // 自提取 at/tags 轴自愈）；无前缀裸行并入当前条目（多行一段语义）。
    // 正牌头注释条目（degraded 无标志）的正文行不参与切分——多行正文允许日期开头。
    const isLogLine = /^\[\d{4}-\d{2}-\d{2}\]/.test(line);
    if (isLogLine && current?.degraded === true) {
      push(current);
      current = null;
    }
    if (current) {
      current.content += (current.content ? "\n" : "") + line;
    } else {
      const dateM = /^\[(\d{4}-\d{2}-\d{2})\]/.exec(line);
      const tagsM = /^\[\d{4}-\d{2}-\d{2}\]\s+\[([^\]\n]+)\]/.exec(line);
      current = {
        seq: 0,
        ...(dateM ? { at: new Date(`${dateM[1]}T00:00:00.000Z`).toISOString() } : {}),
        ...(tagsM ? { tags: tagsM[1].split("|").map((t) => t.trim()).filter(Boolean) } : {}),
        content: line,
        degraded: true,
      };
    }
  }
  if (current) push(current);
  // 条目正文 trim（头后首尾空行丢弃）；空内容条目滤除（文件尾残留空头）
  return entries
    .map((e) => ({ ...e, content: e.content.trim() }))
    .filter((e) => e.content.length > 0);
}

/**
 * 铸造条目行（memory_write 服务写口/测试共用）：头注释 + 正文，
 * 追加到文件尾的完整文本块（含首尾换行对齐）。origin/at/seq 由宿主
 * 铸造，Agent 不接触。
 *
 * 条目格式约定（log 形态）：正文行首由宿主铸 `[YYYY-MM-DD] ` 日期段；
 * 标签段 `[tag|tag]` 紧随其后由 Agent 直接写进正文（标签唯一通道，parse
 * 侧提取为轴）。正文在时间线里自描述，渲染/人工阅读不依赖头注释。
 * Agent 传入正文若已带日期段则去重（标签段保留）。
 */
/**
 * 正文行首前缀 `[date] `——日期段由宿主铸造；tags 段由 Agent 直接写进正文
 * （`[date] [tag|tag] 正文`——前缀即标签通道，parse 侧提取为轴）。
 */
export function entryPrefix(at: string): string {
  return `[${at.slice(0, 10)}] `;
}

/** 剥离正文自带的日期前缀段（防重复；标签段是 Agent 的内容通道，保留） */
export function stripEntryPrefix(content: string): string {
  return content.replace(/^\[\d{4}-\d{2}-\d{2}\]\s?/, "");
}

export function mintEntry(input: {
  at: string;
  origin: string;
  peers?: string[];
  content: string;
}): string {
  const fields = [`at:${input.at}`, `origin:${input.origin}`];
  if (input.peers && input.peers.length > 0) fields.push(`peers:${input.peers.join(",")}`);
  const body = stripEntryPrefix(input.content.trim());
  return `<!-- ${fields.join(" | ")} -->\n${entryPrefix(input.at)}${body}\n`;
}

/** 快照/delta 渲染参数 */
export interface RenderOptions {
  /** token 预算（<=0 不截断；缺省 2000） */
  maxTokens?: number;
  /** 快照形态的最大条目数上限（防超多条碎条挤爆；缺省 200） */
  maxEntries?: number;
}

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MAX_ENTRIES = 200;

/**
 * 渲染单条（log 形态）：日期段以条目轴（头注释 at）为准重铸、正文首行若
 * 无标签段则从头注释 tags 补（存量兼容）；正文其余原样。降级行裸正文直出。
 */
function renderEntry(e: MemoryEntry): string {
  if (e.at === undefined) return e.content;
  const body = e.content.replace(/^\[\d{4}-\d{2}-\d{2}\]\s?/, ""); // 只剥日期段
  if (body.startsWith("[")) return `${entryPrefix(e.at)}${body}`; // 正文自带标签段
  const tags = e.tags && e.tags.length > 0 ? `[${e.tags.join("|")}] ` : "";
  return `${entryPrefix(e.at)}${tags}${body}`;
}

/**
 * 快照渲染（确定性：条目升序、整数条截断、溢出计数稳定）。预算内保留
 * 【最近 M 条整数条目】（尾部，近期信息密度高）；头部统计行（N 条 ·
 * 时间跨度 · tags）+ 溢出注记。预算含标记自身。
 */
export function renderSnapshot(entries: MemoryEntry[], options: RenderOptions = {}): string {
  if (entries.length === 0) {
    return "（记忆时间线为空：尚无长期记忆条目）";
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const times = entries
    .map((e) => e.at)
    .filter((t): t is string => t !== undefined)
    .sort();
  const tagSet = new Set<string>();
  for (const e of entries) for (const t of e.tags ?? []) tagSet.add(t);
  const stat = `（记忆时间线：${entries.length} 条 · ${times.length > 0 ? `${times[0].slice(0, 10)} ~ ${times[times.length - 1].slice(0, 10)}` : "时间未知"}${tagSet.size > 0 ? ` · tags: ${[...tagSet].join(",")}` : ""}）`;
  if (maxTokens <= 0) {
    return [stat, ...entries.slice(-maxEntries).map(renderEntry)].join("\n");
  }
  // 尾部预算装载（整数条；超 maxEntries 先截）
  const candidate = entries.slice(-maxEntries);
  const kept: string[] = [];
  let used = estimateTokens(stat);
  for (let i = candidate.length - 1; i >= 0; i--) {
    const line = renderEntry(candidate[i]);
    const t = estimateTokens(line);
    if (used + t > maxTokens && kept.length > 0) break;
    used += t;
    kept.unshift(line);
  }
  const omitted = entries.length - kept.length; // 预算外（含 maxEntries 截断）未注入条数
  const parts: string[] = [stat];
  if (omitted > 0) {
    parts.push(`（另有 ${omitted} 条更早记忆未注入，memory_grep 可查）`);
  }
  return [...parts, ...kept].join("\n");
}

/**
 * delta 渲染（(S, H] 区间条目，升序）：前置一行机制说明。空区间返回
 * undefined（调用方据此不注入）。
 */
export function renderDelta(entries: MemoryEntry[], range: { from: number; to: number }): string | undefined {
  const slice = entries.filter((e) => e.seq > range.from && e.seq <= range.to);
  if (slice.length === 0) return undefined;
  const head = `（自上次会话后新增记忆 ${slice.length} 条——来自其他会话的长期记忆更新）`;
  return [head, ...slice.map(renderEntry)].join("\n");
}

/**
 * grep 过滤轴（memory_grep / 服务 grep 共用语义）：
 *   · pattern：JS 正则（new RegExp 编译；语法错抛错由调用方收敛）；
 *   · since/until：时间轴（at 缺失的降级行排除在时间过滤外——无法定位）；
 *   · peer/tag：包含匹配（条目字段含该值即命中）。
 * 匹配目标 = 正文 + origin + tags（peers/tags 头字段），返回命中条目。
 */
export interface GrepQuery {
  pattern?: string;
  since?: string;
  until?: string;
  peer?: string;
  tag?: string;
}

export function grepEntries(entries: MemoryEntry[], q: GrepQuery): MemoryEntry[] {
  let re: RegExp | undefined;
  if (q.pattern !== undefined && q.pattern !== "") {
    re = new RegExp(q.pattern, "i");
  }
  const sinceMs = q.since !== undefined ? Date.parse(q.since) : undefined;
  const untilMs = q.until !== undefined ? Date.parse(q.until) : undefined;
  return entries.filter((e) => {
    if (re !== undefined) {
      const haystack = [e.content, e.origin ?? "", ...(e.tags ?? [])].join("\n");
      if (!re.test(haystack)) return false;
    }
    if (q.peer !== undefined) {
      if (!(e.peers ?? []).includes(q.peer)) return false;
    }
    if (q.tag !== undefined) {
      if (!(e.tags ?? []).includes(q.tag)) return false;
    }
    if (sinceMs !== undefined || untilMs !== undefined) {
      if (e.at === undefined) return false;
      const t = Date.parse(e.at);
      if (Number.isNaN(t)) return false;
      if (sinceMs !== undefined && !Number.isNaN(sinceMs) && t < sinceMs) return false;
      if (untilMs !== undefined && !Number.isNaN(untilMs) && t > untilMs) return false;
    }
    return true;
  });
}

/** 条目数组渲染为 grep 输出（分组条目级：seq 锚 + log 前缀 + 正文） */
export function renderGrepResult(entries: MemoryEntry[], limit = 50): string {
  if (entries.length === 0) return "（无匹配记忆条目）";
  const shown = entries.slice(-limit);
  const lines = shown.map((e) => `#${e.seq} ${renderEntry(e)}`);
  const overflow = entries.length - shown.length;
  return overflow > 0
    ? [`（更早 ${overflow} 条匹配未展示）`, ...lines].join("\n")
    : lines.join("\n");
}

/**
 * clipMemoryForInjection 退役（快照渲染内建预算——renderSnapshot 整数条
 * 截断语义取代裸文本截断；见 memory-timeline-plan §3.6）。
 */