// ============================================================
// ac-mcp/src/discovery-cache.ts —— MCP 工具发现缓存（cr-1114 批2）
//
// 「boot 期承诺名与形，run 期兑现连与果」的 MCP 侧落地：上次会话发现的
// 工具面缓存在 <dataRoot>/meta/mcp-discovery/<def-hash>.json，boot 期
// 按缓存注册承诺面（连接照懒），首个 run 即全量可见——冷启动盲窗只在
// 无缓存时出现（Codex 同款显式取舍，见 docs/design/assembly/
// host-shell-decisions.md）。
//
// def-hash = 服务器定义指纹（name/transport/command/args/url/headers/env
// 规范化序列化——键排序、env 值展开后的表意键）：定义变 = 新键，旧键自然
// 成孤儿（由后续对账清理，不影响读）。
//
// 数据根分层：meta/ 是第二层（用户域源数据）——发现缓存是**可重建派生物**，
// 寄居 meta/ 以避免顶层新目录（data-root-layers §二 meta 内部表已登记）。
// 损坏/缺席 = null（fail-safe，回落冷启动路径）。
// ============================================================
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServerConfig } from 'ac-mcp-core';

/** 缓存工具条目（承诺面：名与形） */
export interface CachedTool {
  /** 服务器侧原始工具名（callTool 用） */
  name: string;
  /** 注册到 ctx.tools 的最终名（撞名命名空间处理后的结果） */
  finalName: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 发现缓存（wire 形 = 持久形） */
export interface DiscoveryCache {
  version: 1;
  defHash: string;
  server: string;
  tools: CachedTool[];
  /** 写入时刻（诊断用；不参与对账） */
  at: string;
}

/** 服务器定义指纹：影响工具面的字段规范化排序（enabled/超时等运行参数不入） */
export function defHashOf(def: McpServerConfig): string {
  const canon = JSON.stringify({
    name: def.name,
    transport: def.transport ?? '',
    url: def.url ?? '',
    headers: sortedEntries(def.headers),
    command: def.command ?? '',
    args: def.args ?? [],
    env: sortedEntries(def.env),
    insecure: def.insecure === true,
  });
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

function sortedEntries(rec: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(rec ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function discoveryDirOf(dataRoot: string): string {
  return path.join(dataRoot, 'meta', 'mcp-discovery');
}

export function discoveryFileOf(dataRoot: string, defHash: string): string {
  // 路径守卫：defHash 是本模块产出的 hex（防御性拒绝路径词形）
  if (!/^[0-9a-f]{8,64}$/.test(defHash)) throw new Error('def-hash 非法: ' + defHash);
  return path.join(discoveryDirOf(dataRoot), defHash + '.json');
}

/** 读缓存（缺席/损坏/形状非法 → null = 冷启动路径） */
export function readDiscoveryCache(dataRoot: string, defHash: string): DiscoveryCache | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(discoveryFileOf(dataRoot, defHash), 'utf-8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { version?: unknown; server?: unknown; tools?: unknown };
  if (r.version !== 1 || typeof r.server !== 'string' || !Array.isArray(r.tools)) return null;
  const tools: CachedTool[] = [];
  for (const t of r.tools) {
    if (t === null || typeof t !== 'object') return null;
    const c = t as { name?: unknown; finalName?: unknown; description?: unknown; parameters?: unknown };
    if (typeof c.name !== 'string' || typeof c.finalName !== 'string' || typeof c.description !== 'string') return null;
    tools.push({
      name: c.name,
      finalName: c.finalName,
      description: c.description,
      parameters: (c.parameters !== null && typeof c.parameters === 'object' && !Array.isArray(c.parameters)
        ? c.parameters
        : {}) as Record<string, unknown>,
    });
  }
  return { version: 1, defHash, server: r.server, tools, at: typeof (r as { at?: unknown }).at === 'string' ? (r as { at: string }).at : '' };
}

/** 原子写缓存（tmp + rename——同数据根其它第二层文件纪律） */
export function writeDiscoveryCache(dataRoot: string, server: string, defHash: string, tools: CachedTool[]): void {
  const file = discoveryFileOf(dataRoot, defHash);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: DiscoveryCache = { version: 1, defHash, server, tools, at: new Date().toISOString() };
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}
