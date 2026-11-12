// ============================================================
// rowset.ts —— 行集目录 schema + 宿主行集派生（M2.3；cr-1022 批2 起
// 求值全域归一 menu.ts 菜单合成——本文件只剩目录词汇与宿主单例面）
//
// 行文档词汇 = 选择与身份（cr-1025 白名单）：id/name/requires/config——
// tools/packs/bundle 派生词全数退役（工具目录 dump 生成、包足迹依赖
// 闭包——批3）。分区归属由基座文档所在区隐含，投影经 zone 透出。
// ============================================================

import type { AssemblyEntry } from './custom-layer.ts';

/** 目录内一行（静态描述——装载 = 授权动作，运行态不进目录） */
export interface RowDescriptor {
  /** 稳定行 id（= cordis 插件 id；宿主行与壳行同命名域） */
  id: string;
  /** 树归属：host = 宿主树行；shell = 壳树行 */
  tree: 'host' | 'shell';
  /** 分区归属（cr-1022 批2：仅 shell 双区行携带——骨架 = 恒装面，
   * 能力 = 出厂目录；host 行单区无标记） */
  zone?: 'skeleton' | 'capability';
  /** 行定位（link: 去 link: 的仓库相对路径——装载与指纹寻址单源） */
  path?: string;
  /** 硬依赖行 id 清单（菜单完备性校验输入——不进即不装，无自动注入） */
  requires?: string[];
  /** 一句话描述（目录的人类可读面） */
  description?: string;
}

/** 全局行集目录（静态全集——两树同源单表） */
export interface RowsetCatalog {
  rows: RowDescriptor[];
}

// —— 宿主行集派生（偏好文件——宿主单例无实例差量层） ——

/** 宿主行集偏好条目（数据根 host-rows.json；形状 {id, disabled} 沿用） */
export interface HostRowPreference {
  id: string;
  disabled?: boolean;
}

/**
 * 宿主行集派生：目录 host 行 − disabled 集（host 基座 = 全集减法面，
 * 骨架/能力分区立法只辖 shell——menu-assembly.md §2.1）。偏好未提及
 * 的行默认装载（偏好文件只记差异——恒冷生效，无热通道）。
 */
export function deriveHostRowset(
  preferences: HostRowPreference[],
  catalog: RowsetCatalog,
): { rowIds: string[]; warnings: string[] } {
  const hostRows = catalog.rows.filter((r) => r.tree === 'host');
  const warnings: string[] = [];
  const hostIds = new Set(hostRows.map((r) => r.id));
  const disabled = new Set<string>();
  for (const p of preferences) {
    if (!hostIds.has(p.id)) {
      warnings.push('偏好条目非宿主行：' + p.id);
      continue;
    }
    if (p.disabled === true) disabled.add(p.id);
  }
  const rows = hostRows.filter((r) => !disabled.has(r.id));
  return { rowIds: rows.map((r) => r.id), warnings };
}

export type { AssemblyEntry };
