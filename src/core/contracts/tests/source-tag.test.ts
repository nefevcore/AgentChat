import { describe, it, expect } from 'vitest';
import { makeSourceTagStepStartHook, makeSourceContractRunStartHook } from '../src/source-tag';
import type { SourceTagContract } from '../src/source-tag';
import type { AgentMessage } from '@agentchat/types';

/**
 * 来源标签钩子工厂（@agentchat/contracts）测试：
 *   · 机制与内容分离——工厂只有机械部分（拷贝替换保落盘纯净、
 *     WeakSet 幂等、小节追加），标签与协议文本由各域插件自带契约
 *   · 无中心注册表：各域钩子只处理自己契约的 kind，互不重叠；
 *     某域行停用只移除该域的标签与小节，其余域不受影响
 *   · 打标发生在 stepStart（LLM 请求之前），provider 无关
 */

const TIMER: SourceTagContract = {
  kind: 'timer',
  tag: () => '[定时触发]',
  contractSection: '## 消息来源：定时任务\n- `[定时触发]` …',
};
const AGENT_RELAY: SourceTagContract = {
  kind: 'agent',
  tag: (_s, agentId) => (agentId ? `[来自 Agent "${agentId}" 的消息]` : '[来自其他 Agent 的消息]'),
  contractSection: '## 消息来源：Agent 协作\n- `[来自 Agent "id" 的消息]` …',
};

describe('makeSourceTagStepStartHook —— 打标机械', () => {
  it('只处理本契约 kind 的消息；正文前拼标签；原对象不被改写（落盘纯净）', async () => {
    const hook = makeSourceTagStepStartHook(TIMER);
    const timerMsg: AgentMessage = { role: 'user', content: '到点检查新闻', source: { kind: 'timer', form: 'hint' } };
    const otherMsg: AgentMessage = { role: 'user', content: '帮我查一下', agent_id: 'bob', source: { kind: 'agent', form: 'relay' } };
    const messages = [{ role: 'system', content: 'sys' } as any, timerMsg as any, otherMsg as any];
    await hook({} as any, messages as any[]);
    expect(messages[1].content).toBe('[定时触发]\n到点检查新闻');
    expect(timerMsg.content).toBe('到点检查新闻');
    // 非 timer kind 原样（归其域钩子处理）
    expect(messages[2].content).toBe('帮我查一下');
  });

  it('真实用户消息（无 source / kind=user）不打标；跨 step 幂等', async () => {
    const hook = makeSourceTagStepStartHook(TIMER);
    const messages = [
      { role: 'user', content: '你好' },
      { role: 'user', content: 'tick', source: { kind: 'timer', form: 'hint' } },
    ] as any[];
    await hook({} as any, messages);
    await hook({} as any, messages);
    await hook({} as any, messages);
    expect(messages[0].content).toBe('你好');
    expect(messages[1].content).toBe('[定时触发]\ntick');
  });

  it('多域钩子接力：同一数组先经 timer 钩子再经 agent 钩子，各自只动自己的 kind', async () => {
    const timerHook = makeSourceTagStepStartHook(TIMER);
    const agentHook = makeSourceTagStepStartHook(AGENT_RELAY);
    const messages = [
      { role: 'user', content: 'tick', source: { kind: 'timer', form: 'hint' } },
      { role: 'user', content: '帮我查一下', agent_id: 'agent-bob', source: { kind: 'agent', form: 'relay' } },
    ] as any[];
    await timerHook({} as any, messages);
    await agentHook({} as any, messages);
    // 再各跑一遍（跨 step）：不双重打标
    await timerHook({} as any, messages);
    await agentHook({} as any, messages);
    expect(messages[0].content).toBe('[定时触发]\ntick');
    expect(messages[1].content).toBe('[来自 Agent "agent-bob" 的消息]\n帮我查一下');
  });

  it('step 间新注入的 steer 消息同样被打标；tool/assistant 不受影响', async () => {
    const hook = makeSourceTagStepStartHook(AGENT_RELAY);
    const messages: any[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ];
    await hook({} as any, messages);
    messages.push({ role: 'user', content: '新指令', agent_id: 'agent-bob', source: { kind: 'agent', form: 'relay' } });
    await hook({} as any, messages);
    expect(messages[1].content).toBe('ok');
    expect(messages[2].content).toBe('[来自 Agent "agent-bob" 的消息]\n新指令');
  });
});

describe('makeSourceContractRunStartHook —— 协议小节', () => {
  it('追加本域小节到 systemPrompt 尾部', async () => {
    const hook = makeSourceContractRunStartHook(TIMER);
    const ctx = { systemPrompt: '基础提示词' } as any;
    await hook(ctx);
    expect(ctx.systemPrompt.startsWith('基础提示词\n\n## 消息来源：定时任务')).toBe(true);
    expect(ctx.systemPrompt).toContain('[定时触发]');
  });

  it('多域小节并列追加（无中心协调，顺序=钩子注册序）', async () => {
    const timerHook = makeSourceContractRunStartHook(TIMER);
    const agentHook = makeSourceContractRunStartHook(AGENT_RELAY);
    const ctx = { systemPrompt: '基础提示词' } as any;
    await timerHook(ctx);
    await agentHook(ctx);
    expect(ctx.systemPrompt).toContain('## 消息来源：定时任务');
    expect(ctx.systemPrompt).toContain('## 消息来源：Agent 协作');
  });

  it('空 systemPrompt 时直接以小节开头；空小节不追加', async () => {
    const hook = makeSourceContractRunStartHook(TIMER);
    const ctx = { systemPrompt: '' } as any;
    await hook(ctx);
    expect(ctx.systemPrompt.startsWith('## 消息来源：定时任务')).toBe(true);

    const empty = makeSourceContractRunStartHook({ ...TIMER, contractSection: '' });
    const ctx2 = { systemPrompt: '保持原样' } as any;
    await empty(ctx2);
    expect(ctx2.systemPrompt).toBe('保持原样');
  });
});
