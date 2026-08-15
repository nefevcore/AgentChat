// ============================================================
// loadGroupHistory 回归测试 —— 群聊历史注入（重构恢复）
//
// 背景：5 层架构重构时丢失了旧 agent-session 的 loadGroupHistory
//（未归档群聊历史注入 + <msg> 格式化 + 合并相邻发言 + 超限截断），
// 本测试锁定恢复后的行为契约。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadGroupHistory } from '@agentchat/agent-session';

describe('loadGroupHistory 群聊历史注入', () => {
  const gid = 'g1';
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-gh-'));
    vi.stubEnv('AGENTCHAT_WORKSPACE', tmp);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function messagesFile(): string {
    return path.join(tmp, 'sessions', `group~${gid}`, 'messages.jsonl');
  }

  function writeMessages(msgs: Record<string, unknown>[]): void {
    const f = messagesFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, msgs.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  }

  function writeGroupConfig(name: string): void {
    const f = path.join(tmp, 'groups', gid, 'group.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ group_id: gid, name }), 'utf-8');
  }

  it('无群聊本体文件时返回空数组', () => {
    expect(loadGroupHistory(gid, 'news')).toEqual([]);
  });

  it('非当前视角消息封装 <msg> 标签（含名称/群名映射），自身消息不套', () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '我自己的播报', timestamp: '2026-08-09T00:00:00Z' },
      { role: 'agent', agent_id: 'neko', content: '收到喵', timestamp: '2026-08-09T00:00:01Z' },
      { role: 'agent', agent_id: 'news', content: '我再补充一句', timestamp: '2026-08-09T00:00:02Z' },
    ]);
    const h = loadGroupHistory(gid, 'news', {
      getName: (id) => ({ neko: 'Neko', user: '风栗' }[id] ?? id),
      getGroupName: () => '聊天群',
    });
    expect(h).toHaveLength(3);
    // 自身消息不套 <msg>
    expect(h[0].content).toBe('我自己的播报');
    expect(h[2].content).toBe('我再补充一句');
    // 他人消息套 <msg>，含 from/name/group
    expect(h[1].content).toContain('<msg from="neko" name="Neko" group="聊天群">收到喵</msg>');
  });

  it('user 消息视为对方，同样封装 <msg>', () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '播报', timestamp: '2026-08-09T00:00:00Z' },
      { role: 'agent', agent_id: 'user', content: '早', timestamp: '2026-08-09T00:00:01Z' },
    ]);
    const h = loadGroupHistory(gid, 'news', {
      getName: (id) => (id === 'user' ? '风栗' : id),
      getGroupName: () => '聊天群',
    });
    expect(h).toHaveLength(2);
    expect(h[1].content).toContain('<msg from="user" name="风栗" group="聊天群">早</msg>');
  });

  it('名称映射缺失时回退 agent_id；群名注入缺失时读 group.json，再回退群 ID', () => {
    writeMessages([
      { role: 'agent', agent_id: 'neko', content: '喵', timestamp: '2026-08-09T00:00:00Z' },
    ]);
    // 无 getName / getGroupName：名称回退 agent_id；群名回退 group.json
    writeGroupConfig('研发群');
    const h1 = loadGroupHistory(gid, 'news');
    expect(h1[0].content).toContain('name="neko" group="研发群"');

    // 无 group.json：群名回退群 ID
    fs.rmSync(path.join(tmp, 'groups'), { recursive: true, force: true });
    const h2 = loadGroupHistory(gid, 'news');
    expect(h2[0].content).toContain(`group="${gid}"`);
  });

  it('合并相邻"对方视角"纯发言（连续对方消息合成一条，<msg> 标签区分发言人）', () => {
    writeMessages([
      { role: 'agent', agent_id: 'neko', content: '第一句', timestamp: '2026-08-09T00:00:00Z' },
      { role: 'agent', agent_id: 'chat_agent', content: '第二句', timestamp: '2026-08-09T00:00:01Z' },
      { role: 'agent', agent_id: 'news', content: '我插一句', timestamp: '2026-08-09T00:00:02Z' },
      { role: 'agent', agent_id: 'test', content: '第三句', timestamp: '2026-08-09T00:00:03Z' },
    ]);
    const h = loadGroupHistory(gid, 'news');
    // neko + chat_agent 合并为一条；news 自身；test 单独
    expect(h).toHaveLength(3);
    expect(h[0].content).toContain('第一句');
    expect(h[0].content).toContain('第二句');
    expect(h[0].content).toContain('</msg>\n<msg');
    expect(h[1].content).toBe('我插一句');
    expect(h[2].content).toContain('第三句');
  });

  it('超限截断保留尾部近期（groupLoadLimitTokens）', () => {
    // 写 5 条长消息，让总 token 超 100
    writeMessages([
      { role: 'agent', agent_id: 'neko', content: 'A'.repeat(300), timestamp: '2026-08-09T00:00:00Z' },
      { role: 'agent', agent_id: 'news', content: 'B'.repeat(300), timestamp: '2026-08-09T00:00:01Z' },
      { role: 'agent', agent_id: 'neko', content: 'C'.repeat(300), timestamp: '2026-08-09T00:00:02Z' },
      { role: 'agent', agent_id: 'test', content: 'D'.repeat(300), timestamp: '2026-08-09T00:00:03Z' },
      { role: 'agent', agent_id: 'neko', content: 'E'.repeat(300), timestamp: '2026-08-09T00:00:04Z' },
    ]);
    const h = loadGroupHistory(gid, 'news', { groupLoadLimitTokens: 100 });
    expect(h.length).toBeGreaterThan(0);
    expect(h.length).toBeLessThan(5);
    // 保留尾部近期：最后一条（E）必须在
    expect(h[h.length - 1].content).toContain('E');
  });

  it('超限截断不触发时返回全部合并结果', () => {
    writeMessages([
      { role: 'agent', agent_id: 'neko', content: '短', timestamp: '2026-08-09T00:00:00Z' },
      { role: 'agent', agent_id: 'news', content: '短', timestamp: '2026-08-09T00:00:01Z' },
    ]);
    const h = loadGroupHistory(gid, 'news', { groupLoadLimitTokens: 100000 });
    expect(h).toHaveLength(2);
  });
});
