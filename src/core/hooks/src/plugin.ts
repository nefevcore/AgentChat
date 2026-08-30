// ============================================================
// @agentchat/hooks/src/plugin.ts —— 钩子注册中心插件（cordis 服务行）
//
// 提供 ctx.hooks（HooksService）。builtin 钩子已拆到扩展域独立行注册
// （agent-prompt/agent-skill/agent-session/agent-memory/agent-mcp/
// security，每域一行，可插拔）；本行仅保留内联的 toolExecutionEnd
// 轻量日志钩子。
// 另注册 'system' 兜底来源标签钩子（无域归属的运行时 kind——router
// 兜底/notice 注入等；基础设施 kind 归基础设施行，机械部分来自
// @agentchat/contracts 的钩子工厂）。
// 由 cordis.yml 挂载；registerCoreServices 的无 Loader 兜底同样经本行。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolExecutionOutcome } from '@agentchat/contracts';
import { makeSourceTagStepStartHook, makeSourceContractRunStartHook } from '@agentchat/contracts';
import type { SourceTagContract } from '@agentchat/contracts';
import { HooksService } from './service';

export const name = 'agentchat-hooks';

/** 运行时通用兜底来源（kind='system'）：无域归属的运行时注入形态 */
const SYSTEM_SOURCE_TAG: SourceTagContract = {
  kind: 'system',
  tag: (s) => (s.form === 'notice' ? '[系统通知]' : '[系统触发]'),
  contractSection: [
    '## 消息来源：系统',
    '- user 消息正文首行的 `[系统触发]` / `[系统通知]` 标签表示运行时注入的提示与一次性事件通知（如后台任务完成）。',
    '- 无标签的 user 消息才是用户本人输入。',
  ].join('\n'),
};

export function apply(ctx: Context) {
  const hooks = new HooksService(ctx);
  // toolExecutionEnd：轻量日志（hooks 内联）
  hooks.register('toolExecutionEnd', 'hooks.log-tool', () => async (outcome: ToolExecutionOutcome) => {
    ctx.logger('hooks').info(`工具 ${outcome.toolName} 完成，耗时 ${outcome.durationMs ?? '?'}ms${outcome.error ? '（异常）' : ''}`);
  }, name);
  // system 兜底来源标签（ownerless automatic：不受 hooks 清单与 preset 过滤）
  hooks.register('stepStart', 'hooks.system-source-tag', () => makeSourceTagStepStartHook(SYSTEM_SOURCE_TAG), undefined, true);
  hooks.register('runStart', 'hooks.system-source-contract', () => makeSourceContractRunStartHook(SYSTEM_SOURCE_TAG), undefined, true);
  ctx.logger('hooks').info('ctx.hooks 就绪（钩子域各自成行注册）');
}
