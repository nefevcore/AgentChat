// ============================================================
// ac-client-ui-agents/client/tagExclusive.ts —— 抉择组语义
// （2026-12 标签配置语义升级：分组内 tag 合一为下拉单选）
//
// 目录条目挂 exclusive 元数据（同组互斥）：access-tier（base-access/
// sandbox-access/full-access）、tool-mode（tc-none/tc-base/
// tc-programmatic）由 tag-registry 预注册；browser-tier（observe/
// manipulate/inject）由 ac-web-tools 声明。本模块把目录按抉择组
// 聚合、由 Agent tags 反解当前档、按抉择产出落词——判定面
// （tierOf / toolModeOf / browser 层级门禁）全部基于「tags 含某词」
// 原语，不消费抉择元数据：落词规则保证一致态（同组至多一词），
// 判定即语义等价。
//
// 落词规则（applyExclusiveChoice）：
//   · 选普通词：移除组内全部词 → 写入所选词；
//   · 选 exclusiveNone 缺省词（base-access / tc-base）：移除组内全部
//     词 → 不写入（缺席即语义——判定函数缺省档兜底，wire 语义不变）；
//   · tier 族（browser-tier）：选高层词时连带写齐全部低层词（工具
//     requiredTags 是 AND 地板 ['web','observe']——不含 observe 则
//     browser 整个工具不可见；tier=max 门禁语义下低层全含无害）。
//
// 纯模块零依赖：目录条目形状自持（rosterApi.TagCatalogItem 的结构
// 子集），可独立单测；AgentPane 消费。
// ============================================================

/** 抉择模块所需的最小目录条目形状（TagCatalogItem 结构子集） */
export interface ExclusiveCatalogItem {
  tag: string;
  description?: string;
  order?: number;
  exclusive?: string;
  exclusiveNone?: boolean;
  /** 抉择组「全关」后果说明（无缺省词的组；同组一致——组级取首个非空） */
  exclusiveOffDesc?: string;
  tier?: boolean;
}

/** 一个抉择组（下拉单选项 = 组内词，按 order 升序） */
export interface ExclusiveGroup {
  /** 组名（exclusive 值；UI key） */
  key: string;
  /** 组内条目（order 升序，缺省 50） */
  items: ExclusiveCatalogItem[];
  /** 组内 tag 集（快速判定 + 落词剔除） */
  tags: Set<string>;
  /**
   * 「全关」态的后果说明：有 exclusiveNone 缺省词 → undefined（关闭态
   * 描述 = 缺省词自身 description，UI 自取）；无缺省词的组 → 声明方
   * 的 exclusiveOffDesc（组内首个非空——同组应一致，声明方责任）
   */
  offDesc?: string;
}

/**
 * 从目录聚合抉择组（key 升序稳定输出）。目录为空/无抉择词 → 空数组
 * （AgentPane 回落既有徽章形态，行为不变）。
 */
export function collectExclusiveGroups(catalog: ExclusiveCatalogItem[]): ExclusiveGroup[] {
  const byKey = new Map<string, ExclusiveCatalogItem[]>();
  for (const item of catalog) {
    if (!item.exclusive) continue;
    const list = byKey.get(item.exclusive) ?? [];
    list.push(item);
    byKey.set(item.exclusive, list);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, items]) => ({
      key,
      items: [...items].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.tag.localeCompare(b.tag)),
      tags: new Set(items.map((i) => i.tag)),
      // 全关后果说明：仅无缺省词的组需要（有缺省词的组关闭态描述 =
      // 缺省词 description，UI 自取——offDesc 留空避免双源）
      ...(items.some((i) => i.exclusiveNone)
        ? {}
        : { offDesc: items.find((i) => i.exclusiveOffDesc)?.exclusiveOffDesc }),
    }));
}

/**
 * 抉择组当前值（由 Agent tags 反解）：组内最后一个在册词；无 →
 * exclusiveNone 缺省词；无缺省词条目 → null（真「都不选」——UI
 * 下拉第一项「关闭」）。返回 tag 字符串（'' 表示缺省/关闭态由
 * 调用方用 currentExclusiveValue 处理展示）。
 */
export function currentExclusiveTag(group: ExclusiveGroup, tags: string[]): ExclusiveCatalogItem | null {
  // 反序扫描：tags 中组内最高位词（多词并存是手工编辑的旧态，取
  // items 序最后一个命中——与判定函数的优先序对齐由判定函数保证，
  // 这里只做展示反解）
  for (let i = group.items.length - 1; i >= 0; i--) {
    const item = group.items[i];
    if (tags.includes(item.tag)) return item;
  }
  const none = group.items.find((i) => i.exclusiveNone);
  return none ?? null;
}

/**
 * 抉择落词（唯一写入口）：nextTag = 组内词 → 剔除组内全部词后写入
 * 所选词；nextTag = 组内 exclusiveNone 词或 null（关闭）→ 仅剔除。
 * tier 族连带：所选词之前存在 tier:true 的组内词（按 order 序）时，
 * 一并写齐这些地板词（browser-tier 选 manipulate/inject 连带 observe）。
 * 返回新 tags 数组（原数组不变）。
 */
export function applyExclusiveChoice(
  group: ExclusiveGroup,
  tags: string[],
  nextTag: string | null,
): string[] {
  // 剔除组内全部词
  const rest = tags.filter((t) => !group.tags.has(t));
  if (nextTag === null) return rest;
  if (!group.tags.has(nextTag)) return rest; // 组外词：不落（防误写）
  const chosen = group.items.find((i) => i.tag === nextTag);
  if (!chosen) return rest;
  if (chosen.exclusiveNone) return rest; // 缺省词：缺席即语义
  // tier 族地板连带：order 序先于所选词的 tier 词全部写齐
  const floors = group.items.filter((i) => i.tier && (i.order ?? 50) < (chosen.order ?? 50)).map((i) => i.tag);
  return [...rest, ...floors.filter((f) => f !== nextTag), nextTag];
}

/**
 * 组的「都不选」词 tag（exclusiveNone 词条目；无 → null）。胶囊停用
 * （左半点击关闭）= 落到该词（等价剔除全部组内词——缺席即语义）。
 */
export function noneTagOf(group: ExclusiveGroup): string | null {
  return group.items.find((i) => i.exclusiveNone)?.tag ?? null;
}

/**
 * 胶囊启用（左半点击开启）的恢复词：restore 记忆（上次显式选择）命中
 * 且非缺省词 → 用之；否则组内 order 最小的非缺省词（access-tier →
 * sandbox-access、tool-mode → tc-none、browser-tier → observe）；
 * 全缺省组（理论不出现）→ null（无法启用）。
 */
export function pickRestoreTag(group: ExclusiveGroup, restore?: string): string | null {
  if (restore && group.tags.has(restore)) {
    const item = group.items.find((i) => i.tag === restore);
    if (item && !item.exclusiveNone) return restore;
  }
  const first = [...group.items]
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
    .find((i) => !i.exclusiveNone);
  return first?.tag ?? null;
}
