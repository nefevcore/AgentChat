// ============================================================
// ac-client-ui-conversation/client/fileEdits.ts —— 会话文件编辑
// 追踪纯函数层（辅助侧边栏「文件编辑」选区数据面）
//
// 数据源：feed 的 rawMessages（append-only 事件流）。编辑类工具
// 调用的参数与结果完整持久化（直播 = toolCalls[].arguments 对象 +
// onToolEnd 结果；历史 = steps[].toolCalls（arguments JSON 字符串 +
// result 对象原样）——historyApi.ts 的 PSessionStep 契约）。本层做
// 三件事：
//   1. extractFileEdits —— 从消息流提取编辑事件序列（时间序）；
//   2. replayFiles —— 按时间序正向重放，得到每文件终版内容 +
//      聚合统计（次数 / +N -M / 首末时间）；
//   3. baseVersionOf —— 初版重建：首编辑为新建（write/create）→
//      不存在（全量新增）；存量编辑 → 逆向回退（edit 的逆操作是
//      确定的 new→old 替换），回退到断链点（覆盖性 write 的前一版
//      不在消息流中——标记 partial，UI 提示「自会话内首次可重建
//      点起算」）。
//
// 覆盖工具面：write / edit（ac-fs-tools）+ str_replace_editor 的
// create / str_replace / insert（ac-str-replace-editor）。bash 等
// 间接写文件不可追踪（UI 另行提示）。
//
// 纯函数层纪律（同 feed.ts）：零 vue/cordis 依赖，可独立单测。
// diff 生成复用 ac-edit-core 的 generateDiffString（纯函数、无
// node 依赖）。
// ============================================================

// 注意：从子路径直接导入 diff.ts（包入口 ./src/index.ts 聚合了
// mutation-queue/executor（node:fs 依赖）——浏览器构建会炸；
// diff.ts 本身零 node 依赖，前端安全）。
import { generateDiffString } from 'ac-edit-core/src/diff.ts';
import type { ChatMessage } from './types.ts';

/** 编辑事件工具名（可追踪面） */
const FILE_EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

/** 编辑动作类型 */
export type FileEditAction = 'create' | 'overwrite' | 'edit' | 'insert' | 'replace' | 'unknown';

/** 从消息流提取的单条编辑事件（时间序） */
export interface FileEditEvent {
  /** 工具调用 id（直播与历史均携带；同一步内唯一） */
  callId: string;
  /** 工具名：write / edit / str_replace_editor */
  tool: string;
  /** 归一化动作 */
  action: FileEditAction;
  /** 目标文件路径（参数原样；空串 = 无法解析——事件仍保留供列表展示） */
  path: string;
  /** 执行成功与否（ok:false / error = 失败——失败编辑不参与重放） */
  ok: boolean;
  /** 执行者 Agent id（群聊多 Agent 场景；缺省 ''） */
  agentId: string;
  /** 消息时间戳（epoch ms；列表与聚合排序锚） */
  timestamp: number;
  /** 工具报告的 +N（结果 diff_added；缺省 undefined） */
  added?: number;
  /** 工具报告的 -M（结果 diff_removed） */
  removed?: number;
  /** ── 重放参数（按工具/命令归一） ── */
  /** write/create：完整文件内容 */
  fullContent?: string;
  /** edit/str_replace：原文 */
  oldStr?: string;
  /** edit/str_replace：新文 */
  newStr?: string;
  /** insert：行号（0 = 开头） */
  insertLine?: number;
}

/** 参数宽松形态（直播 = 对象；历史 = JSON 字符串） */
function looseArgsOf(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

/** 结果宽松形态（直播 tool 消息 content = JSON 字符串；历史 toolCalls[].result = 对象（ToolResult {ok,output} 或裸 output）） */
function looseResultOf(msg: ChatMessage | undefined, tc: unknown): Record<string, unknown> | null {
  const parse = (v: unknown): Record<string, unknown> | null => {
    if (v == null) return null;
    if (typeof v === 'string') {
      try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; }
    }
    if (typeof v === 'object') return v as Record<string, unknown>;
    return null;
  };
  /** ToolResult {ok, output} 包装层解包（output 为对象时）；裸对象原样 */
  const unwrap = (o: Record<string, unknown> | null): Record<string, unknown> | null =>
    o !== null && typeof o.output === 'object' && !Array.isArray(o.output)
      ? { ...(o.output as Record<string, unknown>), ok: o.ok ?? true }
      : o;
  return unwrap(parse((tc as { result?: unknown } | undefined)?.result))
    ?? unwrap(parse(msg?.content));
}

function pathOf(args: Record<string, unknown>): string {
  const p = args.file_path ?? args.filePath ?? args.path;
  return typeof p === 'string' ? p.trim() : '';
}

function actionOf(tool: string, args: Record<string, unknown>): FileEditAction {
  if (tool === 'write') return 'overwrite';
  if (tool === 'edit') return 'edit';
  if (tool === 'str_replace_editor') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    if (cmd === 'create') return 'create';
    if (cmd === 'str_replace') return 'replace';
    if (cmd === 'insert') return 'insert';
    return 'unknown'; // view 等只读命令——extractFileEdits 已过滤
  }
  return 'unknown';
}

/**
 * 从消息流提取编辑事件（时间序）。
 *
 * 遍历 role:'agent' 消息的 toolCalls（直播与历史双形态——历史按步
 * 展开后 assistant 气泡带 tool_calls、工具结果在同 call 的 result
 * 字段或 role:'tool' 消息；直播结果在 role:'tool' 消息 content）。
 * view 等只读命令跳过；失败调用保留（列表如实呈现，重放跳过）。
 */
export function extractFileEdits(messages: ChatMessage[]): FileEditEvent[] {
  const out: FileEditEvent[] = [];
  for (const m of messages) {
    if (m.role !== 'agent' || !Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls as unknown as Array<Record<string, unknown>>) {
      const name = typeof tc.name === 'string' ? tc.name : '';
      if (!FILE_EDIT_TOOLS.has(name)) continue;
      const args = looseArgsOf(tc.arguments ?? (tc as { function?: { arguments?: string } }).function?.arguments);
      const action = actionOf(name, args);
      if (action === 'unknown') continue; // str_replace_editor view 等只读命令
      const path = pathOf(args);
      if (!path) continue;
      // 结果：同消息 toolCalls[].result（历史）→ role:'tool' 消息（直播）
      const callId = typeof tc.id === 'string' ? tc.id : '';
      const toolMsg = callId
        ? messages.find((x) => x.role === 'tool' && x.tool_call_id === callId)
        : undefined;
      const result = looseResultOf(toolMsg, tc) ?? {};
      const ok = result.ok !== false && result.error === undefined;
      out.push({
        callId: callId || `t-${m.id}-${out.length}`,
        tool: name,
        action,
        path,
        ok,
        agentId: typeof m.agent_id === 'string' ? m.agent_id : '',
        timestamp: m.timestamp,
        added: typeof result.diff_added === 'number' ? result.diff_added : undefined,
        removed: typeof result.diff_removed === 'number' ? result.diff_removed : undefined,
        fullContent: typeof args.content === 'string' ? args.content
          : typeof args.file_text === 'string' ? args.file_text : undefined,
        oldStr: typeof args.old_string === 'string' ? args.old_string
          : typeof args.oldString === 'string' ? args.oldString
          : typeof args.old_str === 'string' ? args.old_str : undefined,
        newStr: typeof args.new_string === 'string' ? args.new_string
          : typeof args.newString === 'string' ? args.newString
          : typeof args.new_str === 'string' ? args.new_str : undefined,
        insertLine: typeof args.insert_line === 'number' ? args.insert_line : undefined,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ 
// 重放：时间序应用编辑 → 每文件终版
// ------------------------------------------------------------

/** 单文件重放态（replayFiles 私有） */
interface ReplayState {
  content: string | null;       // 当前重放内容；null = 链未启（无全量写入）
  firstVersion: string | null;  // 首次全量写入版（created 锚；null = created=false）
  partialBase: string | null;   // 存量断链后的重启点（首个全量写入版）
  partial: boolean;             // 首事件是存量编辑（初版不可完整重建）
  mismatches: number;
}

/** str_replace/insert 的前置存在检查 + 应用（成功 = 应用后内容） */
function applyReplace(cur: string, ev: FileEditEvent): { next: string } | { mismatch: true } {
  if (ev.oldStr === undefined) return { mismatch: true };
  // 换行对齐（edit 工具执行面语义：参数 LF 归一，磁盘可能 CRLF——
  // 命中后按参数侧形态替换，产物换行跟随基底）
  const aligned = alignNewlines(ev.oldStr, cur);
  const idx = cur.indexOf(aligned);
  if (idx < 0) return { mismatch: true };
  const rep = alignNewlines(ev.newStr ?? '', cur);
  const next = cur.slice(0, idx) + rep + cur.slice(idx + aligned.length);
  return { next };
}

/**
 * 换行形态对齐：old/new 串跟随基底内容的行尾风格（基底含 \r\n →
 * 参数 LF 串转 CRLF；基底纯 LF → 原样）。与 ac-edit-core 执行面
 * 「归一 LF 处理 + 写回还原」等价的消费侧逆运算。
 */
function alignNewlines(s: string, base: string): string {
  if (!s.includes('\n')) return s;
  const baseCrlf = base.includes('\r\n');
  if (baseCrlf && !s.includes('\r\n')) return s.replace(/(?<!\r)\n/g, '\r\n');
  if (!baseCrlf && s.includes('\r\n')) return s.replace(/\r\n/g, '\n');
  return s;
}

function applyInsert(cur: string, ev: FileEditEvent): { next: string } | { mismatch: true } {
  if (ev.insertLine === undefined || ev.newStr === undefined) return { mismatch: true };
  // 换行对齐同 applyReplace（insert 侧 CRLF 基底会产出 \r\n 段）
  const nl = cur.includes('\r\n') ? '\r\n' : '\n';
  const lines = cur.split(nl);
  if (ev.insertLine < 0 || ev.insertLine > lines.length) return { mismatch: true };
  const next = [...lines.slice(0, ev.insertLine), ...alignNewlines(ev.newStr, cur).split(nl), ...lines.slice(ev.insertLine)].join(nl);
  return { next };
}

/** 单文件聚合视图（列表项） */
export interface FileEditSummary {
  path: string;
  /** 事件序（时间序，含失败——列表展开用） */
  events: FileEditEvent[];
  /** 成功编辑次数（工具报 ok） */
  editCount: number;
  /**
   * 会话内首版已知（首条成功事件 = 全量写入 write/create）。
   * true 时 baseContent = 首版全文，diff 可完整比对；false =
   * 存量文件打头（首条是编辑），首版磁盘内容不在消息流。
   */
  created: boolean;
  /** 工具报告的累计 +N/-M（缺省 0） */
  added: number;
  removed: number;
  firstAt: number;
  lastAt: number;
  /** 重放终版内容（null = 链不可启：存量打头且无后续全量写入） */
  finalContent: string | null;
  /** 初版（会话内首次全量写入版；created=false 时 null） */
  baseContent: string | null;
  /**
   * 断链场景的可重建起点（首个全量写入版——存量编辑打头、之后
   * 被 write 重启链时 = 该版内容；纯存量无写入 = null 不可比）。
   */
  partialBase: string | null;
  /** true = 初版不可完整重建（UI 提示「自会话内首次全量写入起算」） */
  partial: boolean;
  /**
   * 磁盘终版兜底回推的停点标记（applyDiskFinals）：true = 初版自
   * 「会话内首次全量写入/失配点」回推（非真初版——更早形态不可知）；
   * 干净回退到底/快照接管 = undefined。UI 软提示（diff 仍可信）。
   */
  diskBackfill?: boolean;
  /** 重放失配计数（工具报 ok 但替换串找不到——消息流残缺/外部并发改） */
  mismatches: number;
}

/**
 * 按时间序重放编辑事件 → 每文件聚合（单遍正向，无逆向回推）。
 *
 * 链完整性判据：会话内出现过成功全量写入（write/create）→ 链完整
 * （此后的一切内容全知：覆盖 write 带全量内容、edit/insert 带精确
 * 参数——base = 首次全量写入版，final = 重放终版）。唯一断链场景 =
 * 存量文件打头（首事件是 edit/insert，首版磁盘内容不在消息流）：
 * partial=true；若后续出现全量写入，链自该版重启（partialBase）。
 *
 * 失败事件（ok=false）跳过——磁盘未变更。失配（ok=true 但替换串
 * 找不到）不计入演进、不中断链——通常为消息流残缺或外部并发修改，
 * mismatches 计数供 UI 提示。
 */
export function replayFiles(events: FileEditEvent[]): Map<string, FileEditSummary> {
  const states = new Map<string, ReplayState>();
  const firstAtOf = new Map<string, number>();
  const lastAtOf = new Map<string, number>();

  const stOf = (path: string): ReplayState => {
    let st = states.get(path);
    if (!st) {
      st = { content: null, firstVersion: null, partialBase: null, partial: false, mismatches: 0 };
      states.set(path, st);
    }
    return st;
  };

  for (const ev of events) {
    const st = stOf(ev.path);
    if (!firstAtOf.has(ev.path)) firstAtOf.set(ev.path, ev.timestamp);
    lastAtOf.set(ev.path, ev.timestamp);
    if (!ev.ok) continue; // 失败：磁盘未变更——仅进事件列表

    if (ev.action === 'create' || ev.action === 'overwrite') {
      const full = ev.fullContent ?? '';
      if (st.firstVersion === null) {
        // 会话内首个成功事件 = 全量写入 → created（首版 = 本版）
        st.firstVersion = full;
        st.content = full;
        // 存量编辑打头、随后被 write 重启：partial 保持，partialBase = 本版
        if (st.partial) st.partialBase = full;
      } else {
        // 覆盖 write：内容全知——链不中断，仅推进
        st.content = full;
      }
    } else if (st.content === null) {
      // 存量文件首事件是编辑：链不可启（首版磁盘内容未知）
      st.partial = true;
      st.partialBase = null;
    } else {
      const r = ev.action === 'insert'
        ? applyInsert(st.content, ev)
        : applyReplace(st.content, ev);
      if ('mismatch' in r) st.mismatches += 1;
      else st.content = r.next;
    }
  }

  const summaries = new Map<string, FileEditSummary>();
  for (const [path, st] of states) {
    const eventsOf = events.filter((e) => e.path === path);
    const okEvents = eventsOf.filter((e) => e.ok);
    summaries.set(path, {
      path,
      events: eventsOf,
      editCount: okEvents.length,
      created: st.firstVersion !== null && !st.partial,
      added: okEvents.reduce((n, e) => n + (e.added ?? 0), 0),
      removed: okEvents.reduce((n, e) => n + (e.removed ?? 0), 0),
      firstAt: firstAtOf.get(path) ?? 0,
      lastAt: lastAtOf.get(path) ?? 0,
      finalContent: st.content,
      baseContent: st.partial ? null : st.firstVersion,
      partialBase: st.partial ? st.partialBase : null,
      partial: st.partial,
      mismatches: st.mismatches,
    });
  }
  return summaries;
}

// ------------------------------------------------------------
// diff：初版 vs 终版（generateDiffString 复用——ac-edit-core 纯函数）
// ------------------------------------------------------------

/** 逐文件 diff 结果 */
export interface FileDiffResult {
  path: string;
  /** 可比对（false = 终版或初版不可得——列表降级为统计展示） */
  comparable: boolean;
  diff: string;
  added: number;
  removed: number;
  /** partial：diff 基于 partialBase（会话内首次可重建点），非真正初版 */
  partial: boolean;
}

/** 单文件初版 vs 终版 diff（summary 形态直供） */
export function diffOfSummary(s: FileEditSummary, contextLines = 4): FileDiffResult {
  const finalContent = s.finalContent;
  const base = s.partial ? s.partialBase : s.baseContent;
  if (finalContent === null || base === null) {
    return { path: s.path, comparable: false, diff: '', added: s.added, removed: s.removed, partial: s.partial };
  }
  const r = generateDiffString(base, finalContent, contextLines);
  return { path: s.path, comparable: true, diff: r.diff, added: r.diffAdded, removed: r.diffRemoved, partial: s.partial };
}

// ------------------------------------------------------------
// 方案 C：服务端首见快照接管存量断链（partial 场景的初版补全）
// ------------------------------------------------------------

/** 服务端快照条目（RPC fileSnapshots/list 形状） */
export interface RemoteSnapshot {
  absPath: string;
  /** 首见时磁盘内容；null = 首见时不存在（会话内新建） */
  content: string | null;
  capturedAt: number;
}

/** 自基底重放单文件成功事件链（快照/磁盘兜底共用）：返回终版与失配计数 */
function replayFrom(base: string, evs: FileEditEvent[]): { final: string; mismatches: number } {
  let cur = base;
  let mismatches = 0;
  for (const ev of evs) {
    if (ev.action === 'create' || ev.action === 'overwrite') {
      cur = ev.fullContent ?? '';
    } else if (ev.action === 'edit' || ev.action === 'replace') {
      const r = applyReplace(cur, ev);
      if ('mismatch' in r) mismatches += 1;
      else cur = r.next;
    } else if (ev.action === 'insert') {
      const r = applyInsert(cur, ev);
      if ('mismatch' in r) mismatches += 1;
      else cur = r.next;
    }
  }
  return { final: cur, mismatches };
}

/**
 * 用服务端快照补全存量断链文件的初版（方案 C 前端消费面）：
 *   · partial 且快照在场（absPath 匹配事件 path 或其 basename）→
 *     base = 快照内容，重放改为「快照底 + 首条全量写入后的编辑链」——
 *     partial 消除，diff 完整；
 *   · 快照 content=null（首见时不存在）= created 语义（base=''）；
 *   · 无匹配快照 → 原样（方案 A 行为不变）。
 * 路径匹配：工具参数路径多为相对路径（相对沙箱工作区），快照是绝对
 * 路径——按「相等 / 后缀段匹配」对齐（rel 'a.ts' ↔ abs '.../files/x/a.ts'）。
 * 返回新 Map（不改原 summaries——纯函数）。
 */
export function applySnapshots(
  summaries: Map<string, FileEditSummary>,
  events: FileEditEvent[],
  snapshots: RemoteSnapshot[],
): Map<string, FileEditSummary> {
  if (snapshots.length === 0) return summaries;
  const out = new Map<string, FileEditSummary>();
  for (const [path, s] of summaries) {
    if (!s.partial) { out.set(path, s); continue; }
    const snap = matchSnapshot(path, snapshots);
    if (!snap) { out.set(path, s); continue; }
    if (snap.content === null) {
      // 首见时不存在 = 会话内新建——base ''，重放整链（insert 打头等）
      const r = replayFrom('', events.filter((e) => e.path === path && e.ok));
      out.set(path, { ...s, partial: false, partialBase: null, baseContent: '', finalContent: r.final });
      continue;
    }
    // 快照底重放：快照内容 + 本会话全部编辑事件（从首条起）
    const r = replayFrom(snap.content, events.filter((e) => e.path === path && e.ok));
    out.set(path, {
      ...s,
      partial: false,
      partialBase: null,
      baseContent: snap.content,
      finalContent: r.final,
      mismatches: s.mismatches + r.mismatches,
    });
  }
  return out;
}

/** 路径形态归一（反斜杠 → 斜杠、去前导 ./） */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 路径匹配：相等 / 事件路径是候选路径的后缀段（rel 'a/b.ts' ↔ abs '.../x/a/b.ts'） */
function pathMatches(target: string, candidate: string): boolean {
  if (target === candidate) return true;
  const tSegs = target.split('/').filter(Boolean);
  const sSegs = candidate.split('/').filter(Boolean);
  if (tSegs.length === 0 || tSegs.length > sSegs.length) return false;
  for (let i = 0; i < tSegs.length; i++) {
    if (tSegs[tSegs.length - 1 - i] !== sSegs[sSegs.length - 1 - i]) return false;
  }
  return true;
}

/** 路径匹配查找：事件路径（多为相对形态）在快照/磁盘表（绝对路径键）中定位 */
function matchSnapshot(path: string, snapshots: RemoteSnapshot[]): RemoteSnapshot | undefined {
  const target = normPath(path);
  for (const snap of snapshots) {
    if (pathMatches(target, normPath(snap.absPath))) return snap;
  }
  return undefined;
}

/** 便捷入口：消息流 → 编辑事件 → 重放（+ 可选快照/磁盘兜底）→ 逐文件 diff */
export function fileEditsOf(messages: ChatMessage[]): {
  events: FileEditEvent[];
  files: Map<string, FileEditSummary>;
  diffs: FileDiffResult[];
} {
  return fileEditsFull(messages, [], {});
}

/** 带快照版：消息流 + 服务端快照 → 补全后的逐文件 diff（方案 C 全链） */
export function fileEditsWithSnapshots(
  messages: ChatMessage[],
  snapshots: RemoteSnapshot[],
): {
  events: FileEditEvent[];
  files: Map<string, FileEditSummary>;
  diffs: FileDiffResult[];
} {
  return fileEditsFull(messages, snapshots, {});
}

// ------------------------------------------------------------
// 磁盘终版兜底（无快照的存量文件）：终版 = 磁盘现内容，
// 初版 = 终版逐条逆向回退编辑事件（edit 逆 = new→old 替换；
// insert 逆 = 删行；write 逆 = 断链——前版不可知，停在该点）
// ------------------------------------------------------------

/** 磁盘内容表（read-current RPC 形状：绝对路径 → 内容/null） */
export type DiskContents = Record<string, string | null>;

/** insert 的逆：从 cur 删除第 [insertLine, insertLine+n) 行并校验内容 */
function uninsert(cur: string, ev: FileEditEvent): { next: string } | { mismatch: true } {
  if (ev.insertLine === undefined || ev.newStr === undefined) return { mismatch: true };
  const nl = cur.includes('\r\n') ? '\r\n' : '\n';
  const lines = cur.split(nl);
  const n = alignNewlines(ev.newStr, cur).split(nl).length;
  const start = ev.insertLine;
  if (start + n > lines.length) return { mismatch: true };
  if (lines.slice(start, start + n).join(nl) !== alignNewlines(ev.newStr, cur)) return { mismatch: true };
  return { next: [...lines.slice(0, start), ...lines.slice(start + n)].join(nl) };
}

/**
 * 磁盘终版兜底重建：仍 partial 的文件（无快照匹配——存量编辑打头且
 * 快照机制上线前已被改），若磁盘内容可得 → 终版 = 磁盘现内容、初版 =
 * 自终版逆序回退全部编辑事件（回到会话最初形态）。回退到 write（前版
 * 不可知）= 停点——以该点为初版（partialFromDisk 标记提示「初版自会话
 * 内首次全量写入起回推」，diff 仍完整可信：回推链与磁盘对账）。
 * 返回新 Map（纯函数）。
 */
export function applyDiskFinals(
  summaries: Map<string, FileEditSummary>,
  events: FileEditEvent[],
  disk: DiskContents,
): Map<string, FileEditSummary> {
  if (Object.keys(disk).length === 0) return summaries;
  const out = new Map<string, FileEditSummary>();
  for (const [path, s] of summaries) {
    if (!s.partial) { out.set(path, s); continue; }
    const diskContent = lookupDisk(path, disk);
    if (diskContent === undefined || diskContent === null) { out.set(path, s); continue; } // 未请求/文件不存在——不兜底
    // 逆序回退该文件全部成功编辑
    const evs = events.filter((e) => e.path === path && e.ok);
    let cur: string | null = diskContent;
    let stoppedAtWrite = false;
    let mismatches = s.mismatches;
    for (let i = evs.length - 1; i >= 0 && cur !== null; i--) {
      const ev = evs[i];
      if (ev.action === 'create' || ev.action === 'overwrite') {
        // 全量写入的逆 = 前版不可知——回推停点（初版 = 该 write 前一刻
        // 的内容 = 当前 cur；此处 cur 已是回退掉后续编辑的形态）
        stoppedAtWrite = i > 0; // 首事件即 write 且无更早事件 = 干净新建（无停点）
        break;
      }
      if (ev.action === 'edit' || ev.action === 'replace') {
        const r = applyReplace(cur, { ...ev, oldStr: ev.newStr ?? '', newStr: ev.oldStr ?? '' });
        if ('mismatch' in r) { mismatches += 1; break; } // 失配停点（保守）
        cur = r.next;
      } else if (ev.action === 'insert') {
        const r = uninsert(cur, ev);
        if ('mismatch' in r) { mismatches += 1; break; }
        cur = r.next;
      }
    }
    out.set(path, {
      ...s,
      partial: false,
      partialBase: null,
      baseContent: cur ?? '',
      finalContent: diskContent,
      mismatches,
      // 停点标记（UI 提示「初版自首次全量写入/失配点起回推」；干净
      // 回退到底 = undefined——真初版）
      diskBackfill: stoppedAtWrite || undefined,
    });
  }
  return out;
}

/** 磁盘表查找：精确命中 / 后缀段匹配（与 matchSnapshot 同规——事件路径可能是相对形态） */
function lookupDisk(path: string, disk: DiskContents): string | null | undefined {
  const target = normPath(path);
  if (target in disk) return disk[target];
  for (const key of Object.keys(disk)) {
    if (pathMatches(target, normPath(key))) return disk[key];
  }
  return undefined;
}

/** 全链入口（方案 C 完整形态）：消息流 + 快照 + 磁盘终版 → 逐文件 diff */
export function fileEditsFull(
  messages: ChatMessage[],
  snapshots: RemoteSnapshot[],
  disk: DiskContents,
): {
  events: FileEditEvent[];
  files: Map<string, FileEditSummary>;
  diffs: FileDiffResult[];
} {
  const events = extractFileEdits(messages);
  let files = applySnapshots(replayFiles(events), events, snapshots);
  files = applyDiskFinals(files, events, disk);
  const diffs = [...files.values()].map((s) => diffOfSummary(s));
  return { events, files, diffs };
}
