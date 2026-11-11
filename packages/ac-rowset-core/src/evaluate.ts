// ============================================================
// evaluate.ts —— 装配合成求值引擎（cr-1004 / docs/design/assembly/agent-assembly.md）
//
// 两段式、一个引擎（每进程种类同形）：
//   存在合成（无差量语义——并集）：
//     rows = <base>.yml 基座行 ∪ fit(installed.yml × 本基座 face)
//   差量合成（逐层 delta，外层剔除内层不可见）：
//     ← <base>.patch.yml      # 用户全局差量（disabled/except/replace——
//                              #   replace 由调用方先行换向解析，引擎纯函数）
//       ← agent.patch.yml     # 实例差量（加法/disabled/config——仅多实例基座）
//
// 纯函数：无身份、无权限判断、无 fs。词汇表里没有「Agent」——身份层
// 知道代数（单向依赖）。席位护栏（恒并基座席位停用拒绝）是管控策略
// （assembly-governance.md §四），经 seatIds 注入——代数不为策略改形状。
//
// 代数（§四）：
//   基础集 = 基座非捆绑行（恒并席位天然在内——特判消解）
//     ∪ fit(installed)
//     ∪ 各 patch 层加法展开（byRow / byTool / byBundle——词形单源）
//   → requires 闭包（依赖行递归并入——先于减法：用户减法不被闭包复活）
//   − 各 patch 层减法（disabled；闭包后执行——显式排除 = 良定义降级）
//   → 静态断言（fail-loud 契约，boot 消费）
// ============================================================

import type { RowDescriptor } from './rowset.ts';

/** 差量层条目（<base>.patch.yml / agent.patch.yml 全层共用一套词形，
 * cordis 方言邻接；层权限表在 assembly-governance.md §一） */
export interface AssemblyEntry {
  /** 行 id / 工具名 / 捆绑词（消歧：行名优先——声明面单位是行） */
  id: string;
  /** 减法（显式排除 = 良定义降级） */
  disabled?: boolean;
  /** 停用豁免（仅随 disabled；用户全局层专属否决权词汇） */
  except?: string[];
  /** 行内配置（cordis 方言原生——levels 机制归位于此） */
  config?: Record<string, unknown>;
}

/** 求值结果 */
export interface Evaluation {
  /** 装配行 id 清单（排序稳定） */
  rowIds: string[];
  /** 本行集内可见工具名全集 */
  toolNames: string[];
  /** 终态行描述符全集（装配寻址 / 指纹 / 插件行注册面消费） */
  rows: RowDescriptor[];
  /** 行内配置合成（行 id → config；外层覆盖内层同名键） */
  rowConfigs: Record<string, Record<string, unknown>>;
  /** 派生警告（fail-loud 面：boot 断言消费——点名未命中/求值矛盾） */
  warnings: string[];
  /** 派生通知（fail-soft 面：boot stderr 消费——席位护栏拒绝/用户层
   * 词形未命中/installed 撞名丢弃等降级语义，不阻断 boot） */
  notices: string[];
  /** 求值矛盾（实例层点名被用户层停用且无豁免——非静默丢面，boot 必炸） */
  errors: string[];
}

/** 求值输入（replace 已由调用方解析换向——引擎不见 fs） */
export interface EvaluateInput {
  /** 本基座行全集（<base>.yml 投影——存在合成第一段） */
  base: RowDescriptor[];
  /** fit(installed.yml × 本基座 face) 结果（存在合成第二段；撞基座名丢弃） */
  installed?: RowDescriptor[];
  /** 用户全局差量（<base>.patch.yml） */
  userPatch?: AssemblyEntry[];
  /** 实例差量（agent.patch.yml——仅多实例基座） */
  agentPatch?: AssemblyEntry[];
  /** except 豁免判定锚（实例层身份） */
  agentId?: string;
  /** 恒并基座席位（停用拒绝生效的管控策略注入——防「能 boot 缺收信面」） */
  seatIds?: readonly string[];
}

/** 统一求值（§二 evaluate(base, installed, patches) → composition） */
export function evaluateAssembly(input: EvaluateInput): Evaluation {
  const warnings: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  // —— 存在合成：基座 ∪ fit(installed)（撞基座名丢弃——保留字护栏） ——
  const universe = new Map<string, RowDescriptor>();
  for (const row of input.base) universe.set(row.id, row);
  for (const row of input.installed ?? []) {
    if (universe.has(row.id)) {
      notices.push('installed 行与基座行撞名，已丢弃：' + row.id);
      continue;
    }
    universe.set(row.id, row);
  }
  const byRow = new Map(universe);
  const byTool = new Map<string, RowDescriptor>();
  const byBundle = new Map<string, RowDescriptor[]>();
  for (const row of universe.values()) {
    if (row.bundle !== undefined) {
      const list = byBundle.get(row.bundle);
      if (list) list.push(row);
      else byBundle.set(row.bundle, [row]);
    }
    for (const t of row.tools ?? []) byTool.set(t, row);
  }
  const expandToken = (token: string): RowDescriptor[] | undefined => {
    // 行名优先于工具名（声明面单位是行——工具名与行名同名时点名指行）
    const row = byRow.get(token) ?? byTool.get(token);
    if (row !== undefined) return [row];
    return byBundle.get(token);
  };
  // —— 差量合成：逐层（内 → 外：用户全局 → 实例） ——
  const picked = new Set<RowDescriptor>();
  // 基础集 = 非捆绑行（恒并席位天然在内）
  for (const row of universe.values()) {
    if (row.bundle === undefined) picked.add(row);
  }
  const rowConfigs: Record<string, Record<string, unknown>> = {};
  const applyConfig = (entry: AssemblyEntry, layer: string): void => {
    if (entry.config === undefined) return;
    for (const row of expandToken(entry.id) ?? []) {
      rowConfigs[row.id] = { ...rowConfigs[row.id], ...entry.config };
    }
    if (expandToken(entry.id) === undefined) {
      notices.push(layer + ' config 条目未命中目录：' + entry.id);
    }
  };
  /** 用户层停用面：行 id → 是否豁免（agentId 命中 except = 保留） */
  const userDisabled = new Map<string, boolean>(); // true = 停用生效
  const seatIds = input.seatIds ?? [];
  const layerName = (kind: 'user' | 'agent'): string =>
    kind === 'user' ? '<base>.patch.yml' : 'agent.patch.yml';
  // —— 内层：用户全局差量 ——
  for (const entry of input.userPatch ?? []) {
    if (entry.disabled === true) {
      const rows = expandToken(entry.id) ?? [];
      if (rows.length === 0) {
        notices.push('disable 点名不在基座菜单（跳过）：' + entry.id);
        continue;
      }
      const exceptSet = new Set(entry.except ?? []);
      for (const row of rows) {
        const exempted = input.agentId !== undefined && exceptSet.has(input.agentId);
        if (seatIds.includes(row.id)) {
          // 席位护栏（管控策略注入）：停用拒绝生效——换实现请用 replace
          notices.push(row.id + '：恒并基座席位不可停用（拒绝生效——防静默半激活；换实现请用 replace）');
          userDisabled.set(row.id, false);
          continue;
        }
        userDisabled.set(row.id, !exempted);
      }
      continue;
    }
    const rows = expandToken(entry.id);
    if (rows === undefined) {
      notices.push(layerName('user') + ' 条目未命中目录：' + entry.id);
      continue;
    }
    for (const row of rows) picked.add(row);
    applyConfig(entry, layerName('user'));
  }
  /** 外层（实例层）停用面：闭包后统一执行（减法不被闭包复活） */
  const agentDisabled = new Set<string>();
  // —— 外层：实例差量（外层剔除内层不可见） ——
  for (const entry of input.agentPatch ?? []) {
    if (entry.disabled === true) {
      const rows = expandToken(entry.id) ?? [];
      if (rows.length === 0) {
        notices.push('disable 点名不在基座菜单（跳过）：' + entry.id);
        continue;
      }
      for (const row of rows) {
        if (seatIds.includes(row.id)) {
          notices.push(row.id + '：恒并基座席位不可停用（拒绝生效——防静默半激活；换实现请用 replace）');
          continue;
        }
        agentDisabled.add(row.id);
      }
      continue;
    }
    const rows = expandToken(entry.id);
    if (rows === undefined) {
      warnings.push(layerName('agent') + ' 条目未命中目录：' + entry.id);
      continue;
    }
    for (const row of rows) {
      // 实例层点名被用户层停用且无豁免 = 求值 fail-loud（点名不可见行，
      // 非静默丢面——§二）
      if (userDisabled.get(row.id) === true) {
        errors.push('实例层点名行 ' + row.id + ' 已被用户全局层停用且无豁免——fail-loud（豁免词形：except）');
        continue;
      }
      picked.add(row);
    }
    applyConfig(entry, layerName('agent'));
  }
  // —— requires 闭包（依赖行递归并入——先于减法：减法不被闭包复活） ——
  expandRequires(picked, byRow);
  // —— 减法（闭包后执行——显式排除 = 良定义降级） ——
  for (const id of agentDisabled) {
    const row = byRow.get(id);
    if (row !== undefined) picked.delete(row);
  }
  for (const [id, effective] of userDisabled) {
    if (effective) {
      const row = byRow.get(id);
      if (row !== undefined) picked.delete(row);
    }
  }
  return finalize(picked, rowConfigs, warnings, notices, errors);
}

/** 行集闭包：picked 行的 requires 依赖行递归并入。引用目录外 id 忽略——
 * 词表自洽由 catalog 对账测试锁定。 */
function expandRequires(picked: Set<RowDescriptor>, byRow: Map<string, RowDescriptor>): void {
  const queue = [...picked];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const req of current.requires ?? []) {
      const dep = byRow.get(req);
      if (dep === undefined || picked.has(dep)) continue;
      picked.add(dep);
      queue.push(dep);
    }
  }
}

function finalize(
  picked: Set<RowDescriptor>,
  rowConfigs: Record<string, Record<string, unknown>>,
  warnings: string[],
  notices: string[],
  errors: string[],
): Evaluation {
  const rows = [...picked].sort((a, b) => (a.id < b.id ? -1 : 1));
  const tools = new Set<string>();
  for (const r of rows) for (const t of r.tools ?? []) tools.add(t);
  const configs: Record<string, Record<string, unknown>> = {};
  const pickedIds = new Set(rows.map((r) => r.id));
  for (const [id, cfg] of Object.entries(rowConfigs)) {
    if (pickedIds.has(id)) configs[id] = cfg;
  }
  return {
    rowIds: rows.map((r) => r.id),
    toolNames: [...tools].sort(),
    rows,
    rowConfigs: configs,
    warnings,
    notices,
    errors,
  };
}

/**
 * 存量 rows 绝对清单 → 实例差量（cr-1004 §七 确定性转换的读侧桥——
 * agent.patch.yml 差量化（批2）落地并由 migrate 脚本迁移存量后退役）：
 *   加法 = T − B（点名 expansions 不在基础集内的 token）
 *   减法 = B − T（基础集行未被点名覆盖 → disabled 条目）
 * 与迁移公式同源（B = 基础集、T = 展开后的点名集），幂等可逆。
 */
export function legacyRowsToAgentPatch(
  rows: string[] | { include?: string[]; exclude?: string[] } | undefined,
  base: RowDescriptor[],
  installed: RowDescriptor[],
  seatIds: readonly string[] = [],
): AssemblyEntry[] {
  if (rows === undefined) return [];
  const universe = new Map<string, RowDescriptor>();
  for (const row of [...base, ...installed]) universe.set(row.id, row);
  const byTool = new Map<string, RowDescriptor>();
  const byBundle = new Map<string, RowDescriptor[]>();
  for (const row of universe.values()) {
    if (row.bundle !== undefined) {
      const list = byBundle.get(row.bundle);
      if (list) list.push(row);
      else byBundle.set(row.bundle, [row]);
    }
    for (const t of row.tools ?? []) byTool.set(t, row);
  }
  const expandToken = (token: string): Set<RowDescriptor> => {
    const row = universe.get(token) ?? byTool.get(token);
    if (row !== undefined) return new Set([row]);
    const bundle = byBundle.get(token);
    return bundle !== undefined ? new Set(bundle) : new Set();
  };
  const baseSet = new Set([...universe.values()].filter((r) => r.bundle === undefined));
  const entries: AssemblyEntry[] = [];
  // 两种形态统一收敛为「点名清单 T」（旧语义逐位对齐）：
  //   数组 = 点名白名单；{include} = 白名单（缺席 = 全集〔无 B−T 减法〕）；
  //   {exclude} = 在白名单结果上做减法
  const tokens = Array.isArray(rows) ? rows : rows.include;
  const excludes = Array.isArray(rows) ? [] : rows.exclude ?? [];
  for (const token of tokens ?? []) {
    // cr-1007 §六 精简：expansion 完全落入基础集的加法是 no-op（基础集恒在
    // picked）——不落条目；未命中 token 与捆绑/installed 词保留（后者是真差量，
    // 前者由引擎 warning 面 fail-loud）
    const hit = expandToken(token);
    if (hit.size > 0 && [...hit].every((r) => baseSet.has(r))) continue;
    entries.push({ id: token });
  }
  if (tokens !== undefined) {
    // T = 恒并席位 ∪ expansions 的 requires 闭包（点名 ≠ 裁基座——席位
    // 恒并；依赖行随点名并入，与旧 deriveShellRowset 语义逐位对齐）
    const target = new Set<RowDescriptor>(
      [...universe.values()].filter((r) => seatIds.includes(r.id)),
    );
    const queue: RowDescriptor[] = [...target]; // 席位依赖同样入闭包（旧语义：seats 先入 picked 再统一闭包）
    for (const token of tokens) {
      for (const row of expandToken(token)) {
        if (!target.has(row)) {
          target.add(row);
          queue.push(row);
        }
      }
    }
    while (queue.length > 0) {
      for (const req of queue.pop()!.requires ?? []) {
        const dep = universe.get(req);
        if (dep === undefined || target.has(dep)) continue;
        target.add(dep);
        queue.push(dep);
      }
    }
    for (const row of baseSet) {
      if (!target.has(row)) entries.push({ id: row.id, disabled: true }); // B − T
    }
  }
  for (const token of excludes) {
    entries.push({ id: token, disabled: true });
  }
  return entries;
}



/**
 * 差量瘦身（cr-1007 §六）：滤除「expansion 完全落入基础集且无 config」的
 * no-op 加法条目——与基线一致 = 删条目。disabled / config / 捆绑与
 * installed 加法 / 未命中 token（fail-loud 面）原样保留。语义保持：对
 * 同一基础集求值结果逐位一致。
 */
export function slimAssemblyEntries(
  entries: AssemblyEntry[],
  base: RowDescriptor[],
  installed: RowDescriptor[] = [],
): AssemblyEntry[] {
  const universe = new Map<string, RowDescriptor>();
  for (const row of [...base, ...installed]) universe.set(row.id, row);
  const byTool = new Map<string, RowDescriptor>();
  const byBundle = new Map<string, RowDescriptor[]>();
  for (const row of universe.values()) {
    if (row.bundle !== undefined) {
      const list = byBundle.get(row.bundle);
      if (list) list.push(row);
      else byBundle.set(row.bundle, [row]);
    }
    for (const t of row.tools ?? []) byTool.set(t, row);
  }
  const baseSet = new Set([...universe.values()].filter((r) => r.bundle === undefined));
  return entries.filter((e) => {
    if (e.disabled === true || e.config !== undefined) return true;
    const row = universe.get(e.id) ?? byTool.get(e.id);
    if (row !== undefined) return !baseSet.has(row);
    const bundle = byBundle.get(e.id);
    if (bundle !== undefined) return !bundle.every((r) => baseSet.has(r));
    return true; // 未命中 token——fail-loud 面保留
  });
}

/**
 * 存量 rows 绝对清单求值便捷面（cr-1004 读侧桥——批2 差量化迁移后随
 * legacyRowsToAgentPatch 一并退役）：内部走确定性转换 + 统一引擎，
 * 与 shell boot 装配链同语义（消费方：subagent 授权投影 / 形态合成）。
 */
export function evaluateLegacyShellRows(
  rows: string[] | { include?: string[]; exclude?: string[] } | undefined,
  base: RowDescriptor[],
  installed: RowDescriptor[],
  seatIds: readonly string[],
): Evaluation {
  return evaluateAssembly({
    base,
    installed,
    agentPatch: legacyRowsToAgentPatch(rows, base, installed, seatIds),
    seatIds,
  });
}

/** 词展开纯函数（点名 token → 行集；requires 闭包随行）——spawn 工具词
 * 过滤等「单 token 命中判定」消费面（不涉差量层） */
export function expandAssemblyTokens(
  tokens: string[],
  base: RowDescriptor[],
  installed: RowDescriptor[] = [],
): { rowIds: string[]; warnings: string[] } {
  const universe = new Map<string, RowDescriptor>();
  for (const row of [...base, ...installed]) universe.set(row.id, row);
  const byTool = new Map<string, RowDescriptor>();
  const byBundle = new Map<string, RowDescriptor[]>();
  for (const row of universe.values()) {
    if (row.bundle !== undefined) {
      const list = byBundle.get(row.bundle);
      if (list) list.push(row);
      else byBundle.set(row.bundle, [row]);
    }
    for (const t of row.tools ?? []) byTool.set(t, row);
  }
  const picked = new Set<RowDescriptor>();
  const warnings: string[] = [];
  for (const token of tokens) {
    const row = universe.get(token) ?? byTool.get(token);
    if (row !== undefined) {
      picked.add(row);
      continue;
    }
    const bundle = byBundle.get(token);
    if (bundle !== undefined) {
      for (const r of bundle) picked.add(r);
      continue;
    }
    warnings.push('条目未命中目录：' + token);
  }
  expandRequires(picked, universe);
  const rows = [...picked].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { rowIds: rows.map((r) => r.id), warnings };
}
