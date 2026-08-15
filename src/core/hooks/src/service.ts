// ============================================================
// @agentchat/hooks/src/service.ts —— 钩子注册中心（cordis Service）
//
// 提供 ctx.hooks（由 @agentchat/ext 更名而来）。
//   · register —— 插件注册钩子工厂（per-Agent 烘焙 config + services；带 owner）
//   · unregister —— 按 owner（插件名）精确卸载（动态插件 dispose 用）
//   · collect  —— 以 config.hooks（全局顺序表）单向驱动解析：
//       hooks.<kind> 的数组顺序即钩子执行顺序；
//       owner 不在 config.presets 中的钩子被跳过（presets 缺省 = 旧契约兼容）；
//       未注册的名字跳过（允许先配置、后安装插件）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { AgentConfig } from '@agentchat/agent-config';
import type { ToolContext } from '@agentchat/tools';
import type { CurrentContext } from '@agentchat/agent-loop';

/** 七类钩子的名字集合（与 L1 钩子一一对齐） */
export interface HookNames {
  runStart?: string[];
  runEnd?: string[];
  turnStart?: string[];
  turnEnd?: string[];
  toolExecutionStart?: string[];
  toolExecutionEnd?: string[];
  fallback?: string[];
}

export type HookKind = keyof HookNames;

/** 钩子工厂：per-Agent 烘焙（services 可忽略）→ 钩子函数 */
export type HookFactory = (config: AgentConfig, services: ToolContext) => unknown;

/** 钩子注册条目（含 owner 归属） */
export interface HookEntry {
  factory: HookFactory;
  /** 注册归属（cordis 插件 name = preset id；缺省 = 无主，始终启用） */
  owner?: string;
}

/** 带 kind/name 的钩子目录条目（UI 目录/反查用） */
export interface HookCatalogEntry {
  kind: HookKind;
  name: string;
  entry: HookEntry;
}

/** 钩子类 → CurrentContext 钩子数组字段名 */
const HOOK_FIELD: Record<HookKind, keyof CurrentContext> = {
  runStart: 'runStartHook',
  runEnd: 'runEndHook',
  turnStart: 'turnStartHook',
  turnEnd: 'turnEndHook',
  toolExecutionStart: 'toolExecutionStartHook',
  toolExecutionEnd: 'toolExecutionEndHook',
  fallback: 'fallbackHook',
};

export const HOOK_KINDS = Object.keys(HOOK_FIELD) as HookKind[];

export type ResolvedHooks = Partial<Pick<CurrentContext,
  | 'runStartHook' | 'runEndHook' | 'turnStartHook' | 'turnEndHook'
  | 'toolExecutionStartHook' | 'toolExecutionEndHook' | 'fallbackHook'>>;

export class HooksService extends Service {
  /** kind → [name → 注册条目]（同名后注册者覆盖） */
  private factories: Record<HookKind, Map<string, HookEntry>> = {
    runStart: new Map(), runEnd: new Map(), turnStart: new Map(), turnEnd: new Map(),
    toolExecutionStart: new Map(), toolExecutionEnd: new Map(), fallback: new Map(),
  };

  constructor(ctx: Context) {
    super(ctx, 'hooks');
  }

  /** 注册钩子工厂（同名后注册者覆盖；owner = cordis 插件 name） */
  register(kind: HookKind, name: string, factory: HookFactory, owner?: string): void {
    this.factories[kind].set(name, { factory, owner });
  }

  /** 按 owner 卸载全部钩子注册（动态插件 dispose/更新用）；返回移除条数 */
  unregister(owner: string): number {
    let removed = 0;
    for (const kind of HOOK_KINDS) {
      const map = this.factories[kind];
      for (const [name, entry] of map) {
        if (entry.owner === owner) {
          map.delete(name);
          removed++;
        }
      }
    }
    return removed;
  }

  /** 查询注册条目（动态插件诊断 / UI 归属展示用） */
  find(kind: HookKind, name: string): HookEntry | undefined {
    return this.factories[kind].get(name);
  }

  /** 已注册的钩子名（UI 钩子目录 / 诊断用） */
  listNames(kind: HookKind): string[] {
    return [...this.factories[kind].keys()];
  }

  /** 全部注册 owner（诊断/UI 用） */
  listOwners(): string[] {
    const owners = new Set<string>();
    for (const kind of HOOK_KINDS) {
      for (const entry of this.factories[kind].values()) {
        if (entry.owner) owners.add(entry.owner);
      }
    }
    return [...owners];
  }

  /** 全量钩子目录（kind/name/entry，供 UI 目录与 owner 反查） */
  listCatalog(): HookCatalogEntry[] {
    const out: HookCatalogEntry[] = [];
    for (const kind of HOOK_KINDS) {
      for (const [name, entry] of this.factories[kind]) {
        out.push({ kind, name, entry });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 指定 owner 注册的全部钩子名（目录反查 manifest.provides 用） */
  listByOwner(owner: string): string[] {
    return this.listCatalog()
      .filter((e) => e.entry.owner === owner)
      .map((e) => e.name);
  }

  /**
   * 按全局钩子顺序表解析各类钩子数组。
   * @param names config.hooks（顺序表；缺省 = 无钩子）
   * @param config Agent 配置（presets 决定 owner 过滤；presets 缺省 = 旧契约兼容）
   */
  collect(names: HookNames | undefined, config: AgentConfig, services: ToolContext): ResolvedHooks {
    const out: ResolvedHooks = {};
    if (!names) return out;
    const presets = config.presets;
    const enabled = (entry: HookEntry): boolean => {
      if (!entry.owner) return true;   // 无主注册：始终启用（兼容通道）
      if (!presets) return true;       // 未声明 presets：旧契约，不过滤
      return presets.includes(entry.owner);
    };

    for (const kind of HOOK_KINDS) {
      const list = names[kind];
      if (!list || list.length === 0) continue;
      const fns: unknown[] = [];
      for (const name of list) {
        const entry = this.factories[kind].get(name);
        if (!entry) continue;          // 未注册：跳过（允许先配置后安装）
        if (!enabled(entry)) continue; // preset 未启用：跳过，顺序仍由顺序表决定
        const fn = entry.factory(config, services);
        if (fn != null) fns.push(fn);
      }
      if (fns.length > 0) {
        (out as Record<string, unknown>)[HOOK_FIELD[kind]] = fns;
      }
    }
    return out;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 钩子注册中心（由 @agentchat/hooks 提供） */
    hooks: HooksService;
  }
}
