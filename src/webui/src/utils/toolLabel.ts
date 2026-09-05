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

/** 工具名 → 友好名（旧轨各工具行注册的 label 词汇） */
const TOOL_FRIENDLY_NAMES: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  str_replace_editor: '字符串替换编辑器',
  glob: '文件匹配',
  grep: '内容搜索',
  bash: '执行命令',
  web_search: '网络搜索',
  browser: '浏览器',
  subagent: '子 Agent 调度',
  timer: '定时任务',
  todo: '任务清单',
  goal: '目标管理',
  send_agent: '发送给 Agent',
  send_group: '发送到群组',
  ask_questions: '询问用户',
  math: '数学',
  skill: '技能',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 参数摘要（旧轨各工具 extractLabel 的行为对齐；返回空串 = 只显示友好名） */
function argDetail(name: string, a: Record<string, unknown>): string {
  switch (name) {
    case 'read':
    case 'write':
      return str(a.file_path ?? a.filePath ?? a.path);
    case 'edit': {
      const fp = str(a.file_path ?? a.filePath ?? a.path);
      if (!fp) return '';
      return str(a.old_string ?? a.oldString) ? `${fp} (替换)` : fp;
    }
    case 'str_replace_editor':
      return `${str(a.command)} ${str(a.path)}`.trim();
    case 'glob':
      return str(a.pattern);
    case 'grep':
      return str(a.pattern).slice(0, 30);
    case 'bash':
      return str(a.description) || str(a.command);
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
        const tools = Array.isArray(a.tools) && a.tools.length ? ` [${a.tools.length}工具]` : '';
        return t ? `spawn ${t}${tools}` : action;
      }
      if (action === 'send') {
        const m = str(a.message).slice(0, 40);
        const mode = str(a.mode) && str(a.mode) !== 'async' ? ` (${str(a.mode)})` : '';
        return m ? `send ${m}${mode}` : `send${mode}`;
      }
      return action; // await/list/stop/delete
    }
    case 'timer': {
      const action = str(a.action) || '?';
      if (action === 'set') return `set ${str(a.mode) || 'delay'} ${str(a.time) || str(a.delay)}`.trim();
      if (action === 'disable') return `禁用: ${str(a.id) || '?'}`;
      return action === 'list' ? '' : action;
    }
    case 'todo':
    case 'goal':
      return str(a.action);
    case 'send_agent':
      return str(a.to);
    case 'send_group':
      return str(a.group_id) ? `群:${str(a.group_id)}` : '';
    case 'ask_questions': {
      const first = Array.isArray(a.questions) ? (a.questions[0] as { question?: unknown } | undefined) : undefined;
      const q = str(first?.question).slice(0, 30);
      return q ? `问: ${q}` : '';
    }
    case 'math':
      return str(a.expression);
    case 'skill':
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
  const base = TOOL_FRIENDLY_NAMES[toolName] ?? toolName;
  const detail = argDetail(toolName, asArgs(args)).trim().slice(0, 60);
  return detail ? `${base} ${detail}` : base;
}
