// ============================================================
// ac-credentials —— 凭据插件行
//
// 无 inject（零依赖基础服务）。config（{ file?, root? }）经
// loader/bootTree 传入 → 转构造参数。
//
// LLM 凭据注入（本行订阅，随行卸载回收）：llm/before-chat 时按
// 解析链把已存凭据注入 input.api_key——池条目 key（UI 连接管理写口，
// credId 'pool:<provider名>'）自此真正被运行时消费。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { CredentialsService, type CredentialsRowOptions } from './service.ts';
import { splitModelRef } from 'ac-llm';
import type {} from 'ac-llm'; // llm/* 事件目录 + LlmChatCall 类型（type-only）

export const name = 'ac-credentials';

/**
 * LLM 调用的凭据解析链（纯函数，测试友好；llm-provider-model-plan P4 收窄）。
 * 优先级：input 已带 key（上游显式，不动）→ 全局池引用
 * `pool:<provider>`（provider = input.provider 优先，其次 model 的
 * name@model 引用左段）→ undefined（种子 env 兜底在 provider 构造层）。
 * Agent 级覆盖 rung 已退役（D3 裁决：连接凭据锁死在 provider 定义——
 * 全局 pool:<名> 单级；存量 Agent 级凭据由迁移脚本并入）。
 */
export function resolveLlmApiKey(
  credentials: {
    getGlobal(provider: string): string;
  },
  input: { api_key?: string; provider?: string; model: string },
): string | undefined {
  if (input.api_key) return undefined; // 上游已显式指定：不覆盖
  const provider = input.provider ?? splitModelRef(input.model).provider;
  if (!provider) return undefined;
  return credentials.getGlobal(`pool:${provider}`) || undefined;
}

export function apply(ctx: Context, options: CredentialsRowOptions = {}) {
  ctx.plugin(CredentialsService, options);

  // 凭据注入：拦截链在路由之前——注入 api_key 只影响传输头（provider
  // 剥离），不改写路由。观察型监听器必调 next()。
  // 服务访问走 ctx.get（M12 铁律 #2：闭包 raw ctx 只认本行 inject/provide，
  // root-traced 解析才可达自己提供的服务实例）。
  ctx.on('llm/before-chat', (call, next) => {
    const credentials = ctx.get('credentials');
    const key = credentials ? resolveLlmApiKey(credentials, call.input) : undefined;
    if (key) call.input = { ...call.input, api_key: key };
    return next();
  }, { description: '凭据解析：pool:<provider> apiKey 注入 LLM 调用（不落日志）' });
}

export { CredentialsService, encryptValue, decryptValue } from './service.ts';
export type { CredentialsRowOptions } from './service.ts';
