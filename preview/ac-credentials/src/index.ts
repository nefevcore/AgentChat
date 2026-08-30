// ============================================================
// ac-credentials —— 凭据插件行
//
// 无 inject（零依赖基础服务）。config（{ file?, root? }）经
// loader/bootTree 传入 → 转构造参数。
//
// LLM 凭据注入（本行订阅，随行卸载回收）：llm/before-chat 时按
// 解析链把已存凭据注入 input.api_key——池条目 key（UI 模型管理写口，
// credId 'pool:<池名>'/'searchpool:<池名>'）与 Agent 级 key
// （agents/set-credential 写口）自此真正被运行时消费。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { CredentialsService, type CredentialsRowOptions } from './service.ts';
import type {} from 'ac-llm'; // llm/* 事件目录 + LlmChatCall 类型（type-only）

export const name = 'ac-credentials';

/**
 * LLM 调用的凭据解析链（纯函数，测试友好）。
 * 优先级：input 已带 key（上游显式，不动）→ Agent 级池引用 →
 * Agent 级 provider → 全局池引用 → 全局 provider → undefined
 * （适配器行构造 key / env 兜底）。
 * 池引用 = 'pool:<model>'（preview 语义：AgentConfig.model ≈ 池条目名，
 * 迁移池条目名即原 $ref 名）。
 */
export function resolveLlmApiKey(
  credentials: {
    get(agentId: string, provider: string): string;
    getGlobal(provider: string): string;
  },
  input: { api_key?: string; provider?: string; model: string; meta?: { agent?: string } },
): string | undefined {
  if (input.api_key) return undefined; // 上游已显式指定：不覆盖
  const agent = input.meta?.agent;
  const poolRef = `pool:${input.model}`;
  if (agent) {
    const agentPool = credentials.get(agent, poolRef);
    if (agentPool) return agentPool;
    if (input.provider) {
      const agentProvider = credentials.get(agent, input.provider);
      if (agentProvider) return agentProvider;
    }
  }
  const globalPool = credentials.getGlobal(poolRef);
  if (globalPool) return globalPool;
  if (input.provider) {
    const globalProvider = credentials.getGlobal(input.provider);
    if (globalProvider) return globalProvider;
  }
  return undefined;
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
  });
}

export { CredentialsService, encryptValue, decryptValue } from './service.ts';
export type { CredentialsRowOptions } from './service.ts';
