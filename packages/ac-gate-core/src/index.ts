// ============================================================
// ac-gate-core —— per-Agent 事件门控 helper（M25 §3.3，纯库零 cordis 依赖）
//
// agentGate(ctx, pluginName, agentOf, inner, {facet?})：把一个事件监听器
// 包成"对该 Agent 软停用时自动让路"的形态——
//   · **waterfall 停用 = `return next()`**（末参函数判定）：不调 next()
//     就是静默吞掉下游全部默认行为的反模式从根上消灭（机械保证）；
//   · emit 停用 = 跳过（返回 undefined）；
//   · 配置读取走 agents.settingsOf（M24 A1：全局默认层 ∪ 差异层合成；
//     未配置 = 启用——与"无配置 = 启用"语义一致）；
//   · **软依赖**：ctx.get('agents')——没有 agents 服务的组合里 gated
//     插件照常运行（恒放行）；不用裸 ctx.agents（事件闭包里受限解析
//     会断链，M12 铁律 2）；
//   · facet 切面子键（一插件多 run 域事件的细分关停）：逐监听器包裹时
//     传 { facet: 'redact' } → 读
//     `settings[pluginName][facet].enabled ?? settings[pluginName].enabled`
//     （子键覆盖、回落行为级——与 A1 同款"具体覆盖一般"）。facet 名由
//     作者命名（稳定语义承诺，非事件名——重构挂载不碎配置）；耦合由
//     作者裁定（不可分的监听器共享 facet 或不传）。
//
// 判定式与类型：agentOf 读取器签名强制传（owning 包导出，M25 §3.2）→
// 无身份事件编译期不可门控。读取器返回 undefined → 门控 fail-open
// （宿主直调/子代理等无身份场景恒放行）。
// ============================================================

/** agentGate 需要的最小 ctx 形状（结构性——纯库零 cordis 依赖） */
export interface GateContext {
  /** 软依赖解析（root-traced；无该服务返回 undefined） */
  get(name: string): unknown;
}

/** agents 服务最小形状（结构性；settingsOf = M24 A1 合成口） */
interface AgentsLike {
  settingsOf(id: string, name?: string): unknown;
}

/** 门控选项 */
export interface AgentGateOptions {
  /**
   * facet 切面子键：读 settings[pluginName][facet].enabled ??
   * settings[pluginName].enabled（子键覆盖、回落行为级）。
   */
  facet?: string;
}

/**
 * 包裹一个事件监听器为 per-Agent 门控形态。
 *
 * @param ctx 宿主 Context（结构性：只用到 get）
 * @param pluginName settings 键锚点（行名 / 动态插件 manifest.name）
 * @param agentOf 身份读取器（owning 包导出；first = 分发首参）
 * @param inner 原监听器（waterfall 形态末参为 next）
 * @param opts facet 切面
 * @returns 与 inner 同签名的门控监听器（可直接传 ctx.on）
 */
export function agentGate<L extends (...args: any[]) => any>(
  ctx: GateContext,
  pluginName: string,
  agentOf: (first: Parameters<L>[0]) => string | undefined,
  inner: L,
  opts: AgentGateOptions = {},
): L {
  const gated = (...args: Parameters<L>): ReturnType<L> | undefined => {
    // 末参函数判定：waterfall 分发（末参 = next）vs emit（末参 = 载荷）
    const last = args[args.length - 1];
    const isWaterfall = typeof last === 'function';
    if (isDisabled(ctx, pluginName, agentOf(args[0] as Parameters<L>[0]), opts.facet)) {
      // 停用：waterfall = 机械 return next()（链继续——吞的是本监听器，
      // 不是下游默认行为）；emit = 跳过
      return isWaterfall ? (last as () => any)() : undefined;
    }
    return inner(...args);
  };
  return gated as unknown as L;
}

/** 停用判定：无 agents 服务 / 无身份 / 无配置 = 放行（fail-open） */
function isDisabled(
  ctx: GateContext,
  pluginName: string,
  agentId: string | undefined,
  facet: string | undefined,
): boolean {
  if (agentId === undefined) return false; // 无身份 → fail-open
  const agents = ctx.get('agents') as AgentsLike | undefined;
  if (!agents || typeof agents.settingsOf !== 'function') return false; // 无 agents 服务 → 恒放行
  const settings = agents.settingsOf(agentId, pluginName);
  if (settings === undefined || settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return false; // 无配置 / 旧非对象形状 = 启用
  }
  const cfg = settings as Record<string, unknown>;
  if (facet === undefined) return cfg.enabled === false;
  // facet 子键覆盖、回落行为级：settings[facet].enabled ?? settings.enabled
  const sub = cfg[facet];
  if (sub !== undefined && sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
    const subEnabled = (sub as { enabled?: unknown }).enabled;
    if (subEnabled !== undefined) return subEnabled === false;
  }
  return cfg.enabled === false;
}
