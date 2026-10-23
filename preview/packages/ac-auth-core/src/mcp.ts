// ============================================================
// mcp.ts —— mcp.json 清单（R-12：MCP 服务器清单 = 授权资产）+
// 授权草稿 F1 钉：独立文件（MCP 现有用户可见面不动，auth 引用之）
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface McpServerEntry {
  /** 服务器名（键） */
  name: string;
  [key: string]: unknown;
}

export interface McpManifest {
  version: 1;
  servers: McpServerEntry[];
}

/** mcp.json 路径（数据根/mcp.json） */
export function mcpManifestFile(dataRoot: string): string {
  return path.join(dataRoot, 'mcp.json');
}

/** 直读清单（缺席/损坏 = 空表） */
export function readMcpManifest(dataRoot: string): McpManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpManifestFile(dataRoot), 'utf-8')) as Partial<McpManifest>;
    if (Array.isArray(parsed.servers)) return { version: 1, servers: parsed.servers as McpServerEntry[] };
  } catch {
    // 缺席 = 空
  }
  return { version: 1, servers: [] };
}

/** 原子写清单（宿主单写） */
function writeMcp(dataRoot: string, manifest: McpManifest): void {
  const file = mcpManifestFile(dataRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/** 追加服务器（名字段去重幂等；返回是否实质变更） */
export function addMcpServer(dataRoot: string, entry: McpServerEntry): { changed: boolean; manifest: McpManifest } {
  const manifest = readMcpManifest(dataRoot);
  let changed = false;
  if (!manifest.servers.some((s) => s.name === entry.name)) {
    manifest.servers.push(entry);
    changed = true;
  }
  if (changed) writeMcp(dataRoot, manifest);
  return { changed, manifest };
}

/** 移除服务器（缺位 = 幂等 no-op） */
export function removeMcpServer(dataRoot: string, name: string): { changed: boolean; manifest: McpManifest } {
  const manifest = readMcpManifest(dataRoot);
  const before = manifest.servers.length;
  manifest.servers = manifest.servers.filter((s) => s.name !== name);
  const changed = manifest.servers.length !== before;
  if (changed) writeMcp(dataRoot, manifest);
  return { changed, manifest };
}
