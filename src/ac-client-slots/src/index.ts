// ============================================================
// ac-client-slots —— SlotCore 纯核（M27 S0 朴素形态 → S1.5 增强级）
//
// 零 cordis 依赖、零框架依赖的 slot 注册表内核（本仓自己的纪律：
// 纯核可独立单测，参照 ac-*-core 纯库族；DSH 0.1.2-rc.1 已将两包
// 并入 renderer/runner，其动机（循环依赖/行政成本）不适用于本仓，
// 维持拆分——见 m27 计划头部参照系注记）。
//
// **S1.5 增强级**（复核 §3.2 验收门，签名自 S0 起即占位——演进 =
// 行为增强而非签名变更，D15）：
//   1. SlotMap 类型化：declare module 'ac-client-slots' 注入 slot key +
//      owner props 类型（声明集从 string 账本升级；未注明的 key 经
//      string 渐进兼容）；
//   2. cell + priority 选举（single shadow 语义；无贡献回落默认插槽由
//      渲染面承担，D16 衔接）；chain 型按 priority 逐条消费序；
//   3. store 座位实例轴（SlotStoreAxis：handle × scope key 创建/缓存/
//      引用计数/会话死即清）；
//   4. abdicate 退位（entry 崩溃/劣迹 → 让出选举位，重注册即复位）；
//      onEntryError 监督钩子住运行时层（ac-client-runtime）。
//
// 语义对照（现行 webui 三注册表 + core/extensions/slots.ts 的延续）：
//   · 同 slot 内同 id 后注册者替换前者（幂等，继承插入序）；
//   · order 缺省 100，升序，同 order 按注册先后稳定（list 型排序轴）；
//   · 未声明（不在声明账本）的 key 一律拒绝注册——D1 fail-closed；
//   · root 单席位纪律（D3）：factory 席位出厂装配封印后拒绝动态注册；
//     选举中出厂层恒高于动态层（「动态注册者恒低优」）。
// ============================================================

/** slot 形态（D2 终态词汇） */
export type SlotKind = 'single' | 'list' | 'chain';

/** slot 作用域（D2）：root = 应用级；session = 会话作用域（store 座位实例轴） */
export type SlotScope = 'root' | 'session';

/** order 缺省值（slot-tree §5.11：延续 slots.ts/三注册表现行语义） */
export const DEFAULT_SLOT_ORDER = 100;

/** cell 缺省名（未声明 cell 的贡献都住 base cell） */
export const DEFAULT_CELL = 'base';

/** 装载校验错误码（fail-closed 且可诊断） */
export type SlotCoreErrorCode =
  /** 注册到未声明的 slot（先 declare 再 register） */
  | 'UNDECLARED_SLOT'
  /**
   * 出厂席位封印后的动态注册（S0/S1 防线语义；S1.5 起被 tier 选举
   * 取代——动态注册恒低优不再拒绝，此码保留给诊断面/历史兼容）
   */
  | 'FACTORY_SEALED'
  /** 声明/条目参数形状非法 */
  | 'INVALID_DEF';

/** 装载校验错误（携带稳定 code，便于测试与诊断面分类） */
export class SlotCoreError extends Error {
  readonly code: SlotCoreErrorCode;

  constructor(code: SlotCoreErrorCode, message: string) {
    super(`[slots:${code}] ${message}`);
    this.name = 'SlotCoreError';
    this.code = code;
  }
}

// ------------------------------------------------------------
// SlotMap 类型化（S1.5-1）：每包经 declare module 注入自己的 slot 词表
// ------------------------------------------------------------

/** 单个 slot 的类型元数据（owner props 形状 + 缺省形态） */
export interface SlotTypeMeta<P = unknown> {
  /** owner props（席位 data 的类型——D16-③ 透传给贡献组件） */
  props?: P;
  kind?: SlotKind;
  scope?: SlotScope;
}

/**
 * SlotMap：类型化声明集（S1.5 升级）。
 *
 * 声明合并目标 = 本模块（不碰 '@agentchat/cordis'，D22）：
 *   declare module 'ac-client-slots' {
 *     interface SlotMap {
 *       'chat:header-actions': { props: { context: string } };
 *     }
 *   }
 * 未注入的 key 走 `string & {}` 渐进兼容（迁移期 string 账本共存）。
 */
export interface SlotMap {
  [key: string]: SlotTypeMeta;
}

/** 已类型化的 slot key（含渐进兼容的裸 string） */
export type SlotKey = (keyof SlotMap & string) | (string & {});

// ------------------------------------------------------------
// 声明与贡献
// ------------------------------------------------------------

/** store 座位工厂（D2 终态）：返回值可带 dispose()（引用计数归零即回收） */
export type SlotStoreFactory = (handle: SlotStoreHandle) => unknown;

/** store 座位实例句柄（实例轴键 = slotKey + entryId + scopeKey） */
export interface SlotStoreHandle {
  slotKey: string;
  entryId: string;
  /** 会话作用域实例化键（scope:'root' 席位恒为 'root'） */
  scopeKey: string;
}

/** slot 声明（声明账本条目——「声明集」的运行时形态） */
export interface SlotDecl {
  /**
   * slot key：`<域>:<元素>[-<位置/方向>]` param-case
   * （slot-tree §5.11 命名约定；root 例外——保留裸名 'root'）。
   */
  key: string;
  /** 形态；缺省 'list' */
  kind?: SlotKind;
  /** 作用域；缺省 'root' */
  scope?: SlotScope;
  /**
   * 出厂席位（D3）：root 等出厂占用型 seat。出厂装配期（sealFactory
   * 之前）注册 = 出厂层（tier 0，选举恒胜）；封印后动态注册允许但恒入
   * 动态层（tier 1，「动态注册者恒低优」——S1.5 起生效；S0/S1 的
   * 「封印即拒」防线由 tier 选举取代，两代差异在测试显式记录）。
   */
  factory?: boolean;
  /**
   * 第三方可声明（D13 公开子集）：第三方 manifest ui.slots 校验面的
   * 数据源由账本派生（替代 BUILTIN_SLOTS 静态数组；S3 消费）。
   */
  public?: boolean;
  /** 高危替换 seat（D13 门槛名单：整面板/composer 类；manifest 显式声明 + 确认面） */
  highRisk?: boolean;
  /** 一句话职责描述（账本快照/诊断面） */
  description?: string;
  /**
   * owner props 契约（D2：吸收 slot-tree §5 横切约定——z-index 配额、
   * 替换型移动端行为继承、命令式通道保留、四态回落等；声明集承载）。
   */
  ownerProps?: Record<string, unknown>;
}

/** slot 贡献条目（注册面；D2 终态形状） */
export interface SlotEntry<P extends Record<string, unknown> = Record<string, unknown>> {
  /** 贡献 id（同 slot 内唯一；后注册者替换前者——幂等） */
  id: string;
  /** 贡献组件（框架中立：由渲染器解释——Vue 组件/渲染函数） */
  component: unknown;
  /** 排序轴（缺省 100；升序；同 order 按注册先后稳定——list 型排序） */
  order?: number;
  /** 禁用：布尔或谓词（每次 entries() 读取时评估） */
  disabled?: boolean | (() => boolean);
  /**
   * cell 选举（S1.5 实装）：同 cell 高 priority shadow 低者；single 型
   * 经 cell 分组后取最高 cell 的最高条目；缺省 'base'。
   */
  cell?: string;
  /**
   * priority 选举（S1.5 实装）：同 cell 内高者 shadow 低者；
   * 缺省 0；tie → order → 注册序。
   */
  priority?: number;
  /**
   * store 座位（S1.5 实装）：per-entry 工厂 → SlotStoreAxis 按
   * (entryId × scopeKey) 实例化 / 引用计数 / 会话死即清。
   */
  store?: SlotStoreFactory;
  /** 声明式子插口（S1.5 实装：children 键 = 本条目内部的子席位声明） */
  children?: string[];
  /**
   * 声明性载荷（框架中立）：注册面随条目携带的自定义数据——如 webui
   * bridge 过渡期把旧注册表 def（label/icon/onClick 等非组件词汇）整体
   * 存入（消费面经 meta 取回，见 webui core/extensions/slots.ts）。
   */
  meta?: Record<string, unknown>;
  /** 传给贡献组件的 props：对象，或基于 owner data 的工厂（条目 props 优先） */
  props?: P | ((data: unknown) => P);
}

/** 内部存储条目（解析了选举/排序/层级元数据） */
interface StoredEntry {
  entry: SlotEntry;
  order: number;
  seq: number;
  /** 出厂层（factory 席位 + 封印前注册）恒高于动态层 */
  tier: 0 | 1;
  /** 退位标记（entry 崩溃/劣迹）：让出选举位直至重注册 */
  abdicated: boolean;
}

/** 声明账本快照（调试面：snapshot() 返回值） */
export interface SlotCoreSnapshot {
  declarations: SlotDecl[];
  slots: Record<string, SlotEntry[]>;
  factorySealed: boolean;
}

/** 选举比较器：tier（低者胜）→ priority（高者胜）→ order（低者胜）→ seq（低者胜） */
function compareElection(a: StoredEntry, b: StoredEntry): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const pa = a.entry.priority ?? 0;
  const pb = b.entry.priority ?? 0;
  if (pa !== pb) return pb - pa;
  if (a.order !== b.order) return a.order - b.order;
  return a.seq - b.seq;
}

/** list 排序比较器：order（低者胜）→ seq（低者胜，稳定） */
function compareOrder(a: StoredEntry, b: StoredEntry): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.seq - b.seq;
}

function visible(s: StoredEntry): boolean {
  if (s.abdicated) return false;
  const d = s.entry.disabled;
  return typeof d === 'function' ? !d() : !d;
}

/**
 * SlotCore —— slot 注册表纯核。
 *
 * 框架中立：不 import vue / cordis；响应式由上层经版本计数
 * （version(key)，key 级细粒度轴——D14）+ 事件桥建立。
 * 级联回收：register() 返回 disposer，上层（SlotRegistry）将其挂到
 * 调用方 fiber，插件卸载即逆序执行——与服务端 fiber 语义同构（D5）。
 */
export class SlotCore {
  private decls = new Map<string, SlotDecl>();
  private slots = new Map<string, StoredEntry[]>();
  private versions = new Map<string, number>();
  private seq = 0;
  private factorySealed = false;

  /** 声明席位（写入声明账本）。重复声明后者替换前者；既有贡献保留（仅换形状）。 */
  declare(decl: SlotDecl): void {
    if (typeof decl?.key !== 'string' || decl.key.length === 0) {
      throw new SlotCoreError('INVALID_DEF', `slot 声明缺少非空 key：${JSON.stringify(decl)}`);
    }
    if (decl.kind !== undefined && !['single', 'list', 'chain'].includes(decl.kind)) {
      throw new SlotCoreError('INVALID_DEF', `slot "${decl.key}" 的 kind 非法：${String(decl.kind)}（single | list | chain）`);
    }
    if (decl.scope !== undefined && !['root', 'session'].includes(decl.scope)) {
      throw new SlotCoreError('INVALID_DEF', `slot "${decl.key}" 的 scope 非法：${String(decl.scope)}（root | session）`);
    }
    this.decls.set(decl.key, { kind: 'list', scope: 'root', ...decl });
    this.touch(decl.key);
  }

  /** 撤销声明（声明方卸载）：该席位全部贡献一并消失（渲染面已无处安放）。 */
  undeclare(key: string): boolean {
    if (!this.decls.delete(key)) return false;
    this.slots.delete(key);
    this.touch(key);
    return true;
  }

  /** 席位是否已声明 */
  has(key: string): boolean {
    return this.decls.has(key);
  }

  /** 声明账本读取（未声明 → undefined） */
  declOf(key: string): Readonly<SlotDecl> | undefined {
    return this.decls.get(key);
  }

  /**
   * 注册贡献（装载校验 fail-closed）：
   * 未声明的 key → 抛 SlotCoreError。
   * 同 id 后注册者替换前者（继承插入序）；重注册同时清除该 id 的退位标记。
   *
   * factory 席位（D3 两代语义）：出厂装配期（sealFactory 前）注册 =
   * 出厂层（tier 0）；封印后动态注册【允许】但恒入动态层（tier 1）——
   * 选举中出厂层恒高于动态层（「动态注册者恒低优」，S1.5 起生效；
   * S0/S1 的「封印即拒」防线由选举层取代，两代差异显式记录于测试）。
   *
   * @returns disposer（撤销本条贡献；幂等，可重复调用）
   */
  register(key: string, entry: SlotEntry): () => void {
    const decl = this.decls.get(key);
    if (!decl) {
      throw new SlotCoreError(
        'UNDECLARED_SLOT',
        `slot "${key}" 未声明——装载校验 fail-closed（M27 D1）：先经 declare() 进声明账本，再注册贡献`,
      );
    }
    if (typeof entry?.id !== 'string' || entry.id.length === 0) {
      throw new SlotCoreError('INVALID_DEF', `slot "${key}" 的贡献缺少非空 id：${JSON.stringify(entry)}`);
    }
    if (entry.component === undefined || entry.component === null) {
      throw new SlotCoreError('INVALID_DEF', `slot "${key}" 的贡献 "${entry.id}" 缺少 component（非视觉缝不走 slot——M27 D8）`);
    }

    const list = this.slots.get(key) ?? [];
    this.slots.set(key, list);
    const stored: StoredEntry = {
      entry,
      order: entry.order ?? DEFAULT_SLOT_ORDER,
      seq: this.seq++,
      tier: decl.factory === true && !this.factorySealed ? 0 : 1,
      abdicated: false,
    };
    const idx = list.findIndex((s) => s.entry.id === entry.id);
    if (idx >= 0) {
      stored.seq = list[idx].seq; // 同 id 替换继承原插入序（同 order 平局仍居原位）
      list.splice(idx, 1, stored);
    } else {
      list.push(stored);
    }
    this.touch(key);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const arr = this.slots.get(key);
      if (!arr) return;
      const i = arr.indexOf(stored);
      if (i >= 0) arr.splice(i, 1);
      this.touch(key);
    };
  }

  /**
   * 读取席位条目（disabled/退位过滤 + 排序）。
   * · list：order 升序稳定（同轴 order——D16-①）；
   * · chain：priority 降序（逐条消费序：高优先 = 外层先消费）；
   * · 读取时评估 disabled 谓词——谓词内部状态变化不触版本计数
   *   （与 Koishi 同款限制；可见性门控正交——slot-tree §5.5）。
   */
  entries(key: string): readonly SlotEntry[] {
    const decl = this.decls.get(key);
    if (!decl) return [];
    const list = (this.slots.get(key) ?? []).filter(visible);
    if (decl.kind === 'chain') list.sort(compareElection);
    else list.sort(compareOrder);
    return list.map((s) => s.entry);
  }

  /**
   * single 型选举（S1.5 cell shadow）：
   * · cell 分组 → 组内 (tier, priority, order, seq) 选优；
   * · 各 cell 优胜者再同轴竞标 → 全局唯一赢家；
   * · 无贡献 → undefined（「未填充回落宿主默认」由渲染面默认插槽承担，D16-②）；
   * · 退位（abdicated）条目不参选。
   */
  single(key: string): SlotEntry | undefined {
    const decl = this.decls.get(key);
    if (!decl || decl.kind !== 'single') return this.visibleOrdered(key)[0]?.entry;
    const list = (this.slots.get(key) ?? []).filter(visible);
    if (list.length === 0) return undefined;
    // cell 分组（保持 cell 首见序）
    const cells = new Map<string, StoredEntry[]>();
    for (const s of list) {
      const cell = s.entry.cell ?? DEFAULT_CELL;
      const group = cells.get(cell) ?? [];
      group.push(s);
      cells.set(cell, group);
    }
    // 各 cell 优胜者（组内 election 序首位）
    const winners: StoredEntry[] = [];
    for (const group of cells.values()) {
      group.sort(compareElection);
      winners.push(group[0]);
    }
    // 全局赢家（同轴竞标）
    winners.sort(compareElection);
    return winners[0].entry;
  }

  /**
   * 退位（S1.5-5 与 onEntryError 监督配套）：entry 崩溃/劣迹 → 让出
   * 选举位（single 退到下一候选；list/chain 从 entries() 消失），
   * 直至同 id 重注册（复位）。
   */
  abdicate(key: string, entryId: string): boolean {
    const list = this.slots.get(key);
    if (!list) return false;
    const stored = list.find((s) => s.entry.id === entryId);
    if (!stored || stored.abdicated) return false;
    stored.abdicated = true;
    this.touch(key);
    return true;
  }

  /** 出厂装配封印（D3）：此后 factory 席位的动态注册一律拒绝。 */
  sealFactory(): void {
    this.factorySealed = true;
  }

  /** 封印状态（诊断面） */
  get sealed(): boolean {
    return this.factorySealed;
  }

  /** 声明账本 + 各席位条目 + 封印状态（调试面） */
  snapshot(): SlotCoreSnapshot {
    const slots: Record<string, SlotEntry[]> = {};
    for (const [key, list] of this.slots) slots[key] = list.map((s) => s.entry);
    return {
      declarations: [...this.decls.values()].map((d) => ({ ...d })),
      slots,
      factorySealed: this.factorySealed,
    };
  }

  /** 席位版本计数（key 级细粒度失效轴——D14；声明/注册/撤销/退位均递增） */
  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  private visibleOrdered(key: string): StoredEntry[] {
    return (this.slots.get(key) ?? []).filter(visible).sort(compareOrder);
  }

  private touch(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
}

// ------------------------------------------------------------
// SlotStoreAxis —— store 座位实例轴（S1.5-3，D2/D10）
//
// per-entry handle × scope key 实例化 / 引用计数 / 会话死即清。
// 持久化态随清：工厂返回值可带 dispose()，归零或 dropScope 时执行。
// ------------------------------------------------------------

interface StoreInstance {
  value: unknown;
  refs: number;
  dispose?: () => void;
}

/** store 实例的获取结果（引用句柄——release 用） */
export interface StoreSeat<T = unknown> {
  value: T;
  release(): void;
}

export class SlotStoreAxis {
  private instances = new Map<string, StoreInstance>();

  private static keyOf(handle: SlotStoreHandle): string {
    return `${handle.slotKey}\u0000${handle.entryId}\u0000${handle.scopeKey}`;
  }

  /** 获取（或创建）实例：引用计数 +1。工厂返回值带 dispose() 则追踪回收。 */
  acquire(handle: SlotStoreHandle, factory: SlotStoreFactory): StoreSeat {
    const key = SlotStoreAxis.keyOf(handle);
    let inst = this.instances.get(key);
    if (!inst) {
      const produced = factory(handle);
      const dispose = typeof (produced as { dispose?: unknown })?.dispose === 'function'
        ? (produced as { dispose: () => void }).dispose.bind(produced)
        : undefined;
      inst = { value: produced, refs: 0, dispose };
      this.instances.set(key, inst);
    }
    inst.refs++;
    let released = false;
    return {
      value: inst.value,
      release: () => {
        if (released) return;
        released = true;
        this.release(handle);
      },
    };
  }

  /** 释放一次引用：归零 → dispose + 删除（持久化态随清） */
  release(handle: SlotStoreHandle): void {
    const key = SlotStoreAxis.keyOf(handle);
    const inst = this.instances.get(key);
    if (!inst) return;
    inst.refs--;
    if (inst.refs <= 0) {
      this.instances.delete(key);
      try {
        inst.dispose?.();
      } catch {
        // dispose 失败不阻断回收链（监督面由运行层 onEntryError 记录）
      }
    }
  }

  /** 会话死即清：清空匹配 scopeKey 的全部实例（返回清理数）。 */
  dropScope(scopeKey: string | ((scopeKey: string) => boolean)): number {
    const match = typeof scopeKey === 'string' ? (k: string) => k === scopeKey : scopeKey;
    let dropped = 0;
    for (const [key, inst] of [...this.instances]) {
      const scope = key.split('\u0000')[2];
      if (!match(scope)) continue;
      this.instances.delete(key);
      dropped++;
      try {
        inst.dispose?.();
      } catch {
        /* 同上 */
      }
    }
    return dropped;
  }

  /** 读已有实例（不增引用；诊断/同步读取面） */
  peek(handle: SlotStoreHandle): unknown {
    return this.instances.get(SlotStoreAxis.keyOf(handle))?.value;
  }

  /** 诊断快照：实例键 → 引用计数 */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, inst] of this.instances) out[key] = inst.refs;
    return out;
  }
}
