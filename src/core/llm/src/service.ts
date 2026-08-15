// ============================================================
// @agentchat/llm/src/service.ts —— LLM 服务（cordis Service）
//
// 第二阶段 cordis 化：ctx.llm 成为 LLM 适配器工厂的唯一入口。
// 插件通过 ctx.llm.create(config) 创建适配器，替代手工 services.llm 注入。
//
// 契约化阶段④（2026-08-14）：适配器改为【可替换后端】——LLMService 提供
// registerAdapter(provider, factory)，deepseek/openai 适配器由独立插件行
// （plugin-deepseek / plugin-openai）注册；组合决定装哪些适配器。
// create() 分发：静态 factory 被测试替换（≠ 默认 createLLM）时优先（注入点），
// 否则按 provider 查实例适配器表，无注册回退 createLLM（兼容旧行为）。
// 声明合并：全局 Context 增加 ctx.llm（见文件底部 declare module）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { LLMConfig, LLMProvider } from './contracts';
import { createLLM, type AdapterFactory } from './index';
import { resolveApiKey } from './adapters';

export class LLMService extends Service {
  /** 适配器工厂（测试注入点：替换为 mock 工厂；默认 = 真实 createLLM） */
  static factory: (config: LLMConfig) => LLMProvider = createLLM;

  /** 实例适配器表（provider → 工厂；由适配器插件行注册） */
  private adapters = new Map<string, AdapterFactory>();

  constructor(ctx: Context) {
    super(ctx, 'llm');
  }

  /** 注册 provider 适配器（插件行 apply 内调用；随插件卸载自动注销） */
  registerAdapter(provider: string, factory: AdapterFactory): void {
    this.adapters.set(provider, factory);
    this.ctx.effect(() => () => {
      this.adapters.delete(provider);
    });
  }

  /** 从 LLMConfig（snake_case）创建 LLM 适配器（deepseek → DeepSeekChatLLM；其余 → OpenAIChatLLM） */
  create(config: LLMConfig): LLMProvider {
    // 测试注入点：静态工厂被替换（≠ 默认 createLLM）时优先
    if (LLMService.factory !== createLLM) return LLMService.factory(config);
    const f = this.adapters.get(config.provider ?? '') ?? this.adapters.get('default');
    if (!f) return createLLM(config); // 无适配器注册回退默认分发（兼容）
    return f(config);
  }

  /** 解析 API Key：支持 ${ENV_VAR} 环境变量引用 */
  resolveKey(apiKey: string | undefined): string {
    return resolveApiKey(apiKey);
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** LLM 适配器工厂（由 @agentchat/llm 提供） */
    llm: LLMService;
  }
}
