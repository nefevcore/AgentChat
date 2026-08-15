// ============================================================
// 回归：1v1 对话对象从 dialogId 反解（chat~admin~user → user），
// 不能把 selfId（admin/艾吉）当成对话对象。
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '@agentchat/agent-config';
import type { CurrentContext } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import { makeBuildSystemPromptHook } from '../src/prompt-hook';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-hook-'));
  fs.mkdirSync(path.join(tmp, 'admin'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'user'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'admin', 'config.json'), JSON.stringify({ agent_id: 'admin', name: '艾吉' }), 'utf-8');
  fs.writeFileSync(path.join(tmp, 'user', 'config.json'), JSON.stringify({ agent_id: 'user', name: '用户', virtual: true }), 'utf-8');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('build-system-prompt 对话信息', () => {
  it('chat~admin~user 应显示对话对象 user - 用户，而不是 admin - 艾吉（自己）', async () => {
    const config: AgentConfig = {
      agent_id: 'admin',
      name: '艾吉',
      tags: ['admin'],
    } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const hook = makeBuildSystemPromptHook(config, services);

    const ctx = {
      agentId: 'admin',
      dialogId: 'chat~admin~user',
      tools: new Map(),
      systemPrompt: '',
    } as unknown as CurrentContext;

    await hook(ctx);

    expect(ctx.systemPrompt).toContain('[当前对话对象] user - 用户');
    expect(ctx.systemPrompt).not.toContain('[当前对话对象] admin - 艾吉（自己）');
  });

  it('群组 trigger 仍以 selfId 作为 sender（不反解为 counterpart）', async () => {
    const config: AgentConfig = {
      agent_id: 'admin',
      name: '艾吉',
      tags: ['admin'],
    } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const hook = makeBuildSystemPromptHook(config, services);

    const ctx = {
      agentId: 'admin',
      dialogId: 'group~g1~admin',
      tools: new Map(),
      systemPrompt: '',
    } as unknown as CurrentContext;

    await hook(ctx);

    expect(ctx.systemPrompt).toContain('[当前群聊] g1');
    expect(ctx.systemPrompt).not.toContain('[当前对话对象]');
  });
});
