// ============================================================
// ac-agent-presets —— 预设 Agent 目录（可注入注册中心）
//
// 「模式」（标准模式/极简模式这类预设 Agent）不再硬编码在本包：
// 本包只做目录服务——数据行（内置 ac-agent-presets-builtin / 第三方
// 插件）经 ctx.agentPresets.register 注入预设定义，服务统一负责物化
// 进 ctx.agents（preset: true）、默认池模型解析与 config/changed 热更新。
// 摘掉全部数据行 = 空目录（defaultPreset → null，消费方按既有缺省口径
// 回落）；插件注入自有模式与内置模式同一注册面、零特殊化。
//
// 物化语义（src 轨道原样继承，src-to-preview-map §3.2「预设数据薄行」）：
//   · 预设 = 完整 AgentConfig 数据 + 展示元信息（label/description/
//     default/order）——独立会话（singles）的选用目录与空 Agent 会话的
//     默认路由目标。
//   · 物化进 ctx.agents（preset: true）：不出现在 Agent 名册
//     （agents/list RPC 过滤），仅供独立会话选用；不接收协作消息
//     （send_agent 拒绝——src 防幽灵会话语义）；管理面写口拦截
//     （ac-agent-admin）。
//   · 模型解析：llm 池缺省 → 默认池连接（P5 口径统一：ac-llm-pool
//     defaultPoolConnection——provider = 条目名，model = defaultModel；
//     config/changed 后重解析（reassign 热更新，不重注册）。
//   · 注册即 skip-if-present：盘上已有同 id 实体（agents-dir 物化在前）
//     则用户数据优先（src `registry.has(...) continue` 同款）——目录照记，
//     物化跳过。
//
// 预设的「无记忆」语义由数据行表达（settings 软停用 memory/skill/
// datetime；dsh-minimal 另停 system-prompt——M24 X1 词汇收口
// hooks→settings）：独立会话本身就是隔离上下文（conversationId = sid，
// 记忆键随会话隔离）——预设层再关掉注入 = src「单 session 无记忆」语义。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { AgentConfig } from 'ac-agents';
import { defaultPoolConnection } from 'ac-llm-pool';

/** 预设展示元信息（singles 选用 UI 用） */
export interface AgentPresetMeta {
  /** 选项标签（如「标准模式」） */
  label: string;
  /** 一句话说明 */
  description?: string;
  /** 是否默认预设（空 Agent 会话的路由目标；缺省取 order 最小者） */
  default?: boolean;
  /** 展示顺序（升序；缺省垫底） */
  order?: number;
}

/** 预设定义 = 元信息 + AgentConfig 主体（model 留空——物化期解析） */
export interface AgentPresetDefinition {
  meta: AgentPresetMeta;
  agent: Omit<AgentConfig, 'model'>;
}

/** llm 池条目形状（config llmProviders；P5：连接定义，默认物化走 ac-llm-pool） */
type LlmPools = Record<string, unknown>;

/** 默认池连接（provider = 条目名，model = defaultModel；无 → undefined） */
function defaultConnection(pools: LlmPools | undefined): { provider: string; model: string } | undefined {
  return defaultPoolConnection(pools);
}

export class AgentPresetsService extends Service {
  /** 物化必需 agents（fiber 依赖等待）；config 为可选能力（缺行 = 模型留空） */
  static inject = ['agents'];

  private defs = new Map<string, AgentPresetDefinition>();

  constructor(ctx: Context) {
    super(ctx, 'agentPresets');

    // 池配置变更 → 重解析默认模型（reassign 热更新；已注册条目原地替换）
    this.ctx.on('config/changed', () => this.refreshModels(), { description: '配置热更：刷新预设模型池' });
  }

  /**
   * 注册一个预设模式（内置/插件数据行的注入面）。
   * 注册即归属：目录条目与 ctx.agents 物化都挂调用方 fiber，数据行卸载时
   * 自动回收（插件作者零 dispose 代码）。重名注册抛错；同 id 的用户盘上
   * 实体已物化（skip-if-present）时目录照记、物化跳过（用户数据优先）。
   * @returns effect disposer（数据驱动场景可手动调用——同时撤目录与物化）
   */
  register(def: AgentPresetDefinition) {
    const id = def.agent.id;
    if (!id) throw new Error('预设注册缺少 agent.id');
    if (this.defs.has(id)) throw new Error(`agentPresets "${id}" 已注册`);
    let retractMaterial: (() => void) | undefined;
    return this.ctx.fiber.effect(() => {
      this.defs.set(id, def);
      if (!this.ctx.agents.has(id)) {
        retractMaterial = this.ctx.agents.register(this.materialize(def));
      }
      return () => {
        this.defs.delete(id);
        // 物化 effect 归属调用方 fiber（行卸载时 cordis 亦会清理——幂等）；
        // 手动撤注册路径下显式联动，保证 disposer 语义完整
        retractMaterial?.();
      };
    }, `agentPresets.register(${id})`);
  }

  /** 目录中的预设定义（无则 undefined） */
  get(id: string): AgentPresetDefinition | undefined {
    return this.defs.get(id);
  }

  /** 预设 → 可注册 AgentConfig（补默认池连接 provider+model） */
  private materialize(def: AgentPresetDefinition): AgentConfig {
    const conn = defaultConnection(this.pools());
    return {
      ...def.agent,
      ...(conn ? { model: conn.model, provider: conn.provider } : {}),
    } as AgentConfig;
  }

  /** 全局 llm 池（config 行未装 → undefined） */
  private pools(): LlmPools | undefined {
    const config = this.ctx.get('config') as
      | { get<T>(key: string): T | undefined }
      | undefined;
    return config?.get<LlmPools>('llmProviders');
  }

  /** 重解析默认连接并热更新已物化的预设（未装配置行/无池 = 清除回落） */
  private refreshModels(): void {
    const conn = defaultConnection(this.pools());
    for (const def of this.defs.values()) {
      const current = this.ctx.agents.get(def.agent.id);
      if (!current || current.preset !== true) continue; // 未物化/已被用户实体覆盖
      const next = conn
        ? { ...current, model: conn.model, provider: conn.provider }
        : { ...current, model: undefined, provider: undefined };
      if (next.model === current.model && next.provider === current.provider) continue;
      this.ctx.agents.reassign(next);
    }
  }

  /** 全部预设定义（meta.order 升序、缺省垫底；同序按注册序破平） */
  list(): AgentPresetDefinition[] {
    return [...this.defs.values()].sort((a, b) => {
      const oa = a.meta.order ?? Number.POSITIVE_INFINITY;
      const ob = b.meta.order ?? Number.POSITIVE_INFINITY;
      return oa - ob;
    });
  }

  /** 默认预设（meta.default 优先，缺省 order 最小/首个；无预设 → null） */
  defaultPreset(): AgentPresetDefinition | null {
    const all = this.list();
    return all.find((d) => d.meta.default) ?? all[0] ?? null;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 预设 Agent 目录（ac-agent-presets 提供）：注册面 + ctx.agents 物化 */
    agentPresets: AgentPresetsService;
  }
}

export const name = 'ac-agent-presets';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'agent-presets',
  label: '预设模式目录',
  description: '预设模式注册中心：数据行（内置/插件）注入预设定义 → ctx.agents 物化 + 默认池模型解析（config/changed 热更）',
  automatic: true,
};

export function apply(ctx: Context) {
  ctx.plugin(AgentPresetsService);
}
