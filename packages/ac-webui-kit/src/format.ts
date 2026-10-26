// ============================================================
// webui-kit/src/format.ts —— 通用格式化纯函数（M28 P3 自
// ac-client-ui-conversation/client/format.ts 下沉——跨域消费面
//〔runview/singles〕经 kit 直连，conversation re-export 维持旧路径）
// ============================================================

export function formatFileSize(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/** 运行时长（m:ss / h:mm:ss；负值归零——时钟回拨防御） */
export function formatDurationMs(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/** 相对时间格式化 */
export function formatRelativeTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return `今天 ${timeStr}`;
  if (diffDays === 1) return `昨天 ${timeStr}`;
  if (diffDays === 2) return `前天 ${timeStr}`;
  if (diffDays <= 7) return `${diffDays}天前 ${timeStr}`;
  const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (d.getFullYear() === now.getFullYear()) return `${dateStr} ${timeStr}`;
  return `${d.getFullYear()}-${dateStr} ${timeStr}`;
}
