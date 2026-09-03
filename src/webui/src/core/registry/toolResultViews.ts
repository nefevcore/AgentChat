// ============================================================
// core/registry/toolResultViews.ts —— 工具结果视图注册表 ★扩展点
//
// 后端新增工具时，前端只需注册一个渲染组件：
//   registerToolResultView('my_tool', MyToolResult.vue)
// 匹配链：精确名 / 正则族 → 优先级覆盖 → 未命中返回 null（调用方按文本渲染）。
// ============================================================

import { ref, type Component } from 'vue';
import ToolResultCode from '@/components/chat/ToolResult/ToolResultCode.vue';
import ToolResultWeb from '@/components/chat/ToolResult/ToolResultWeb.vue';
import ToolResultTerminal from '@/components/chat/ToolResult/ToolResultTerminal.vue';
import ToolResultWrite from '@/components/chat/ToolResult/ToolResultWrite.vue';
import ToolResultEdit from '@/components/chat/ToolResult/ToolResultEdit.vue';
import ToolResultSubagent from '@/components/chat/ToolResult/ToolResultSubagent.vue';
import ToolResultBrowser from '@/components/chat/ToolResult/ToolResultBrowser.vue';
// 任务追踪（ac-goal/ac-todo）：goal/todo 工具 → 清单/目标卡片
// （数据归一化在 api/tasks.ts，live 帧与历史回放两形统一）
import ToolResultTodo from '@/components/chat/ToolResult/ToolResultTodo.vue';
import ToolResultGoal from '@/components/chat/ToolResult/ToolResultGoal.vue';

interface ToolResultViewDef {
  /** 精确工具名 或 正则（族匹配，如 /^browser_/） */
  match: string | RegExp;
  component: Component;
  /** 同命中时优先级，默认 0（越大越优先，用于覆盖内置） */
  priority?: number;
}

const views: ToolResultViewDef[] = [];

/** 注册表版本号：每次 register/unregister 自增，供 computed 建立响应式依赖 */
const toolResultViewVersion = ref(0);

/** 注册工具结果视图（可由插件/外部模块追加或覆盖内置）。
 *  幂等：同 match 的既有条目被替换（与 perspectives/messageViews 一致）——
 *  重复注册此前是纯 push，解析取先注册者 → 插件更新组件时静默不生效且旧条目永不清理。 */
export function registerToolResultView(match: string | RegExp, component: Component, opts?: { priority?: number }): () => void {
  const entry: ToolResultViewDef = { match, component, priority: opts?.priority ?? 0 };
  const idx = views.findIndex(v => v.match === match);
  if (idx >= 0) views.splice(idx, 1, entry);
  else views.push(entry);
  toolResultViewVersion.value++;
  return () => {
    const i = views.indexOf(entry);
    if (i >= 0) {
      views.splice(i, 1);
      toolResultViewVersion.value++;
    }
  }
}

/** 解析工具名 → 渲染组件（精确匹配优先于正则族；同命中取最高优先级） */
export function resolveToolResultView(toolName?: string): Component | null {
  toolResultViewVersion.value; // 建立响应式依赖：动态注册/卸载后视图自动重解析
  if (!toolName) return null;
  // ① 精确名匹配（可覆盖正则族内置）
  let best: ToolResultViewDef | null = null;
  for (const v of views) {
    if (typeof v.match === 'string' && v.match === toolName) {
      if (!best || (v.priority ?? 0) > (best.priority ?? 0)) best = v;
    }
  }
  if (best) return best.component;
  // ② 正则族匹配
  let bestRegex: ToolResultViewDef | null = null;
  for (const v of views) {
    if (typeof v.match !== 'string' && v.match.test(toolName)) {
      if (!bestRegex || (v.priority ?? 0) > (bestRegex.priority ?? 0)) bestRegex = v;
    }
  }
  return bestRegex?.component ?? null;
}

// ── 内置注册（迁移自 useToolResult.ts 的 COMPONENT_MAP）──
registerToolResultView('bash', ToolResultTerminal);
registerToolResultView('read', ToolResultCode);
registerToolResultView('write', ToolResultWrite);
registerToolResultView('edit', ToolResultEdit);
registerToolResultView('web_search', ToolResultWeb);
// 浏览器主工具（独立组件：多动作 tab / steps 批量）；其余浏览器族工具走 ToolResultWeb
registerToolResultView('browser', ToolResultBrowser);
// 浏览器相关工具族
registerToolResultView(/^(fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code)$/, ToolResultWeb);
// subAgent 工具（0.6.1 合并为单一 subagent，action 分发）
registerToolResultView('subagent', ToolResultSubagent);
// 任务追踪工具面（ac-todo / ac-goal）
registerToolResultView('todo', ToolResultTodo);
registerToolResultView('goal', ToolResultGoal);
