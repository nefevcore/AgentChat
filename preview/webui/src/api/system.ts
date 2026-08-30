// ============================================================
// api/system.ts —— 系统模块 Port B（版本/备份，阶段二第一梯）
//
// 由适配器 REST 路由（/api/version*、/api/backup）整体迁入：
// system/version + backup/run RPC 直连；preview 无面的部分
// （更新检查/changelog）显式降级——入口在、状态明示，不垫假数据。
// ============================================================

import { wireRpc } from './wire.ts';

export interface VersionInfo {
  current?: string;
  latest?: string;
  hasUpdate?: boolean;
  latestUrl?: string;
}

interface PVersionResult { current?: string; name?: string }
interface PBackupResult { backup?: { file?: string; path?: string; size?: number; backups?: Array<unknown> } }

/** 版本信息（preview 无更新通道：latest/hasUpdate 显式缺省） */
export async function fetchVersion(_simulate = false, rpc: { call<T>(m: string, p?: Record<string, unknown>): Promise<T> } = wireRpc): Promise<VersionInfo> {
  void _simulate;
  const r = await rpc.call<PVersionResult>('system/version');
  return { current: r.current };
}

/** changelog：preview 轨道无此面（VersionDialog 次级请求，空文案降级） */
export async function fetchChangelog(): Promise<{ content?: string }> {
  return { content: '（preview 轨道暂无 changelog）' };
}

/** 版本更新：无通道，显式降级状态（组件按非 success 分支展示后仍会刷新页面） */
export async function runVersionUpdate(): Promise<{ status?: string; message?: string; steps?: string[] }> {
  return { status: 'unavailable', message: 'preview 轨道无版本更新通道' };
}

/** 立即备份（Sidebar 菜单；名字与 src 端点契约一致，最小组件 diff） */
export async function backupNow(rpc: { call<T>(m: string, p?: Record<string, unknown>): Promise<T> } = wireRpc): Promise<{ status?: string; file?: string; size?: number; keep?: number; error?: string }> {
  const r = await rpc.call<PBackupResult>('backup/run');
  const b = r.backup ?? {};
  return { status: 'ok', file: b.file ?? b.path, size: b.size, keep: b.backups?.length };
}
