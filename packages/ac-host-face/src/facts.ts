// ============================================================
// ac-host-face/src/facts.ts —— facts 投影（cr-886）
//
// singles/group 注册表宿主直读（与壳 shim 同树同布局——.singles-registry.json
// 与 groups/ 目录都是宿主 owning 写者的盘上形态）。契约只声明能力名
// （facts: ['singles','group']），查询走 execute 帧特型 fact 查询？
// ——不：facts 查询是高频小读（段 provider 每 run 调），走 execute 帧
// 会把每次组装变跨进程调用。裁决：facts 经**数据根**回流——壳 client
// discover 成功后自行直读同树（Shim 形态），契约 facts 字段 = 「宿主
// 保证这些注册表当前可达且为你敞开」的声明位。宿主崩了注册表还在盘上，
// 壳读不受影响——与「宿主注入」的根本差异：数据本体不依赖宿主进程。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readGroupConfig } from 'ac-core-utils';

/** singles 注册表命中（conversationId → 独立会话判定）——直读 .singles-registry.json */
export function isSingleConversation(dataRoot: string, conversationId: string | undefined): boolean {
  if (conversationId === undefined) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(
      path.join(dataRoot, 'viewer', 'sessions', '.singles-registry.json'), 'utf-8'),
    ) as { entries?: Record<string, unknown> };
    return raw.entries !== undefined && conversationId in raw.entries;
  } catch {
    return false;
  }
}

/** 群配置直读（groups/<gid>/group.json——ac-core-utils readGroupConfig 同源单用） */
export function readGroupFact(
  dataRoot: string,
  gid: string,
): { name: string; members: string[]; description?: string } | undefined {
  const g = readGroupConfig(dataRoot, gid);
  if (g === null) return undefined;
  return {
    name: g.name,
    members: g.members,
    ...(g.description !== undefined ? { description: g.description } : {}),
  };
}