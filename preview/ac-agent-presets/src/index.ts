// ============================================================
// ac-agent-presets —— 预设 Agent 目录（src agent-presets 的 preview 落地）
//
// src 语义原样继承（src-to-preview-map §3.2「预设数据薄行（复用
// ac-agents）」的补齐实现）：
//   · 预设 = 完整 AgentConfig 数据 + 展示元信息（label/description/
//     default/order）——独立会话（singles）的选用目录与空 Agent 会话的
//     默认路由目标（__standard__）。
//   · 物化进 ctx.agents（preset: true）：不出现在 Agent 名册
//     （agents/list RPC 过滤），仅供独立会话选用；不接收协作消息
//     （send_agent 拒绝——src 防幽灵会话语义）。
//   · 模型解析：llm 池缺省 → 全局默认池条目名（AgentConfig.model ≈
//     池条目名，与 ac-credentials pool:<model> 注入链同源）；config/changed
//     后重解析（reassign 热更新，不重注册）。
//   · 注册即 skip-if-present：盘上已有同 id 实体（agents-dir 物化在前）
//     则用户数据优先（src `registry.has(...) continue` 同款）。
//
// 预设的「无记忆」语义：__standard__ / __dsh_minimal__ 的 settings 软停用
// memory/skill/datetime（src 预设 hooks 是 allowlist——标准/极简均不含
// 记忆/技能/日期注入；preview 行组合制下经 settings[具名].enabled=false
// 表达，ADR-4；M24 X1 词汇收口 hooks→settings）。独立会话本身就是隔离
// 上下文（conversationId = sid，记忆键随会话隔离）——预设层再关掉注入
// = src「单 session 无记忆」语义。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { AgentConfig } from 'ac-agents';

/** 预设展示元信息（singles 选用 UI 用） */
export interface AgentPresetMeta {
  /** 选项标签（如「标准模式」） */
  label: string;
  /** 一句话说明 */
  description?: string;
  /** 是否默认预设（空 Agent 会话的路由目标；缺省取第一个） */
  default?: boolean;
  /** 展示顺序（升序；缺省垫底） */
  order?: number;
}

/** 预设定义 = 元信息 + AgentConfig 主体（model 留空——物化期解析） */
export interface AgentPresetDefinition {
  meta: AgentPresetMeta;
  agent: Omit<AgentConfig, 'model'>;
}

/** 内置预设清单（src presets/standard + presets/dsh-minimal 的 preview 形状） */
export const BUILTIN_PRESETS: AgentPresetDefinition[] = [
  {
    meta: {
      label: '标准模式',
      description: '无人物设定的通用对话：读写/Shell/搜索/提问，单会话无记忆不归档',
      default: true,
      order: 1,
    },
    agent: {
      id: '__standard__',
      description: '标准模式',
      preset: true,
      // src allowlist（persona/system-prompt/session/security/usage）不含
      // memory/skill/datetime——软停用对齐（无记忆语义）
      settings: {
        memory: { enabled: false },
        skill: { enabled: false },
        datetime: { enabled: false },
      },
    },
  },
  {
    meta: {
      label: '极简模式',
      description: '仅 str_replace_editor / bash 两件工具：单工具编辑器 + 跑命令，上下文成本最低',
      order: 2,
    },
    agent: {
      id: '__dsh_minimal__',
      description: '极简模式（DSH-Like）',
      preset: true,
      // DSH 同款最小工具面：str_replace_editor 四件 + bash
      tools: { include: ['view', 'create', 'str_replace', 'insert', 'bash'] },
      settings: {
        memory: { enabled: false },
        skill: { enabled: false },
        datetime: { enabled: false },
        // src dsh-minimal 的 hooks 不含 build-system-prompt——零框架块，
        // 上下文成本最低（faithful）
        'system-prompt': { enabled: false },
      },
    },
  },
];

/** llm 池条目形状（config llmProviders；名称即 AgentConfig.model） */
type LlmPools = Record<string, { default?: unknown }>;

/** 默认池条目名（default:true 优先，缺省第一条；无池 → undefined） */
function defaultPoolName(pools: LlmPools | undefined): string | undefined {
  if (!pools) return undefined;
  const entries = Object.entries(pools).filter(
    ([k, v]) => !k.startsWith('$') && v !== null && typeof v === 'object' && !Array.isArray(v),
  );
  const def = entries.find(([, v]) => v.default === true);
  return (def ?? entries[0])?.[0];
}

export class AgentPresetsService extends Service {
  /** 物化必需 agents（fiber 依赖等待）；config 为可选能力（缺行 = 模型留空） */
  static inject = ['agents'];

  constructor(ctx: Context) {
    super(ctx, 'agentPresets');

    // 物化：已注册同 id（agents-dir 先物化的盘上实体）则跳过——用户数据优先
    for (const def of BUILTIN_PRESETS) {
      if (this.ctx.agents.has(def.agent.id)) continue;
      this.ctx.agents.register(this.materialize(def));
    }

    // 池配置变更 → 重解析默认模型（reassign 热更新；已注册条目原地替换）
    this.ctx.on('config/changed', () => this.refreshModels());
  }

  /** 预设 → 可注册 AgentConfig（补默认池模型） */
  private materialize(def: AgentPresetDefinition): AgentConfig {
    const model = defaultPoolName(this.pools());
    return { ...def.agent, ...(model ? { model } : {}) } as AgentConfig;
  }

  /** 全局 llm 池（config 行未装 → undefined） */
  private pools(): LlmPools | undefined {
    const config = this.ctx.get('config') as
      | { get<T>(key: string): T | undefined }
      | undefined;
    return config?.get<LlmPools>('llmProviders');
  }

  /** 重解析默认模型并热更新已物化的预设（未装配置行/无池 = 清除回落） */
  private refreshModels(): void {
    const model = defaultPoolName(this.pools());
    for (const def of BUILTIN_PRESETS) {
      const current = this.ctx.agents.get(def.agent.id);
      if (!current || current.preset !== true) continue; // 未物化/已被用户实体覆盖
      const next = { ...current, ...(model ? { model } : { model: undefined }) };
      if (next.model === current.model) continue;
      this.ctx.agents.reassign(next);
    }
  }

  /** 全部预设定义（注册序） */
  list(): AgentPresetDefinition[] {
    return BUILTIN_PRESETS;
  }

  /** 默认预设（meta.default 优先，缺省第一个；无预设 → null） */
  defaultPreset(): AgentPresetDefinition | null {
    const all = this.list();
    return all.find((d) => d.meta.default) ?? all[0] ?? null;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 预设 Agent 目录（ac-agent-presets 提供）：内置预设 + ctx.agents 物化 */
    agentPresets: AgentPresetsService;
  }
}

export const name = 'ac-agent-presets';

export function apply(ctx: Context) {
  ctx.plugin(AgentPresetsService);
}
