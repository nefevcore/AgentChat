// ============================================================
// ac-llm-pool/src/credentials.ts —— 池凭据注入（llm/before-chat 订阅）
//
// 2026-09-05 插件边界评估建议 #4：LLM 凭据注入自 ac-credentials 迁入
// 本行——凭据是横切服务，不应感知 LLM 域（原 resolveLlmApiKey +
// before-chat 订阅住 ac-credentials，构成 credentials→ac-llm 的运行时
// 反向依赖）。方向修正为【LLM 连接域感知凭据服务】：ctx.get 可选能力，
// 凭据行未装载 = 不注入（provider 构造层 env 兜底）。池条目 key
// （credId 'pool:<provider名>'，UI 连接管理写口）自此真正被运行时消费。
// ============================================================
import { splitModelRef } from 'ac-llm';
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-llm'; // llm/* 事件目录（type-only）

/** ac-credentials 服务面（结构化本地类型：跨域走服务方法，运行时按服务 key 解耦） */
interface CredentialsBackend {
  getGlobal(provider: string): string;
}

/**
 * LLM 调用的凭据解析链（纯函数，测试友好；llm-provider-model-plan P4 收窄）。
 * 优先级：input 已带 key（上游显式，不动）→ 全局池引用
 * `pool:<provider>`（provider = input.provider 优先，其次 model 的
 * name@model 引用左段）→ undefined（种子 env 兜底在 provider 构造层）。
 * Agent 级覆盖 rung 已退役（D3 裁决：连接凭据锁死在 provider 定义——
 * 全局 pool:<名> 单级；存量 Agent 级凭据由迁移脚本并入）。
 */
export function resolveLlmApiKey(
  credentials: CredentialsBackend,
  input: { api_key?: string; provider?: string; model: string },
): string | undefined {
  if (input.api_key) return undefined; // 上游已显式指定：不覆盖
  const provider = input.provider ?? splitModelRef(input.model).provider;
  if (!provider) return undefined;
  return credentials.getGlobal(`pool:${provider}`) || undefined;
}

/**
 * 凭据注入订阅（apply 装配）：拦截链在路由之前——注入 api_key 只影响
 * 传输头（provider 剥离），不改写路由。观察型监听器必调 next()。
 * 服务访问走 ctx.get（M12 铁律 #2：闭包 raw ctx 只认本行 inject/provide，
 * root-traced 解析才可达 credentials 实例；可选能力——未装载 = 不注入）。
 */
export function registerCredentialsInjection(ctx: Context): void {
  ctx.on('llm/before-chat', (call, next) => {
    const credentials = ctx.get('credentials', false) as CredentialsBackend | undefined;
    const key = credentials ? resolveLlmApiKey(credentials, call.input) : undefined;
    if (key) call.input = { ...call.input, api_key: key };
    return next();
  }, { description: '凭据解析：pool:<provider> apiKey 注入 LLM 调用（不落日志）' });
}
