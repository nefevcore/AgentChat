// ============================================================
// view-model/display.ts —— 渲染视图模型（UI 层）
//
// DisplayItem / insertTimeSeparators 是"如何展示"的产物，
// 属于视图层而非数据层（domain）。数据层只产出 Turn 列表。
// ============================================================

import type { Turn } from '@/domain/types';
import { formatRelativeTime } from '@/domain/format';

export type DisplayItemType = 'message' | 'turn' | 'time-separator' | 'trigger';

export interface DisplayItem {
  type: DisplayItemType;
  turn?: Turn;
  index: number;
  isStreaming?: boolean;
  timeText?: string;
}

/** 相邻 Turn 时间间隔超过该值（分钟）则插入时间分隔符 */
const TIME_SEPARATOR_GAP_MIN = 5;

export function insertTimeSeparators(items: DisplayItem[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  let prevTs: number | null = null;
  for (const item of items) {
    const ts = item.turn?.final?.timestamp ?? item.turn?.steps?.[0]?.assistant?.timestamp;
    if (ts && prevTs !== null && ts - prevTs > TIME_SEPARATOR_GAP_MIN * 60 * 1000) {
      result.push({ type: 'time-separator', index: item.index, timeText: formatRelativeTime(ts) });
    }
    if (ts) prevTs = ts;
    result.push(item);
  }
  return result;
}
