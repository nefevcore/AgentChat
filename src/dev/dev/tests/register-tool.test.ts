// ============================================================
// @agentchat/dev register_tool 端到端测试（Agent 自我进化闭环）
//
// 验证：注册 → 解析（resolveTools 包含新工具）→ 执行（沙箱 execute）
//     → 热生效（下条消息 resolveTools 可用）→ 安全隔离（无 IO/进程）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { ToolsService } from '@agentchat/tools';
import { Context } from '@agentchat/cordis';
import { makeRegisterTool } from '../src/register-tool';
import type { AgentConfig } from '@agentchat/agent-config';

const makeConfig = (): AgentConfig => ({ agent_id: 't1', name: '测试', tags: ['admin'] } as AgentConfig);

describe('register_tool（自我进化闭环）', () => {
  it('注册新工具 → resolveTools 立即包含（热生效）', async () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const reg = makeRegisterTool(tools);
    const res = await reg.execute({
      name: 'my_add',
      label: '加法',
      description: '两数相加',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      execute: 'async ({ a, b }) => String(a + b)',
    } as never);
    expect(JSON.parse(res as string).status).toBe('ok');

    // 热生效：resolveTools 包含新工具（显式声明 + requires 无限制）
    const resolved = tools.resolveTools(['my_add'], makeConfig(), {});
    const tool = resolved.get('my_add');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('my_add');
    expect(await tool?.execute?.({ a: 1, b: 2 }, undefined, undefined)).toBe('3');
  });

  it('requires 门控：admin 标签命中', async () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const reg = makeRegisterTool(tools);
    await reg.execute({
      name: 'admin_util',
      description: '管理工具',
      parameters: {},
      execute: 'async () => "ok"',
      requires: ['admin'],
    } as never);
    // admin Agent 可见
    expect(tools.resolveTools(['admin_util'], makeConfig(), {}).has('admin_util')).toBe(true);
    // 非 admin Agent 不可见（requires 不匹配 → 不自动注入）
    const nonAdmin = { agent_id: 'x', name: 'X', tags: ['dev'] } as AgentConfig;
    expect(tools.resolveTools(['admin_util'], nonAdmin, {}).has('admin_util')).toBe(false);
  });

  it('requires 受控词汇表：未知标签拒绝注册；缺省为 base', async () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const reg = makeRegisterTool(tools);

    const invalid = await reg.execute({
      name: 'bad_cap', description: 'x', parameters: {}, execute: 'async () => "x"',
      requires: ['root'],
    } as never);
    expect(JSON.parse(invalid as string).status).toBe('error');
    expect(tools.listAll(makeConfig(), {}).some((t) => t.name === 'bad_cap')).toBe(false);

    await reg.execute({
      name: 'default_cap', description: 'x', parameters: {}, execute: 'async () => "x"',
    } as never);
    const tool = tools.resolveTools(makeConfig(), {}).get('default_cap');
    expect(tool?.requires).toEqual(['base']);
  });

  it('沙箱隔离：execute 无法访问 process/require（安全边界）', async () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const reg = makeRegisterTool(tools);
    const res = await reg.execute({
      name: 'evil',
      description: '尝试越权',
      parameters: {},
      execute: 'async () => { try { return String(process.env); } catch (e) { return "blocked:" + e.message; } }',
    } as never);
    expect(JSON.parse(res as string).status).toBe('ok');
    const tool = tools.resolveTools(['evil'], makeConfig(), {}).get('evil');
    const out = await tool?.execute?.({}, undefined, undefined);
    expect(String(out)).toContain('blocked'); // process 不可见 → 抛错被捕获
  });

  it('非法 execute（非函数/语法错）→ 注册失败', async () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const reg = makeRegisterTool(tools);
    const res = await reg.execute({
      name: 'bad',
      description: '坏代码',
      parameters: {},
      execute: 'not a function',
    } as never);
    expect(JSON.parse(res as string).status).toBe('error');
    expect(tools.resolveTools(['bad'], makeConfig(), {}).has('bad')).toBe(false);
  });

  it('工具目录可见（listAll 包含新注册工具）', async () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const reg = makeRegisterTool(tools);
    await reg.execute({
      name: 'visible_tool',
      description: '目录可见',
      parameters: {},
      execute: 'async () => "v"',
    } as never);
    const names = tools.listAll(makeConfig(), {}).map((t) => t.name);
    expect(names).toContain('visible_tool');
  });

  it('同名重复注册：replace 语义（后注册者胜，不叠加）', async () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const reg = makeRegisterTool(tools);
    await reg.execute({
      name: 'dup',
      description: 'v1',
      parameters: {},
      execute: 'async () => "v1"',
    } as never);
    await reg.execute({
      name: 'dup',
      description: 'v2',
      parameters: {},
      execute: 'async () => "v2"',
    } as never);

    const dup = tools.resolveTools(['dup'], makeConfig(), {}).get('dup');
    expect(dup?.description).toBe('v2');
    expect(await dup?.execute?.({}, undefined, undefined)).toBe('v2');
    expect(tools.listAll(makeConfig(), {}).filter((t) => t.name === 'dup')).toHaveLength(1);
  });
});
