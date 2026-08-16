// ============================================================
// makeLoadHistoryHook 群聊 trigger hint 去重测试
//
// 背景（8/16 现场复现）：deliverGroupMessage 先 emit group.message.received
// （GroupService 同步落盘 messages.jsonl）→ 后 emit group.trigger（通知参与者）。
// 参与者 runStart 加载历史时，刚落盘的消息已写入 messages.jsonl
// （loadGroupHistory 会包含它），而 trigger hint 又携带同一消息
// （router.ts _wireGroupTriggers 的 <msg> 封装与 loadGroupHistory 逐字一致）
// → LLM 上下文同一条消息出现两次 → Agent 判为「消息重复投递」。
//
// 修复：makeLoadHistoryHook 群聊分支剔除历史末尾与 hint 相同的消息
// （hint 已携带，无需历史再注入）。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeLoadHistoryHook } from '@agentchat/agent-session';
import { CHAT_START_META_KEY } from '@agentchat/contracts';
import type { CurrentContext } from '@agentchat/agent-loop';

describe('makeLoadHistoryHook 群聊 trigger hint 去重', () => {
  const gid = 'g1';
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-ghd-'));
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

  function makeCtx(overrides: Partial<CurrentContext> = {}): CurrentContext {
    return {
      llm: {} as any,
      systemPrompt: '',
      history: [],
      tools: new Map(),
      inbox: { nextTurn: [], nextStep: [] },
      dialogId: `group~${gid}~neko`,
      agentId: 'neko',
      ...overrides,
    } as CurrentContext;
  }

  function makeHook() {
    // services 仅需要 router（getName/getGroupName 注入）；未注入时回退 agent_id/群 ID，不影响去重判定
    return makeLoadHistoryHook({ agent_id: 'neko' } as any, { router: undefined } as any);
  }

  it('群聊 trigger：历史末尾与 hint 相同的消息被剔除（单条独立场景）', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '晚间速递内容', timestamp: '2026-08-16T12:00:00Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '<msg from="news" name="news" group="愉快玩耍">晚间速递内容</msg>\n\n[当前时间] 2026-08-16 20:00 周日\n收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊——直接输出文本不会发送到群聊、其他成员看不到；若无话可说则保持沉默，请注意不要刷屏。',
          source: { kind: 'group', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    // 历史只加载 hint 之前的内容；本条被剔除（hint 已携带）→ history 为空
    expect(ctx.history).toHaveLength(0);
  });

  it('群聊 trigger：历史末尾 hint 相同 + 更早历史共存时，只剔除末尾一条', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'chat_agent', content: '更早的消息', timestamp: '2026-08-16T11:50:00Z' },
      { role: 'agent', agent_id: 'news', content: '晚间速递内容', timestamp: '2026-08-16T12:00:00Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '<msg from="news" name="news" group="愉快玩耍">晚间速递内容</msg>\n\n[当前时间] 2026-08-16 20:00 周日\n收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊。',
          source: { kind: 'group', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('更早的消息');
    expect(ctx.history[0].content).not.toContain('晚间速递内容');
  });

  it('群聊 trigger：合并场景（相邻对方视角已合并）剔除末尾 hint 段', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'chat_agent', content: '第一条', timestamp: '2026-08-16T11:59:00Z' },
      { role: 'agent', agent_id: 'test', content: '第二条', timestamp: '2026-08-16T11:59:01Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '<msg from="test" name="test" group="愉快玩耍">第二条</msg>\n\n[当前时间] 2026-08-16 20:00 周日\n收到群聊消息。',
          source: { kind: 'group', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    // 两条对方消息被 loadGroupHistory 合并为一条；末尾 hint 段被剔除，保留第一条
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('第一条');
    expect(ctx.history[0].content).not.toContain('第二条');
  });

  it('非群聊 trigger（无 hint 或 hint 非 <msg 开头）不剔除历史', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '正常历史', timestamp: '2026-08-16T11:00:00Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    // 无 meta（如用户主动打开群聊历史加载）
    const ctx = makeCtx({});
    await hook(ctx);
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('正常历史');
  });

  it('1v1 会话不走群聊分支（不受 hint 去重影响）', async () => {
    const hook = makeHook();
    const ctx = makeCtx({
      dialogId: 'chat~neko~news',
      agentId: 'neko',
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '任意 hint',
          source: { kind: 'system', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    // 1v1 无历史文件 → 空；不抛错即可（关键是不进入群聊分支）
    expect(ctx.history).toEqual([]);
  });
});
