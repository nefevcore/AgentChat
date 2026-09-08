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
//
// M27.2-2：fetchVersion/backupNow 数据面已随 sidebar 件迁
// ac-client-ui-sidebar/client/systemApi.ts（rpc 契约面注入）；本模块
// 薄包装维持旧签名（rpc 缺省 wireRpc——VersionDialog/port-b 消费零改动）。
// ============================================================

import { wireRpc } from './wire.ts';
import {
  fetchVersion as pkgFetchVersion,
  backupNow as pkgBackupNow,
  fetchChangelog as pkgFetchChangelog,
  runVersionUpdate as pkgRunVersionUpdate,
} from 'ac-client-ui-sidebar/client/systemApi.ts';

export type { VersionInfo } from 'ac-client-ui-sidebar/client/systemApi.ts';

type Rpc = { call<T>(m: string, p?: Record<string, unknown>, requestId?: string, timeoutMs?: number): Promise<T> };

/** 版本信息：本地版本 + 更新检查并取（simulate=测试通道，伪造 patch+1） */
export async function fetchVersion(simulate = false, rpc: Rpc = wireRpc): Promise<import('ac-client-ui-sidebar/client/systemApi.ts').VersionInfo> {
  return pkgFetchVersion(simulate, rpc);
}

/** changelog：项目根 CHANGELOG.md 读面（缺失 → 空文案）——owning =
 *  ac-client-ui-sidebar/client/systemApi.ts（M27.2-2 layout 件出包随件迁） */
export function fetchChangelog(rpc: Rpc = wireRpc): Promise<{ content?: string }> {
  return pkgFetchChangelog(rpc);
}

/** 版本更新：git 检出 stash→pull→install→build + 重启；npm 安装 unavailable */
export function runVersionUpdate(rpc: Rpc = wireRpc): Promise<{ status?: string; message?: string; steps?: string[] }> {
  return pkgRunVersionUpdate(rpc);
}

/** 立即备份（Sidebar 菜单；名字与 src 端点契约一致，最小组件 diff） */
export async function backupNow(rpc: Rpc = wireRpc): Promise<{ status?: string; file?: string; size?: number; keep?: number; error?: string }> {
  return pkgBackupNow(rpc);
}
