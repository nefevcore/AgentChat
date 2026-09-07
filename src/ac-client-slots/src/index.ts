// ============================================================
// ac-client-slots —— SlotCore 纯核（M27 S0，D15 首版朴素形态）
//
// 零 cordis 依赖、零框架依赖的 slot 注册表内核（本仓自己的纪律：
// 纯核可独立单测，参照 ac-*-core 纯库族；DSH 0.1.2-rc.1 已将两包
// 并入 renderer/runner，其动机（循环依赖/行政成本）不适用于本仓，
// 维持拆分——见 m27 计划头部参照系注记）。
//
// 首版语义 = Koishi 朴素形态（webui-koishi-console-research §3.1-1）：
//   string key + order + single/list + disabled + 装载校验 + 卸载级联。
//
// **注册面签名从首版起按 D2 终态参数形状设计**（D15）：cell / priority /
// store / children 字段在注册面先占位（S0 存而不选/不建/不嵌），把后续
// 演进收敛为「行为增强而非签名变更」——S1.5 实装 cell 选举与 store 座位。
//
// 语义对照（现行 webui 三注册表 + core/extensions/slots.ts 的延续）：
//   · 同 slot 内同 id 后注册者替换前者（幂等，保持插入位置）；
//   · order 缺省 100，升序，同 order 按注册先后稳定；
//   · 未声明（不在声明账本）的 key 一律拒绝注册——D1 fail-closed 由
//     声明账本 + 装载校验承担（BUILTIN_SLOTS 静态表的退役方向）；
//   · root 单席位纪律（D3）：factory 席位出厂装配封印后拒绝动态注册。
// ============================================================

/** slot 形态（D2 终态词汇；chain 的「逐条消费」语义 S1.5 实装，S0 与 list 同形） */
export type SlotKind = 'single' | 'list' | 'chain';

/** slot 作用域（D2）：root = 应用级；session = 会话作用域（store 座位实例轴用，S1.5） */
export type SlotScope = 'root' | 'session';

/** order 缺省值（slot-tree §5.11：延续 slots.ts/三注册表现行语义） */
export const DEFAULT_SLOT_ORDER = 100;

/** 装载校验错误码（fail-closed 且可诊断） */
export type SlotCoreErrorCode =
  /** 注册到未声明的 slot（先 declare 再 register） */
  | 'UNDECLARED_SLOT'
  /** 出厂席位封印后的动态注册（root 单席位纪律） */
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

/**
 * store 座位工厂（D2 终态签名占位；S1.5 实装：per-entry handle ×
 * scope key 实例化 / 引用计数 / 会话死即清含持久化态）。
 */
export type SlotStoreFactory = (handle: SlotStoreHandle) => unknown;

/** store 座位实例句柄（终态形状占位） */
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
   * 之前）可注册；封印后动态注册一律拒绝——S0/S1 的 root 防线。
   * S1.5 cell 选举生效后升级为「动态注册者恒低优」。
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
   * 替换型移动端行为继承、命令式通道保留、四态回落等；S1.5 类型化
   * 时随声明集承载，S0 仅账本字段）。
   */
  ownerProps?: Record<string, unknown>;
}

/** slot 贡献条目（注册面；含 D15 终态形状占位字段） */
export interface SlotEntry<P extends Record<string, unknown> = Record<string, unknown>> {
  /** 贡献 id（同 slot 内唯一；后注册者替换前者——幂等） */
  id: string;
  /** 贡献组件（框架中立：由渲染器解释——Vue 组件/渲染函数） */
  component: unknown;
  /** 排序轴（缺省 100；升序；同 order 按注册先后稳定） */
  order?: number;
  /** 禁用：布尔或谓词（每次 entries() 读取时评估） */
  disabled?: boolean | (() => boolean);
  /**
   * cell 选举占位（D15：S0 存而不选；S1.5 实装——同 cell 高 priority
   * shadow 低者，single 型无贡献才回落默认插槽）。
   */
  cell?: string;
  /** priority 选举占位（D15：S0 存而不选） */
  priority?: number;
  /** store 座位占位（D15：S0 存而不建；S1.5 实装实例轴） */
  store?: SlotStoreFactory;
  /** 声明式子插口占位（D15：S0 存而不嵌；S1.5 实装 children seat） */
  children?: string[];
  /** 传给贡献组件的 props：对象，或基于 owner data 的工厂（条目 props 优先） */
  props?: P | ((data: unknown) => P);
}

/** 内部存储条目（解析了缺省 order 与注册序） */
interface StoredEntry {
  entry: SlotEntry;
  order: number;
  seq: number;
}

/** 声明账本快照（调试面：snapshot() 返回值） */
export interface SlotCoreSnapshot {
  declarations: SlotDecl[];
  slots: Record<string, SlotEntry[]>;
  factorySealed: boolean;
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
   * 未声明的 key / 出厂封印后的 factory 席位 → 抛 SlotCoreError。
   * 同 id 后注册者替换前者（保持插入位置——order 稳定语义）。
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
    if (decl.factory === true && this.factorySealed) {
      throw new SlotCoreError(
        'FACTORY_SEALED',
        `slot "${key}" 是出厂席位（factory）且出厂装配已封印——动态注册一律拒绝（root 单席位纪律，M27 D3）`,
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
    const stored: StoredEntry = { entry, order: entry.order ?? DEFAULT_SLOT_ORDER, seq: this.seq++ };
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
   * 读取席位条目（disabled 过滤 + order 升序稳定排序）。
   * 读取时评估 disabled 谓词——谓词内部状态变化不触版本计数
   * （与 Koishi 同款限制；可见性门控正交——slot-tree §5.5）。
   */
  entries(key: string): readonly SlotEntry[] {
    if (!this.decls.has(key)) return [];
    const list = (this.slots.get(key) ?? [])
      .filter((s) => {
        const d = s.entry.disabled;
        return typeof d === 'function' ? !d() : !d;
      })
      .sort((a, b) => a.order - b.order || a.seq - b.seq);
    return list.map((s) => s.entry);
  }

  /**
   * single 型解析：首条（最低 order）贡献，无贡献 → undefined。
   * 「未填充回落宿主默认渲染」由渲染面的默认插槽承担（D16-②）——
   * 核只回答「有没有贡献」。
   */
  single(key: string): SlotEntry | undefined {
    return this.entries(key)[0];
  }

  /** 席位版本计数（key 级细粒度失效轴——D14；声明/注册/撤销均递增） */
  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  /**
   * 出厂装配封印（D3）：此后 factory 席位的动态注册一律拒绝。
   * 由装配序列在「基础插件集合装配完成」之后调用（main.ts 装配序列）。
   */
  sealFactory(): void {
    this.factorySealed = true;
  }

  /** 封印状态（诊断面） */
  get sealed(): boolean {
    return this.factorySealed;
  }

  /** 声明账本 + 各席位贡献快照（调试面：snapshot 调试面的数据源） */
  snapshot(): SlotCoreSnapshot {
    const slots: Record<string, SlotEntry[]> = {};
    for (const [key, list] of this.slots) slots[key] = list.map((s) => s.entry);
    return {
      declarations: [...this.decls.values()].map((d) => ({ ...d })),
      slots,
      factorySealed: this.factorySealed,
    };
  }

  private touch(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
}
