// ============================================================
// direct-im-contract.test.ts —— 1v1 IM 契约段判定（cr-1327 dual-view P3）
//
// DIRECT_IM_CONTRACT 段注入判据：viewer 对桶（一端 user）+ send_agent
// 在场 → 注入；agent~agent 桶 / 无 send_agent / 无会话键 → 不注入。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as collab from '../src/index.ts';

/** ctx 桩：捕获 registerPromptSection + 固定工具集/agents 面 */
function bootCollab(toolNames: string[]) {
  const sections = new Map<string, (r: Record<string, unknown>) => string>();
  const ctx = {
    tools: { register: () => {} },
    agents: {
      has: (id: string) => id === 'user' || id === 'alpha' || id === 'beta',
      get: (id: string) => (id === 'user' ? { virtual: true } : { id }),
      settingsOf: () => undefined,
    },
    conversation: { deliver: async () => ({ kind: 'sent' }) },
    get: (name: string) => (name === 'subagents' ? undefined : undefined),
    agentLoop: {
      registerPromptSection: (s: { name: string; text: (r: Record<string, unknown>) => string }) => {
        sections.set(s.name, s.text);
      },
    },
  };
  collab.apply(ctx as never);
  return sections;
}

const req = (agent: string, conversationId: string | undefined, tools: string[]) =>
  ({ agent, conversationId, tools });

describe('DIRECT_IM_CONTRACT 段判定（cr-1327 P3）', () => {
  it('viewer 对桶 + send_agent 在场 → 注入；内容含 send_agent(user) 引导', () => {
    const sections = bootCollab(['send_agent']);
    const text = sections.get('DIRECT_IM_CONTRACT')!(req('alpha', 'alpha~user', ['send_agent']) as never);
    expect(text).toContain('send_agent');
    expect(text).toContain('user');
  });

  it('agent~agent 委托桶（无 user 端）→ 不注入', () => {
    const sections = bootCollab(['send_agent']);
    expect(sections.get('DIRECT_IM_CONTRACT')!(req('alpha', 'alpha~beta', ['send_agent']) as never)).toBe('');
  });

  it('cr-1339：uuid 形（single 独立会话）→ 注入（用户面前的会话形态）', () => {
    const sections = bootCollab(['send_agent']);
    const text = sections.get('DIRECT_IM_CONTRACT')!(req('alpha', '018f1e23-4567-7890-abcd-ef0123456789', ['send_agent']) as never);
    expect(text).toContain('send_agent');
    expect(text).toContain('当前会话');
  });

  it('cr-1339：群成员流键（gid~self，群在册）→ 不注入（归 GROUP_CONTRACT）', () => {
    const sections = bootCollab(['send_agent']);
    // 群服务缺席（ctx.get 恒 undefined）：gid~self 形落 pair——不含 user 端即不注入
    expect(sections.get('DIRECT_IM_CONTRACT')!(req('alpha', 'g-test01~alpha', ['send_agent']) as never)).toBe('');
  });

  it('send_agent 不在场（PTC 收窄）→ 不注入；无会话键 → 不注入', () => {
    const sections = bootCollab(['run_code']);
    expect(sections.get('DIRECT_IM_CONTRACT')!(req('alpha', 'alpha~user', ['run_code']) as never)).toBe('');
    expect(sections.get('DIRECT_IM_CONTRACT')!(req('alpha', undefined, ['send_agent']) as never)).toBe('');
  });
});
