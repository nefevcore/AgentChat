// ============================================================
// rowset.ts —— 行集目录 schema + 宿主行集派生（M2.3；cr-1004 起壳行集
// 派生全域归一 evaluate.ts 求值引擎——本文件只剩目录词汇与宿主单例面）
//
// cordis.yml 已降格为全集目录（静态数据——装载态运行时再定）；tag 词汇
// 全链退役，fs/infra 类捆绑词在求值内消解。
// ============================================================

import { evaluateAssembly, type AssemblyEntry } from './evaluate.ts';

// 求值引擎词汇经本模块转出口（单点入口消费面——tests / boot 直读 rowset.ts）
export { evaluateAssembly, evaluateLegacyShellRows, expandAssemblyTokens, legacyRowsToAgentPatch, slimAssemblyEntries } from './evaluate.ts';
export type { AssemblyEntry, Evaluation, EvaluateInput } from './evaluate.ts';

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

/**
 * 恒并基座席位（壳基座非捆绑行 = 天然基础集成员——cr-1004 统一引擎后
 * 席位特判消解，本表只剩管控护栏语义：停用拒绝生效、替换放行）。
 * 单源：evaluate seatIds 注入与 shell 装配面共用。
 */
export const SEAT_ROW_IDS: readonly string[] = [
  'conversation', 'persona', 'conduct', 'llm-pool', 'auto-title', 'host-face-client',
];

// —— 宿主行集派生（偏好文件——宿主单例无实例差量层） ——

/** 宿主行集偏好条目（数据根 host-rows.json；形状 {id, disabled} 沿用） */
export interface HostRowPreference {
  id: string;
  disabled?: boolean;
}

/**
 * 宿主行集派生：目录 host 行 − disabled 集（宿主基座无捆绑行——基础集
 * = host 行全集，与引擎语义一致）。偏好未提及的行默认装载（偏好文件只
 * 记差异——恒冷生效，无热通道）。
 */
export function deriveHostRowset(
  preferences: HostRowPreference[],
  catalog: RowsetCatalog,
): { rowIds: string[]; toolNames: string[]; warnings: string[] } {
  const hostRows = catalog.rows.filter((r) => r.tree === 'host');
  const warnings: string[] = [];
  const hostIds = new Set(hostRows.map((r) => r.id));
  const disabledPrefs: HostRowPreference[] = [];
  for (const p of preferences) {
    if (!hostIds.has(p.id)) {
      warnings.push('偏好条目非宿主行：' + p.id);
      continue;
    }
    if (p.disabled === true) disabledPrefs.push(p);
  }
  const userPatch: AssemblyEntry[] = disabledPrefs.map((p) => ({ id: p.id, disabled: true as const }));
  const ev = evaluateAssembly({ base: hostRows, userPatch });
  return { rowIds: ev.rowIds, toolNames: ev.toolNames, warnings: [...warnings, ...ev.warnings] };
}
