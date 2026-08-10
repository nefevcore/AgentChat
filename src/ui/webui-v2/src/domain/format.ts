// ============================================================
// domain/format.ts —— 纯格式化函数（零 UI 依赖，可单测）
// ============================================================

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatNumber(num: number): string {
  return num?.toLocaleString() || '0';
}

export function formatRate(rate: number): string {
  if (rate === undefined || rate === null) return '0.0%';
  return (rate * 100).toFixed(1) + '%';
}

export function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function getFileType(filename: string): string {
  const ext = filename?.split('.').pop()?.toLowerCase();
  const typeMap: Record<string, string> = {
    pdf: 'PDF', doc: 'DOC', docx: 'DOC', txt: 'TXT',
    jpg: 'IMG', png: 'IMG', gif: 'IMG', svg: 'IMG',
    mp4: 'VID', mp3: 'AUD', zip: 'ZIP', rar: 'ZIP',
  };
  return typeMap[ext || ''] || 'FILE';
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/** 相对时间（今天/昨天/N天前） */
export function formatRelativeTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return `今天 ${timeStr}`;
  if (diffDays === 1) return `昨天 ${timeStr}`;
  if (diffDays > 1 && diffDays < 7) return `${diffDays} 天前 ${timeStr}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
