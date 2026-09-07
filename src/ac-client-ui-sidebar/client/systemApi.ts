// ============================================================
// ac-client-ui-sidebar/client/systemApi.ts —— 系统小 API
//（M27.2-2 随 sidebar 件迁入：Sidebar 更多菜单的数据面）
//
// 自 webui api/system.ts 迁入（fetchVersion/backupNow——rpc 经
// ac-client-runtime 契约面注入，缺省由调用方（组件）传 ctx.rpc；
// fetchChangelog/runVersionUpdate 留 webui——VersionDialog 消费，
// 且 runVersionUpdate 需 10min 超时透传，超出 ctx.rpc 契约面）。
// webui api/system re-export 维持旧路径。
// ============================================================
type Rpc = { call<T>(m: string, p?: Record<string, unknown>): Promise<T> };

export interface VersionInfo {
  current?: string;
  latest?: string | null;
  hasUpdate?: boolean;
  latestUrl?: string | null;
  /** 检查失败（网络不可达/限流）——UI 显示"无法确认"而非"已是最新" */
  checkFailed?: boolean;
  /** 桌面壳装配（Electron）：更新归 electron-updater，UI 换桌面文案 */
  desktop?: boolean;
}

interface PCheckResult {
  current?: string;
  latest?: string | null;
  hasUpdate?: boolean;
  latestUrl?: string | null;
  checkFailed?: boolean;
  desktop?: boolean;
}

/** 版本信息：本地版本 + 更新检查并取（simulate=测试通道，伪造 patch+1） */
export async function fetchVersion(simulate: boolean, rpc: Rpc): Promise<VersionInfo> {
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

/** 立即备份（Sidebar 菜单；名字与 src 端点契约一致，最小组件 diff） */
export async function backupNow(rpc: Rpc): Promise<{ status?: string; file?: string; size?: number; keep?: number; error?: string }> {
  const r = await rpc.call<{ backup?: { file?: string; path?: string; size?: number; backups?: Array<unknown> } }>('backup/run');
  const b = r.backup ?? {};
  return { status: 'ok', file: b.file ?? b.path, size: b.size, keep: b.backups?.length };
}
