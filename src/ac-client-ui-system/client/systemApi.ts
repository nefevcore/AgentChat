// ============================================================
// ac-client-ui-sidebar/client/systemApi.ts —— 系统小 API
//（M27.2-2 随 sidebar 件迁入：Sidebar 更多菜单的数据面）
//
// 自 webui api/system.ts 迁入（fetchVersion/backupNow——rpc 经
// ac-client-runtime 契约面注入，缺省由调用方（组件）传 ctx.rpc；
// fetchChangelog/runVersionUpdate 留 webui——VersionDialog 消费，
// 且 runVersionUpdate 需 10min 超时透传，超出 ctx.rpc 契约面）。
// 原 webui api/system 门面已退役〔M28 §4.2〕。
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

// ---- 版本面其余两接口（M27.2-2 layout 件出包随件迁：VersionDialog
//      消费——rpc 契约面注入；runVersionUpdate 的 10min 超时经
//      call timeoutMs 透传） ----

type FullRpc = { call<T>(m: string, p?: Record<string, unknown>, requestId?: string, timeoutMs?: number): Promise<T> };

/** changelog：项目根 CHANGELOG.md 读面（缺失 → 空文案） */
export async function fetchChangelog(rpc: Rpc): Promise<{ content?: string }> {
  return rpc.call<{ content?: string }>('system/version-changelog');
}

/** 版本更新：git 检出 stash→pull→install→build + 重启；npm 安装 unavailable */
export async function runVersionUpdate(rpc: FullRpc): Promise<{ status?: string; message?: string; steps?: string[] }> {
  // install+build 分钟级：60s 缺省超时不够，拉长到 10min
  return rpc.call<{ status?: string; message?: string; steps?: string[] }>('system/version-update', {}, undefined, 600_000);
}
