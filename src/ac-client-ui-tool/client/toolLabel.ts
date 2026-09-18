// ============================================================
// 工具卡片标签（utils/toolLabel.ts）
//
// 背景：旧轨（src/core agent-loop）的 Tool 带 label + extractLabel(args)，
// loop 每次调用生成 "友好名 + 参数摘要"（如 "读取文件 src/main.ts"）落进步
// 记录并随 tool.start 推给前端。preview→src 轨道转正后该契约丢失：
// ToolDefinition 无 label 字段、loop 不再生成——各数据面退化为 label=name
// （llm/delta-end / resume / history 均如此），工具卡头部只剩裸名（"read"、
// "bash"）。此处在展示层按 工具名+参数 重建旧词汇，覆盖流式/resume/历史
// 全部路径；未来后端若恢复真实 label 契约（label ≠ name）则自动优先采用。
// ============================================================

import { resolveToolDisplayMeta } from './toolResultViews.ts';

/** 工具名 → 友好名（旧轨各工具行注册的 label 词汇。
 *  M28 P3/T9：卡行携带词条（meta.def.label）优先——本表为无 runtime/
 *  行未装载时的回落词汇（与 toolResultViews 旧数组回落同款语义） */
const TOOL_FRIENDLY_NAMES: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  str_replace_editor: '字符串替换编辑器',
  glob: '文件匹配',
  grep: '内容搜索',
  bash: '执行命令',
  pwsh: '执行命令',
  job: '后台任务',
  web_search: '网络搜索',
  browser: '浏览器',
  subagent: '子 Agent 调度',
  run_code: '运行程序',
  timer: '定时任务',
  todo: '任务清单',
  goal: '目标管理',
  send_agent: '发送给 Agent',
  send_group: '发送到群组',
  ask_questions: '询问用户',
  math: '数学',
  skill: '技能',
  load_skill: '加载技能',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 参数摘要（旧轨各工具 extractLabel 的行为对齐；返回空串 = 只显示友好名）。
 *  摘要内部子段统一以「·」连接（与 label↔摘要 的连接符一致——一种表述构造） */
function argDetail(name: string, a: Record<string, unknown>): string {
  switch (name) {
    case 'read':
    case 'write':
      return str(a.file_path ?? a.filePath ?? a.path);
    case 'edit': {
      const fp = str(a.file_path ?? a.filePath ?? a.path);
      if (!fp) return '';
      return str(a.old_string ?? a.oldString) ? `${fp} · 替换` : fp;
    }
    case 'str_replace_editor':
      return `${str(a.command)} ${str(a.path)}`.trim();
    case 'glob':
      return str(a.pattern);
    case 'grep':
      return str(a.pattern).slice(0, 30);
    case 'bash':
    case 'pwsh':
      return str(a.description) || str(a.command);
    case 'job': {
      // 意图优先（与 bash description 同语义）；回落 action[ · job_id]
      if (str(a.description)) return str(a.description);
      const action = str(a.action) || '?';
      const id = str(a.job_id ?? a.jobId);
      return id ? `${action} · ${id}` : action;
    }
    case 'web_search':
      return str(a.description) || `搜索 ${str(a.query).slice(0, 40)}`;
    case 'browser': {
      if (Array.isArray(a.steps) && a.steps.length) return `steps[${a.steps.length}]`;
      return `${str(a.action)} ${str(a.url)}`.trim();
    }
    case 'subagent': {
      const action = str(a.action) || '?';
      if (action === 'spawn') {
        const t = str(a.task).slice(0, 40);
        const tools = Array.isArray(a.tools) && a.tools.length ? ` · ${a.tools.length} 工具` : '';
        return t ? `${action} · ${t}${tools}` : action;
      }
      if (action === 'send') {
        const m = str(a.message).slice(0, 40);
        const mode = str(a.mode) && str(a.mode) !== 'async' ? ` · ${str(a.mode)}` : '';
        return m ? `${action} · ${m}${mode}` : (mode ? `${action}${mode}` : action);
      }
      return action; // await/list/stop/delete
    }
    case 'run_code': {
      // 意图优先（与 bash/job 的 description 同语义）：模型显式给的
      // 一句话意图；回落程序首行注释或首个语句行（截 40）——标签行
      // 一眼可见程序意图；完整程序体在卡内代码视图
      const intent = str(a.description);
      if (intent) return intent.slice(0, 60);
      const code = str(a.code);
      if (!code) return '';
      const first = code.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('//'));
      const comment = code.match(/^\s*\/\/\s*(.+)$/m);
      return (comment?.[1] ?? first ?? '').slice(0, 40);
    }
    case 'timer': {
      const action = str(a.action) || '?';
      if (action === 'set') return `set ${str(a.mode) || 'delay'} ${str(a.time) || str(a.delay)}`.trim();
      if (action === 'disable') return `禁用 · ${str(a.id) || '?'}`;
      return action === 'list' ? '' : action;
    }
    case 'todo':
    case 'goal':
      return str(a.action);
    case 'send_agent':
      return str(a.to);
    case 'send_group':
      return str(a.group_id) ? `群 · ${str(a.group_id)}` : '';
    case 'ask_questions': {
      const first = Array.isArray(a.questions) ? (a.questions[0] as { question?: unknown } | undefined) : undefined;
      const q = str(first?.question).slice(0, 30);
      return q ? `问 · ${q}` : '';
    }
    case 'math':
      return str(a.expression);
    case 'skill':
    case 'load_skill':
      return str(a.name);
    default:
      return '';
  }
}

/** 参数可能是对象或 OpenAI 风格 JSON 字符串 */
function asArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'string') {
    try { return JSON.parse(args) as Record<string, unknown>; } catch { return {}; }
  }
  return typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

// ============================================================
// fs 工具 diff 统计（卡片 Label 尾缀 +N -M 数据源）
// ============================================================

/** 行级变更统计（+N 绿 / -M 红；undefined = 无可展示统计） */
export interface DiffStat {
  added: number;
  removed: number;
}

/** 非负整数读取（负数/小数/字符串数字视为无效） */
function intOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * 解析工具结果 JSON 文本 → 行变更统计。
 * 新记录：优先结构化 diff_added/diff_removed 字段；旧记录回落
 * 解析 diff 文本（`- `/`+ ` 前缀行计数——与后端 renderDiff 同格式）。
 * 非工具结果 / 无统计信息 → null。
 */
export function toolDiffStat(content: unknown): DiffStat | null {
  if (typeof content !== 'string' || !content) return null;
  const text = content.trimEnd();
  // 与 useToolResult 流式短路同款：尾部非 }/] 必不完整，跳过 parse
  const last = text[text.length - 1];
  if (last !== '}' && last !== ']') return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  // 三形归一（与 useToolResult.parseToolResult 同语义）：剥 {ok, output} 信封
  if (typeof obj.ok === 'boolean') {
    if (!obj.ok) return null;
    const out = obj.output;
    if (out !== null && typeof out === 'object') obj = out as Record<string, unknown>;
    else return null;
  }
  const added = intOf(obj.diff_added);
  const removed = intOf(obj.diff_removed);
  if (added !== undefined || removed !== undefined) {
    // 全 0（write 覆盖同内容等）= 无可见变更 → 不展示
    if ((added ?? 0) === 0 && (removed ?? 0) === 0) return null;
    return { added: added ?? 0, removed: removed ?? 0 };
  }
  // 旧记录回落：diff 文本行计数（edit 工具历史记录）
  if (typeof obj.diff === 'string' && obj.diff && obj.diff !== '（无变更）') {
    let a = 0;
    let r = 0;
    for (const line of obj.diff.split('\n')) {
      if (line.startsWith('- ')) r++;
      else if (line.startsWith('+ ')) a++;
    }
    if (a > 0 || r > 0) return { added: a, removed: r };
  }
  return null;
}

/**
 * 工具卡头部显示名。
 * @param name 工具名（message.name / toolName）
 * @param label 数据面携带的 label（当前普遍 = name）
 * @param args 工具参数（对象或 JSON 字符串）
 */
export function toolDisplayLabel(name: string | undefined, label: string | undefined, args: unknown): string {
  const toolName = (name ?? '').trim();
  // 显式 label 优先（流式占位"正在调用工具: X"、后端恢复真实 label 契约时直接生效）；
  // label === name 是当前各数据面的退化合成，与裸名等价 → 走友好合成
  if (label && label !== toolName) return label;
  if (!toolName) return label || '工具调用';
  // T9：卡行词条（meta.def.label）优先——注册表 election 先于静态回落表
  const base = resolveToolDisplayMeta(toolName)?.label ?? TOOL_FRIENDLY_NAMES[toolName] ?? toolName;
  // 参数摘要上限 80 字符；超限截断并以「…」收尾（此前裸切 60 字符，
  // 用户无法察觉还有更多内容——"Label 被裁剪"观感的直接来源）
  const MAX_DETAIL_CHARS = 80;
  const rawDetail = argDetail(toolName, asArgs(args)).trim();
  const detail = rawDetail.length > MAX_DETAIL_CHARS
    ? `${rawDetail.slice(0, MAX_DETAIL_CHARS)}…`
    : rawDetail;
  // 统一表述：label 与参数摘要以「·」连接（与思考行「已思考 · XmYs · 预览」
  // 同款构造）；摘要内部的子段亦用「·」连接（见 argDetail）
  return detail ? `${base} · ${detail}` : base;
}
