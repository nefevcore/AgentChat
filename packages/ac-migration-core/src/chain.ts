// ============================================================
// chain.ts —— 迁移链核心（cr-1036 / docs/design/assembly/migration-chain-completeness.md）
//
// 版本化持久形态的换轨器统一组织：每个形态注册一条链
//   edges: { from, to, migrate }[]
// 新增换档 = 注册新边（一次性 migrate 脚本禁令）；完备性由校验器静态
// 保证——注册时即红，不待运行。DSH CompiledSessionFormatChain 先例的
// 链立法照搬（单开发者仓库不需要四代独立包）。
//
// 四断言：
//   1. 严格相邻：to === from + 1；
//   2. from 无重复：同一起点两条边 = 注册错误；
//   3. 链完整：v0..current 每环都在，缺环 fail-loud 列名；
//   4. 未来拒绝：输入版本 > current → 显式报错，绝不静默降级读。
//
// 纯函数：无身份、无 fs、零 cordis 依赖。migrate 边为纯函数（旧形态值
// → 新形态值），不可迁显式抛错报告（纯库不猜降级语义，调用方决定）。
// ============================================================

/** 迁移边（一条 = 一次换档）：from → to 逐边应用纯函数 */
export interface MigrationEdge<T> {
  /** 起始版本（≥ 0 整数） */
  from: number;
  /** 目标版本（断言 1：恒 = from + 1） */
  to: number;
  /** 换档函数（旧形态值 → 新形态值——可判定无损，或显式抛错报告不可迁） */
  migrate: (value: T) => T;
}

/** 版本化形态值（stored 侧——版本与形态值本体） */
export interface VersionedValue<T> {
  version: number;
  value: T;
}

/** 链完备性违规（fail-loud——列名断言与违规边） */
export interface ChainIntegrityError {
  /** 违反的断言：adjacent 严格相邻 / duplicate 起点重复 / complete 缺环 */
  assertion: 'adjacent' | 'duplicate' | 'complete';
  /** 人类可读描述（列名 from→to 与断言语义） */
  message: string;
}

/** 单条边的应用记录（逐边可审计——notice 报告每边换档结果） */
export interface EdgeReport {
  from: number;
  to: number;
}

/** 链当前版本（结构合法边的最大 to；空链 = v0 起点形态） */
export function chainCurrent<T>(chain: MigrationEdge<T>[]): number {
  return Math.max(0, ...chain.map((e) => e.to));
}

// —— 校验器（注册时即红） ——

/** 边结构断言（断言 1）：from ≥ 0 整数且 to = from + 1，否则列名 */
function adjacentError<T>(edge: MigrationEdge<T>): ChainIntegrityError | null {
  if (!Number.isInteger(edge.from) || edge.from < 0
    || !Number.isInteger(edge.to) || edge.to !== edge.from + 1) {
    return {
      assertion: 'adjacent',
      message: '边不严格相邻（to 必须 = from + 1，from ≥ 0 整数）：'
        + edge.from + '→' + edge.to,
    };
  }
  return null;
}

/** 四断言完备性校验：返回全部违规（空数组 = 链完备可执行）。
 * 断言 1/2 逐边可判（结构非法与起点重复的边不进有效集）；断言 3 对
 * 有效集的 v0..current-1 逐起点扫缺环——有效集为空时无完整面可扫，
 * 恒过（空链 = v0 起点形态的合法退化）。 */
export function validateChain<T>(edges: MigrationEdge<T>[]): ChainIntegrityError[] {
  const errors: ChainIntegrityError[] = [];
  const byFrom = new Map<number, MigrationEdge<T>>();
  for (const edge of edges) {
    const structural = adjacentError(edge);
    if (structural !== null) { errors.push(structural); continue; }
    const hit = byFrom.get(edge.from);
    if (hit !== undefined) {
      errors.push({
        assertion: 'duplicate',
        message: 'from 起点重复（同一起点两条边 = 注册错误）：v' + hit.from
          + '→v' + hit.to + ' 与 v' + edge.from + '→v' + edge.to,
      });
      continue;
    }
    byFrom.set(edge.from, edge);
  }
  for (let v = 0; v < chainCurrent([...byFrom.values()]); v++) {
    if (!byFrom.has(v)) {
      errors.push({
        assertion: 'complete',
        message: '链缺环（v0..current 每环必须在场，缺环 fail-loud）：v'
          + v + '→v' + (v + 1) + ' 边未注册',
      });
    }
  }
  return errors;
}

/** 注册面断言（注册时即红）：链不完备即抛——形态链声明处模块加载期调用，
 * 违规边一次列名。 */
export function assertChainIntegrity<T>(form: string, chain: MigrationEdge<T>[]): void {
  const errors = validateChain(chain);
  if (errors.length > 0) {
    throw new Error('迁移链不完备（' + form + '）：' + errors.map((e) => e.message).join('；'));
  }
}

// —— 执行语义 ——

/** 现算剩余边序列（storedVersion → current 的逐边计划，按 from 升序）。
 * 断言 4 前置：storedVersion > current = 未来版本（新数据旧代码），显式
 * 抛错拒绝降级读；链不完备同样抛（运行时兜底——与注册时即红双保险）。 */
export function planChain<T>(
  chain: MigrationEdge<T>[],
  storedVersion: number,
): MigrationEdge<T>[] {
  const errors = validateChain(chain);
  if (errors.length > 0) {
    throw new Error('迁移链不完备（拒绝执行）：' + errors.map((e) => e.message).join('；'));
  }
  if (!Number.isInteger(storedVersion) || storedVersion < 0) {
    throw new Error('存量版本非法（须 ≥ 0 整数）：' + storedVersion);
  }
  const current = chainCurrent(chain);
  if (storedVersion > current) {
    throw new Error(
      '未来版本拒绝降级读：stored v' + storedVersion + ' > current v' + current
      + '（新数据旧代码——请升级软件后重试）',
    );
  }
  return chain
    .filter((e) => e.from >= storedVersion)
    .sort((a, b) => a.from - b.from);
}

/** 逐边应用（审计面：reports 逐边记录换档，notice 由此生成）。
 * migrate 抛错 = 该值不可迁（显式报告，纯库不猜降级语义）。 */
export function runChain<T>(
  chain: MigrationEdge<T>[],
  stored: VersionedValue<T>,
): { value: T; version: number; reports: EdgeReport[] } {
  const plan = planChain(chain, stored.version);
  const reports: EdgeReport[] = [];
  let value = stored.value;
  let version = stored.version;
  for (const edge of plan) {
    value = edge.migrate(value);
    version = edge.to;
    reports.push({ from: edge.from, to: edge.to });
  }
  return { value, version, reports };
}
