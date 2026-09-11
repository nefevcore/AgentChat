// ============================================================
// ac-client-ui-settings/client/sectionTree.ts —— 设置左树节派生
// 纯函数（2026-11 左树数据化）
//
// 树叶不再壳内硬编码：域行贡献 settings:section 携带
// meta.section（选举键）/ meta.label（叶词条）+ 顶层 order（叶序轴），
// 壳按席位条目派生平铺叶——左树叶与右区内容同源，行装卸 → 叶/节
// 同步出现/消失（D19 整枝退场在设置面板完整兑现）。
// ============================================================
import type { SlotEntry } from 'ac-client-slots';

/** 左树平铺叶（id = 选举键 meta.section；label = 贡献词条） */
export interface SectionLeaf {
  id: string;
  label: string;
}

/**
 * settings:section 席位条目 → 左树平铺叶（纯映射）。
 *
 * 排序不是本函数职责——entries() 已按 order 升序稳定（同轴注册序）。
 * 防御口径：缺 meta.section 的条目弃置（无选举键不可寻址）；缺
 * meta.label 回落节 id（叶仍可选、内容仍可达，词条缺失不构成整节目击
 * 失效）。
 */
export function deriveSectionLeaves(entries: readonly SlotEntry[]): SectionLeaf[] {
  const leaves: SectionLeaf[] = [];
  for (const e of entries) {
    const section = e.meta?.section;
    if (typeof section !== 'string' || section === '') continue;
    const label = e.meta?.label;
    leaves.push({ id: section, label: typeof label === 'string' && label !== '' ? label : section });
  }
  return leaves;
}
