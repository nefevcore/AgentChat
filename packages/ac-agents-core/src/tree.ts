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
import { readAgentPatch, patchToConfig, configToPatch, writeAgentPatch, agentPatchFile, readPluginConfigs, writePluginConfig } from './patch-doc.ts';

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

/**
 * 直读 Agent 定义（cr-906 批4 双读：agent.patch.yml 在场即赢——投影回
 * AgentConfig 形状；缺席走 config.json 旧路径，窗口兼容未迁移存量）。
 * ◐b cr-691 键归一：盘上旧键 tools → rows（读时兼容已迁数据；写恒 rows
 * ——writeAgentConfig 落盘的恒为归一后形态，旧键只在读时出现一次）。
 */
export function readAgentConfig(dataRoot: string, agentId: string): AgentConfig | null {
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
    return parsed as AgentConfig;
  } catch {
    return null;
  }
}

/** 写 Agent 定义（cr-906 批4 patch 主写；cr-918 镜像双落退役——读路径
 * 存量窗口保留：仅 config.json 的旧根仍可读） */
export function writeAgentConfig(dataRoot: string, config: AgentConfig): void {
  assertAgentId(config.id);
  const dir = agentDir(dataRoot, config.id);
  fs.mkdirSync(dir, { recursive: true });
  const prevPatch = fs.existsSync(agentPatchFile(dataRoot, config.id))
    ? readAgentPatch(dataRoot, config.id) : null;
  // 插件配置拆分（cr-906 切片二）：settings → agents/<id>/<unit>.json（各插件
  // 自定自读）；patch 不随行 settings；config.json 镜像仍含（旧读者窗口）
  for (const [unit, value] of Object.entries(config.settings ?? {})) {
    writePluginConfig(dataRoot, config.id, unit, value);
  }
  const { settings: _split, ...withoutSettings } = configToPatch(config, prevPatch?.origin);
  writeAgentPatch(dataRoot, config.id, withoutSettings);
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
export function readChildConfig(parentDataRoot: string, parentId: string, childId: string): AgentConfig | null {
  assertAgentId(parentId);
  assertAgentId(childId);
  const file = path.join(agentDir(parentDataRoot, parentId), 'children', childId, CONFIG_FILE);
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
 * 身份一次性落盘，父此后改配置不传播）。已存在 = fail-loud（不静默覆盖）。 */
export function materializeChild(
  dataRoot: string,
  parentId: string,
  childId: string,
  parent: AgentConfig,
): string {
  assertAgentId(parentId);
  assertAgentId(childId);
  const dir = path.join(agentDir(dataRoot, parentId), 'children', childId);
  if (fs.existsSync(path.join(dir, CONFIG_FILE))) {
    throw new Error('child 已物化：' + dir + '——不静默覆盖（重 spawn 用新 id）');
  }
  fs.mkdirSync(dir, { recursive: true });
  const child = deriveChildConfig(parent, childId);
  const file = path.join(dir, CONFIG_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(child, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return dir;
}
