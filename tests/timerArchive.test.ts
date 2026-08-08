// ============================================================
// TimerManager 一次性定时器完成归档 单元测试
//
// 背景（2026-08-02）：限定次数定时器（repeatCount>=1）完成后，
// 从 config.json 的 timer.entries 移除并追加到 <agentDir>/timer-archive.jsonl，
// 便于复盘 Agent 设置过的定时器，同时让配置文件保持干净。
// 永久定时器（repeatCount=0）走独立分支，不受归档影响。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { TimerManager } from '@plugins/builtin/services/timer';

describe('TimerManager 一次性定时器完成归档', () => {
  let agentsDir: string;
  let agentDir: string;
  let cfgPath: string;
  let mgr: any;

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(tmpdir(), 'agentchat-timer-arc-'));
    agentDir = path.join(agentsDir, 'test_agent');
    fs.mkdirSync(agentDir, { recursive: true });
    cfgPath = path.join(agentDir, 'config.json');
    mgr = new TimerManager({ agentsDir, workspaceDir: agentsDir, timezone: 'Asia/Shanghai' }) as any;
  });

  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  function writeConfig(entries: any[]) {
    fs.writeFileSync(cfgPath, JSON.stringify({
      agent_id: 'test_agent',
      timer: { entries },
    }, null, 2), 'utf-8');
  }

  it('一次性定时器完成：从 config 移除 + 写入归档文件', () => {
    writeConfig([{
      id: 't1', enabled: true, mode: 'delay', delay: '1s',
      hint: '一次性提醒', target: 'user', repeatCount: 1,
    }]);
    const entry = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).timer.entries[0];

    (mgr as any).archiveCompletedEntry('test_agent', entry, 1);

    // config 条目被移除
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.timer.entries.length).toBe(0);

    // 归档文件生成且含完整记录
    const archivePath = path.join(agentDir, 'timer-archive.jsonl');
    expect(fs.existsSync(archivePath)).toBe(true);
    const rec = JSON.parse(fs.readFileSync(archivePath, 'utf-8').trim());
    expect(rec.id).toBe('t1');
    expect(rec.status).toBe('completed');
    expect(rec.executedCount).toBe(1);
    expect(rec.repeatCount).toBe(1);
    expect(rec.hint).toBe('一次性提醒');
    expect(rec.completedAt).toBeTruthy();
  });

  it('多次(N>1)定时器完成后归档 executedCount=N', () => {
    writeConfig([{
      id: 't3', enabled: true, mode: 'delay', delay: '1h',
      hint: '重复三次', target: 'user', repeatCount: 3,
    }]);
    const entry = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).timer.entries[0];

    (mgr as any).archiveCompletedEntry('test_agent', entry, 3);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.timer.entries.length).toBe(0);
    const rec = JSON.parse(fs.readFileSync(path.join(agentDir, 'timer-archive.jsonl'), 'utf-8').trim());
    expect(rec.executedCount).toBe(3);
    expect(rec.status).toBe('completed');
  });

  it('归档 append-only：多次完成追加多行', () => {
    writeConfig([
      { id: 'a', enabled: true, mode: 'delay', delay: '1s', hint: 'A', target: 'user', repeatCount: 1 },
      { id: 'b', enabled: true, mode: 'delay', delay: '1s', hint: 'B', target: 'user', repeatCount: 1 },
    ]);
    (mgr as any).archiveCompletedEntry('test_agent', { id: 'a', mode: 'delay', delay: '1s', hint: 'A', target: 'user', repeatCount: 1, enabled: true }, 1);
    (mgr as any).archiveCompletedEntry('test_agent', { id: 'b', mode: 'delay', delay: '1s', hint: 'B', target: 'user', repeatCount: 1, enabled: true }, 1);

    const lines = fs.readFileSync(path.join(agentDir, 'timer-archive.jsonl'), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).id).toBe('a');
    expect(JSON.parse(lines[1]).id).toBe('b');
  });
});
