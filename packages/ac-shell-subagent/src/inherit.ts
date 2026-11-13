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
import { ACCESS_RANK, accessOf, toolModeOf, type AccessLevel } from 'ac-agents-core';
import { resolveToolNames } from 'ac-agents-core';
import { splitModelRef } from 'ac-llm';

/**
 * spawn 工具词过滤（spawn ⊆ 父授权投影）：
 *   · 未命中父壳活装配行集（cr-616——击穿子壳行集静态断言；cr-1022
 *     批4 词面从静态目录换轨为 bootShell 注入的活行集）；
 *   · subagent 行（cr-762——防子孙无限增长）；
 *   · run-code 行（cr-763——子域程序化形态会收窄掉全部授予工具）；
 *   · 不属父行集的词。
 * 三者皆拒（filtered 回报）；过滤后空集 = 纯推理子 Agent。
 * cr-1022 批2：词形 = 行 id 单一（工具名/捆绑词随 tools 声明退役）；
 * 批4 落地：词面 = 父壳活装配行集（bootShell 注入——静态目录不查）。
 */
export function filterSpawnTools(tokens: string[], parentRowIds: Set<string>, shellRowIds: ReadonlySet<string>): { granted: string[]; rejected: string[] } {
  const granted: string[] = [];
  const rejected: string[] = [];
  for (const token of tokens) {
    if (!shellRowIds.has(token) || token === 'subagent' || token === 'run-code'
      || !parentRowIds.has(token)) {
      rejected.push(token);
    } else {
      granted.push(token);
    }
  }
  return { granted, rejected };
}

/**
 * 会话设置继承面（cr-953 结构化换轨——tags 退役）：发起会话 conv-settings
 * 覆盖值 → 子 config 结构化字段。新增设置键的继承面在此登记（映射与
 * conv-settings BUILTIN_KEYS 的 grants 档位轴同源维护）。access（cr-947
 * 前名 elevation）与 per-call access 取高者（只升不降）。tc-* 不继承：
 * 交互形态非授权——子形态由装配结构化合成。browserTier → levels.browser
 *（取高者——父级更高时保父）。issueSubmit 无结构化继承面（授权 = 行
 * 装载，无标签轴）。
 */
export function convInheritOf(
  settings: Record<string, string>,
  callAccess: 'sandbox-access' | 'full-access' | undefined,
): { access?: AccessLevel; browserLevel?: 'observe' | 'manipulate' | 'inject' } {
  const access = ACCESS_RANK[(settings.access as AccessLevel | undefined) ?? 'base-access'] >= ACCESS_RANK[callAccess ?? 'base-access']
    ? settings.access
    : callAccess;
  const BROWSER_ORDER = { observe: 0, manipulate: 1, inject: 2 } as const;
  const browserLevel = settings.browserTier === 'observe' || settings.browserTier === 'manipulate' || settings.browserTier === 'inject'
    ? settings.browserTier
    : undefined;
  return {
    ...(access === 'full-access' || access === 'sandbox-access' ? { access: access as AccessLevel } : {}),
    ...(browserLevel !== undefined ? { browserLevel } : {}),
  };
}

/** 会话继承面输入（spawnOp 解析 ctx 服务后的产物——本文件零 cordis） */
export interface SpawnInheritInput {
  parent: AgentConfig;
  /** 过滤后的工具词（undefined = 缺省继承父行集） */
  tools?: string[];
  /** 父行集快照（cr-1007：v2 差量下 config.rows 不投影——缺省继承与
   * 形态合成的行集事实源；tools 在场时忽略） */
  effectiveRows?: string[];
  name?: string;
  system?: string;
  /** convInheritOf 产物（结构化继承面） */
  inherit?: { access?: AccessLevel; browserLevel?: 'observe' | 'manipulate' | 'inject' };
  /** 发起会话工作区锚点（缺席 = 不写——子保持专用空间） */
  workdirAnchor?: string;
  /** 发起会话模型覆盖（'name@model'/裸名；缺席 = 父静态） */
  modelOverride?: string;
}

/**
 * 子 config 快照合成（单源）：父 access/levels 继承 + 会话继承面取高合入
 * + rows 含 run-code 行时合成 toolMode='tc-programmatic'（形态跟随装配）
 * + workdir / model 覆盖快照。产物经 materializeChild 落盘（其剥减层补
 * id/preset）。cr-953：tags 轴删除——授权继承 = access 字段与 levels。
 */
export function spawnChildConfigOf(input: SpawnInheritInput): AgentConfig {
  const { parent, tools, name, system, inherit, workdirAnchor, modelOverride, effectiveRows } = input;
  // 形态合成（cr-821 / cr-1021 修正）：子的 toolMode = 父形态 ∧ 子行集含
  // run-code 行。run-code 进基础集（cr-1021）后「行集含 run-code」对缺省
  // 继承恒真——仅凭行集判定会把所有 spawn 子翻转成程序化模式；父级
  // tc-* 不继承的语义保留在「父非程序化 → 子恒常规」分支。
  // cr-1049 边界标注：此处仍是 tc-programmatic 单模式特写（词与行 id
  // 字面量）——第二个模式行出现时再按注册表通用化（入口行 id → 模式词
  // 的映射需真实第二例驱动接口，现状通用化 = speculation）。
  // cr-1022 批2：词形 = 行 id 单一——正清单直读（组合读已含骨架行；
  // 捆绑/工具名词形与闭包展开随差量引擎退役）
  const childTokens = tools ?? effectiveRows ?? resolveToolNames(parent.rows) ?? [];
  const childRowIds = new Set(childTokens);
  const parentProgrammatic = toolModeOf(parent) === 'tc-programmatic';
  // 档位继承：会话覆盖与父 access 取高（只升不降）
  const parentAccess = accessOf(parent);
  const inheritedAccess = inherit?.access !== undefined && ACCESS_RANK[inherit.access] > ACCESS_RANK[parentAccess]
    ? inherit.access
    : parentAccess !== 'base-access' ? parentAccess : undefined;
  // browser 层级继承：会话覆盖与父 levels.browser 取高
  const BROWSER_ORDER = { observe: 0, manipulate: 1, inject: 2 } as const;
  const parentBrowser = parent.levels?.browser;
  const parentBrowserLevel = parentBrowser === 'observe' || parentBrowser === 'manipulate' || parentBrowser === 'inject'
    ? parentBrowser : undefined;
  const browserLevel = inherit?.browserLevel !== undefined && parentBrowserLevel !== undefined
    ? (BROWSER_ORDER[inherit.browserLevel] >= BROWSER_ORDER[parentBrowserLevel] ? inherit.browserLevel : parentBrowserLevel)
    : inherit?.browserLevel ?? parentBrowserLevel;
  const levels = { ...(parent.levels ?? {}) } as Record<string, string | boolean>;
  if (browserLevel !== undefined) levels.browser = browserLevel;
  else delete levels.browser;
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
    ...(tools !== undefined ? { rows: tools } : effectiveRows !== undefined ? { rows: effectiveRows } : {}),
    ...(inheritedAccess !== undefined ? { access: inheritedAccess } : {}),
    // 形态跟随装配（cr-821/cr-953，cr-1021 修正）：程序化 = 父形态 ∧ 子行集
    // 含 run-code——非程序化父的子恒常规（父 toolMode 不继承）
    ...(parentProgrammatic && childRowIds.has('run-code') ? { toolMode: 'tc-programmatic' as const } : {}),
  } as AgentConfig;
  if (!(parentProgrammatic && childRowIds.has('run-code'))) delete (child as { toolMode?: unknown }).toolMode;
  if (Object.keys(levels).length > 0) (child as { levels?: Record<string, string | boolean> }).levels = levels;
  else delete (child as { levels?: Record<string, string | boolean> }).levels;
  if (Object.keys(settings).length > 0) (child as { settings?: Record<string, unknown> }).settings = settings;
  else delete (child as { settings?: Record<string, unknown> }).settings;
  delete (child as { tags?: unknown }).tags; // cr-953：tags 轴退役
  return child;
}
