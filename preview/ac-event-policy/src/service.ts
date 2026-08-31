// ============================================================
// ac-event-policy/src/service.ts —— 事件治理策略行（M25 §3.4 / P2）
//
// 进程级 (插件 × 事件) 停用集。两层关停分离：per-Agent = 分发时门控
// （agentGate 自查，ac-gate-core）；进程级 = 注册期拦截（本行）。
//
// 机制（三件套，B1 重裁"拦截 + boot 末一次性清扫"）：
//   1. **拦截**：internal/listener bail（{global:true}）——`this.fiber?.name`
//      定位注册方；键 `${owner}::${name}` 命中停用集 → 返回替代注册
//      `() => true`（监听器从未进 _hooks）。吞注册 ≠ veto——waterfall
//      链由剩余监听器自动构链照常跑（ADR-7 顺序无关收敛保证任意子集
//      成立）。internal/* 恒放行（自锁守卫：本行自己的 seam 不可被停）。
//      行序 ≠ 激活序（loader 并发创建行、fiber 各自激活无屏障）——拦截
//      只管"本行就位之后"的注册：运行时 install / 插件重载全覆盖。
//   2. **boot 末一次性清扫**：boot 期出厂行注册可能先于本行就位（哪些
//      逃逸随 import 时序非确定漂移）——组合根收敛点（ac-app/boot.ts
//      在 loader.create 收敛后）显式调用 sweep()，对 _hooks 按停用集做
//      单次清扫。与"不做运行时 splice"不矛盾：被否的是响应式热改
//      （配置热更随时 splice → 与注册表漂移）；单次清扫发生在全部注册
//      尘埃落定后、与重载互斥，语义收敛。程序化路径（bootTree 无
//      loader、串行 await）由测试直调 sweep。
//   3. **行 reload 自追清扫**（N6）：行重挂期间 internal/listener 无
//      消费者、注册逃逸且 boot 已过——apply 收尾自追一次 sweep（幂等）；
//      窗口极窄（dev/HMR），如实声明。
//
// 停用键（定死）：config.json `events.disabled: string[]`，键 =
// events/listeners 的 owner **原文**（不迁移）；P3 聚合只改呈现不改键、
// 策略行匹配对 fiber 名与聚合行名双命中。
// 生效时机：注册期拦截 + boot 末清扫；config/changed 热更只影响**后续**
// 注册（已注册条目等重载/重启——与 patch 停用同款 UX）。
// fiber 生命周期安全：吞注册路径 vendor register() 未执行、无 effect
// disposer（卸载天然无操作）；清扫路径条目正常移除，插件卸载时原
// disposer unregister 落空 → no-op。
// bail 单链纪律：internal/listener 首胜单链——此 seam 仅本策略行使用
// （规约 + 测试锁定：其余 preview 行注册即红灯；判据排除 vendor 自带
// 消费者[EventsService 构造器 internal/update 特判]，events/listeners
// RPC 过滤 internal/*——测试直读 _hooks）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { computeRowAggregates } from './aggregate.ts';

// 聚合符号（computeRowAggregates/rowOfFiber）的包级出口在 index.ts（直连 aggregate.ts）

/** _hooks 私有读形状（vendor 无公开列举 API——与 events/listeners RPC 同款立场） */
interface HooksTable {
  _hooks: Record<string, Array<{ ctx?: { fiber?: { name?: string } }; callback?: unknown }>>;
}

export class EventPolicyService extends Service {
  /** 构造期/闭包要访问 config（停用集持久层）——M12 铁律 1 */
  static inject = ['config'];

  constructor(ctx: Context) {
    super(ctx, 'eventPolicy');
    const service = this;

    // ---- 拦截：internal/listener bail（吞注册） ----
    // vendor 声明第三参为 prepend: boolean，运行时实参是 options 对象——
    // 本行不消费该参（吞注册与位置无关），实现侧不碰 vendor。
    this.ctx.on(
      'internal/listener',
      function (this: Context, name: string | symbol, _listener: unknown) {
        if (typeof name !== 'string') return; // symbol 事件不治理
        if (name.startsWith('internal/')) return; // 自锁守卫：internal/* 恒放行
        const owner = this.fiber?.name ?? '(anonymous)';
        if (service.isDisabled(owner, name)) {
          // 替代注册：对任何真值生效（vendor bail isBailed）——幂等
          return () => true;
        }
      },
      { global: true, description: '策略行专属 seam：internal/listener 吞注册（(插件×事件) 停用集命中 → 监听器不进链）' },
    );

    // config/changed 热更：停用集变更只影响后续注册（已注册条目等重载/重启）
    this.ctx.on('config/changed', () => {
      this.disabledKeys(true); // 失效缓存（下次查询重读）
    }, { description: '策略热更：重读停用集 + 自追清扫' });

    // registry 变化（行装载/卸载）→ 聚合别名重算
    this.ctx.on('internal/plugin', () => {
      this.aliasesFresh = false;
    }, { global: true, description: '行装载/卸载 → 聚合别名重算' });
  }

  private disabledCache: Set<string> | undefined;

  /** 停用键集（config events.disabled；owner 原文；缓存 + 失效） */
  disabledKeys(refresh = false): Set<string> {
    if (this.disabledCache !== undefined && !refresh) return this.disabledCache;
    const raw = this.ctx.config.get<unknown>('events.disabled');
    const keys = new Set<string>(
      Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [],
    );
    this.disabledCache = keys;
    return keys;
  }

  /** 键是否命中停用集（fiber 名与聚合行名双命中——P3 聚合后按行名书写的新键不失配） */
  isDisabled(owner: string, event: string): boolean {
    const keys = this.disabledKeys();
    if (keys.has(`${owner}::${event}`)) return true;
    // 双命中：owner 是 fiber 名（如服务类名）时按聚合行名（目录条目 row /
    // yml 行名）再查一次——聚合只改呈现不改键的补充面（仅当两名不同）
    this.ensureAliases();
    const alias = this.rowAlias.get(owner);
    return alias !== undefined && alias !== owner && keys.has(`${alias}::${event}`);
  }

  /** 聚合别名懒构建（fiber/runtime 名 → 顶层行名；registry 变化后重算） */
  private aliasesFresh = false;
  /** fiber 名 → 聚合行名（双命中判定用——聚合只改呈现不改键；实例私有防跨组合泄漏） */
  private readonly rowAlias = new Map<string, string>();
  private ensureAliases(): void {
    if (this.aliasesFresh) return;
    this.aliasesFresh = true;
    for (const [from, to] of computeRowAggregates(this.ctx)) {
      this.rowAlias.set(from, to);
    }
  }

  /**
   * 写一条治理键（config.set('events.disabled', …)；影响提示：
   * 已注册条目需重载/重启——吞注册只管后续注册）。
   */
  async setPolicy(key: string, disabled: boolean): Promise<string[]> {
    if (!/^[^\s:]+::[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(key)) {
      throw new Error(`治理键 "${key}" 形状非法（owner::event，如 ac-security::tool/before-execute）`);
    }
    const event = key.split('::')[1] ?? '';
    if (event.startsWith('internal/')) {
      // 自锁守卫（写侧）：internal/* 是框架 seam（含本行自己的拦截口），
      // 恒不可停——写入也永不生效，直接拒绝给出可诊断错误
      throw new Error(`internal/* 事件不可治理（${key}——框架 seam 自锁守卫）`);
    }
    const keys = this.disabledKeys(true);
    if (disabled) keys.add(key);
    else keys.delete(key);
    const next = [...keys].sort();
    this.ctx.config.set('events.disabled', next);
    return next;
  }

  /**
   * 一次性清扫（boot 末 / 行 reload 自追；幂等）：对 _hooks 按停用集
   * 移除已注册条目。返回移除条数（0 = 无事发生——幂等重入的断言锚）。
   * 已停用条目的宿主插件卸载时原 disposer unregister 落空 → no-op。
   */
  sweep(): number {
    const keys = this.disabledKeys();
    if (keys.size === 0) return 0;
    const events = this.ctx.events as unknown as HooksTable;
    let removed = 0;
    for (const [name, hooks] of Object.entries(events._hooks)) {
      if (!Array.isArray(hooks)) continue;
      for (let i = hooks.length - 1; i >= 0; i--) {
        const hook = hooks[i];
        if (!hook?.ctx) continue;
        const owner = hook.ctx.fiber?.name ?? '(anonymous)';
        if (this.isDisabled(owner, name)) {
          hooks.splice(i, 1);
          removed++;
        }
      }
    }
    return removed;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 事件治理策略行（ac-event-policy 提供）：进程级 (插件×事件) 停用集 */
    eventPolicy: EventPolicyService;
  }
}
