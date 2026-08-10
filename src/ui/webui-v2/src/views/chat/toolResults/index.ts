// ============================================================
// toolResults/index.ts —— 工具结果视图注册（渲染插槽装配）
//
// 新增工具展示：新建组件 + 在此 registerToolResultView 一行。
// ToolMessage 通过 getToolResultView(toolName) 分发，零改动框架。
// ============================================================

import { registerToolResultView, FALLBACK_TOOL_ID } from '@/framework/toolResultViews';
import ToolResultCode from './ToolResultCode.vue';
import ToolResultTerminal from './ToolResultTerminal.vue';
import ToolResultWrite from './ToolResultWrite.vue';
import ToolResultEdit from './ToolResultEdit.vue';
import ToolResultWeb from './ToolResultWeb.vue';
import ToolResultBrowser from './ToolResultBrowser.vue';
import ToolResultSubagent from './ToolResultSubagent.vue';
import ToolResultFallback from './ToolResultFallback.vue';

registerToolResultView('read', ToolResultCode);
registerToolResultView('write', ToolResultWrite);
registerToolResultView('edit', ToolResultEdit);
registerToolResultView('bash', ToolResultTerminal);
registerToolResultView('web_search', ToolResultWeb);
// 浏览器系列
registerToolResultView('browser', ToolResultBrowser);
registerToolResultView('fetch_webpage', ToolResultWeb);
registerToolResultView('open_browser_page', ToolResultWeb);
registerToolResultView('navigate_page', ToolResultWeb);
registerToolResultView('read_page', ToolResultWeb);
registerToolResultView('click_element', ToolResultWeb);
registerToolResultView('type_in_page', ToolResultWeb);
registerToolResultView('screenshot_page', ToolResultBrowser);
registerToolResultView('hover_element', ToolResultWeb);
registerToolResultView('drag_element', ToolResultWeb);
registerToolResultView('handle_dialog', ToolResultWeb);
registerToolResultView('run_playwright_code', ToolResultWeb);
// subAgent 系列
registerToolResultView('spawn_subagent', ToolResultSubagent);
registerToolResultView('await_subagent', ToolResultSubagent);
registerToolResultView('list_subagents', ToolResultSubagent);
registerToolResultView('kill_subagent', ToolResultSubagent);
// 兜底
registerToolResultView(FALLBACK_TOOL_ID, ToolResultFallback);
