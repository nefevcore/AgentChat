// ============================================================
// 归档残留 pending 清理 单元测试
//
// 背景（2026-08-04 bug）：.archive_pending 残留（归档整理轮异常/重启打断
// 导致标记未清理）会让超时监视器误判"归档整理超时"并强制归档，
// 把最近对话也归档掉（20:47 把 20:44 的对话归档，会话割裂）。
//
// 修复：scanPendingArchives 启动即扫描残留 pending——
//   - 超时 → 强制归档（idleArchive, reason='pending-timeout'）
//   - 未超时 → 清理 pending + 写审查标记（不强制归档，避免误伤新对话）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

const mockCfg = vi.hoisted(() => ({ sessionsDir: '' }));
vi.mock('@agents/config', () => ({
  getGlobalConfig: () => ({ sessionsDir: mockCfg.sessionsDir }),
}));

import { scanPendingArchives } from '../src/plugins/builtin/extensions/agent-session/archive';

describe('归档残留 pending 清理 (scanPendingArchives)', () => {
  let sessionsDir: string;
  let pairDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(tmpdir(), 'agentchat-pending-'));
    pairDir = path.join(sessionsDir, 'agentA', 'agentB');
    fs.mkdirSync(pairDir, { recursive: true });
    mockCfg.sessionsDir = sessionsDir;
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  /** 写 .archive_pending（requestedAt 可指定，ISO） */
  function writePending(requestedAt: Date): void {
    fs.writeFileSync(
      path.join(pairDir, '.archive_pending'),
      JSON.stringify({
        agent: 'agentA', counterpart: 'agentB',
        participants: ['agentA'],
        requestedAt: requestedAt.toISOString(),
      }, null, 2),
      'utf-8',
    );
  }

  /** 写 messages.jsonl（2 行） */
  function writeMessages(): void {
    const lines = [
      { role: 'agent', content: '早期消息', timestamp: new Date().toISOString() },
      { role: 'agent', content: '近期消息', timestamp: new Date().toISOString() },
    ];
    fs.writeFileSync(path.join(pairDir, 'messages.jsonl'),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  }

  it('超时 pending → 强制归档（messages.jsonl 移入 archive/）且清理标记', async () => {
    writePending(new Date(Date.now() - 20 * 60 * 1000)); // 20 分钟前 → 超时
    writeMessages();

    const handled = await scanPendingArchives();

    expect(handled).toBe(1);
    // pending 已清理
    expect(fs.existsSync(path.join(pairDir, '.archive_pending'))).toBe(false);
    // 归档文件生成（history_1.jsonl）
    const archiveDir = path.join(pairDir, 'archive');
    expect(fs.existsSync(path.join(archiveDir, 'history_1.jsonl'))).toBe(true);
  });

  it('未超时残留 pending → 清理 + 写审查标记，messages.jsonl 保留（不误归档）', async () => {
    writePending(new Date(Date.now() - 60 * 1000)); // 1 分钟前 → 未超时
    writeMessages();

    const handled = await scanPendingArchives();

    expect(handled).toBe(1);
    // pending 已清理
    expect(fs.existsSync(path.join(pairDir, '.archive_pending'))).toBe(false);
    // messages.jsonl 保留（未强制归档）
    expect(fs.existsSync(path.join(pairDir, 'messages.jsonl'))).toBe(true);
    // 无归档文件生成
    expect(fs.existsSync(path.join(pairDir, 'archive'))).toBe(false);
    // 写审查标记兜底记忆整理
    expect(fs.existsSync(path.join(pairDir, '.memory_review_needed'))).toBe(true);
  });

  it('无 pending → 无操作', async () => {
    writeMessages();
    const handled = await scanPendingArchives();
    expect(handled).toBe(0);
    expect(fs.existsSync(path.join(pairDir, 'messages.jsonl'))).toBe(true);
  });
});
