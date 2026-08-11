// ============================================================
// tests/webui-streaming-markdown.test.ts
// splitStreamingContent / findSafeSplitIndex：流式 markdown 分块切分
// ============================================================

import { describe, it, expect } from 'vitest';
import { splitStreamingContent, findSafeSplitIndex } from '../src/ui/webui/src/utils/streamingMarkdown';

describe('findSafeSplitIndex', () => {
  it('空内容', () => {
    expect(findSafeSplitIndex('')).toEqual({ blank: -1, newline: -1, inFence: false });
  });

  it('空行块边界', () => {
    const r = findSafeSplitIndex('第一段\n\n第二段');
    expect(r.blank).toBe('第一段\n\n'.length); // 5（第一个空行之后）
    expect(r.newline).toBe('第一段\n\n'.length); // 围栏外最近换行 = 空行处（末行无换行，不计）
    expect(r.inFence).toBe(false);
  });

  it('代码围栏内的空行不算安全切点', () => {
    const content = '```\ncode line 1\n\ncode line 2\n```';
    const r = findSafeSplitIndex(content);
    // 围栏内有两个换行，但都在围栏内 → 不记录
    expect(r.blank).toBe(-1);
    expect(r.inFence).toBe(false); // 围栏已闭合
  });

  it('未闭合代码围栏', () => {
    const r = findSafeSplitIndex('```ts\nconst a = 1');
    expect(r.inFence).toBe(true);
    expect(r.blank).toBe(-1);
    expect(r.newline).toBe(-1);
  });
});

describe('splitStreamingContent', () => {
  it('空内容', () => {
    expect(splitStreamingContent('')).toEqual({ committed: '', pending: '', inFence: false });
  });

  it('有块边界 → 提交到最后一个空行', () => {
    const r = splitStreamingContent('第一段\n\n第二段\n\n第三段ing');
    expect(r.committed).toBe('第一段\n\n第二段\n\n');
    expect(r.pending).toBe('第三段ing');
  });

  it('短内容无空行 → 整体提交', () => {
    const r = splitStreamingContent('只是一句话');
    expect(r.committed).toBe('只是一句话');
    expect(r.pending).toBe('');
  });

  it('短代码块（已闭合）→ 整体提交', () => {
    const content = '```\ncode\n```';
    const r = splitStreamingContent(content);
    expect(r.committed).toBe(content);
    expect(r.pending).toBe('');
  });

  it('未闭合代码围栏 → 保持 pending（不破坏围栏）', () => {
    const content = '```ts\nconst a = 1';
    const r = splitStreamingContent(content);
    expect(r.inFence).toBe(true);
    expect(r.committed).toBe('');
    expect(r.pending).toBe(content);
  });

  it('超长单段无空行 → 在词边界强制切分', () => {
    const word = 'word '.repeat(2000); // ~10000 chars，无空行
    const r = splitStreamingContent(word, 2000);
    expect(r.committed + r.pending).toBe(word);
    expect(r.committed.length).toBeGreaterThan(0);
    expect(r.committed.length).toBeLessThanOrEqual(2000);
    // 切分点本身是空格（committed 截止到空格之前，空格是 pending 的首字符）
    expect(word[r.committed.length]).toBe(' ');
  });

  it('长未闭合围栏 → 强制在换行处切分', () => {
    const content = '```\n' + 'line\n'.repeat(1000); // 长未闭合围栏
    const r = splitStreamingContent(content, 2000);
    expect(r.committed.length).toBeGreaterThan(0);
    expect(r.committed + r.pending).toBe(content);
  });
});
