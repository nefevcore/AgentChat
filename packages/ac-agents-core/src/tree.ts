// ============================================================
// tree.ts —— agents/<id>/ 树直读（R-6 直读第四层：CLI 形态无 RPC 对端，
// 直读数据根即身份——宿主缺席不失忆）+ children 嵌套解析（R-5：物化即
// 快照，子身份重读不依赖父目录）
//
// agents/<id>/ 树布局（D4.1 + 授权草稿 A 节）：
//   agent.patch.yml  装配 overlay 主写面（cr-906/918）；config.json = 存量旧读窗口
//   auth.json        per-agent 授权层（M2.2 消费，此处只透传路径）
//   sessions/<uuid>/ 账本（D4）
//   children/<cid>/  子树（物化快照——同构嵌套，不回溯父目录）
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentConfig } from './config.ts';
import { normalizeLegacyTags, accessOf, toolModeOf } from './config.ts';
import { readCatalog, defaultCatalogFile, assemblyBaseStamp, type AssemblyEntry } from 'ac-rowset-core';
import { readAgentPatch, patchToConfig, readPluginConfigs, readPluginConfigsAt, writePluginConfig, readAgentPatchV3At, readAgentProfileAt, writeAgentProfileAt, writeAgentPatchV3At, rowsToMenuDefs, levelsOfEntries, mergeLevelsIntoEntries, writePluginConfigAt as writePluginConfigAt2, PATCH_FILE, type AgentProfile } from './patch-doc.ts';

/** 树内文件名常量（读写双面共用单源） */
export const CONFIG_FILE = 'config.json';

/** 子域归档标识文件名（cr-712 delete 收割改归档——在场 = 已收割） */
export const ARCHIVED_FILE = 'archived.json';

/** 子域是否已归档收割（cr-712：归档保留子域账本供回放审计，list/看板按此隐去） */
export function childIsArchived(dataRoot: string, parentId: string, childId: string): boolean {
  return fs.existsSync(path.join(agentDir(dataRoot, parentId), 'children', childId, ARCHIVED_FILE));
}

/** agents/<id>/ 目录（数据根下） */
export function agentDir(dataRoot: string, agentId: string): string {
  assertAgentId(agentId);
  return path.join(dataRoot, 'agents', agentId);
}

/** fail-loud：agentId 不得含路径组件（防穿越） */
export function assertAgentId(id: string): void {
  if (id.length === 0) throw new Error('agentId 不得为空');
  if (/[/\\]/.test(id) || id === '.' || id === '..') {
    throw new Error(`agentId 含路径组件（${id}）——拒绝`);
  }
}

/**
 * Agent 身份词形（主线 M19 承重墙同款）：id 禁 `~`——对键桶 conversationId
 * = pairKey(a,b) 排序 `~` 连接，身份若也含 `~` 会与对键撞键、破坏
 * runAddress 从右解析的歧义性。agents/ 树内含 `~` 的目录 = 会话流域
 * （pair 对桶/自会话对角线/群成员流——兜底 config 在场也不是名册身份）。
 * 本函数只判身份词形；agentDir 寻址（会话域路径）仍走 assertAgentId。
 */
export function isAgentIdentity(id: string): boolean {
  return id !== '' && !id.includes('~');
}

/** v3 菜单组合（cr-1022 批2/批3——唯一组合读面）：agent.json 档案 + 菜单
 * 片段定义 → AgentConfig 投影（rows = 骨架 ∪ 定义清单——正清单直读） */
function profileToMenuConfig(agentId: string, profile: AgentProfile, defs: import("ac-rowset-core").MenuEntry[], skeletonIds: readonly string[]): AgentConfig {
  const lv = levelsOfEntries(defs, profile.levels);
  return normalizeLegacyTags({
    id: agentId,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
    ...(profile["llm-params"] !== undefined ? { llmParams: profile["llm-params"] } : {}),
    ...(profile["max-steps"] !== undefined ? { maxSteps: profile["max-steps"] } : {}),
    ...(profile.tier !== undefined ? { access: profile.tier } : {}),
    ...(profile["tool-mode"] !== undefined ? { toolMode: profile["tool-mode"] } : {}),
    ...(profile.name !== undefined ? { name: profile.name } : {}),
    ...(profile.description !== undefined ? { description: profile.description } : {}),
    ...(profile.virtual === true ? { virtual: true } : {}),
    ...(lv !== undefined ? { levels: lv } : {}),
    rows: { include: [...new Set([...skeletonIds, ...defs.map((d) => d.id)])] },
  });
}
/**
 * 直读 Agent 定义（cr-906 批4 双读 + cr-1004 批2 三读：v2 差量〔数组
 * agent.patch.yml + agent.json〕赢 → 旧映射 patch → config.json 存量窗口）。
 * ◐b cr-691 键归一：盘上旧键 tools → rows（读时兼容已迁数据；写恒 rows）。
 */
export function readAgentConfig(dataRoot: string, agentId: string, opts: { catalogFile?: string } = {}): AgentConfig | null {
  const dir = agentDir(dataRoot, agentId);
  // v3 菜单片段（cr-1022 批3 起唯一装配读面——v2 差量组合读退役）
  const v3 = readAgentPatchV3At(dir);
  if (v3 !== null) {
    const profile = readAgentProfileAt(dir) ?? {};
    const skeletonIds = readCatalog(opts.catalogFile ?? defaultCatalogFile(dataRoot)).rows
      .filter((r) => r.tree === 'shell' && r.zone === 'skeleton').map((r) => r.id);
    const config = profileToMenuConfig(agentId, profile, v3.defs, skeletonIds);
    const unitFiles = readPluginConfigs(dataRoot, agentId);
    if (Object.keys(unitFiles).length === 0) return config;
    return { ...config, settings: { ...(config.settings ?? {}), ...unitFiles } };
  }
  const patch = readAgentPatch(dataRoot, agentId);
  if (patch !== null) {
    // 插件配置合成（cr-906 切片二）：单元文件赢——拆分后 patch 不再随行
    // settings（窗口期 patch 内联 settings 为未拆分存量兜底）
    const config = patchToConfig(agentId, patch);
    const unitFiles = readPluginConfigs(dataRoot, agentId);
    if (Object.keys(unitFiles).length === 0) return config;
    return { ...config, settings: { ...(config.settings ?? {}), ...unitFiles } };
  }
  const file = path.join(agentDir(dataRoot, agentId), CONFIG_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AgentConfig> & { tools?: unknown };
    if (typeof parsed.id !== 'string' || parsed.id !== agentId) return null;
    if (parsed.rows === undefined && parsed.tools !== undefined) {
      (parsed as Record<string, unknown>).rows = parsed.tools;
      delete (parsed as Record<string, unknown>).tools;
    }
    // cr-953：存量 tags 读侧归一（档位/模式/levels 词结构化，能力词丢弃）
    return normalizeLegacyTags(parsed as AgentConfig);
  } catch {
    return null;
  }
}

/** 写 Agent 定义（cr-1004 批2：档案 → agent.json；装配差量 → agent.patch.yml
 * v2 数组形态〔含 `# ac-base` 基线戳保真〕；settings 拆单元文件）。
 * 数组白名单 rows 需 shell 行目录（B−T 确定性转换）——opts.shellRows 注入。 */
export function writeAgentConfig(
  dataRoot: string,
  config: AgentConfig,
  opts: { shellRows?: import('ac-rowset-core').RowDescriptor[]; baseStamp?: string } = {},
): void {
  assertAgentId(config.id);
  const dir = agentDir(dataRoot, config.id);
  fs.mkdirSync(dir, { recursive: true });
  // origin 保真：档案在读（agent.json）→ 旧映射 patch → 丢弃（身份层主写面在
 // preset-origin reconcile，本函数不产 origin）
  let prevOrigin: import('./patch-doc.ts').PatchOrigin | undefined;
  const profile0 = readAgentProfileAt(dir);
  if (profile0?.origin !== undefined) prevOrigin = profile0.origin;
  else {
    try { prevOrigin = readAgentPatch(dataRoot, config.id)?.origin; } catch { /* 损坏 = 无可保真 */ }
  }
  // 插件配置拆分（cr-906 切片二）：settings → agents/<id>/<unit>.json
  for (const [unit, value] of Object.entries(config.settings ?? {})) {
    writePluginConfig(dataRoot, config.id, unit, value);
  }
  const access = accessOf(config);
  const toolMode = toolModeOf(config);
  const profile: import('./patch-doc.ts').AgentProfile = {
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.llmParams !== undefined ? { 'llm-params': config.llmParams } : {}),
    ...(config.maxSteps !== undefined ? { 'max-steps': config.maxSteps } : {}),
    ...(access !== 'base-access' ? { tier: access } : {}),
    ...(toolMode !== 'tc-base' ? { 'tool-mode': toolMode } : {}),
    ...(config.name !== undefined ? { name: config.name } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.virtual === true ? { virtual: true } : {}),
    ...(prevOrigin !== undefined ? { origin: prevOrigin } : {}),
  };
  writeAgentProfileAt(dir, profile);
  // shell 能力目录（定义拷贝面）：显式注入赢；缺省自动解析数据根目录
  //（profile/shell.yml 基座投影 ∨ row-catalog.json——宿主 boot 物化后恒在场）
  const shellRows = opts.shellRows !== undefined
    ? opts.shellRows
    : readCatalog(defaultCatalogFile(dataRoot)).rows.filter((r) => r.tree === 'shell');
  const capability = shellRows
    .filter((r) => r.zone !== 'skeleton')
    .map((r) => ({
      id: r.id,
      ...(r.path !== undefined ? { name: 'link:' + r.path } : {}),
      ...(r.requires !== undefined ? { requires: r.requires } : {}),
    }));
  // v3 菜单片段（cr-1022 批2）：正清单定义拷贝 + src-fingerprint + levels
  // 归 config；基线戳保真语义沿用（既有戳赢，新写才现算）
  const { defs, fingerprints } = rowsToMenuDefs(config.rows, capability);
  mergeLevelsIntoEntries(defs, config.levels);
  const existingStamp = readAgentPatchV3At(dir)?.base;
  writeAgentPatchV3At(dir, defs, fingerprints,
    opts.baseStamp ?? existingStamp ?? assemblyBaseStamp(dataRoot, 'shell'));
}

/** 列 agents/ 下全部 agent id（缺席 = 空数组） */
export function listAgentIds(dataRoot: string): string[] {
  const dir = path.join(dataRoot, 'agents');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/**
 * children 嵌套解析（R-5 物化即快照）：读 agents/<id>/children/<cid>/
 * config.json——子身份直接从物化目录解析，不回溯父目录（父此后改配置
 * 不传播）。跨层引用（孙辈及更深）由调用方递归本函数。
 */
export function readChildConfig(parentDataRoot: string, parentId: string, childId: string, opts: { catalogFile?: string } = {}): AgentConfig | null {
  assertAgentId(parentId);
  assertAgentId(childId);
  const dir = path.join(agentDir(parentDataRoot, parentId), 'children', childId);
  // v2 差量（cr-1004 批2：children 随 migrate 同形迁移）→ 组合读；
  // 缺席走 config.json 旧路径（物化即快照——v3 缺席 = null）
  const v3 = readAgentPatchV3At(dir);
  if (v3 !== null) {
    const skeletonIds = readCatalog(opts.catalogFile ?? defaultCatalogFile(parentDataRoot)).rows
      .filter((r) => r.tree === 'shell' && r.zone === 'skeleton').map((r) => r.id);
    const config = profileToMenuConfig(childId, readAgentProfileAt(dir) ?? {}, v3.defs, skeletonIds);
    const unitFiles = readPluginConfigsAt(dir);
    if (Object.keys(unitFiles).length === 0) return config;
    return { ...config, settings: { ...(config.settings ?? {}), ...unitFiles } };
  }
  const file = path.join(dir, CONFIG_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AgentConfig>;
    if (typeof parsed.id !== 'string' || parsed.id !== childId) return null;
    return parsed as AgentConfig;
  } catch {
    return null;
  }
}

/** 列某 agent 的 children id（物化子树清单；缺席 = 空数组） */
export function listChildIds(dataRoot: string, parentId: string): string[] {
  const dir = path.join(agentDir(dataRoot, parentId), 'children');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/**
 * 全场派生身份集合（children 树的逆查面）：任一顶层身份的 children/<cid>/
 * 在场者 = 子身份，不是独立身份。名册与计数须排除——子身份运行期会在顶层
 * 留兜底目录（supervise 预置 config 只含 id），只按「config 在场」判身份
 * 会把它误当名册条目（cr-674：sub-* 混入 agents/list）。
 */
export function materializedChildIds(dataRoot: string): Set<string> {
  const ids = new Set<string>();
  for (const parentId of listAgentIds(dataRoot)) {
    for (const childId of listChildIds(dataRoot, parentId)) ids.add(childId);
  }
  return ids;
}

// —— 影子物化（R-5：spawn = 派生身份新 agent；RSI 候选机制，P2③ 影子不撞锁） ——

/**
 * 物化剥减（身份面）：改写 id，其余原样快照——子身份重读不依赖父目录。
 * （cr-880：preset 字段全链退役——预设类属由 id 词形承载，子 id 无 __x__
 * 词形即天然非预设，无物可剥。）会话基座（conversation/ledger 行）由行集
 * 派生层单源并入（cr-548——派生层恒并，本函数不再改写 tools）。
 */
export function deriveChildConfig(parent: AgentConfig, childId: string): AgentConfig {
  return { ...parent, id: childId };
}

/** 物化子身份到 agents/<parentId>/children/<childId>/（物化即快照——
 * 身份一次性落盘，父此后改配置不传播）。cr-1004 批2：写 v2 形态
 * （agent.json 档案 + agent.patch.yml 差量〔白名单 rows 经 B−T 转换——
 * shellRows 注入；基线戳取当前存在合成〕）；config.json 旧读窗口保留。
 * 已存在 = fail-loud（不静默覆盖）。 */
export function materializeChild(
  dataRoot: string,
  parentId: string,
  childId: string,
  parent: AgentConfig,
  opts: { shellRows?: import('ac-rowset-core').RowDescriptor[] } = {},
): string {
  assertAgentId(parentId);
  assertAgentId(childId);
  const dir = path.join(agentDir(dataRoot, parentId), 'children', childId);
  if (fs.existsSync(path.join(dir, PATCH_FILE)) || fs.existsSync(path.join(dir, CONFIG_FILE))) {
    throw new Error('child 已物化：' + dir + '——不静默覆盖（重 spawn 用新 id）');
  }
  fs.mkdirSync(dir, { recursive: true });
  const child = deriveChildConfig(parent, childId);
  // 插件配置拆单元（快照语义——与主身份写面同形）
  for (const [unit, value] of Object.entries(child.settings ?? {})) {
    writePluginConfigAt2(dir, unit, value);
  }
  const shellRows = opts.shellRows !== undefined
    ? opts.shellRows
    : readCatalog(defaultCatalogFile(dataRoot)).rows.filter((r) => r.tree === 'shell');
  const access = accessOf(child);
  const toolMode = toolModeOf(child);
  writeAgentProfileAt(dir, {
    ...(child.model !== undefined ? { model: child.model } : {}),
    ...(child.provider !== undefined ? { provider: child.provider } : {}),
    ...(child.llmParams !== undefined ? { 'llm-params': child.llmParams } : {}),
    ...(child.maxSteps !== undefined ? { 'max-steps': child.maxSteps } : {}),
    ...(access !== 'base-access' ? { tier: access } : {}),
    ...(toolMode !== 'tc-base' ? { 'tool-mode': toolMode } : {}),
    ...(child.name !== undefined ? { name: child.name } : {}),
    ...(child.description !== undefined ? { description: child.description } : {}),
    ...(child.virtual === true ? { virtual: true } : {}),
    ...(child.levels !== undefined ? { levels: child.levels } : {}),
  });
  const capability = shellRows
    .filter((r) => r.zone !== 'skeleton')
    .map((r) => ({
      id: r.id,
      ...(r.path !== undefined ? { name: 'link:' + r.path } : {}),
      ...(r.requires !== undefined ? { requires: r.requires } : {}),
    }));
  const { defs, fingerprints } = rowsToMenuDefs(child.rows, capability);
  mergeLevelsIntoEntries(defs, child.levels);
  writeAgentPatchV3At(dir, defs, fingerprints, assemblyBaseStamp(dataRoot, 'shell'));
  return dir;
}
