// ============================================================
// api/system.ts —— 系统模块 Port B（版本/备份）
//
// 版本面三连接口直连后端 RPC（更新功能修复批）：
//   system/version（本地版本读）+ system/version-check（GitHub
//   Releases 检查，失败 checkFailed 显式呈现）并取 → VersionInfo；
//   system/version-changelog（项目根 CHANGELOG.md）；
//   system/version-update（git 检出自更新；npm 安装显式 unavailable）。
// backup/run 直连不变。旧"preview 无更新通道"的降级垫已随
// 后端面补齐移除——入口、状态、数据三层齐备。
// ============================================================

import { wireRpc } from './wire.ts';

interface VersionInfo {
  current?: string;
  latest?: string | null;
  hasUpdate?: boolean;
  latestUrl?: string | null;
  /** 检查失败（网络不可达/限流）——UI 显示"无法确认"而非"已是最新" */
  checkFailed?: boolean;
  /** 桌面壳装配（Electron）：更新归 electron-updater，UI 换桌面文案 */
  desktop?: boolean;
}

type Rpc = { call<T>(m: string, p?: Record<string, unknown>, requestId?: string, timeoutMs?: number): Promise<T> };

interface PCheckResult {
  current?: string;
  latest?: string | null;
  hasUpdate?: boolean;
  latestUrl?: string | null;
  checkFailed?: boolean;
  desktop?: boolean;
}

/** 版本信息：本地版本 + 更新检查并取（simulate=测试通道，伪造 patch+1） */
export async function fetchVersion(simulate = false, rpc: Rpc = wireRpc): Promise<VersionInfo> {
  const [v, check] = await Promise.all([
    rpc.call<{ current?: string }>('system/version'),
    rpc.call<PCheckResult>('system/version-check', { simulate }),
  ]);
  return {
    current: v.current ?? check.current,
    latest: check.latest ?? null,
    hasUpdate: check.hasUpdate ?? false,
    latestUrl: check.latestUrl ?? null,
    ...(check.checkFailed ? { checkFailed: true } : {}),
    ...(check.desktop ? { desktop: true } : {}),
  };
}

/** changelog：项目根 CHANGELOG.md 读面（缺失 → 空文案） */
export async function fetchChangelog(rpc: Rpc = wireRpc): Promise<{ content?: string }> {
  return rpc.call<{ content?: string }>('system/version-changelog');
}

/** 版本更新：git 检出 stash→pull→install→build + 重启；npm 安装 unavailable */
export async function runVersionUpdate(rpc: Rpc = wireRpc): Promise<{ status?: string; message?: string; steps?: string[] }> {
  // install+build 分钟级：60s 缺省超时不够，拉长到 10min
  return rpc.call<{ status?: string; message?: string; steps?: string[] }>('system/version-update', {}, undefined, 600_000);
}

/** 立即备份（Sidebar 菜单；名字与 src 端点契约一致，最小组件 diff） */
export async function backupNow(rpc: Rpc = wireRpc): Promise<{ status?: string; file?: string; size?: number; keep?: number; error?: string }> {
  const r = await rpc.call<{ backup?: { file?: string; path?: string; size?: number; backups?: Array<unknown> } }>('backup/run');
  const b = r.backup ?? {};
  return { status: 'ok', file: b.file ?? b.path, size: b.size, keep: b.backups?.length };
}
