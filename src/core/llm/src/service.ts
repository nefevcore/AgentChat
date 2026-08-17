// ============================================================
// @agentchat/llm/src/service.ts —— LLM 服务（cordis Service）
//
// 第二阶段 cordis 化：ctx.llm 成为 LLM 适配器工厂的唯一入口。
// 插件通过 ctx.llm.create(config) 创建适配器，替代手工 services.llm 注入。
//
// 契约化阶段④：适配器为【可替换后端】——LLMService 提供
// registerAdapter(provider, factory)，deepseek/openai 适配器由独立包
// （@agentchat/llm-deepseek / @agentchat/llm-openai）的插件行注册。
// create() 优先测试注入的 static factory；否则按 provider 查实例适配器表；
// 无注册时抛错（组合装配必须挂适配器行，抽象包不依赖具体实现）。
// 声明合并：全局 Context 增加 ctx.llm（见文件底部 declare module）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { LLMConfig, LLMProvider } from './contracts';
import type { AdapterFactory } from './adapters';
import { resolveApiKey } from './adapters';

export class LLMService extends Service {
  /** 适配器工厂（测试注入点；缺省 undefined = 走注册表分发） */
  static factory?: (config: LLMConfig) => LLMProvider;

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

  /** 从 LLMConfig（snake_case）创建 LLM 适配器（优先测试注入；否则注册表分发） */
  create(config: LLMConfig): LLMProvider {
    if (LLMService.factory) return LLMService.factory(config);
    const f = this.adapters.get(config.provider ?? '') ?? this.adapters.get('default');
    if (!f) {
      throw new Error(
        `未注册 LLM 适配器：${config.provider ?? '(default)'}。` +
        `请挂载 @agentchat/llm-openai、@agentchat/llm-deepseek 或 @agentchat/llm-glm 适配器插件行。`,
      );
    }
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
