// ============================================================
// 工具图标映射（utils/toolIcon.ts）
//
// 工具卡头部图标：按工具名 → lucide 图标名（经 ui/Icon 渲染，
// 与 toolResultViews 同源词汇）。图标需先在 ui/icons.ts 注册；
// 未收录的工具回落 wrench（工具通用象形）。
//
// 设计口径：
//   · 文件读写编辑 → 文件系图标（text / pen / diff / search）
//   · 命令执行 / 任务 → 终端系（terminal / square-terminal）
//   · 搜索 / 浏览 / 计算 → 各自象形（globe / monitor / calculator）
//   · Agent / 群组协作 → 人形与会话气泡系
//   · 追踪类 → target / clipboard / timer 等已有品牌意象
// 与 toolLabel.ts 的 TOOL_FRIENDLY_NAMES、toolResultViews 的正则族
// 口径保持一致（浏览器族共用 monitor）。
// ============================================================

/** 工具名 → lucide 图标名（精确匹配优先） */
const TOOL_ICONS: Record<string, string> = {
  // ── 文件 ──
  read: 'file-text',
  write: 'file-pen',
  edit: 'file-diff',
  str_replace_editor: 'file-diff',
  glob: 'folder-search',
  grep: 'file-search',
  // ── 命令 / 任务 ──
  bash: 'terminal',
  job: 'square-terminal',
  // ── 网络 / 搜索 / 浏览器 ──
  web_search: 'globe',
  browser: 'monitor',
  // ── 计算 / 技能 ──
  math: 'calculator',
  skill: 'book-open',
  load_skill: 'book-open',
  // ── Agent / 协作 ──
  subagent: 'bot',
  send_agent: 'send',
  send_group: 'messages-square',
  ask_questions: 'help-circle',
  list_agents: 'users',
  list_groups: 'users-round',
  read_agent_info: 'id-card',
  update_agent_profile: 'user-cog',
  // ── 任务追踪 ──
  todo: 'clipboard-list',
  goal: 'target',
  timer: 'timer',
  // ── 会话 / 历史 ──
  read_history: 'history',
  grep_history: 'history',
  // ── 链路 ──
  hello: 'activity',
  list_tools: 'wrench',
};

/** 正则族 → 图标（与 toolResultViews 的浏览器工具族口径一致） */
const TOOL_ICON_PATTERNS: Array<[RegExp, string]> = [
  [/^(fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code)$/, 'monitor'],
];

/** 未收录工具的兜底（工具通用象形） */
export const FALLBACK_TOOL_ICON = 'wrench';

/** 工具名 → 图标名（多工具聚合 / 未知工具回落 wrench） */
export function toolIconName(name: string | undefined | null): string {
  if (!name) return FALLBACK_TOOL_ICON;
  const exact = TOOL_ICONS[name];
  if (exact) return exact;
  for (const [re, icon] of TOOL_ICON_PATTERNS) {
    if (re.test(name)) return icon;
  }
  return FALLBACK_TOOL_ICON;
}
