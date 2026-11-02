// ============================================================
// inherit.ts —— spawn 物化单源（cr-856 症状三收敛）
//
// 子 config = f(父 config, spawn 输入, 会话继承面)。此前六处独立写入
// 内联在 spawnOp（cr-527 授权 / cr-731 会话键 / cr-753 会话设置等效词 /
// cr-758 workdir / cr-759 模型 / cr-763+821 形态合成逐点补丁的现场），
// 「什么该继承」判据散落、新键登记靠记忆（继承问题反反复复的根源）。
// 收拢为纯函数：新增继承面只改本文件。
//
// 物化即快照（R-5）语义不变——本文件只算「快照什么」；spawn ⊆ 授权投影
// 的过滤（cr-616/762/763 拒绝词）同源在此，越权词不进子 config。
// ============================================================
import type { AgentConfig } from 'ac-agents-core';
import { TIER_RANK, type AccessTier } from 'ac-agents-core';
import { deriveShellRowset, type RowsetCatalog } from 'ac-rowset-core';
import { splitModelRef } from 'ac-llm';

/** 交互形态词（不随继承传播——形态跟随装配，cr-763/821） */
const MODE_TAGS = new Set(['tc-programmatic', 'tc-none']);

/**
 * spawn 工具词过滤（spawn ⊆ 父授权投影）：
 *   · 未命中目录 / warnings（cr-616——击穿子壳行集静态断言）；
 *   · subagent 行（cr-762——防子孙无限增长）；
 *   · run-code 行（cr-763——子域程序化形态会收窄掉全部授予工具）；
 *   · 不属父行集的词。
 * 三者皆拒（filtered 回报）；过滤后空集 = 纯推理子 Agent。
 */
export function filterSpawnTools(tokens: string[], parentRowIds: Set<string>, catalog: RowsetCatalog): { granted: string[]; rejected: string[] } {
  const granted: string[] = [];
  const rejected: string[] = [];
  for (const token of tokens) {
    const derived = deriveShellRowset({ rows: [token] }, catalog);
    if (derived.rowIds.includes('subagent') || derived.rowIds.includes('run-code')
      || derived.warnings.length > 0 || !derived.rowIds.every((id) => parentRowIds.has(id))) {
      rejected.push(token);
    } else {
      granted.push(token);
    }
  }
  return { granted, rejected };
}

/**
 * 会话设置继承映射表（cr-753 收窄至授权词 + cr-763 模式词除外）：
 * 发起会话 conv-settings 覆盖值 → 子 config 等效能力词。新增设置键的
 * 继承面在此登记（映射与 conv-settings BUILTIN_KEYS 的 grants 档位轴
 * 同源维护）。elevation 与 per-call elevation 取水位（只升不降）。
 * tc-* 不继承：交互形态非授权——子形态由装配结构化合成。
 */
export function convInheritTagsOf(
  settings: Record<string, string>,
  callElevation: 'sandbox-access' | 'full-access' | undefined,
): string[] {
  const tags = new Set<string>();
  const tier = TIER_RANK[(settings.elevation as AccessTier | undefined) ?? 'base-access'] >= TIER_RANK[callElevation ?? 'base-access']
    ? settings.elevation
    : callElevation;
  if (tier === 'full-access' || tier === 'sandbox-access') tags.add(tier);
  if (settings.browserTier === 'observe') { tags.add('web'); tags.add('observe'); }
  else if (settings.browserTier === 'manipulate') for (const t of ['web', 'observe', 'manipulate']) tags.add(t);
  else if (settings.browserTier === 'inject') for (const t of ['web', 'observe', 'manipulate', 'inject']) tags.add(t);
  if (settings.issueSubmit === 'enabled') tags.add('issue-report');
  return [...tags];
}

/** 会话继承面输入（spawnOp 解析 ctx 服务后的产物——本文件零 cordis） */
export interface SpawnInheritInput {
  parent: AgentConfig;
  /** 过滤后的工具词（undefined = 缺省继承父 rows） */
  tools?: string[];
  name?: string;
  system?: string;
  /** convInheritTagsOf 产物（等效能力词） */
  inheritTags?: string[];
  /** 发起会话工作区锚点（缺席 = 不写——子保持专用空间） */
  workdirAnchor?: string;
  /** 发起会话模型覆盖（'name@model'/裸名；缺席 = 父静态） */
  modelOverride?: string;
}

/**
 * 子 config 快照合成（单源）：父 tags 剥交互形态词 + 继承面合入 +
 * rows 含 run-code 行时合成 tc-programmatic（形态跟随装配）+ workdir /
 * model 覆盖快照。产物经 materializeChild 落盘（其剥减层补 id/preset）。
 */
export function spawnChildConfigOf(input: SpawnInheritInput, catalog: RowsetCatalog): AgentConfig {
  const { parent, tools, name, system, inheritTags, workdirAnchor, modelOverride } = input;
  // 形态合成（cr-821）：子的 toolMode 由子 rows 是否含 run-code 行结构化
  // 决定——父级 tc-* 全剥除，缺省继承（父 rows）或显式点名命中才合成。
  const childRowIds = new Set(deriveShellRowset({ rows: tools ?? parent.rows ?? [] }, catalog).rowIds);
  const childTags = [...(parent.tags ?? []).filter((t) => !MODE_TAGS.has(t)), ...(inheritTags ?? [])]
    .filter((t) => !MODE_TAGS.has(t));
  if (childRowIds.has('run-code')) childTags.push('tc-programmatic');
  // workdir 锚点（cr-758）：子会话键是新对桶——singles 记录结构上到不了
  // 子壳，快照是唯一通道（挂载即基准语义）。
  const settings = { ...(parent.settings ?? {}) } as Record<string, unknown>;
  if (typeof workdirAnchor === 'string' && workdirAnchor !== '') {
    const prior = settings.security as Record<string, unknown> | undefined;
    settings.security = { ...(prior ?? {}), workdir: workdirAnchor };
  }
  // 模型覆盖（cr-759）：会话生效模型不在父 config（conv-settings 合并点
  // 产物）——不快照则子回落默认模型。
  const modelRef = typeof modelOverride === 'string' && modelOverride !== '' ? splitModelRef(modelOverride) : undefined;
  const child = {
    ...parent,
    ...(modelRef !== undefined ? { model: modelRef.model, ...(modelRef.provider !== undefined ? { provider: modelRef.provider } : {}) } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(system !== undefined ? { system } : {}),
    ...(tools !== undefined ? { rows: tools } : {}),
    tags: childTags,
  } as AgentConfig;
  if (Object.keys(settings).length > 0) (child as { settings?: Record<string, unknown> }).settings = settings;
  else delete (child as { settings?: Record<string, unknown> }).settings;
  return child;
}
