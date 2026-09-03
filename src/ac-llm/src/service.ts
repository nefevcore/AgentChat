// ============================================================
// ac-llm/src/service.ts —— LLM 纯路由服务（cordis Service）
//
// 本包同时是 LLM 域契约的 owning package：域类型见 ./contract.ts，
// llm/* 事件目录见 ./events.ts（谁 emit 谁声明）。
//
// ctx.llm：provider 工厂注册表 + 惰性实例化 + model→provider 路由。
//   · register —— 适配器薄行注册工厂。fiber 归属：this.ctx 经 cordis
//     tracker 指向【调用方插件】的 context，注册随该插件卸载自动回收
//     （已实例化的 provider 会被调用 close()）——插件作者零 dispose 代码。
//   · stream —— AsyncIterable<Chunk>；chat 是 stream 的聚合语法糖。
//   · 事件：llm/before-chat（waterfall 拦截，改写输入或短路）、
//     llm/chat-error（emit，监控/降级订阅）。
//
// 关键语义：路由发生在拦截【之后】——拦截器改写 input.model 即改写路由。
// 升级 llm provider = 换一行：inject 的依赖方 fiber 由 cordis 自动回滚重载。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type {
  LlmChatCall,
  LlmChatInput,
  LlmChatResult,
  LlmProvider,
  LlmProviderFactory,
  LlmStreamChunk,
  LlmUsage,
} from './contract.ts';

/** LLM 域错误（机器可读 code）。显式字段赋值——参数属性不被 Node 原生
 *  TS strip-only 加载器支持（yml 文件路径行在无 tsx hook 的进程也会加载本文件） */
export class LlmError extends Error {
  readonly code: 'NO_PROVIDER' | 'PROVIDER_ERROR';

  constructor(code: 'NO_PROVIDER' | 'PROVIDER_ERROR', message: string) {
    super(message);
    this.code = code;
    this.name = 'LlmError';
  }
}

/** provider 注册元数据（model 路由清单 + 描述） */
export interface LlmRegisterMeta {
  /** 可路由 model 清单：精确匹配优先，其次前缀匹配（m / m-* / m/*） */
  models?: string[];
  description?: string;
  /** 连接锚点（诊断 + /models 发现 RPC 的 baseURL 透出；可选） */
  baseUrl?: string;
  /**
   * 模型能力元数据（探测/手配）：model → {vision?, hidden?}。
   * llm/providers stats 透出 → 前端视觉徽章与下拉过滤；不参与路由。
   */
  modelMeta?: Record<string, { vision?: boolean; hidden?: boolean }>;
  /**
   * 视觉门控有效清单（精确 > 前缀 m-/m/ > 通配 *——显式 visionModels ∪
   * models[].vision 探测标志，注册行算好并集传入）。适配层物化/剥离、
   * `visionOf()` 查询口（系统提示词模型能力注入）同一判定单源。
   */
  visionModels?: string[];
}

/** 路由查询（provider 与 model 至少给一项；provider 优先） */
export interface LlmRouteQuery {
  provider?: string;
  model?: string;
}

/** provider 诊断快照（UI/冒烟用） */
export interface LlmProviderStats {
  name: string;
  models: string[];
  instantiated: boolean;
  description?: string;
  /** 连接锚点（注册行声明时透出） */
  baseUrl?: string;
  /** 模型能力元数据（vision/hidden；前端徽章与下拉过滤消费） */
  modelMeta?: Record<string, { vision?: boolean; hidden?: boolean }>;
  /** 视觉门控有效清单（显式 ∪ 探测；visionOf 查询与适配层同源） */
  visionModels?: string[];
}

/**
 * 模型名 × 模式清单匹配（视觉门控口径）：精确 > 前缀 `m-`/`m/` > 通配
 * `'*'`。与 ac-openai-completions 的 modelMatchesPatterns 同款语义——
 * 本行不依赖协议纯库（分层纪律），两处由对拍测试锁定防漂移。
 */
function modelMatchesPatterns(model: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  if (patterns.includes(model) || patterns.includes('*')) return true;
  return patterns.some((m) => model.startsWith(`${m}-`) || model.startsWith(`${m}/`));
}

export class LlmService extends Service {
  private factories = new Map<string, { factory: LlmProviderFactory; meta: LlmRegisterMeta }>();
  private instances = new Map<string, LlmProvider>();

  constructor(ctx: Context) {
    super(ctx, 'llm');
  }

  /**
   * 注册 provider 工厂（不实例化——首次 stream/chat 才构造）。
   * fiber 归属：经 tracker，this.ctx = 调用方插件 context；
   * 该插件卸载时工厂与已实例化 provider 自动回收。
   *
   * @returns effect disposer（一般无需手动调用——随注册方 fiber 卸载自动执行）
   */
  register(name: string, factory: LlmProviderFactory, meta: LlmRegisterMeta = {}) {
    if (this.factories.has(name)) {
      throw new Error(`llm provider "${name}" 已注册`);
    }
    return this.ctx.fiber.effect(() => {
      this.factories.set(name, { factory, meta });
      return async () => {
        this.factories.delete(name);
        const instance = this.instances.get(name);
        if (instance) {
          this.instances.delete(name);
          await instance.close?.();
        }
      };
    }, `llm.register(${name})`);
  }

  /** 已注册 provider 名单 */
  providers(): string[] {
    return [...this.factories.keys()];
  }

  /** 诊断快照（是否已实例化等；UI/冒烟用） */
  stats(): LlmProviderStats[] {
    return [...this.factories.entries()].map(([name, { meta }]) => ({
      name,
      models: meta.models ?? [],
      instantiated: this.instances.has(name),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}),
      ...(meta.modelMeta && Object.keys(meta.modelMeta).length > 0 ? { modelMeta: meta.modelMeta } : {}),
      ...(meta.visionModels && meta.visionModels.length > 0 ? { visionModels: meta.visionModels } : {}),
    }));
  }

  /**
   * 模型发现（GET /models 经 provider 实例）：懒实例化同 stream/chat；
   * provider 未实现 listModels（非 OpenAI 兼容适配）→ PROVIDER_ERROR。
   * params.api_key 传输层键——凭据链上层注入（优先于构造默认）；
   * params.signal 探测超时/中止（透传底层 fetch）。
   */
  async listModels(
    name: string,
    params: { api_key?: string; signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const instance = this.instance(this.resolveProvider({ provider: name }));
    if (typeof instance.listModels !== 'function') {
      throw new LlmError('PROVIDER_ERROR', `llm provider "${name}" 不支持模型发现（无 /models 实现）`);
    }
    return instance.listModels(params);
  }

  /**
   * 视觉能力探测（模型能力元数据）：懒实例化同 stream/chat；provider
   * 未实现 probeVision → PROVIDER_ERROR。三态语义见契约（探测不抛错，
   * undefined = 未知是有效载荷）。
   */
  async probeVision(
    name: string,
    model: string,
    params: { api_key?: string; signal?: AbortSignal } = {},
  ): Promise<boolean | undefined> {
    const instance = this.instance(this.resolveProvider({ provider: name }));
    if (typeof instance.probeVision !== 'function') {
      throw new LlmError('PROVIDER_ERROR', `llm provider "${name}" 不支持视觉探测`);
    }
    return instance.probeVision(model, params);
  }

  /**
   * 视觉能力查询（静态判定：注册 meta 的有效 visionModels 清单——
   * 精确 > 前缀 > 通配，与适配层物化门控同一匹配单源）。系统提示词
   * 模型能力注入等消费面用；与 probeVision（真发图探测）互补。
   * @returns true/false = 注册面可判定；undefined = 无能力元数据
   * （未声明 visionModels 的 provider——如实未知，消费方自行缺省）
   */
  visionOf(model: string, provider?: string): boolean | undefined {
    let name: string;
    try {
      name = this.resolveProvider({ ...(provider ? { provider } : {}), model });
    } catch {
      return undefined; // 无法路由（无 provider 注册）= 未知
    }
    const meta = this.factories.get(name)?.meta;
    if (meta?.visionModels === undefined || meta.visionModels.length === 0) return undefined;
    return modelMatchesPatterns(model, meta.visionModels);
  }

  /** 解析 provider 名：显式指定 > models 精确匹配 > models 前缀匹配 */
  resolveProvider(query: LlmRouteQuery): string {
    if (query.provider) {
      if (!this.factories.has(query.provider)) {
        throw new LlmError('NO_PROVIDER', `未注册的 llm provider "${query.provider}"（${this.roster()}）`);
      }
      return query.provider;
    }
    const model = query.model;
    if (!model) throw new LlmError('NO_PROVIDER', '路由需要 provider 或 model 至少一项');
    for (const [name, { meta }] of this.factories) {
      if (meta.models?.includes(model)) return name;
    }
    for (const [name, { meta }] of this.factories) {
      if (meta.models?.some((m) => model.startsWith(`${m}/`) || model.startsWith(`${m}-`))) {
        return name;
      }
    }
    throw new LlmError('NO_PROVIDER', `model "${model}" 无法路由到任何 provider（${this.roster()}）`);
  }

  async *stream(input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
    // 细分事件在拦截链之后发射：观察者看到的是最终流（含拦截器改写）。
    // 边界事件与 chat() 同款成对发射（谁流谁发——消费者 break 提前退出
    // 经 finally 仍收 delta-end）
    this.ctx.emit('llm/delta-start', input, input.meta);
    try {
      for await (const chunk of this.run({ input })) {
        this.ctx.emit('llm/delta', input, chunk, input.meta);
        yield chunk;
      }
    } finally {
      this.ctx.emit('llm/delta-end', input, input.meta);
    }
  }

  /** chat 是 stream 的聚合语法糖：拼接 delta/reasoning，聚合 toolCalls，收尾 finish/usage */
  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    const call: LlmChatCall = { input };
    let text = '';
    let reasoning = '';
    let finish: string | undefined;
    let usage: LlmUsage | undefined;
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    this.ctx.emit('llm/delta-start', input, input.meta);
    try {
      for await (const chunk of this.run(call)) {
        this.ctx.emit('llm/delta', input, chunk, input.meta);
        text += chunk.delta;
        if (chunk.reasoning) reasoning += chunk.reasoning;
        for (const frag of chunk.toolCalls ?? []) {
          const acc = toolCalls.get(frag.index) ?? { id: '', name: '', args: '' };
          if (frag.id) acc.id = frag.id;
          if (frag.name) acc.name = frag.name;
          if (frag.argumentsDelta) acc.args += frag.argumentsDelta;
          toolCalls.set(frag.index, acc);
        }
        if (chunk.finish) finish = chunk.finish;
        if (chunk.usage) usage = chunk.usage;
      }
    } finally {
      this.ctx.emit('llm/delta-end', input, input.meta);
    }
    const calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: acc.args }));
    return {
      provider: this.nominalProvider(call.input),
      model: call.input.model,
      text,
      ...(reasoning ? { reasoning } : {}),
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(finish ? { finish } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  /** waterfall 拦截链：llm/before-execute 监听器可变异 call.input 改写请求/路由 */
  private async *run(call: LlmChatCall): AsyncIterable<LlmStreamChunk> {
    yield* this.ctx.waterfall('llm/before-chat', call, () => this.dispatch(call));
  }

  private async *dispatch(call: LlmChatCall): AsyncIterable<LlmStreamChunk> {
    const input = call.input; // 读取时机在拦截之后：改写生效
    const provider = this.resolveProvider(input);
    // meta 是本域透传键（事件载荷增强用），剥离后才进 provider——
    // 请求体永不携带（provider 对未知字段可能严格校验）
    const { meta: _meta, ...providerInput } = input;
    try {
      yield* this.instance(provider).stream(providerInput);
    } catch (err) {
      this.ctx.emit('llm/chat-error', input, err);
      throw err;
    }
  }

  private instance(name: string): LlmProvider {
    let instance = this.instances.get(name);
    if (!instance) {
      const entry = this.factories.get(name);
      if (!entry) throw new LlmError('NO_PROVIDER', `未注册的 llm provider "${name}"（${this.roster()}）`);
      instance = entry.factory(); // 懒实例化：首次调用才构造
      this.instances.set(name, instance);
    }
    return instance;
  }

  /** 结果元数据用的名义 provider（拦截器短路时无法确定实际执行方） */
  private nominalProvider(input: LlmChatInput): string {
    try {
      return this.resolveProvider(input);
    } catch {
      return '(intercepted)';
    }
  }

  private roster(): string {
    const list = this.providers()
      .map((p) => `${p}[${this.factories.get(p)?.meta.models?.join(', ') ?? ''}]`)
      .join(' · ');
    return list || '无已注册 provider';
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** LLM 纯路由服务（ac-llm 提供；provider 由各适配器薄行注册） */
    llm: LlmService;
  }
}
