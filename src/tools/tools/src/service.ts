// ============================================================
// @agentchat/tools/src/service.ts —— 工具注册中心（cordis Service）
//
// 第二阶段 cordis 化：ctx.tools 成为工具注册与解析的唯一入口。
//   · register / registerFactory —— 插件在 apply(ctx) 内经 ctx.tools 注册工具
//   · unregister —— 按 owner（插件名）精确卸载（动态插件 dispose 用）
//   · resolveTools —— 按 Agent 配置解析工具表：
//       1. 插件级过滤：config.presets 决定哪些 owner 的注册参与烘焙
//          （presets 缺省 = 旧契约兼容：不过滤）
//       2. 权限门禁：tool.requires 非空时，所有标签必须命中 Agent 能力标签
//          （'base' 为隐式基础能力层；旧 'agent' 标签读取时归一化为 base；
//           dev/admin/conductor 是真正的权限门禁）
//       3. 意图覆盖：config.tools = { include, exclude }（唯一来源）
//          exclude > include > 默认（requires 非空的候选默认启用）
//
// owner 语义：owner = cordis 插件 name（preset id）。owner 缺省的注册视为
// “无主/内置”，始终参与烘焙（旧插件与运行时工具兼容通道）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { effectiveCapabilityTags, effectiveToolOverrides, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from './contracts';

/** 共享工具注册条目 */
export interface ToolEntry {
  tool: Tool;
  /** 注册归属（cordis 插件 name = preset id；缺省 = 无主，始终启用） */
  owner?: string;
  /** 动态注册标记：跳过 presets 过滤，始终启用 */
  always?: boolean;
  /** 同名替换：注册时移除已有同名共享工具；烘焙时遮蔽同名工厂工具 */
  replace?: boolean;
}

/** 工具工厂注册条目 */
export interface ToolFactoryEntry {
  factory: (config: AgentConfig, services: ToolContext) => Tool[];
  owner?: string;
}

/** 带归属信息的工具目录条目（UI 插件目录/反查用） */
export interface ToolCatalogEntry {
  tool: Tool;
  owner?: string;
  always?: boolean;
  replace?: boolean;
}

export class ToolsService extends Service {
  /** 共享工具（跨 Agent 复用实例；含 owner 归属） */
  private shared: ToolEntry[] = [];
  /** 工具工厂（per-Agent 烘焙 config + services；含 owner 归属） */
  private factories: ToolFactoryEntry[] = [];

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  /** 注册共享工具（无 per-Agent 配置依赖，跨 Agent 复用） */
  register(owner: string | undefined, tools: Tool[], opts: { always?: boolean; replace?: boolean } = {}): void {
    for (const tool of tools) {
      if (opts.replace) {
        // 同名替换：移除已有同名共享注册（后注册者胜）
        this.shared = this.shared.filter((e) => e.tool.name !== tool.name);
      }
      this.shared.push({ tool, owner, always: opts.always, replace: opts.replace });
    }
  }

  /** 注册工具工厂（per-Agent 烘焙：沙箱路径 / 命名空间 / 身份 from 等） */
  registerFactory(owner: string | undefined, fn: (config: AgentConfig, services: ToolContext) => Tool[]): void {
    this.factories.push({ factory: fn, owner });
  }

  /** 按 owner 卸载全部共享工具与工厂（动态插件 dispose/更新用）；返回移除条数 */
  unregister(owner: string): number {
    const before = this.shared.length + this.factories.length;
    this.shared = this.shared.filter((e) => e.owner !== owner);
    this.factories = this.factories.filter((e) => e.owner !== owner);
    return before - (this.shared.length + this.factories.length);
  }

  /** 清空全部注册（热重载/测试用） */
  clear(): void {
    this.shared = [];
    this.factories = [];
  }

  /** 全部注册 owner（诊断/UI 用；无主注册记为空串） */
  listOwners(): string[] {
    const owners = new Set<string>();
    for (const e of this.shared) owners.add(e.owner ?? '');
    for (const e of this.factories) owners.add(e.owner ?? '');
    return [...owners].filter((o) => o !== '');
  }

  /** 收集全部工具（工厂按 config 烘焙；不经过 presets 过滤，供 UI 目录展示；replace 注册遮蔽同名工厂） */
  listAll(config: AgentConfig, services: ToolContext): Tool[] {
    return this.listCatalog(config, services).map((e) => e.tool);
  }

  /** 全量目录（带 owner 归属；工厂按 config 烘焙；replace 注册遮蔽同名工厂） */
  listCatalog(config: AgentConfig, services: ToolContext): ToolCatalogEntry[] {
    const out: ToolCatalogEntry[] = [];
    const shadowed = new Set<string>();
    for (const e of this.shared) {
      out.push({ tool: e.tool, owner: e.owner, always: e.always, replace: e.replace });
      if (e.replace) shadowed.add(e.tool.name);
    }
    for (const e of this.factories) {
      for (const tool of e.factory(config, services)) {
        if (shadowed.has(tool.name)) continue;
        out.push({ tool, owner: e.owner });
      }
    }
    return out;
  }

  /** 指定 owner 注册的全部工具（目录反查 manifest.provides 用） */
  listByOwner(owner: string, config: AgentConfig, services: ToolContext): Tool[] {
    return this.listCatalog(config, services)
      .filter((e) => e.owner === owner)
      .map((e) => e.tool);
  }

  /** 收集参与当前 Agent 烘焙的工具（presets 插件级过滤后） */
  private listEnabled(config: AgentConfig, services: ToolContext): Tool[] {
    const presets = config.presets;
    const enabled = (e: { owner?: string; always?: boolean }): boolean => {
      if (e.always) return true;
      if (!e.owner) return true;          // 无主注册：始终启用（兼容通道）
      if (!presets) return true;          // 未声明 presets：旧契约，不过滤
      return presets.includes(e.owner);
    };
    const all: Tool[] = [];
    const shadowed = new Set<string>();
    for (const e of this.shared) {
      if (!enabled(e)) continue;
      all.push(e.tool);
      if (e.replace) shadowed.add(e.tool.name);   // replace 注册遮蔽工厂同名工具
    }
    for (const e of this.factories) {
      if (!enabled(e)) continue;
      for (const tool of e.factory(config, services)) {
        if (shadowed.has(tool.name)) continue;
        all.push(tool);
      }
    }
    return all;
  }

  /**
   * 解析工具实例表（新契约：单一 config 来源）。
   * 优先级：presets 候选过滤 → requires 权限门禁 → exclude → include → 默认。
   */
  resolveTools(config: AgentConfig, services: ToolContext): Map<string, Tool>;
  /**
   * @deprecated 兼容旧调用（names 视为额外 include）。
   */
  resolveTools(names: string[] | undefined, config: AgentConfig, services: ToolContext): Map<string, Tool>;
  resolveTools(
    namesOrConfig: string[] | undefined | AgentConfig,
    configOrServices: AgentConfig | ToolContext,
    maybeServices?: ToolContext,
  ): Map<string, Tool> {
    const legacyMode = maybeServices !== undefined;
    const legacyNames = legacyMode ? (namesOrConfig as string[] | undefined) : undefined;
    const config = (legacyMode ? configOrServices : namesOrConfig) as AgentConfig;
    const services = (legacyMode ? maybeServices : configOrServices) as ToolContext;

    const out = new Map<string, Tool>();
    const agentTags = effectiveCapabilityTags(config.tags);
    const gate = (tool: Tool): boolean => {
      if (!tool.requires || tool.requires.length === 0) return true;
      return tool.requires.every((t) => agentTags.has(t));
    };

    const overrides = effectiveToolOverrides(config);
    const include = new Set<string>([
      ...(legacyNames ?? []),
      ...(overrides.include ?? []),
    ]);
    const exclude = new Set<string>(overrides.exclude ?? []);

    const all = this.listEnabled(config, services);

    for (const tool of all) {
      if (out.has(tool.name)) continue;
      if (!gate(tool)) continue;                       // 权限门禁：标签不足永远不可用
      if (exclude.has(tool.name)) continue;            // 1. 显式停用（最高优先级）
      if (include.has(tool.name)) {                    // 2. 显式启用
        out.set(tool.name, tool);
        continue;
      }
      if (tool.requires && tool.requires.length > 0) { // 3. 默认：随插件启用
        out.set(tool.name, tool);
      }
    }

    return out;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 工具注册中心（由 @agentchat/tools 提供） */
    tools: ToolsService;
  }
}
