// ============================================================
// @agentchat/hooks/src/service.ts —— 钩子注册中心（cordis Service）
//
// 提供 ctx.hooks（由 @agentchat/ext 更名而来）。
//   · register —— 插件注册钩子工厂（per-Agent 烘焙 config + services；带 owner）
//   · unregister —— 按 owner（插件名）精确卸载（动态插件 dispose 用）
//   · collect  —— 以 config.hooks（启用清单，顺序即执行顺序）单向驱动解析：
//       不在清单里 = 停用（没有第二个 disabled 数组）；
//       owner 不在 config.presets 中的钩子被跳过（presets 缺省 = 旧契约兼容）；
//       未注册的名字跳过（允许先配置、后安装插件）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { effectiveHookOrder, normalizeHookName, readHookOrder } from '@agentchat/agent-config';
import type { AgentConfig } from '@agentchat/agent-config';
import type { ToolContext } from '@agentchat/tools';
import type { CurrentContext } from '@agentchat/contracts';

/** 七类钩子的名字集合（与 L1 钩子一一对齐） */
export interface HookNames {
  runStart?: string[];
  runEnd?: string[];
  stepStart?: string[];
  stepEnd?: string[];
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
  /** 基础设施钩子：不受 config.hooks 清单控制，自动进入每个 run（仍受 owner preset 过滤） */
  automatic?: boolean;
}

/** 带 kind/name 的钩子目录条目（UI 目录/反查用） */
export interface HookCatalogEntry {
  kind: HookKind;
  name: string;
  entry: HookEntry;
  /** 该 kind 内的注册顺序（0 起；UI 重新启用/排序的推荐锚点） */
  order: number;
}

/** 钩子类 → CurrentContext 钩子数组字段名 */
const HOOK_FIELD: Record<HookKind, keyof CurrentContext> = {
  runStart: 'runStartHook',
  runEnd: 'runEndHook',
  stepStart: 'stepStartHook',
  stepEnd: 'stepEndHook',
  toolExecutionStart: 'toolExecutionStartHook',
  toolExecutionEnd: 'toolExecutionEndHook',
  fallback: 'fallbackHook',
};

export const HOOK_KINDS = Object.keys(HOOK_FIELD) as HookKind[];

export type ResolvedHooks = Partial<Pick<CurrentContext,
  | 'runStartHook' | 'runEndHook' | 'stepStartHook' | 'stepEndHook'
  | 'toolExecutionStartHook' | 'toolExecutionEndHook' | 'fallbackHook'>>;

export class HooksService extends Service {
  /** kind → [name → 注册条目]（同名后注册者覆盖） */
  private factories: Record<HookKind, Map<string, HookEntry>> = {
    runStart: new Map(), runEnd: new Map(), stepStart: new Map(), stepEnd: new Map(),
    toolExecutionStart: new Map(), toolExecutionEnd: new Map(), fallback: new Map(),
  };

  constructor(ctx: Context) {
    super(ctx, 'hooks');
  }

  /** 注册钩子工厂（同名后注册者覆盖；owner = cordis 插件 name；automatic = 不受 hooks 清单控制） */
  register(kind: HookKind, name: string, factory: HookFactory, owner?: string, automatic = false): void {
    this.factories[kind].set(name, { factory, owner, ...(automatic ? { automatic } : {}) });
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

  /** 全量钩子目录（kind/name/entry/order，供 UI 目录与 owner 反查；按注册顺序） */
  listCatalog(): HookCatalogEntry[] {
    const out: HookCatalogEntry[] = [];
    for (const kind of HOOK_KINDS) {
      let order = 0;
      for (const [name, entry] of this.factories[kind]) {
        out.push({ kind, name, entry, order: order++ });
      }
    }
    return out;
  }

  /** 指定 owner 注册的全部钩子名（目录反查 manifest.provides 用） */
  listByOwner(owner: string): string[] {
    return this.listCatalog()
      .filter((e) => e.entry.owner === owner)
      .map((e) => e.name);
  }

  /**
   * 按 config.hooks 启用清单解析各类钩子数组（新契约：单一 config 来源）。
   * 清单数组顺序即执行顺序；不在清单里 = 停用。
   */
  collect(config: AgentConfig, services: ToolContext): ResolvedHooks;
  /**
   * @deprecated 兼容旧调用（显式传入顺序表）。
   */
  collect(names: HookNames | undefined, config: AgentConfig, services: ToolContext): ResolvedHooks;
  collect(
    namesOrConfig: HookNames | undefined | AgentConfig,
    configOrServices: AgentConfig | ToolContext,
    maybeServices?: ToolContext,
  ): ResolvedHooks {
    const legacyMode = maybeServices !== undefined;
    const legacyNames = legacyMode ? (namesOrConfig as HookNames | undefined) : undefined;
    const config = (legacyMode ? configOrServices : namesOrConfig) as AgentConfig;
    const services = (legacyMode ? maybeServices : configOrServices) as ToolContext;

    const out: ResolvedHooks = {};
    const names = legacyMode
      ? readHookOrder(legacyNames, config.disabledHooks)
      : effectiveHookOrder(config);
    const presets = config.presets;
    const enabled = (entry: HookEntry): boolean => {
      if (!entry.owner) return true;   // 无主注册：始终启用（兼容通道）
      if (!presets) return true;       // 未声明 presets：旧契约，不过滤
      return presets.includes(entry.owner);
    };

    for (const kind of HOOK_KINDS) {
      const list = names[kind];
      const fns: unknown[] = [];
      const selected = new Set<string>();
      if (list && list.length > 0) {
        for (const name of list) {
          // 兼容旧契约 hooks 顺序表中的 builtin.* 别名（如 builtin.save-session）
          const canonical = normalizeHookName(name);
          const entry = this.factories[kind].get(canonical);
          if (!entry) continue;          // 未注册：跳过（允许先配置后安装）
          if (!enabled(entry)) continue; // preset 未启用：跳过
          const fn = entry.factory(config, services);
          if (fn != null) {
            fns.push(fn);
            selected.add(canonical);
          }
        }
      }
      // 基础设施钩子（automatic）：不受 hooks 清单控制，追加在显式钩子之后；
      // 同名已在清单中启用时去重；仍受 owner preset 过滤。
      for (const [name, entry] of this.factories[kind]) {
        if (!entry.automatic || selected.has(name)) continue;
        if (!enabled(entry)) continue;
        const fn = entry.factory(config, services);
        if (fn != null) {
          fns.push(fn);
          selected.add(name);
        }
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
