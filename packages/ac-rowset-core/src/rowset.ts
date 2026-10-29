// ============================================================
// rowset.ts —— 行集推导器（M2.3；行集清单 R3.2 + 裁决簿〈tag 机制解体〉）
//
// 行集派生全域单一（A9）：
//   壳   = AgentConfig（tools 点名 ∨ 行引用）× 全局行集目录 → 派生清单
//   宿主 = 偏好文件 {id, disabled} × 目录全集 → 派生清单
// cordis.yml 降格为全集目录（静态数据——装载态运行时再定）；tag 词汇
// 全链退役，fs/infra 类捆绑词在派生内消解。
// ============================================================

// —— 目录 schema（cordis.yml 终态：全集目录，非装配清单） ——

/** 目录内一行（静态描述——装载 = 授权动作，运行态不进目录） */
export interface RowDescriptor {
  /** 稳定行 id（= cordis 插件 id；宿主行与壳行同命名域） */
  id: string;
  /** 树归属：host = 宿主树行；shell = 壳树行 */
  tree: 'host' | 'shell';
  /** 行提供的工具名清单（工具面行非空；服务行空） */
  tools?: string[];
  /** 捆绑词（fs / infra 类——声明引用时按组消解） */
  bundle?: string;
  /** 行包目录（相对仓库根——已实现行单源；指纹与快照按此寻址行内容）。
   * 一行跨多包（如 fs-tools 并入 file-snapshots）= 数组全集——指纹盖住
   * 生效面的全部行内容，缺一即「改了快照行不换指纹」的对拍漏洞。 */
  path?: string | string[];
  /** 硬依赖行 id 清单（cordis inject 的行集投影）：点名该行时依赖行经
   *  行集闭包自动并入（cr-521）——装配满足性在派生层断根，不靠装配序；
   *  垫片服务（agents/agentStore/workspace/credentials）非行集行，不标注。 */
  requires?: string[];
  /** 一句话描述（目录的人类可读面） */
  description?: string;
}

/** 全局行集目录（静态全集——两树同源单表） */
export interface RowsetCatalog {
  rows: RowDescriptor[];
}

// —— 壳行集派生（AgentConfig × 目录） ——

export interface DerivedRowset {
  /** 装配行 id 清单（排序稳定） */
  rowIds: string[];
  /** 本行集内可见工具名全集（工具点名与行引用的并集展开） */
  toolNames: string[];
  /** 派生警告（fail-loud 面：boot 断言消费） */
  warnings: string[];
}

/**
 * 壳行集派生：AgentConfig.rows（点名工具 ∨ 引用行）× 目录。
 *   · rows 缺省 → 基础壳行集（目录内 tree=shell 且基础=true 的行）
 *   · 条目词形：精确工具名（目录 tools 命中）∨ 行 id（目录 rows 命中）
 *     ∨ 捆绑词（bundle 命中——展开为组内全部行）
 *   · exclude 减法在展开后的行集上执行（工具级减法 = 移除提供行）
 * 未命中条目 → warnings（行集静态断言面，boot fail-loud）
 * ◐b cr-691：入参字段名随 AgentConfig 更名 tools→rows（旧 tools 键由
 * readAgentConfig 归一，本函数只认 rows）。
 */
export function deriveShellRowset(
  config: { rows?: string[] | { include?: string[]; exclude?: string[] } },
  catalog: RowsetCatalog,
): DerivedRowset {
  const byTool = new Map<string, RowDescriptor>();
  const byRow = new Map<string, RowDescriptor>();
  const byBundle = new Map<string, RowDescriptor[]>();
  const baseRows: RowDescriptor[] = [];
  for (const row of catalog.rows) {
    if (row.tree !== 'shell') continue;
    byRow.set(row.id, row);
    if (row.bundle !== undefined) {
      const list = byBundle.get(row.bundle);
      if (list) list.push(row);
      else byBundle.set(row.bundle, [row]);
    } else {
      baseRows.push(row);
    }
    for (const t of row.tools ?? []) byTool.set(t, row);
  }
  const warnings: string[] = [];
  let picked = new Set<RowDescriptor>();
  const entries = config.rows === undefined || Array.isArray(config.rows)
    ? (config.rows as string[] | undefined) ?? null
    : config.rows.include ?? null;
  if (entries === null) {
    picked = new Set(baseRows); // 缺省 = 基础壳行集（非捆绑行）
  } else {
    // 装配基座恒并（cr-548 会话基座 + cr-602 提示装配行 + cr-610 池注册行）：
    // 点名形态恒含 conversation（收信面——「点名 ≠ 裁基座」，消灭能 boot 不能
    // 收信的静默半激活）、persona / system-prompt（提示装配组成件——主线形态
    // 两行全局恒装，per-agent 差异走 settings 软停用，如极简模式
    // settings['system-prompt'].enabled=false；行缺席面 = 导入行集按工具
    // 标签快照推导，装配类行不在标签面 → 全体导入 Agent 的人格与指引块
    // 静默丢失）与 llm-pool（池注册行——主线全局恒装行；无 requires 指向、
    // 不在工具标签面 → 点名形态壳内零 provider 注册 = 一切 run NO_PROVIDER）。
    // cr-672 auto-title（会话命名）同款恒并：无 tools、无 requires 指向、
    // 不在工具标签面——不恒并则点名形态壳内零命名 = 会话标题退回首行截断。
    // 用户显式 exclude 由闭包后减法执行（显式排除 = 良定义
    // 降级，boot 装配终检兜底矛盾）。
    for (const seatId of ['conversation', 'persona', 'system-prompt', 'llm-pool', 'auto-title']) {
      const seatRow = byRow.get(seatId);
      if (seatRow !== undefined) picked.add(seatRow);
    }
    for (const token of entries) {
      // 行名优先于工具名（M8.3 词形消歧：工具名与行名同名时点名指行——
      // 声明面单位是行〔A10〕；如 'subagent' 指域服务行而非 harness 同名工具）
      const row = byRow.get(token) ?? byTool.get(token);
      if (row !== undefined) {
        picked.add(row);
        continue;
      }
      const bundle = byBundle.get(token);
      if (bundle !== undefined) {
        for (const r of bundle) picked.add(r);
        continue;
      }
      warnings.push(`tools 条目未命中目录：${token}`);
    }
  }
  // 行集闭包（cr-521）：依赖行并入先于 exclude——用户减法不被闭包复活；
  // 显式排除依赖行的矛盾由 boot 装配终检 fail-loud（PENDING 拦截）。
  expandRequires(picked, byRow);
  // exclude 减法（工具级 = 移除其提供行；行级 = 移除行）
  const excludes = config.rows !== undefined && !Array.isArray(config.rows)
    ? config.rows.exclude ?? []
    : [];
  for (const token of excludes) {
    const row = byRow.get(token) ?? byTool.get(token);
    if (row !== undefined) {
      picked.delete(row);
      continue;
    }
    const bundle = byBundle.get(token);
    if (bundle !== undefined) {
      for (const r of bundle) picked.delete(r);
      continue;
    }
    warnings.push(`exclude 条目未命中目录：${token}`);
  }
  return finalize(picked, warnings);
}

/** 行集闭包：picked 行的 requires 依赖行递归并入（依赖行自身的 requires
 * 同样展开）。引用目录外 id 忽略——词表自洽由 catalog 对账测试锁定。 */
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

function finalize(picked: Set<RowDescriptor>, warnings: string[]): DerivedRowset {
  const rows = [...picked].sort((a, b) => (a.id < b.id ? -1 : 1));
  const tools = new Set<string>();
  for (const r of rows) for (const t of r.tools ?? []) tools.add(t);
  return {
    rowIds: rows.map((r) => r.id),
    toolNames: [...tools].sort(),
    warnings,
  };
}

// —— 行目录静态投影（per-agent 化——目录只出现该 agent 行集内的词） ——

/**
 * 行目录静态投影：只保留 picked 行集内的行与工具词（编辑面与壳存活期
 * 解耦——目录不随壳生死变化，投影随行集窄化）。
 */
export function projectCatalog(catalog: RowsetCatalog, picked: ReadonlySet<string>): RowsetCatalog {
  return {
    rows: catalog.rows
      .filter((r) => picked.has(r.id))
      .map((r) => ({ ...r, tools: r.tools !== undefined ? [...r.tools] : undefined })),
  };
}

// —— 宿主行集派生（偏好文件） ——

/** 宿主行集偏好条目（数据根 host-rows.json；形状 {id, disabled} 沿用） */
export interface HostRowPreference {
  id: string;
  disabled?: boolean;
}

/**
 * 宿主行集派生：目录 host 行 − disabled 集。偏好未提及的行默认装载
 *（偏好文件只记差异——恒冷生效，无热通道）。
 */
export function deriveHostRowset(
  preferences: HostRowPreference[],
  catalog: RowsetCatalog,
): DerivedRowset {
  const disabled = new Set(
    preferences.filter((p) => p.disabled).map((p) => p.id),
  );
  const warnings: string[] = [];
  const hostIds = new Set(catalog.rows.filter((r) => r.tree === 'host').map((r) => r.id));
  for (const p of preferences) {
    if (!hostIds.has(p.id)) warnings.push(`偏好条目非宿主行：${p.id}`);
  }
  const picked = catalog.rows.filter((r) => r.tree === 'host' && !disabled.has(r.id));
  return finalize(new Set(picked), warnings);
}
