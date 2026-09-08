// ============================================================
// ac-app —— 组合根（行表 + bootTree）
//
// 行序仅是装配一览；依赖解析由各插件 inject 声明推导
// （缺服务时 fiber PENDING，服务到位自动激活——顺序错了也能装配）。
// 挂/摘一行 = 挂/摘一个能力域，无需改任何其他行。
// ============================================================
import { Context, type Fiber, type Plugin } from '@agentchat/cordis';
import ConsoleExporter from '@agentchat/cordis-logger';
import { TimerService } from '@agentchat/cordis-timer';
import * as agentAdminRow from 'ac-agent-admin';
import * as agentLoopRow from 'ac-agent-loop';
import * as agentsRow from 'ac-agents';
import * as agentsDirRow from 'ac-agents-dir';
import * as agentPresetsRow from 'ac-agent-presets';
import * as agentStoreRow from 'ac-agent-store';
import * as archiveRow from 'ac-archive';
import * as backupRow from 'ac-backup';
import * as collabToolsRow from 'ac-collab-tools';
import * as configRow from 'ac-config';
import * as conversationRow from 'ac-conversation';
import * as convSettingsRow from 'ac-conv-settings';
import * as credentialsRow from 'ac-credentials';
import * as datetimeRow from 'ac-datetime';
import * as devToolsRow from 'ac-dev-tools';
import * as durableInteractionRow from 'ac-durable-interaction';
import * as fsSearchRow from 'ac-fs-search';
import * as fsToolsRow from 'ac-fs-tools';
import * as goalRow from 'ac-goal';
import * as groupRow from 'ac-group';
import * as helloRow from 'ac-hello';
import * as jobsRow from 'ac-jobs';
import * as jobWakeupRow from 'ac-job-wakeup';
import * as llmRow from 'ac-llm';
import * as llmPoolRow from 'ac-llm-pool';
import * as mathRow from 'ac-math';
import * as mcpRow from 'ac-mcp';
import * as memoryRow from 'ac-memory';
import * as personaRow from 'ac-persona';
import * as restartRow from 'ac-restart';
import * as routerRow from 'ac-router';
import * as securityRow from 'ac-security';
import * as sessionQueryRow from 'ac-session-query';
import * as sessionRow from 'ac-session';
import * as singlesRow from 'ac-singles';
import * as shellToolsRow from 'ac-shell-tools';
import * as skillRow from 'ac-skill';
import * as strReplaceEditorRow from 'ac-str-replace-editor';
import * as subagentRow from 'ac-subagent';
import * as systemPromptRow from 'ac-system-prompt';
import * as timersRow from 'ac-timer';
import * as timerToolsRow from 'ac-timer-tools';
import * as todoRow from 'ac-todo';
import * as toolsRow from 'ac-tools';
import * as usageRow from 'ac-usage';
import * as webApiRow from 'ac-web-api';
import * as webServerRow from 'ac-web-server';
import * as webToolsRow from 'ac-web-tools';
import * as sapAdtRow from 'ac-sap-adt';
import * as webuiExtensionsRow from 'ac-webui-extensions';
import * as webuiRow from 'ac-webui';
// M27 S3 首例 → M27.1 改名入 ac-client-ui-* 全族（runview 运行矩阵域）
import * as runviewClientRow from 'ac-client-ui-runview';
// M27.1：域 UI 拆独立前端行（D19 改裁——ac-client-ui-* 全族）
import * as uiTodoRow from 'ac-client-ui-todo';
import * as uiJobsRow from 'ac-client-ui-jobs';
import * as uiWorkspaceRow from 'ac-client-ui-workspace';
import * as uiSinglesRow from 'ac-client-ui-singles';
import * as uiGroupRow from 'ac-client-ui-group';
import * as uiAgentsRow from 'ac-client-ui-agents';
// M27.2：基础七件出包（phase:'base'；无后端行——boot graph 声明半边）
import * as uiThemeRow from 'ac-client-ui-theme';
import * as uiRendererRow from 'ac-client-ui-renderer';
import * as uiToolRow from 'ac-client-ui-tool';
import * as uiSidebarRow from 'ac-client-ui-sidebar';
import * as uiConversationRow from 'ac-client-ui-conversation';
import * as uiSettingsRow from 'ac-client-ui-settings';
import * as uiLayoutRow from 'ac-client-ui-layout';
// M28 P1：四+一新行（goal/usage/timer/skill/system 域 UI 直达行）
import * as uiGoalRow from 'ac-client-ui-goal';
import * as uiUsageRow from 'ac-client-ui-usage';
import * as uiSkillRow from 'ac-client-ui-skill';
import * as uiSystemRow from 'ac-client-ui-system';
import * as uiTimerRow from 'ac-client-ui-timer';
// M28 P2：工具卡行（§2.2 镜像表）
import * as uiShellRow from 'ac-client-ui-shell';
import * as uiFsRow from 'ac-client-ui-fs';
import * as uiWebRow from 'ac-client-ui-web';
import * as uiBrowserRow from 'ac-client-ui-browser';
import * as uiSubagentRow from 'ac-client-ui-subagent';
import * as uiLlmPoolRow from 'ac-client-ui-llm-pool';
import * as uiPluginRegistryRow from 'ac-client-ui-plugin-registry';
import * as workspaceRow from 'ac-workspace';
import * as wsBridgeRow from 'ac-ws-bridge';
import * as pluginGatesRow from 'ac-plugin-gates';
import * as pluginRegistryRow from 'ac-plugin-registry';
import { patchRpcRow } from 'ac-plugin-registry';
import * as pluginMarketRow from 'ac-plugin-market';
import * as eventPolicyRow from 'ac-event-policy';

interface TreeRow {
  id: string;
  plugin: Plugin;
  config?: unknown;
}

/**
 * 装配行表（程序化路径；配置驱动路径的事实源 = preview/cordis.yml，
 * 两张表行集一致，bootTree 供测试/嵌入直用）。
 * 行序仅是装配一览；依赖解析由各插件 inject 声明推导。
 */
export const TREE: TreeRow[] = [
  { id: 'logger-console', plugin: ConsoleExporter as unknown as Plugin },
  { id: 'timer', plugin: TimerService as unknown as Plugin },
  { id: 'tools', plugin: toolsRow },
  { id: 'jobs', plugin: jobsRow },
  { id: 'config', plugin: configRow },
  { id: 'credentials', plugin: credentialsRow },
  { id: 'agent-store', plugin: agentStoreRow },
  { id: 'agents', plugin: agentsRow },
  { id: 'agents-dir', plugin: agentsDirRow },
  { id: 'agent-presets', plugin: agentPresetsRow },
  { id: 'llm', plugin: llmRow },
  { id: 'llm-pool', plugin: llmPoolRow },
  { id: 'agent-loop', plugin: agentLoopRow },
  { id: 'router', plugin: routerRow },
  { id: 'conversation', plugin: conversationRow },
  { id: 'group', plugin: groupRow },
  { id: 'singles', plugin: singlesRow },
  { id: 'conv-settings', plugin: convSettingsRow },
  { id: 'session', plugin: sessionRow },
  { id: 'persona', plugin: personaRow },
  { id: 'system-prompt', plugin: systemPromptRow },
  { id: 'memory', plugin: memoryRow },
  // ---- 任务追踪（goal/todo：goal-round 自主推进 + 工具面；状态经消息面，system 恒定） ----
  { id: 'goal', plugin: goalRow },
  { id: 'todo', plugin: todoRow },
  { id: 'hello', plugin: helloRow },
  // ---- M11 工具面（行序仅是装配一览；依赖由 inject 声明推导） ----
  { id: 'fs-tools', plugin: fsToolsRow },
  { id: 'fs-search', plugin: fsSearchRow },
  { id: 'str-replace-editor', plugin: strReplaceEditorRow },
  { id: 'shell-tools', plugin: shellToolsRow },
  { id: 'math', plugin: mathRow },
  { id: 'web-tools', plugin: webToolsRow },
  // ---- SAP ABAP ADT 工具面（需 sap-adt 能力标签；demo 目的地默认可用） ----
  { id: 'sap-adt', plugin: sapAdtRow },
  { id: 'dev-tools', plugin: devToolsRow },
  { id: 'restart', plugin: restartRow },
  { id: 'session-query', plugin: sessionQueryRow },
  { id: 'security', plugin: securityRow },
  { id: 'subagent', plugin: subagentRow },
  { id: 'durable-interaction', plugin: durableInteractionRow },
  // ---- M12 服务编排（行序仅是装配一览；依赖由 inject 声明推导） ----
  { id: 'usage', plugin: usageRow },
  { id: 'archive', plugin: archiveRow },
  { id: 'backup', plugin: backupRow },
  { id: 'timers', plugin: timersRow },
  { id: 'workspace', plugin: workspaceRow },
  // ---- M13 宿主与可视化（web-server 测试态用随机端口；yml 生产 3830） ----
  { id: 'web-server', plugin: webServerRow, config: { port: 0 } },
  { id: 'ws-bridge', plugin: wsBridgeRow },
  { id: 'webui', plugin: webuiRow },
  { id: 'webui-extensions', plugin: webuiExtensionsRow },
  { id: 'ui-runview', plugin: runviewClientRow },
  // ---- M27.1：域 UI 独立前端行（行集与 cordis.yml 同步） ----
  { id: 'ui-todo', plugin: uiTodoRow },
  { id: 'ui-jobs', plugin: uiJobsRow },
  { id: 'ui-workspace', plugin: uiWorkspaceRow },
  { id: 'ui-singles', plugin: uiSinglesRow },
  { id: 'ui-group', plugin: uiGroupRow },
  { id: 'ui-agents', plugin: uiAgentsRow },
  // ---- M28 P1：四+一新行（行集与 cordis.yml 同步） ----
  { id: 'ui-goal', plugin: uiGoalRow },
  { id: 'ui-usage', plugin: uiUsageRow },
  { id: 'ui-skill', plugin: uiSkillRow },
  { id: 'ui-system', plugin: uiSystemRow },
  { id: 'ui-timer', plugin: uiTimerRow },
  // ---- M28 P2：工具卡行（行集与 cordis.yml 同步） ----
  { id: 'ui-shell', plugin: uiShellRow },
  { id: 'ui-fs', plugin: uiFsRow },
  { id: 'ui-web', plugin: uiWebRow },
  { id: 'ui-browser', plugin: uiBrowserRow },
  { id: 'ui-subagent', plugin: uiSubagentRow },
  { id: 'ui-llm-pool', plugin: uiLlmPoolRow },
  { id: 'ui-plugin-registry', plugin: uiPluginRegistryRow },
  // ---- M27.2：基础七件出包（行集与 cordis.yml 同步） ----
  { id: 'ui-theme', plugin: uiThemeRow },
  { id: 'ui-renderer', plugin: uiRendererRow },
  { id: 'ui-tool', plugin: uiToolRow },
  { id: 'ui-sidebar', plugin: uiSidebarRow },
  { id: 'ui-conversation', plugin: uiConversationRow },
  { id: 'ui-settings', plugin: uiSettingsRow },
  { id: 'ui-layout', plugin: uiLayoutRow },
  { id: 'plugin-registry', plugin: pluginRegistryRow },
  { id: 'patch-rpc', plugin: patchRpcRow },
  { id: 'plugin-gates', plugin: pluginGatesRow },
  { id: 'plugin-market', plugin: pluginMarketRow },
  { id: 'event-policy', plugin: eventPolicyRow },
  // ---- M14 扩展补全（datetime/skill/mcp/协作工具；行序仅是装配一览） ----
  { id: 'datetime', plugin: datetimeRow },
  { id: 'skill', plugin: skillRow },
  { id: 'collab-tools', plugin: collabToolsRow },
  { id: 'mcp', plugin: mcpRow },
  // ---- M15 对账补齐（timer 工具面 / job 完成唤醒） ----
  { id: 'timer-tools', plugin: timerToolsRow },
  { id: 'job-wakeup', plugin: jobWakeupRow },
  // ---- M7 WebUI 接线（RPC 业务方法注册；行序仅是装配一览） ----
  { id: 'web-api', plugin: webApiRow },
  { id: 'agent-admin', plugin: agentAdminRow },
];

export interface BootedTree {
  ctx: Context;
  fibers: Map<string, Fiber>;
}

/**
 * boot 组合树（逐行激活；configs 按 id 覆盖行配置——行自带 config 为缺省；
 * skip = 停用行 id 集（bootstrap 发布路径应用行偏好层：停用行不装配，
 * 与 loader 路径 include patches 的 disabled 语义等价））。
 */
export async function bootTree(
  configs: Record<string, unknown> = {},
  skip: ReadonlySet<string> = new Set(),
): Promise<BootedTree> {
  const ctx = new Context();
  const fibers = new Map<string, Fiber>();
  for (const row of TREE) {
    if (skip.has(row.id)) continue;
    const config = configs[row.id] !== undefined ? configs[row.id] : row.config;
    const fiber =
      config === undefined ? ctx.plugin(row.plugin) : ctx.plugin(row.plugin, config);
    await fiber;
    fibers.set(row.id, fiber);
  }
  return { ctx, fibers };
}
