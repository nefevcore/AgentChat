// ============================================================
// write.ts —— 授权注册表写者面（宿主 auth-registry 行专用——D3 修订
// 「封死子树自授」：两层皆宿主单写，壳恒只读）
//
// additive-only 语义：全局层新增不改旧、删除 = 墓碑条目（revokedAt——
// 审计 + B3 指纹稳定）；per-agent 层 = 读改写（grants/denials 列表）。
// 全部原子写（tmp + rename——撕裂防护）。children 物化归 agents-core
// tree（deriveChildAuth 快照落盘已在 M6.5 接线），本面不碰 children。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GlobalAuth, GlobalAuthEntry, AgentAuth, AssetRef } from './auth.ts';
import { readGlobalAuth, readAgentAuth } from './disk.ts';

/** 原子写 JSON（宿主单写者——串行安全；tmp+rename 撕裂防护） */
function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

// —— 全局层（数据根/auth.json）—— 

/** 追加全局条目（additive——id 签发归调用方） */
export function appendGlobalEntry(dataRoot: string, entry: GlobalAuthEntry): GlobalAuth {
  const global = readGlobalAuth(dataRoot);
  if (global.entries.some((e) => e.id === entry.id)) {
    throw new Error('全局条目 id 撞车：' + entry.id);
  }
  global.entries.push(entry);
  writeAtomic(path.join(dataRoot, 'auth.json'), global);
  return global;
}

/** 吊销全局条目（墓碑——按条目 id 或资产键单目标；未命中 fail-loud） */
export function revokeGlobalEntry(
  dataRoot: string,
  target: { id?: string; assetKey?: { kind: 'credential' | 'row-load' | 'mcp-server'; name: string } },
  revokedAt: string,
): { global: GlobalAuth; entry: GlobalAuthEntry } {
  const global = readGlobalAuth(dataRoot);
  let entry: GlobalAuthEntry | undefined;
  if (target.id !== undefined) {
    entry = global.entries.find((e) => e.id === target.id);
  } else {
    const { kind, name } = target.assetKey!;
    entry = global.entries.find((e) => {
      if (e.asset.kind !== kind) return false;
      const n = e.asset.kind === 'credential' ? e.asset.ref : e.asset.kind === 'row-load' ? e.asset.rowId : e.asset.name;
      return n === name;
    });
  }
  if (entry === undefined) throw new Error('全局条目未命中：' + JSON.stringify(target));
  if (entry.revokedAt !== undefined) {
    return { global, entry }; // 幂等——已墓碑
  }
  entry.revokedAt = revokedAt;
  writeAtomic(path.join(dataRoot, 'auth.json'), global);
  return { global, entry };
}

// —— per-agent 层（agents/<id>/auth.json）—— 

/** 读改写 per-agent 层（写回原子；agent 层缺席时以 seed 物化） */
export function updateAgentAuth(dataRoot: string, agentId: string, mutate: (auth: AgentAuth) => void): AgentAuth {
  const existing = readAgentAuth(dataRoot, agentId);
  const auth: AgentAuth = existing ?? { version: 1, agentId, grants: [], denials: [] };
  mutate(auth);
  writeAtomic(path.join(dataRoot, 'agents', agentId, 'auth.json'), auth);
  return auth;
}

/** per-agent grants 追加（同资产键去重——幂等；返回是否实质变更） */
export function addGrant(dataRoot: string, agentId: string, ref: AssetRef): { changed: boolean; auth: AgentAuth } {
  const key = assetKey(ref);
  let changed = false;
  const auth = updateAgentAuth(dataRoot, agentId, (a) => {
    if (a.grants.some((g) => assetKey(g) === key)) return;
    a.grants.push(ref);
    changed = true;
  });
  return { changed, auth };
}

/** per-agent grants 移除（撤销授予——找不到 = 幂等 no-op） */
export function removeGrant(dataRoot: string, agentId: string, ref: AssetRef): { changed: boolean; auth: AgentAuth } {
  const key = assetKey(ref);
  let changed = false;
  const auth = updateAgentAuth(dataRoot, agentId, (a) => {
    const before = a.grants.length;
    a.grants = a.grants.filter((g) => assetKey(g) !== key);
    changed = a.grants.length !== before;
  });
  return { changed, auth };
}

/** per-agent denials 追加/移除（用户编辑面——F2 分立：auth-registry 自面） */
export function addDenial(dataRoot: string, agentId: string, ref: AssetRef): { changed: boolean; auth: AgentAuth } {
  const key = assetKey(ref);
  let changed = false;
  const auth = updateAgentAuth(dataRoot, agentId, (a) => {
    if (a.denials.some((d) => assetKey(d) === key)) return;
    a.denials.push(ref);
    changed = true;
  });
  return { changed, auth };
}

export function removeDenial(dataRoot: string, agentId: string, ref: AssetRef): { changed: boolean; auth: AgentAuth } {
  const key = assetKey(ref);
  let changed = false;
  const auth = updateAgentAuth(dataRoot, agentId, (a) => {
    const before = a.denials.length;
    a.denials = a.denials.filter((d) => assetKey(d) !== key);
    changed = a.denials.length !== before;
  });
  return { changed, auth };
}

/** AssetRef 稳定字面键（denials/grants 匹配单源——auth.ts assetKeyOf 对齐） */
function assetKey(ref: AssetRef): string {
  if (ref.globalId !== undefined) return 'g:' + ref.globalId;
  if (ref.row !== undefined) return 'r:' + ref.row;
  if (ref.mcp !== undefined) return 'm:' + ref.mcp;
  return 'i:' + JSON.stringify(ref.inline?.spec ?? {});
}
