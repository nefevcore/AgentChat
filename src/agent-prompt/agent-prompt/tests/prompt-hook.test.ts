// ============================================================
// 回归：
//   1. 1v1 对话对象从 dialogId 反解（chat~admin~user → user），
//      不能把 selfId（admin/艾吉）当成对话对象。
//   2. 系统环境块只保留工作目录（预设 Agent cwd = 挂载的用户文件夹）。
//   3. 标签约定已移除。
//   4. [当前时间] 已拆至 agent-datetime 插件（消息侧注入），system prompt 不再装配。
//   5. 指引含产出物引用约定（markdown 行内代码；旧 <file> 标签已移除）。
// （persona 用例已随钩子迁至 @agentchat/agent-persona tests/persona.test.ts）
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

  it('独立会话 single~<sid>：对话对象是用户，session-id 不得侵入提示词', async () => {
    const config: AgentConfig = {
      agent_id: 'news',
      name: '莉莉新闻',
      tags: ['news'],
    } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const hook = makeBuildSystemPromptHook(config, services);

    const sid = 'c19e10bf-7948-4078-b8b1-2ee1e98ba029';
    const ctx = {
      agentId: 'news',
      dialogId: `single~${sid}`,
      tools: new Map(),
      systemPrompt: '',
    } as unknown as CurrentContext;

    await hook(ctx);

    expect(ctx.systemPrompt).toContain('[当前对话对象] user - 用户');
    expect(ctx.systemPrompt).not.toContain(sid);
  });

  it('build-system-prompt 不再装配角色块（persona 由独立插件注入）', async () => {
    fs.mkdirSync(path.join(tmp, 'neko'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'neko', 'config.json'), JSON.stringify({ agent_id: 'neko', name: 'Neko' }), 'utf-8');
    fs.writeFileSync(path.join(tmp, 'neko', 'AGENT.md'), '猫娘人设', 'utf-8');
    const config = { agent_id: 'neko', name: 'Neko', persona: '内联人设' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = {
      agentId: 'neko',
      dialogId: 'chat~user~neko',
      tools: new Map(),
      systemPrompt: '',
    } as unknown as CurrentContext;
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).not.toContain('<persona>');
    expect(ctx.systemPrompt).not.toContain('## 角色');
    expect(ctx.systemPrompt).not.toContain('猫娘人设');
    expect(ctx.systemPrompt).not.toContain('内联人设');
  });
});

describe('系统环境块（v0.6.3 精简）', () => {
  const mkCtx = (agentId: string) => ({
    agentId,
    dialogId: 'chat~user~' + agentId,
    tools: new Map(),
    systemPrompt: '',
  }) as unknown as CurrentContext;

  it('预设 Agent：工作目录 = 挂载的用户文件夹（security.workdir），而非 ./files/*/', async () => {
    // 挂载场景装配产物：withExtraAllowedPaths 同时写 allowedPaths[0] 与 workdir
    const config = {
      agent_id: '__minimal__',
      name: '极简模式',
      preset: true,
      security: { allowedPaths: ['C:\\Users\\dev\\MyProject'], workdir: 'C:\\Users\\dev\\MyProject' },
    } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('__minimal__');
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).toContain('[工作目录] C:\\Users\\dev\\MyProject');
    expect(ctx.systemPrompt).not.toContain('./files/__minimal__');
  });

  it('预设 Agent 仅 allowedPaths 无 workdir（未挂载会话）：工作目录 = 工作区根', async () => {
    const config = {
      agent_id: '__minimal__',
      name: '极简模式',
      preset: true,
      security: { allowedPaths: ['D:/scratch'] },
    } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('__minimal__');
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).toContain('[工作目录] ./（工作区根）');
    expect(ctx.systemPrompt).toContain('[路径穿透白名单] D:/scratch');
  });

  it('预设 Agent 未挂载文件夹：工作目录 = 工作区根', async () => {
    const config = { agent_id: '__standard__', name: '标准模式', preset: true } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('__standard__');
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).toContain('[工作目录] ./（工作区根）');
  });

  it('常规 Agent：工作目录 = ./files/<agent_id>/，白名单行保留', async () => {
    const config = {
      agent_id: 'admin',
      name: '艾吉',
      security: { allowedPaths: ['D:/scratch'] },
    } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('admin');
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).toContain('[工作目录] ./files/admin/');
    expect(ctx.systemPrompt).toContain('[路径穿透白名单] D:/scratch');
  });

  it('运行环境 / bash 工具 / 编码提示已移除', async () => {
    const config = { agent_id: 'admin', name: '艾吉', tags: ['admin'] } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('admin');
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).not.toContain('[运行环境]');
    expect(ctx.systemPrompt).not.toContain('[bash 工具]');
    expect(ctx.systemPrompt).not.toContain('[编码]');
    expect(ctx.systemPrompt).not.toContain('[引号]');
  });

  it('标签约定已移除（<file> 引导不再注入）', async () => {
    const config = { agent_id: 'admin', name: '艾吉' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('admin');
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).not.toContain('标签约定');
    expect(ctx.systemPrompt).not.toContain('<file path=');
  });
});

describe('时间注入拆分与产出物引用（v0.7.2）', () => {
  const mkCtx = (agentId: string, tools: string[] = []) => ({
    agentId,
    dialogId: 'chat~user~' + agentId,
    tools: new Map(tools.map((n) => [n, { name: n }])),
    systemPrompt: '',
  }) as unknown as CurrentContext;

  it('[当前时间] 不再装配进 system prompt（已拆至 agent-datetime 消息侧注入）', async () => {
    const config = { agent_id: 'admin', name: '艾吉' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('admin');
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).not.toContain('[当前时间]');
  });

  it('有文件产出工具时注入产出物引用约定（markdown 行内代码）', async () => {
    const config = { agent_id: 'admin', name: '艾吉' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('admin', ['read', 'write', 'edit', 'bash']);
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).toContain('产出物引用');
    expect(ctx.systemPrompt).toContain('markdown 行内代码');
  });

  it('仅 str_replace_editor / bash（dsh-minimal 形态）也注入产出物引用', async () => {
    const config = { agent_id: 'admin', name: '艾吉' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('admin', ['str_replace_editor', 'bash']);
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).toContain('产出物引用');
  });

  it('无文件产出工具（纯对话 Agent）不注入产出物引用', async () => {
    const config = { agent_id: 'chat', name: '闲聊' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx('chat', ['send_agent', 'list_agents']);
    await makeBuildSystemPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).not.toContain('产出物引用');
  });
});
