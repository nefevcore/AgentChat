// ============================================================
// persona 独立插件回归（自 agent-prompt tests 迁移 + 插件化补充）：
//   · AGENT.md 优先于 config.persona（本地覆盖预设定义）
//   · 无目录实体时内联 persona 注入，角色块前置到提示词顶部
//   · SYSTEM.md 存在时跳过（完全覆盖语义）
//   · 无 persona / 空白 persona：不注入
//   · buildSystemPromptWithPersona：预览组合装配与运行时钩子链同构
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '@agentchat/agent-config';
import type { CurrentContext } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import { makeBuildSystemPromptHook } from '@agentchat/agent-prompt';
import { makePersonaPromptHook, buildSystemPromptWithPersona } from '../src';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-persona-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mkCtx = () => ({
  agentId: '__minimal__',
  dialogId: 'single~11111111-1111-4111-8111-111111111111',
  tools: new Map(),
  systemPrompt: '',
}) as unknown as CurrentContext;

/** 按运行时钩子顺序执行：build-system-prompt（整体覆盖）→ persona（前置注入） */
async function runPromptHooks(config: AgentConfig, services: ToolContext, ctx: CurrentContext): Promise<void> {
  await makeBuildSystemPromptHook(config, services)(ctx);
  await makePersonaPromptHook(config, services)(ctx);
}

/** 按运行时钩子顺序执行：persona（先行写入）→ build-system-prompt（追加式装配） */
async function runPromptHooksPersonaFirst(config: AgentConfig, services: ToolContext, ctx: CurrentContext): Promise<void> {
  await makePersonaPromptHook(config, services)(ctx);
  await makeBuildSystemPromptHook(config, services)(ctx);
}

describe('persona 注入（独立插件钩子）', () => {
  it('有目录实体时 AGENT.md 优先于 config.persona（本地覆盖预设定义）', async () => {
    fs.mkdirSync(path.join(tmp, '__minimal__'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '__minimal__', 'config.json'), JSON.stringify({ agent_id: '__minimal__', name: '极简模式' }), 'utf-8');
    fs.writeFileSync(path.join(tmp, '__minimal__', 'AGENT.md'), '# 本地覆盖版人设', 'utf-8');
    const config = { agent_id: '__minimal__', name: '极简模式', persona: '内联人设' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx();
    await runPromptHooks(config, services, ctx);
    expect(ctx.systemPrompt).toContain('本地覆盖版人设');
    expect(ctx.systemPrompt).not.toContain('内联人设');
  });

  it('无目录实体时 config.persona 以 persona 块注入，且块位于提示词顶部（build 钩子之后执行）', async () => {
    const config = { agent_id: '__minimal__', name: '极简模式', persona: '你是极简模式，惜字如金。' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx();
    await runPromptHooks(config, services, ctx);
    expect(ctx.systemPrompt).toContain('<persona>');
    expect(ctx.systemPrompt).toContain('你是极简模式，惜字如金。');
    expect(ctx.systemPrompt).toContain('</persona>');
    // 无标题行（只有 <persona> 标签）；块在最前（系统环境等框架块之前）
    expect(ctx.systemPrompt).not.toContain('## 角色');
    expect(ctx.systemPrompt.startsWith('<persona>')).toBe(true);
    expect(ctx.systemPrompt.indexOf('</persona>')).toBeLessThan(ctx.systemPrompt.indexOf('## 系统环境'));
  });

  it('无 persona 且无 AGENT.md：无角色块（standard 预设保持无人设）', async () => {
    const config = { agent_id: '__standard__', name: '标准模式' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = { ...mkCtx(), agentId: '__standard__' } as unknown as CurrentContext;
    await runPromptHooks(config, services, ctx);
    expect(ctx.systemPrompt).not.toContain('<persona>');
    expect(ctx.systemPrompt).not.toContain('## 角色');
  });

  it('persona 为空白字符串视同无人设（不注入空块）', async () => {
    const config = { agent_id: '__minimal__', name: '极简模式', persona: '   ' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx();
    await runPromptHooks(config, services, ctx);
    expect(ctx.systemPrompt).not.toContain('<persona>');
  });

  it('SYSTEM.md 存在时 persona 钩子跳过（完全覆盖语义）', async () => {
    fs.mkdirSync(path.join(tmp, '__minimal__'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '__minimal__', 'config.json'), JSON.stringify({ agent_id: '__minimal__', name: '极简模式' }), 'utf-8');
    fs.writeFileSync(path.join(tmp, '__minimal__', 'SYSTEM.md'), '# 完全自定义系统提示词', 'utf-8');
    const config = { agent_id: '__minimal__', name: '极简模式', persona: '内联人设' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx();
    await runPromptHooks(config, services, ctx);
    expect(ctx.systemPrompt).toContain('完全自定义系统提示词');
    expect(ctx.systemPrompt).not.toContain('<persona>');
  });

  it('无会话键（子 Agent）：不装配', async () => {
    const config = { agent_id: '__minimal__', name: '极简模式', persona: '内联人设' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = { agentId: '__minimal__', tools: new Map(), systemPrompt: '既有提示' } as unknown as CurrentContext;
    await makePersonaPromptHook(config, services)(ctx);
    expect(ctx.systemPrompt).toBe('既有提示'); // 未被改动
  });
});

describe('buildSystemPromptWithPersona（预览组合装配）', () => {
  it('与运行时钩子链结果一致（角色块前置 + 框架装配）', async () => {
    const config = { agent_id: '__minimal__', name: '极简模式', persona: '你是极简模式。' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const ctx = mkCtx();
    await runPromptHooks(config, services, ctx);
    const composed = buildSystemPromptWithPersona(config, services, { toolNames: [] });
    expect(composed).toBe(ctx.systemPrompt);
  });

  it('钩子顺序无关：persona 先行与后置收敛到同一结果（build 追加式装配）', async () => {
    const config = { agent_id: '__minimal__', name: '极简模式', persona: '你是极简模式。' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const before = mkCtx();
    await runPromptHooksPersonaFirst(config, services, before);   // persona → build
    const after = mkCtx();
    await runPromptHooks(config, services, after);                // build → persona
    expect(before.systemPrompt).toBe(after.systemPrompt);
    expect(before.systemPrompt.startsWith('<persona>')).toBe(true);
  });

  it('无人设时组合装配 = 纯 buildSystemPrompt', () => {
    const config = { agent_id: '__standard__', name: '标准模式' } as AgentConfig;
    const services = { agentsDir: tmp } as ToolContext;
    const composed = buildSystemPromptWithPersona(config, services, { toolNames: [] });
    expect(composed).not.toContain('<persona>');
    expect(composed).toContain('## 系统环境');
  });
});
