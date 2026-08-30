// ============================================================
// utils/streamingMarkdown.ts —— 流式 markdown 分块渲染
//
// 流式输出每帧都会收到新 delta；若每帧对"全部已累积内容"全量跑
// markdown-it + highlight.js + KaTeX，长消息呈 O(n²) 卡顿。
//
// 这里把内容切成"已提交前缀"与"待提交尾部"：
//   - 已提交：仅在跨越安全边界（代码围栏外的空行）时增长，HTML 可缓存复用；
//   - 待提交：HTML 转义后以纯文本追加显示，几乎零成本。
// 流式结束时由调用方全量渲染一次保证最终正确。
// ============================================================

export interface StreamSplit {
  /** 已提交前缀（可安全渲染为 markdown） */
  committed: string;
  /** 待提交尾部（转义显示） */
  pending: string;
  /** 是否仍在未闭合的代码围栏内 */
  inFence: boolean;
}

/** 安全切点扫描结果 */
export interface SafeSplitIndex {
  /** 围栏外最近一个"空行之后"的位置（块边界，-1 = 不存在） */
  blank: number;
  /** 围栏外最近一个"换行之后"的位置（-1 = 不存在） */
  newline: number;
  /** 扫描结束时是否仍在未闭合的代码围栏内 */
  inFence: boolean;
}

/**
 * 寻找内容中的安全切点。
 * 安全切点 = 代码围栏之外、紧跟换行（优先空行）之后的位置，markdown 块在此完整。
 * 注意：最后一行没有尾部换行，不产生切点（避免把"内容末尾"误判为安全切点）。
 */
export function findSafeSplitIndex(content: string): SafeSplitIndex {
  let inFence: string | null = null;
  let lastNewlineOutsideFence = -1;
  let lastBlankLine = -1;
  const lines = content.split('\n');
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (inFence) {
      if (line.trim().startsWith(inFence)) inFence = null;
    } else {
      const m = /^[ \t]*(```|~~~)/.exec(line);
      if (m) inFence = m[1];
    }
    if (!isLast) {
      // 该行之后存在真实换行（pos = 换行后的索引）
      pos += line.length + 1;
      if (!inFence) {
        lastNewlineOutsideFence = pos;
        if (line.trim() === '') lastBlankLine = pos;
      }
    }
  }
  return { blank: lastBlankLine, newline: lastNewlineOutsideFence, inFence: !!inFence };
}

/**
 * 流式内容切分。
 * @param maxPending 无空行时允许的最大待提交长度（超限强制切分，避免一直显示原始 markdown）
 */
export function splitStreamingContent(content: string, maxPending = 4000): StreamSplit {
  if (!content) return { committed: '', pending: '', inFence: false };
  const { blank, newline, inFence } = findSafeSplitIndex(content);

  // 有块边界（空行）→ 提交到最后一个空行，视觉与完整渲染基本一致
  if (blank > 0) {
    return { committed: content.slice(0, blank), pending: content.slice(blank), inFence };
  }
  // 无空行但围栏已闭合且内容较短 → 整体提交，避免长期显示原始 markdown
  if (!inFence && content.length <= maxPending) {
    return { committed: content, pending: '', inFence };
  }
  // 长内容强制切分（围栏内也切，避免 pending 无限增长；围栏短暂不完整，流式结束全量修复）
  if (content.length > maxPending) {
    const cut = inFence
      ? content.lastIndexOf('\n')
      : (newline > 0 ? newline : content.lastIndexOf('\n', maxPending));
    if (cut > 0) {
      return { committed: content.slice(0, cut), pending: content.slice(cut), inFence };
    }
  }
  // 单段无换行：仅当未在围栏内（或内容超长）时在词边界切分；
  // 未闭合围栏且内容较短 → 保持全部 pending，不破坏围栏
  if (!inFence || content.length > maxPending) {
    const wordCut = content.lastIndexOf(' ', maxPending);
    if (wordCut > 0) {
      return { committed: content.slice(0, wordCut), pending: content.slice(wordCut), inFence };
    }
  }
  return { committed: '', pending: content, inFence };
}
