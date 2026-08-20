// ============================================================
// @agentchat/agent-presets/src/service.ts —— 预设 Agent 注册中心
//
// DSH agent-presets 形态的 AgentChat 落地：
//   · 预设 = 完整 AgentConfig 数据（presets/plugins 意图清单 + hooks 顺序）
//     + 展示元信息（label/description/default）——allowlist 语义：
//     新增插件默认不进任何预设，预设维护是数据编辑而非代码修改。
//   · 预设 Agent 不出现在 Agent 列表（/api/agents 等按 config.preset
//     过滤），仅供独立会话（Session）选用。
//   · 注册方：内置数据（register.ts）+ 任意插件经 ctx.agentPresets.register
//     （owner 归属，动态插件 dispose 时按 owner 卸载）。
//   · 物化（写入 AgentRegistry 参与路由）由 server 侧消费方完成
//     （service-plugin：置 preset:true + 默认池解析）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { AgentConfig } from '@agentchat/agent-config';

/** 预设展示元信息（Session 选用 UI 用；preset.json 持久形态） */
export interface AgentPresetMeta {
  /** 选项标签（如「空白」） */
  label: string;
  /** 一句话说明 */
  description?: string;
  /** 是否默认预设（空 Agent 会话的路由目标；缺省取第一个） */
  default?: boolean;
  /** 展示顺序（升序；缺省垫底）—— 对应 DSH preset.yml 的 order */
  order?: number;
}

/** 预设定义 = 元信息 + 完整 AgentConfig */
export interface AgentPresetDefinition {
  meta: AgentPresetMeta;
  agent: AgentConfig;
}

/** 注册条目（含 owner 归属，动态插件卸载用） */
interface PresetEntry {
  definition: AgentPresetDefinition;
  owner?: string;
}

export class AgentPresetsService extends Service {
  private entries: PresetEntry[] = [];

  constructor(ctx: Context) {
    super(ctx, 'agentPresets');
  }

  /** 注册预设（同 agent_id 后注册者覆盖） */
  register(definition: AgentPresetDefinition, owner?: string): void {
    const idx = this.entries.findIndex((e) => e.definition.agent.agent_id === definition.agent.agent_id);
    const entry: PresetEntry = { definition, owner };
    if (idx >= 0) this.entries.splice(idx, 1, entry);
    else this.entries.push(entry);
  }

  /** 按 owner 卸载（动态插件 dispose 用）；返回移除条数 */
  unregister(owner: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.owner !== owner);
    return before - this.entries.length;
  }

  /** 全部预设定义（注册序） */
  list(): AgentPresetDefinition[] {
    return this.entries.map((e) => e.definition);
  }

  /** 默认预设（meta.default 优先，缺省第一个；无预设 → null） */
  defaultPreset(): AgentPresetDefinition | null {
    const all = this.list();
    return all.find((d) => d.meta.default) ?? all[0] ?? null;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 预设 Agent 注册中心（由 @agentchat/agent-presets 提供） */
    agentPresets: AgentPresetsService;
  }
}
