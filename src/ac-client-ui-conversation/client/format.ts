// ============================================================
// 格式化工具函数（仅保留有调用方的：formatFileSize / formatRelativeTime /
// formatDurationMs / 时间分隔符插入管线）
//
// M28 P3：三个纯函数下沉 @agentchat/webui-kit（跨域消费面 runview/
// singles 经 kit 直连）；本模块 re-export 维持旧导出面 + 保留
// conversation 域内的时间分隔符插入管线（Turn/DisplayItem 依赖）。
// ============================================================

export { formatFileSize, formatDurationMs, formatRelativeTime } from '@agentchat/webui-kit/src/format.ts';
import { formatRelativeTime } from '@agentchat/webui-kit/src/format.ts';

// ============================================================
// 时间分隔符 & Turn 渲染管线（ChatView / GroupChat 共享）
// ============================================================

import type { Turn, DisplayItem } from './types.ts';

/** 两条消息之间插入时间分隔符的最小间隔（毫秒），默认 5 分钟 */
const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

/** 连排 hint（event/error 分隔）归并时间戳的窗口（毫秒）：3 分钟内的连续
 *  hint 只在首条显示时间（回执/回触/通知链不再每条带时间——2026-09-02
 *  反馈：时间戳显示太多） */
const HINT_TIME_GROUP_MS = 3 * 60 * 1000;

function getItemTimestamp(item: DisplayItem): number {
  if (item.turn?.steps[0]) return item.turn.steps[0].assistant.timestamp;
  if (item.turn?.final) return item.turn.final.timestamp;
  return 0;
}

/** 在 DisplayItem 列表中插入时间分隔符；连排 hint 归并时间戳（showTime） */
export function insertTimeSeparators(items: DisplayItem[]): DisplayItem[] {
  if (items.length <= 1) return items;
  const out: DisplayItem[] = [];
  /** 上一条"时间锚"（hint 链首条或 time-separator）的时刻——窗口内的
   *  后续 hint 不再显示自身时间；正常消息（turn）重置连排 */
  let lastTimeAnchorTs: number | undefined;
  for (let k = 0; k < items.length; k++) {
    // event/error 分隔符自带时间戳时，不再在其前面额外插入 time-separator，
    // 避免同一时间点出现两行时间（时间被 trigger hint 等事件文本“盖住/重复”的问题）。
    const selfTimestamped = (items[k].type === 'event' || items[k].type === 'error') && !!items[k].timestamp;
    if (k > 0 && !selfTimestamped) {
      const prevTs = getItemTimestamp(items[k - 1]);
      const currTs = getItemTimestamp(items[k]);
      if (prevTs > 0 && currTs > 0 && (currTs - prevTs) >= TIME_SEPARATOR_GAP_MS) {
        out.push({ type: 'time-separator', index: -1, timeText: formatRelativeTime(currTs), timestamp: currTs, key: `ts-${currTs}` });
        lastTimeAnchorTs = currTs; // time-separator 已显时间：紧随的 hint 不再重复
      }
    }
    const item = items[k];
    if (item.type === 'event' || item.type === 'error') {
      const ts = item.timestamp ?? 0;
      item.showTime = !(lastTimeAnchorTs !== undefined && ts > 0 && ts - lastTimeAnchorTs < HINT_TIME_GROUP_MS);
      if (item.showTime && ts > 0) lastTimeAnchorTs = ts;
    } else if (item.type === 'turn') {
      lastTimeAnchorTs = undefined; // 正常消息重置连排
    }
    out.push(item);
  }
  return out;
}
