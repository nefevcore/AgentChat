// ============================================================
// 格式化工具函数（仅保留有调用方的：formatFileSize / formatRelativeTime /
// 时间分隔符插入管线；此前的 formatNumber/formatRate/formatTime/
// getFileType/truncateText 均无调用方已删除——TokenUsage/TimerPane 各自
// 持有本地变体）
// ============================================================

export function formatFileSize(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ============================================================
// 时间分隔符 & Turn 渲染管线（ChatView / GroupChat 共享）
// ============================================================

import type { Turn, DisplayItem } from '../types';

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

/** 两条消息之间插入时间分隔符的最小间隔（毫秒），默认 5 分钟 */
export const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

function getItemTimestamp(item: DisplayItem): number {
  if (item.turn?.steps[0]) return item.turn.steps[0].assistant.timestamp;
  if (item.turn?.final) return item.turn.final.timestamp;
  return 0;
}

/** 在 DisplayItem 列表中插入时间分隔符 */
export function insertTimeSeparators(items: DisplayItem[]): DisplayItem[] {
  if (items.length <= 1) return items;
  const out: DisplayItem[] = [];
  for (let k = 0; k < items.length; k++) {
    // event/error 分隔符自带时间戳时，不再在其前面额外插入 time-separator，
    // 避免同一时间点出现两行时间（时间被 trigger hint 等事件文本“盖住/重复”的问题）。
    const selfTimestamped = (items[k].type === 'event' || items[k].type === 'error') && !!items[k].timestamp;
    if (k > 0 && !selfTimestamped) {
      const prevTs = getItemTimestamp(items[k - 1]);
      const currTs = getItemTimestamp(items[k]);
      if (prevTs > 0 && currTs > 0 && (currTs - prevTs) >= TIME_SEPARATOR_GAP_MS) {
        out.push({ type: 'time-separator', index: -1, timeText: formatRelativeTime(currTs), timestamp: currTs, key: `ts-${currTs}` });
      }
    }
    out.push(items[k]);
  }
  return out;
}
