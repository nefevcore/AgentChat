// ============================================================
// agent-datetime 回归：
//   · datetimeLine 仅日期 + 星期（无时分）
//   · runStart：日期行追加到 system prompt 尾部（不触碰消息流）
//   · 独立会话（single~）跳过：会话提示词全静态（最大 KV cache）
//   · 群组（group~）注入（1v1/群组对话需要日期感知）
//   · 无会话键（子 Agent）跳过
//   · enabled=false → 工厂返回 null（钩子不入列）
// ============================================================
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@agentchat/agent-config';
import type { CurrentContext } from '@agentchat/agent-loop';
import { datetimeLine } from '../src/datetime';
import { makeDatetimeHook } from '../src/datetime-hook';

// 2026-08-18 周二（本地时区构造，断言只看格式字段）
const NOW = new Date(2026, 7, 18);

describe('datetimeLine', () => {
  it('仅日期 + 星期（无时分）', () => {
    expect(datetimeLine(NOW)).toBe('[当前时间] 2026-08-18 周二');
  });
});

describe('makeDatetimeHook（runStart 钩子）', () => {
  const mkCtx = (dialogId?: string): CurrentContext => ({
    agentId: 'admin',
    ...(dialogId ? { dialogId } : {}),
    systemPrompt: '## 持久化存储\n…\n\n## 对话信息\n[当前对话对象] user - 用户',
    tools: new Map(),
  }) as unknown as CurrentContext;

  it('1v1：日期行追加到 system prompt 尾部（仅日期，无时分）', async () => {
    const hook = makeDatetimeHook({ agent_id: 'admin', name: '艾吉' } as AgentConfig);
    expect(hook).not.toBeNull();
    const ctx = mkCtx('chat~admin~user');
    const before = ctx.systemPrompt;
    await hook!(ctx);
    expect(ctx.systemPrompt.startsWith(before)).toBe(true);      // 既有装配原样保留在前
    expect(ctx.systemPrompt).toContain('\n\n[当前时间] ');
    expect(ctx.systemPrompt).not.toMatch(/\d{2}:\d{2}/);          // 无时分（跨小时稳定）
  });

  it('群组（group~）同样注入', async () => {
    const hook = makeDatetimeHook({ agent_id: 'admin', name: '艾吉' } as AgentConfig);
    const ctx = mkCtx('group~g1~admin');
    await hook!(ctx);
    expect(ctx.systemPrompt).toContain('[当前时间] ');
  });

  it('独立会话（single~）跳过：会话提示词全静态（最大 KV cache）', async () => {
    const hook = makeDatetimeHook({ agent_id: '__standard__', name: '标准模式' } as AgentConfig);
    const ctx = mkCtx('single~11111111-1111-4111-8111-111111111111');
    const before = ctx.systemPrompt;
    await hook!(ctx);
    expect(ctx.systemPrompt).toBe(before); // 未被改动
  });

  it('无会话键（子 Agent）跳过', async () => {
    const hook = makeDatetimeHook({ agent_id: 'admin', name: '艾吉' } as AgentConfig);
    const ctx = mkCtx();
    const before = ctx.systemPrompt;
    await hook!(ctx);
    expect(ctx.systemPrompt).toBe(before);
  });

  it('systemPrompt 为空时独立成行（钩子顺序无关的健壮性）', async () => {
    const hook = makeDatetimeHook({ agent_id: 'admin', name: '艾吉' } as AgentConfig);
    const ctx = { ...mkCtx('chat~admin~user'), systemPrompt: '' } as unknown as CurrentContext;
    await hook!(ctx);
    expect(ctx.systemPrompt).toMatch(/^\[当前时间\] \d{4}-\d{2}-\d{2} 周[一二三四五六日]$/);
  });

  it('agent.datetime.enabled=false → 返回 null（钩子不入列）', () => {
    const hook = makeDatetimeHook({
      agent_id: 'admin',
      name: '艾吉',
      'agent.datetime': { enabled: false },
    } as unknown as AgentConfig);
    expect(hook).toBeNull();
  });
});
