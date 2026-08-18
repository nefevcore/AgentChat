// ============================================================
// bundle-rows.gen.ts —— 【生成物】请勿手改
// 源：src/boot/boot/src/composition.base.yml · 生成：pnpm gen:bundle-rows
// disabled 行（loader 专属）不在此列；module 经 unwrap 归一
// （workspace 包 namespace 导出 / vendored 包 default 导出 → 统一插件对象）。
// ============================================================
import * as r_logger from '@agentchat/cordis-logger';
import * as r_durableInteraction from '@agentchat/durable-interaction/src/plugin';
import * as r_timer from '@agentchat/cordis-timer';
import * as r_httpHost from '@agentchat/server/src/http-plugin';
import * as r_agentLoop from '@agentchat/agent-loop/src/plugin';
import * as r_llm from '@agentchat/llm/src/plugin';
import * as r_llmDeepseek from '@agentchat/llm-deepseek/src/plugin';
import * as r_llmGlm from '@agentchat/llm-glm/src/plugin';
import * as r_llmOpenai from '@agentchat/llm-openai/src/plugin';
import * as r_tools from '@agentchat/tools/src/plugin';
import * as r_hooks from '@agentchat/hooks/src/plugin';
import * as r_pluginHost from '@agentchat/plugins/src/plugin';
import * as r_market from '@agentchat/plugins/src/market/market-plugin';
import * as r_marketHttp from '@agentchat/plugins/src/market/http-plugin';
import * as r_fsTools from '@agentchat/fs/src/plugin';
import * as r_shellTools from '@agentchat/shell/src/plugin';
import * as r_webTools from '@agentchat/web/src/plugin';
import * as r_devTools from '@agentchat/dev/src/plugin';
import * as r_devAdminTools from '@agentchat/dev/src/plugin-admin';
import * as r_sessionTools from '@agentchat/session-tools/src/plugin';
import * as r_restart from '@agentchat/restart/src/plugin';
import * as r_interaction from '@agentchat/interaction/src/plugin';
import * as r_agentPrompt from '@agentchat/agent-prompt/src/plugin';
import * as r_agentSkill from '@agentchat/agent-skill/src/plugin';
import * as r_agentSession from '@agentchat/agent-session/src/plugin';
import * as r_agentMemory from '@agentchat/agent-memory/src/plugin';
import * as r_agentMcp from '@agentchat/agent-mcp/src/plugin';
import * as r_security from '@agentchat/security/src/plugin';
import * as r_agentTools from '@agentchat/agent-tools/src/plugin';
import * as r_timerTools from '@agentchat/timer/src/plugin';
import * as r_subagentTools from '@agentchat/subagent/src/plugin';
import * as r_mathTools from '@agentchat/math/src/plugin';
import * as r_bootCore from '@agentchat/boot/src/plugin';
import * as r_workspaceInit from '@agentchat/workspace/src/plugin';
import * as r_archive from '@agentchat/archive/src/plugin';
import * as r_timerService from '@agentchat/timer/src/service-plugin';
import * as r_subagentService from '@agentchat/subagent/src/service-plugin';
import * as r_serverL4 from '@agentchat/server/src/service-plugin';
import * as r_bootFinalize from '@agentchat/boot/src/plugin-finalize';
import * as r_httpRoutes from '@agentchat/server/src/http-routes-plugin';
import * as r_pluginsHttp from '@agentchat/plugins/src/http-plugin';
import * as r_diagnostics from '@agentchat/boot/src/plugin-diagnostics';
import * as r_webui from '@agentchat/webui/src/plugin';
import * as r_hello from '@agentchat/hello';

/** namespace/default 导出归一为 cordis 插件对象 */
const unwrap = (m: unknown): unknown => (m as { default?: unknown })?.default ?? m;

export interface BundleRow {
  id: string;
  /** 模块说明符（审计/日志；真实模块在 module） */
  name: string;
  module: unknown;
  config?: Record<string, unknown>;
}

export const BUNDLE_ROWS: readonly BundleRow[] = [
  { id: "logger", name: "@agentchat/cordis-logger", module: unwrap(r_logger), config: {"timestamp":true} as Record<string, unknown> },
  { id: "durable-interaction", name: "@agentchat/durable-interaction/src/plugin", module: unwrap(r_durableInteraction) },
  { id: "timer", name: "@agentchat/cordis-timer", module: unwrap(r_timer) },
  { id: "http-host", name: "@agentchat/server/src/http-plugin", module: unwrap(r_httpHost) },
  { id: "agent-loop", name: "@agentchat/agent-loop/src/plugin", module: unwrap(r_agentLoop) },
  { id: "llm", name: "@agentchat/llm/src/plugin", module: unwrap(r_llm) },
  { id: "llm-deepseek", name: "@agentchat/llm-deepseek/src/plugin", module: unwrap(r_llmDeepseek) },
  { id: "llm-glm", name: "@agentchat/llm-glm/src/plugin", module: unwrap(r_llmGlm) },
  { id: "llm-openai", name: "@agentchat/llm-openai/src/plugin", module: unwrap(r_llmOpenai) },
  { id: "tools", name: "@agentchat/tools/src/plugin", module: unwrap(r_tools) },
  { id: "hooks", name: "@agentchat/hooks/src/plugin", module: unwrap(r_hooks) },
  { id: "plugin-host", name: "@agentchat/plugins/src/plugin", module: unwrap(r_pluginHost) },
  { id: "market", name: "@agentchat/plugins/src/market/market-plugin", module: unwrap(r_market) },
  { id: "market-http", name: "@agentchat/plugins/src/market/http-plugin", module: unwrap(r_marketHttp) },
  { id: "fs-tools", name: "@agentchat/fs/src/plugin", module: unwrap(r_fsTools) },
  { id: "shell-tools", name: "@agentchat/shell/src/plugin", module: unwrap(r_shellTools) },
  { id: "web-tools", name: "@agentchat/web/src/plugin", module: unwrap(r_webTools) },
  { id: "dev-tools", name: "@agentchat/dev/src/plugin", module: unwrap(r_devTools) },
  { id: "dev-admin-tools", name: "@agentchat/dev/src/plugin-admin", module: unwrap(r_devAdminTools) },
  { id: "session-tools", name: "@agentchat/session-tools/src/plugin", module: unwrap(r_sessionTools) },
  { id: "restart", name: "@agentchat/restart/src/plugin", module: unwrap(r_restart) },
  { id: "interaction", name: "@agentchat/interaction/src/plugin", module: unwrap(r_interaction) },
  { id: "agent-prompt", name: "@agentchat/agent-prompt/src/plugin", module: unwrap(r_agentPrompt) },
  { id: "agent-skill", name: "@agentchat/agent-skill/src/plugin", module: unwrap(r_agentSkill) },
  { id: "agent-session", name: "@agentchat/agent-session/src/plugin", module: unwrap(r_agentSession) },
  { id: "agent-memory", name: "@agentchat/agent-memory/src/plugin", module: unwrap(r_agentMemory) },
  { id: "agent-mcp", name: "@agentchat/agent-mcp/src/plugin", module: unwrap(r_agentMcp) },
  { id: "security", name: "@agentchat/security/src/plugin", module: unwrap(r_security) },
  { id: "agent-tools", name: "@agentchat/agent-tools/src/plugin", module: unwrap(r_agentTools) },
  { id: "timer-tools", name: "@agentchat/timer/src/plugin", module: unwrap(r_timerTools) },
  { id: "subagent-tools", name: "@agentchat/subagent/src/plugin", module: unwrap(r_subagentTools) },
  { id: "math-tools", name: "@agentchat/math/src/plugin", module: unwrap(r_mathTools) },
  { id: "boot-core", name: "@agentchat/boot/src/plugin", module: unwrap(r_bootCore) },
  { id: "workspace-init", name: "@agentchat/workspace/src/plugin", module: unwrap(r_workspaceInit) },
  { id: "archive", name: "@agentchat/archive/src/plugin", module: unwrap(r_archive) },
  { id: "timer-service", name: "@agentchat/timer/src/service-plugin", module: unwrap(r_timerService) },
  { id: "subagent-service", name: "@agentchat/subagent/src/service-plugin", module: unwrap(r_subagentService) },
  { id: "server-l4", name: "@agentchat/server/src/service-plugin", module: unwrap(r_serverL4) },
  { id: "boot-finalize", name: "@agentchat/boot/src/plugin-finalize", module: unwrap(r_bootFinalize), config: {"enableWebUI":true,"webuiPort":3830} as Record<string, unknown> },
  { id: "http-routes", name: "@agentchat/server/src/http-routes-plugin", module: unwrap(r_httpRoutes) },
  { id: "plugins-http", name: "@agentchat/plugins/src/http-plugin", module: unwrap(r_pluginsHttp) },
  { id: "diagnostics", name: "@agentchat/boot/src/plugin-diagnostics", module: unwrap(r_diagnostics) },
  { id: "webui", name: "@agentchat/webui/src/plugin", module: unwrap(r_webui), config: {"webuiPort":3830} as Record<string, unknown> },
  { id: "hello", name: "@agentchat/hello", module: unwrap(r_hello), config: {"targets":["preview","cordis-4","monorepo"]} as Record<string, unknown> },
];

/** 按 id 取行；缺行 = bundle 与消费方漂移，fail loud */
export function bundleRow(id: string): BundleRow {
  const row = BUNDLE_ROWS.find((r) => r.id === id);
  if (!row) throw new Error(`bundle 行 "${id}" 不存在（bundle-rows.gen 与消费方漂移？重跑 pnpm gen:bundle-rows）`);
  return row;
}
