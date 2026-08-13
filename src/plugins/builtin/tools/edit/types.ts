// ============================================================
// types.ts —— edit 工具共享类型定义
//
// 2026-08-12 重构：从 edit-diff.ts 拆出，全部接口收敛于此，
// 消除「算法文件同时承载类型定义」的 God file 问题。
// ============================================================

/** 单个替换编辑（oldText 模糊匹配） */
export interface ReplaceEdit {
  oldText: string;
  newText: string;
}

/** 模糊匹配结果 */
export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  usedFuzzyMatch: boolean;
  /** 匹配级别：0=精确, 1=trimEnd模糊, 2=trim模糊（去行首空白） */
  fuzzyLevel: number;
}

/** 行定位点（Hashline 协议：行号 + 期望哈希） */
export interface HashPos {
  /** 1-based 行号 */
  lineNum: number;
  /** 期望行哈希（空串 = 裸行号，执行时从 read 快照解析） */
  hash: string;
  /** 裸行号标记：执行时用 read 快照解析期望哈希 */
  snapshotLine?: boolean;
}

/**
 * 行级编辑操作 —— DSL 与 JSON 两条路径的**统一模型**（基于原始文件 1-based 行号）。
 *
 * 由 DSL op（SWAP/INS.PRE/INS.POST/INS.HEAD/INS.TAIL）或 JSON 行级定位
 * （行号#哈希 replace / append / prepend / range）归一化而来，
 * 统一走「从后往前」应用策略，杜绝两条路径策略不一致。
 */
export interface LineEdit {
  /** 操作类型 */
  kind: 'replace' | 'insert-before' | 'insert-after' | 'insert-start' | 'insert-end';
  /** replace：替换 startLine..endLine（含两端） */
  startLine?: number;
  endLine?: number;
  /** insert-before / insert-after：锚点行 */
  anchorLine?: number;
  /** 新内容行（不含行尾） */
  lines: string[];
  /**
   * 行哈希验证（JSON 路径）：应用前验证目标行哈希一致。
   *   replace → start（起始行哈希）、end（结束行哈希）
   *   insert-before/after → anchor（锚点行哈希）
   * DSL 路径无行哈希（用文件级 TAG 验证整体版本）。
   */
  hashes?: Partial<Record<'start' | 'end' | 'anchor', string>>;
  /**
   * 仅哈希定位（兼容旧格式 lineHash，无行号）：管线用文件内容
   * 哈希表解析出对应行号（startLine=endLine=匹配行）。哈希为空串
   * 表示裸行号待解析（从 read 快照取期望哈希）。
   */
  lineHashOnly?: string;
}

/** applyEditsToNormalizedContent 的返回结果 */
export interface AppliedEditsResult {
  /** 原始归一化内容（用于 diff 生成） */
  baseContent: string;
  /** 替换后的归一化内容 */
  newContent: string;
  /** 每个 edit 在 baseContent 中的位置信息（用于增量 diff） */
  editPositions: EditPosition[];
  /** hash 编辑后更新的行哈希（供 Agent 下次 edit 直接使用） */
  updatedHashInfo: HashUpdateInfo[];
}

/** 单个编辑在原始内容中的位置 */
export interface EditPosition {
  /** baseContent 中的字符偏移 */
  oldCharStart: number;
  /** oldText 长度 */
  oldCharLen: number;
  /** newText 长度 */
  newCharLen: number;
}

/** hash 编辑后更新的行哈希信息，供 Agent 下次 edit 直接使用，无需重新 read */
export interface HashUpdateInfo {
  /** 被替换行的原始 hash */
  oldHash: string;
  /** 替换后每行的新 hash（newText 可能含换行，拆为多行） */
  newHashes: string[];
}
