// ============================================================
// ac-collab-tools/tests/collab.test.ts —— 协作工具七件
//
// · send_agent：异步受理（idle → run）与 wait=true 等回复
// · send_group / list_groups：群经可选 ctx.group；执行身份定"自己"
// · list_agents / read_agent_info：资料面（模型配置仅自查）
// · list_tools：AgentConfig.tools 白名单过滤
// · update_agent_profile：agentStore 落盘 + persona 写 AGENTS.md +
//   admin 门（改他人）/ 白名单字段校验
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentStoreRow from 'ac-agent-store';
import * as agentsRow from 'ac-agents';
import * as collabRow from '../src/index';
import * as conversationRow from 'ac-conversation';
import * as groupRow from 'ac-group';
import * as jobsRow from 'ac-jobs';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as subagentRow from 'ac-subagent';
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

function call(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agentId?: string,
  conversationId?: string,
) {
  return ctx.tools.execute({
    name,
    args,
    ...(agentId ? { agentId } : {}),
    ...(conversationId ? { conversationId } : {}),
  });
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
    ctx.agents.register({ id: 'a', model: 'mock-1', tags: ['infra'], tools: ['list_tools'] });
    const r = await call(ctx, 'list_tools', {}, 'a');
    const output = r.output as { count: number; tools: Array<{ name: string }> };
    expect(output.count).toBeGreaterThanOrEqual(1);
    expect(output.tools.every((t) => t.name === 'list_tools')).toBe(true);
  });

  it('list_tools：会话形态面同口径（2026-12）——excludeForms 工具不进独立会话清单；对桶照常', async () => {
    const { ctx } = await boot();
    // 直构 singles stub（形态识别面——get 命中即独立会话）
    class SinglesStub extends Service {
      private readonly sids: Set<string>;

      constructor(c: Context, options: { sids?: string[] } = {}) {
        super(c, 'singles');
        this.sids = new Set(options.sids ?? []);
      }

      get(sid: string): { agentId: string } | null {
        return this.sids.has(sid) ? { agentId: 'stub-agent' } : null;
      }
    }
    void new SinglesStub(ctx, { sids: ['sid-1'] });
    ctx.tools.register({
      name: 'system_restart',
      description: '重启',
      requiredTags: ['admin'],
      excludeForms: ['single'],
      execute: () => ({ ok: true }),
    });
    ctx.agents.register({ id: 'boss', model: 'mock-1', tags: ['admin'] });

    // 独立会话：与 router 信封同口径——excludeForms 工具不在生效集
    const single = await call(ctx, 'list_tools', {}, 'boss', 'sid-1');
    const singleTools = (single.output as { tools: Array<{ name: string }> }).tools;
    expect(singleTools.some((t) => t.name === 'system_restart')).toBe(false);
    // 对桶（1v1）：照常可见
    const pair = await call(ctx, 'list_tools', {}, 'boss', 'boss~user');
    const pairTools = (pair.output as { tools: Array<{ name: string }> }).tools;
    expect(pairTools.some((t) => t.name === 'system_restart')).toBe(true);
  });
});

describe('send_agent（经 conversation 状态机）', () => {
  it('wait=false 空闲直达：回复文本随结果直返（2026-12 修复：不再丢弃 reply 撒谎"会作为新消息送达"）', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    const r = await call(ctx, 'send_agent', { to: 'b', message: '帮我看下' }, 'a');
    expect(r.ok).toBe(true);
    const output = r.output as { to: string; wait: boolean; reply: string; finish: string };
    expect(output.to).toBe('b');
    expect(output.wait).toBe(false);
    // deliver 空闲路径 await 完对方 run——回复直返调用方（子 Agent 场景
    // 是唯一回收通道：其上下文源是任务收件箱而非 session 对桶）
    expect(output.reply).toMatch(/^回复\d+$/);
    expect(output.finish).toBe('stop');
  });

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

describe('send_agent（子 Agent 直投分支）', () => {
  async function bootWithSubagent(opts: { withSession?: boolean } = {}) {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    // rows = collab 基础 + jobs（subagent 依赖）+ subagent 行
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
      jobsRow,
      loopRow,
      agentsRow,
      routerRow,
      conversationRow,
      ...(opts.withSession ? [sessionRow] : []),
      collabRow,
      subagentRow,
    ];
    for (const row of rows) {
      const fiber = ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    return { ctx, fibers };
  }

  it('父 send_agent(子 sub_id)：转投任务收件箱（delivered=started），子 run 消费该消息', async () => {
    const { ctx } = await bootWithSubagent();
    ctx.agents.register({ id: 'chief', model: 'mock-1', tags: ['delegation'] });
    const sp = await call(ctx, 'subagent', { action: 'spawn', task: '初始任务', wait_time: 30 }, 'chief');
    const subId = (sp.output as { subagent_id: string }).subagent_id;
    // 父经 send_agent 直投子 Agent
    const r = await call(ctx, 'send_agent', { to: subId, message: '补充指示：加个摘要' }, 'chief');
    expect(r.ok).toBe(true);
    const output = r.output as { to: string; subagent: boolean; delivered: string; message: string };
    expect(output.subagent).toBe(true);
    expect(output.delivered).toBe('started');
    expect(output.message).toContain('await');
    // 子 Agent 侧消费：await 收结果（消息进了其会话）
    const done = await call(ctx, 'subagent', { action: 'await', subagent_id: subId }, 'chief');
    expect(done.ok).toBe(true);
    expect((done.output as { status: string }).status).toBe('done');
  });

  it('非父投递子 Agent → 拒绝（仅其父可投）', async () => {
    const { ctx } = await bootWithSubagent();
    ctx.agents.register({ id: 'chief', model: 'mock-1', tags: ['delegation'] });
    ctx.agents.register({ id: 'outsider', model: 'mock-1' });
    const sp = await call(ctx, 'subagent', { action: 'spawn', task: '任务', wait_time: 30 }, 'chief');
    const subId = (sp.output as { subagent_id: string }).subagent_id;
    const r = await call(ctx, 'send_agent', { to: subId, message: '插队消息' }, 'outsider');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('只接收其父');
  });

  it('sub_ 前缀但未注册 → 走常规"未注册"报错', async () => {
    const { ctx } = await bootWithSubagent();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const r = await call(ctx, 'send_agent', { to: 'sub_ghost_1234', message: 'x' }, 'a');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('未注册');
  });

  it('subagents 行未装载 → sub_ id 照常走常规路径（可选能力缺省不炸）', async () => {
    const { ctx } = await boot(); // 无 subagent 行
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const r = await call(ctx, 'send_agent', { to: 'sub_whatever', message: 'x' }, 'a');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('未注册');
  });

  // ---- 子 Agent 发信身份归一（2026-12 修复：注入到正确的会话）----
  it('子 Agent send_agent(普通 Agent)：对桶归一到父（pairKey(parent, b)，非幽灵 sub~b 桶）+ 回复直返', async () => {
    const { ctx } = await bootWithSubagent({ withSession: true });
    ctx.agents.register({ id: 'chief', model: 'mock-1', tags: ['delegation'] });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    ctx.agents.register({ id: 'user', virtual: true });
    const sp = await call(ctx, 'subagent', { action: 'spawn', task: '任务', wait_time: 30 }, 'chief');
    const subId = (sp.output as { subagent_id: string }).subagent_id;
    // 子 Agent 以自身身份给 b 发消息（模拟子 run 内的工具调用）
    const r = await call(ctx, 'send_agent', { to: 'b', message: '帮我查资料' }, subId);
    expect(r.ok).toBe(true);
    const output = r.output as { to: string; reply: string; wait: boolean };
    // 空闲直达：b 的回复随结果直返（子 Agent 的唯一回收通道）
    expect(output.reply).toMatch(/^回复\d+$/);
    expect(output.wait).toBe(false);
    // 入账落父对桶（chief~b）：用户在父⇄b 会话里可见子的发言——不是
    // 无人可达的 sub~b 幽灵桶
    const history = await (ctx.get('session') as { history(id: string): Promise<Array<{ content: string }>> }).history('b~chief');
    expect(history.some((m) => m.content.includes('帮我查资料'))).toBe(true);
    // 幽灵桶不落账
    const ghost = await (ctx.get('session') as { history(id: string): Promise<Array<{ content: string }>> }).history([subId, 'b'].sort().join('~'));
    expect(ghost.some((m) => m.content.includes('帮我查资料'))).toBe(false);
  });

  it('子 Agent send_agent(user 虚拟端点)：落父的直答对桶（chief~user）', async () => {
    const { ctx } = await bootWithSubagent({ withSession: true });
    ctx.agents.register({ id: 'chief', model: 'mock-1', tags: ['delegation'] });
    ctx.agents.register({ id: 'user', virtual: true });
    const sp = await call(ctx, 'subagent', { action: 'spawn', task: '任务', wait_time: 30 }, 'chief');
    const subId = (sp.output as { subagent_id: string }).subagent_id;
    const r = await call(ctx, 'send_agent', { to: 'user', message: '给用户的话' }, subId);
    expect(r.ok).toBe(true);
    const output = r.output as { virtual: boolean; message: string };
    expect(output.virtual).toBe(true);
    // 落父的用户对桶（chief~user）——用户在与 chief 的对话里直接看到
    const history = await (ctx.get('session') as { history(id: string): Promise<Array<{ content: string }>> }).history('chief~user');
    expect(history.some((m) => m.content.includes('给用户的话'))).toBe(true);
  });

  it('子 → 兄弟子 Agent 直投：权限按父判定（同父放行；异父拒绝）', async () => {
    const { ctx } = await bootWithSubagent();
    ctx.agents.register({ id: 'chief', model: 'mock-1', tags: ['delegation'] });
    const sp1 = await call(ctx, 'subagent', { action: 'spawn', task: '甲', wait_time: 30 }, 'chief');
    const subA = (sp1.output as { subagent_id: string }).subagent_id;
    const sp2 = await call(ctx, 'subagent', { action: 'spawn', task: '乙', wait_time: 30 }, 'chief');
    const subB = (sp2.output as { subagent_id: string }).subagent_id;
    // 同父兄弟：subA 的父 = chief = subB 的父 → 放行
    const r = await call(ctx, 'send_agent', { to: subB, message: '协同消息' }, subA);
    expect(r.ok).toBe(true);
    expect((r.output as { subagent: boolean }).subagent).toBe(true);
    // 异父：subB 给 chief2 的子 → 拒绝
    ctx.agents.register({ id: 'chief2', model: 'mock-1', tags: ['delegation'] });
    const sp3 = await call(ctx, 'subagent', { action: 'spawn', task: '丙', wait_time: 30 }, 'chief2');
    const subC = (sp3.output as { subagent_id: string }).subagent_id;
    const denied = await call(ctx, 'send_agent', { to: subC, message: '越权' }, subA);
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toContain('只接收其父');
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
  it('自查字段落盘 + 内存覆盖注册；persona 写 AGENTS.md 并挂载装载', async () => {
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
    // persona → AGENTS.md（生态事实标准；AGENT.md 旧名回退读）+ settings['persona'] 挂载
    expect(ctx.agentStore.readDoc('a', 'AGENTS.md')).toContain('认真负责的工程师');
    expect((ctx.agents.get('a')?.settings?.['persona'] as { file: string }).file).toBe('AGENTS.md');
  });

  it('显示名语义拆分：改 description 不动 name；name 独立更新（空串清除）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ storeRoot: root });
    ctx.agents.register({ id: 'n', model: 'mock-1', name: '小七', description: '旧简介' });
    ctx.agentStore.saveAgent({ id: 'n', model: 'mock-1', name: '小七', description: '旧简介' });

    // Agent 自更新简介：显示名不变（历史缺陷：description 曾兼任显示名）
    const r = await call(ctx, 'update_agent_profile', { fields: { description: '新简介' } }, 'n');
    expect(r.ok).toBe(true);
    expect((r.output as { changed: string[] }).changed).toEqual(['description']);
    expect(ctx.agents.get('n')).toMatchObject({ name: '小七', description: '新简介' });
    expect(ctx.agentStore.getAgent('n')).toMatchObject({ name: '小七', description: '新简介' });

    // 刻意改名走 name（正道）；空串 = 清除（回落 description ?? id）
    const r2 = await call(ctx, 'update_agent_profile', { fields: { name: '小柒' } }, 'n');
    expect(r2.ok).toBe(true);
    expect((r2.output as { changed: string[] }).changed).toEqual(['name']);
    expect(ctx.agents.get('n')?.name).toBe('小柒');
    const r3 = await call(ctx, 'update_agent_profile', { fields: { name: '' } }, 'n');
    expect(r3.ok).toBe(true);
    expect(ctx.agents.get('n')?.name).toBeUndefined();
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
      tags: ['admin'],
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
      tags: ['collab', 'infra'],
      tools: { exclude: ['send_group', 'list_groups', 'update_agent_profile'] },
    });
    const r = await call(ctx, 'list_tools', {}, 'e');
    const output = r.output as { tools: Array<{ name: string }>; note: string };
    expect(output.note).toContain('生效集');
    const names = output.tools.map((t) => t.name);
    expect(names).toContain('send_agent'); // 未被排除
    expect(names).not.toContain('update_agent_profile'); // 已排除
  });

  it('@ 名称引用约定：生效工具集同时含 list_agents + send_agent 才注入（owner 行条件安装）', async () => {
    const { ctx } = await boot({ withGroup: false });

    async function runWithTools(tools?: string[]): Promise<string | undefined> {
      const req = { request: { tools, messages: [] as unknown[] } };
      await ctx.waterfall('loop/before-run', req as never, async () => ({ finish: 'stop' }) as never);
      return (req.request as { system?: string }).system;
    }

    const both = await runWithTools(['list_agents', 'send_agent']);
    expect(both).toContain('[引用约定]');
    expect(both).toContain('@<名称>');
    expect(both).toContain('list_agents');
    // 只有解析没有投递（或反之）→ 不教半套语法
    expect(await runWithTools(['list_agents'])).toBeUndefined();
    expect(await runWithTools(['send_agent'])).toBeUndefined();
    // 缺省 = 全部已注册工具（本行注册两件）→ 注入
    expect(await runWithTools(undefined)).toContain('[引用约定]');
  });
});
