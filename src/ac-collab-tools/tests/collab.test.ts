// ============================================================
// ac-collab-tools/tests/collab.test.ts —— 协作工具七件
//
// · send_agent：异步受理（idle → run）与 wait=true 等回复
// · send_group / list_groups：群经可选 ctx.group；执行身份定"自己"
// · list_agents / read_agent_info：资料面（模型配置仅自查）
// · list_tools：AgentConfig.tools 白名单过滤
// · update_agent_profile：agentStore 落盘 + persona 写 AGENT.md +
//   admin 门（改他人）/ 白名单字段校验
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentStoreRow from 'ac-agent-store';
import * as agentsRow from 'ac-agents';
import * as collabRow from '../src/index';
import * as conversationRow from 'ac-conversation';
import * as groupRow from 'ac-group';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-collab-'));
  tmps.push(dir);
  return dir;
}

/** 脚本 provider：立即回复（第 n 次调用回 `回复n`） */
function scriptedProvider() {
  let counter = 0;
  return () => ({
    stream: async function* (_input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      counter += 1;
      yield { delta: `回复${counter}` };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

interface BootOpts {
  storeRoot?: string;
  withGroup?: boolean;
}

async function boot(opts: BootOpts = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    conversationRow,
    ...(opts.storeRoot ? [agentStoreRow] : []),
    ...(opts.withGroup === false ? [] : [groupRow]),
    collabRow,
  ];
  for (const row of rows) {
    const config = row === agentStoreRow && opts.storeRoot ? { root: opts.storeRoot } : undefined;
    const fiber = config ? ctx.plugin(row as any, config) : ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

function call(ctx: Context, name: string, args: Record<string, unknown>, agentId?: string) {
  return ctx.tools.execute({ name, args, ...(agentId ? { agentId } : {}) });
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('资料面工具', () => {
  it('list_agents：全量清单（虚拟标注；预设不进协作清单）', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1', description: '助手' });
    ctx.agents.register({ id: 'user', virtual: true });
    ctx.agents.register({ id: '__standard__', model: 'mock-1', description: '标准模式', preset: true });
    const r = await call(ctx, 'list_agents', {});
    expect(r.ok).toBe(true);
    const output = r.output as { count: number; agents: Array<Record<string, unknown>> };
    expect(output.count).toBe(2);
    expect(output.agents.find((x) => x.id === 'user')?.virtual).toBe(true);
    expect(output.agents.find((x) => x.id === 'a')?.description).toBe('助手');
    expect(output.agents.some((x) => x.id === '__standard__')).toBe(false); // 预设过滤
  });

  it('read_agent_info：自查含 model；查他人不暴露 model', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1', provider: 'mock', tools: ['read'] });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    const self = await call(ctx, 'read_agent_info', {}, 'a');
    expect((self.output as Record<string, unknown>).model).toBe('mock-1');
    expect((self.output as Record<string, unknown>).tools).toEqual(['read']);
    const other = await call(ctx, 'read_agent_info', { agent_id: 'b' }, 'a');
    expect((other.output as Record<string, unknown>).model).toBeUndefined();
    const missing = await call(ctx, 'read_agent_info', { agent_id: 'ghost' }, 'a');
    expect(missing.ok).toBe(false);
  });

  it('list_tools：AgentConfig.tools 白名单过滤', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'dummy',
      description: '占位',
      async execute() {
        return { ok: true, output: '' };
      },
    });
    ctx.agents.register({ id: 'a', model: 'mock-1', tools: ['list_tools'] });
    const r = await call(ctx, 'list_tools', {}, 'a');
    const output = r.output as { count: number; tools: Array<{ name: string }> };
    expect(output.count).toBeGreaterThanOrEqual(1);
    expect(output.tools.every((t) => t.name === 'list_tools')).toBe(true);
  });
});

describe('send_agent（经 conversation 状态机）', () => {
  it('wait=false：受理即返回（idle → run 完成后 outcome=run）', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    const r = await call(ctx, 'send_agent', { to: 'b', message: '帮我看下' }, 'a');
    expect(r.ok).toBe(true);
    const output = r.output as { to: string; outcome: string };
    expect(output.to).toBe('b');
    expect(output.outcome).toBe('run');  });

  it('wait=true：等独立 run 拿回复文本', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    const r = await call(ctx, 'send_agent', { to: 'b', message: '帮我总结', wait: true }, 'a');
    expect(r.ok).toBe(true);
    const output = r.output as { reply: string; finish: string };
    expect(output.reply).toMatch(/^回复\d+$/);
    expect(output.finish).toBe('stop');
  });

  it('未注册目标 / 缺执行身份 → 报错', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const r1 = await call(ctx, 'send_agent', { to: 'ghost', message: 'x' }, 'a');
    expect(r1.ok).toBe(false);
    const r2 = await call(ctx, 'send_agent', { to: 'a', message: 'x' });
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toContain('执行身份');
  });

  it('委托对会话键：conversationId = a~b（排序）+ 历史播种 + 双向同桶', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ storeRoot: root, withGroup: false });
    // session 行（历史播种经 ctx.session 可选解析）
    const sessionFiber = ctx.plugin(sessionRow as any, { root });
    await sessionFiber;
    booted[booted.length - 1].fibers.push(sessionFiber);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });

    // a → b：会话键 = a~b（排序），非目标 agent 缺省键
    const r = await call(ctx, 'send_agent', { to: 'b', message: '第一句', wait: true }, 'a');
    expect(r.ok).toBe(true);
    const pairDir = join(root, 'sessions', 'a~b');
    const file = join(pairDir, 'messages.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const lines1 = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    // 中性入账（D13）：a 的发言 = role:'agent' + agent_id=a
    expect(lines1.some((l) => l.content === '第一句' && l.role === 'agent' && l.agent_id === 'a')).toBe(true);

    // b → a 回信：同一会话桶（双向同键）+ 历史播种（b 的 run 看到 a 的话）
    const r2 = await call(ctx, 'send_agent', { to: 'a', message: '回信', wait: true }, 'b');
    expect(r2.ok).toBe(true);
    const lines2 = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    // 第一句(a 发) + b 的回复 + 回信(b 发) + a 的回复 —— 同一 jsonl
    expect(lines2.some((l) => l.content === '回信')).toBe(true);
    expect(lines2.length).toBeGreaterThan(lines1.length);
  });
});

describe('群协作（可选 ctx.group）', () => {
  it('send_group：成员发言触发其他参与者；非成员拒绝', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    ctx.group.create({ id: 'team', name: '项目组', members: ['a', 'b'] });
    const r = await call(ctx, 'send_group', { group_id: 'team', message: '开工' }, 'a');
    expect(r.ok).toBe(true);
    expect((r.output as { triggered: string[] }).triggered).toEqual(['b']);

    ctx.agents.register({ id: 'c', model: 'mock-1' });
    const denied = await call(ctx, 'send_group', { group_id: 'team', message: ' outsiders' }, 'c');
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toContain('成员');
  });

  it('list_groups：按执行身份过滤所在群', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    ctx.group.create({ id: 'team', name: '项目组', members: ['a', 'b'] });
    ctx.group.create({ id: 'ops', name: '运维', members: ['b'] });
    const ra = await call(ctx, 'list_groups', {}, 'a');
    expect((ra.output as { count: number }).count).toBe(1);
    const rb = await call(ctx, 'list_groups', {}, 'b');
    expect((rb.output as { count: number }).count).toBe(2);
  });

  it('群行未装 → 明确报错（可选能力降级）', async () => {
    const { ctx } = await boot({ withGroup: false });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const r = await call(ctx, 'list_groups', {}, 'a');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('ac-group');
  });
});

describe('update_agent_profile（档案经 agentStore）', () => {
  it('自查字段落盘 + 内存覆盖注册；persona 写 AGENT.md 并挂载装载', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ storeRoot: root });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agentStore.saveAgent({ id: 'a', model: 'mock-1' });

    const r = await call(
      ctx,
      'update_agent_profile',
      { fields: { description: '新描述', persona: '认真负责的工程师', tools: ['read', 'list_agents'] } },
      'a',
    );
    expect(r.ok).toBe(true);
    expect((r.output as { changed: string[] }).changed).toEqual(
      expect.arrayContaining(['description', 'persona', 'tools']),
    );
    // 落盘 + 内存态都更新
    expect(ctx.agentStore.getAgent('a')?.description).toBe('新描述');
    expect(ctx.agents.get('a')?.tools).toEqual(['read', 'list_agents']);
    // persona → AGENT.md + settings['persona'] 挂载
    expect(ctx.agentStore.readDoc('a', 'AGENT.md')).toContain('认真负责的工程师');
    expect((ctx.agents.get('a')?.settings?.['persona'] as { file: string }).file).toBe('AGENT.md');
  });

  it('非 admin 改他人拒绝；admin 放行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ storeRoot: root });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    ctx.agentStore.saveAgent({ id: 'b', model: 'mock-1' });

    const denied = await call(ctx, 'update_agent_profile', { agent_id: 'b', fields: { description: 'x' } }, 'a');
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toContain('admin');

    ctx.agents.register({
      id: 'admin1',
      model: 'mock-1',
      settings: { security: { capabilities: ['base', 'admin'] } },
    });
    const ok = await call(ctx, 'update_agent_profile', { agent_id: 'b', fields: { description: '由管理员更新' } }, 'admin1');
    expect(ok.ok).toBe(true);
    expect(ctx.agents.get('b')?.description).toBe('由管理员更新');
  });

  it('字段白名单校验；无持久化目录 → 内存生效注明', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const bad = await call(ctx, 'update_agent_profile', { fields: { model: 'x' } }, 'a');
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain('不允许修改');

    const memOnly = await call(ctx, 'update_agent_profile', { fields: { description: '内存态' } }, 'a');
    expect(memOnly.ok).toBe(true);
    expect((memOnly.output as { persisted: boolean }).persisted).toBe(false);
    expect((memOnly.output as { note: string }).note).toContain('内存');
    expect(ctx.agents.get('a')?.description).toBe('内存态');
  });
});

describe('M15 对账补齐', () => {
  it('send_agent 目标为 virtual Agent → 允许投递（M18：消息直达用户，引导"无自动回复"）', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'user', virtual: true });
    const r = await call(ctx, 'send_agent', { to: 'user', message: '你好' }, 'a');
    expect(r.ok).toBe(true);
    const output = r.output as { to: string; virtual: boolean; message: string };
    expect(output.to).toBe('user');
    expect(output.virtual).toBe(true);
    expect(output.message).toContain('虚拟端点');
    expect(output.message).toContain('不会有自动回复');
  });

  it('send_agent 目标为预设 Agent → 拒绝（单会话路由目标不接收协作消息）', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: '__standard__', model: 'mock-1', preset: true });
    const r = await call(ctx, 'send_agent', { to: '__standard__', message: '你好' }, 'a');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('预设');
  });

  it('update_agent_profile 改档案后卸载 collab-tools 行 → Agent 条目存活（reassign 语义）', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot({ storeRoot: root });
    ctx.agents.register({ id: 'p', model: 'mock-1' });
    ctx.agentStore.saveAgent({ id: 'p', model: 'mock-1' });
    const r = await call(ctx, 'update_agent_profile', { fields: { description: '新描述' } }, 'p');
    expect(r.ok).toBe(true);

    // 卸载 collab 行：reassign 不挂本行 fiber——条目不连带删除
    const collabFiber = fibers.find((_, i) => i === fibers.length - 1)!;
    await collabFiber.dispose();
    expect(ctx.agents.has('p')).toBe(true);
    expect(ctx.agents.get('p')?.description).toBe('新描述');
  });

  it('list_tools：tools 对象形态（exclude 增量停用）→ 生效集解析', async () => {
    const { ctx } = await boot();
    ctx.agents.register({
      id: 'e',
      model: 'mock-1',
      tools: { exclude: ['send_group', 'list_groups', 'update_agent_profile'] },
    });
    const r = await call(ctx, 'list_tools', {}, 'e');
    const output = r.output as { tools: Array<{ name: string }>; note: string };
    expect(output.note).toContain('生效集');
    const names = output.tools.map((t) => t.name);
    expect(names).toContain('send_agent'); // 未被排除
    expect(names).not.toContain('update_agent_profile'); // 已排除
  });
});
