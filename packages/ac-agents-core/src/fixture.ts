// ============================================================
// fixture.ts —— 测试数据根骨架工厂（M2.5；授权草稿 A 节总形态）
//
// 一次性钉出 preview 轨测试数据根的规范布局（后续 M3 壳 boot / M4 邮局
// / M5 端到端共用同一 fixture 形态——布局漂移在源头被抓）：
//   数据根/
//     auth.json                      全局授权层
//     row-catalog.json               行集目录（ac-rowset-core）
//     host-rows.json                 宿主行集偏好
//     mcp.json                       MCP 服务器清单（R-12）
//     credentials/<name>.enc         凭据库（R-11 ③ 引用制）
//     agents/<id>/
//       config.json                  AgentConfig
//       auth.json                    per-agent 授权层
//       sessions/<uuid>/…            账本（D4——壳运行期产物，骨架不建）
//       children/<cid>/…             子树（物化期产物，骨架不建）
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAgentConfig } from './tree.ts';
import type { AgentConfig } from './config.ts';
import type { GlobalAuthShape as GlobalAuth, AgentAuthShape as AgentAuth } from './auth-shape.ts';

export interface DataRootSkeleton {
  agents?: AgentConfig[];
  globalAuth?: GlobalAuth;
  agentAuths?: Record<string, AgentAuth>;
  rowCatalog?: unknown;
  hostPreferences?: unknown;
  mcp?: unknown;
  credentials?: Record<string, string>;
}

/**
 * 构建测试数据根（返回根路径）。credentials 为明文映射——工厂内加密
 * 落盘（key 参数注入；缺省用固定 test 材料——真实加密往返在
 * ac-credentials-core 自己的测试里测）。
 */
export function buildDataRoot(
  root: string,
  skeleton: DataRootSkeleton,
  opts: { encrypt?: (name: string, plaintext: string) => string } = {},
): string {
  fs.mkdirSync(root, { recursive: true });
  const write = (file: string, value: unknown) => {
    fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2), 'utf-8');
  };
  if (skeleton.globalAuth !== undefined) write('auth.json', skeleton.globalAuth);
  if (skeleton.rowCatalog !== undefined) write('row-catalog.json', skeleton.rowCatalog);
  if (skeleton.hostPreferences !== undefined) write('host-rows.json', skeleton.hostPreferences);
  if (skeleton.mcp !== undefined) write('mcp.json', skeleton.mcp);
  for (const agent of skeleton.agents ?? []) {
    writeAgentConfig(root, agent);
  }
  for (const [agentId, auth] of Object.entries(skeleton.agentAuths ?? {})) {
    const dir = path.join(root, 'agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth, null, 2), 'utf-8');
  }
  for (const [name, plaintext] of Object.entries(skeleton.credentials ?? {})) {
    const dir = path.join(root, 'credentials');
    fs.mkdirSync(dir, { recursive: true });
    const encoded = opts.encrypt !== undefined
      ? opts.encrypt(name, plaintext)
      : plaintext; // 缺省明文（解密面 readCredential 兼容旧明文形态）
    fs.writeFileSync(path.join(dir, name + '.enc'), encoded, 'utf-8');
  }
  return root;
}
