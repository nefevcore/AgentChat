// ============================================================
// ac-agents —— Agent 注册中心插件行
//
// 无 inject（不依赖其他服务）；Agent 数据由插件行（预设）或运行期
// API（ctx.agents.register）注入。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AgentsService } from './service.ts';

export const name = 'ac-agents';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'agents',
  label: 'Agent 注册表',
  description: 'Agent 注册中心（ctx.agents）：Agent 是数据不是插件（名册/注册/settingsOf 合成）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（M27 S3-1b/D19 行包双半边）：client/ 半边随行走。
  // webui 为可选能力——以【子插件 fiber + inject】承载（在场/迟到才装载，
  // 摘行级联回收）
  ctx.plugin({
    name: 'ac-agents.webui-client',
    inject: ['webui'],
    apply(webuiCtx: Context) {
      const off = webuiCtx.webui.declareClient({
        name: 'agents',
        entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
        platform: 'web',
        phase: 'domain',
      });
      webuiCtx.effect(() => off);
    },
  });
  ctx.plugin(AgentsService);
}

export { AgentsService, resolveToolNames, filterLlmParams, assertAgentId, capabilitySetOf, toolAllowedFor, displayNameOf, LLM_SAMPLING_KEYS } from './service.ts';
export type { AgentConfig } from './service.ts';
export type {} from './events.ts';
