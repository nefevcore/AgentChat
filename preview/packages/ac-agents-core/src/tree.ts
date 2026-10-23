// ============================================================
// tree.ts —— agents/<id>/ 树直读（R-6 直读第四层：CLI 形态无 RPC 对端，
// 直读数据根即身份——宿主缺席不失忆）+ children 嵌套解析（R-5：物化即
// 快照，子身份重读不依赖父目录）
//
// agents/<id>/ 树布局（D4.1 + 授权草稿 A 节）：
//   config.json      AgentConfig（身份：人格/模型引用/档案）
//   auth.json        per-agent 授权层（M2.2 消费，此处只透传路径）
//   sessions/<uuid>/ 账本（D4）
//   children/<cid>/  子树（物化快照——同构嵌套，不回溯父目录）
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentConfig } from './config.ts';

/** 树内文件名常量（读写双面共用单源） */
export const CONFIG_FILE = 'config.json';

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

/** 直读 config.json（缺席/损坏 = null——调用方按未注册语义处理） */
export function readAgentConfig(dataRoot: string, agentId: string): AgentConfig | null {
  const file = path.join(agentDir(dataRoot, agentId), CONFIG_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AgentConfig>;
    if (typeof parsed.id !== 'string' || parsed.id !== agentId) return null;
    return parsed as AgentConfig;
  } catch {
    return null;
  }
}

/** 写 config.json（宿主编辑面 / 物化 spawn 面；原子写 temp+rename） */
export function writeAgentConfig(dataRoot: string, config: AgentConfig): void {
  assertAgentId(config.id);
  const dir = agentDir(dataRoot, config.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CONFIG_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
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

// —— 影子物化（R-5：spawn = 派生身份新 agent；RSI 候选机制，P2③ 影子不撞锁） ——

/**
 * 物化剥减（身份面）：父身份剥掉在场性词汇（preset 名册语义不继承），
 * 其余原样快照——子身份重读不依赖父目录。会话基座（conversation/ledger
 * 行）由行集派生层单源并入（cr-548——派生层恒并，本函数不再改写 tools）。
 */
export function deriveChildConfig(parent: AgentConfig, childId: string): AgentConfig {
  return { ...parent, id: childId, preset: undefined };
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
