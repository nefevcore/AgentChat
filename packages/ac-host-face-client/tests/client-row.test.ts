// ============================================================
// ac-host-face-client/tests/client-row.test.ts —— 壳侧能力面行（cr-886 → cr-1114 → cr-1121）
//
// 不起真宿主：起最小 ipc echo 服务端按需回契约帧——验 client 行的
// boot 静态面（契约缓存驱动注册）、execute 惰性连接、对账重建、
// 宿主缺席可读报错、缓存缺席盲窗如实。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import { listenIpcConns, socketPathFor, type IpcServer } from 'ac-envelope-core';
import type { HostFaceContract, HostFaceFrame } from 'ac-host-face-core';
import { makeHostFaceClientRow, readContractCache } from '../src/index.ts';

const tmps: string[] = [];
const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const servers: IpcServer[] = [];

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const s of servers.splice(0)) await s.close();
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-facec-'));
  tmps.push(dir);
  return dir;
}

/** 最小宿主替身：discover 回给定契约；execute 回固定结果 */
async function fakeHost(dataRoot: string, contract: HostFaceContract): Promise<void> {
  const { server } = await listenIpcConns(socketPathFor(dataRoot, 'host-face'), (payload) => {
    const f = payload as HostFaceFrame;
    if (f.kind === 'discover') return { kind: 'contract', corrId: f.corrId, contract };
    if (f.kind === 'ping') return { kind: 'pong', corrId: f.corrId };
    if (f.kind === 'execute') return { kind: 'exec-result', corrId: f.corrId, ok: true, result: { via: 'host', tool: f.tool } };
    return undefined;
  });
  servers.push(server);
}

/** 契约缓存直投（真宿主由 host-face 行 discover 处理器写——cr-1121） */
function seedCache(dataRoot: string, contract: HostFaceContract): void {
  fs.mkdirSync(path.join(dataRoot, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'meta', 'host-face-contract.json'), JSON.stringify(contract), 'utf-8');
}

/** 宿主聚合契约同款（timer-face + profile-face 贡献并集——对账恒等用例的基准面） */
const HOST_CONTRACT: HostFaceContract = {
  version: 1,
  tools: [{
    name: 'timer',
    description:
      '管理定时任务（cr-1147 探测循环：定时器 = 探测循环 + 判定脚本，Agent 自管理）：set 安排一条探测任务（code = 判定脚本，双参谓词 (a, u) => ({ action?, next?, state?, active? })，落盘前自动干跑自检）；test 干跑看 verdict（不落盘不触发）；list 查看条目（排程态诊断）；cancel 按 id 取消。会话维度：在哪个会话设置就回哪个会话。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'cancel', 'test'], description: '操作' },
        code: { type: 'string', description: '[set/test] 判定脚本源码（双参谓词 (a, u) => { … }；限可擦除 TS，禁 import）' },
        label: { type: 'string', description: '[set] 人读标签（list 展示）' },
        entry_id: { type: 'string', description: '[cancel] 条目 id（list 可见）' },
      },
      required: ['action'],
    },
  }, {
    name: 'update_agent_profile',
    description:
      '更新 Agent 档案（name/description/system/persona/tools/maxSteps/settings）。默认改自己，具备 admin 能力可改他人；name 是显示名称（名册/群聊展示），description 是一句话简介（不影响显示名）；persona 写入 Agent 目录 AGENTS.md。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '目标 Agent（默认自己；仅 admin 可改他人）' },
        fields: {
          type: 'object',
          description: '要更新的字段',
          properties: {
            name: { type: 'string', description: '显示名称（名册/群聊展示；空串 = 清除，回落简介/id）' },
            description: { type: 'string', description: '一句话简介（其他 Agent 与用户可见；不是显示名）' },
            system: { type: 'string', description: '基础系统提示词' },
            persona: { type: 'string', description: '人物设定（写入 Agent 目录 AGENTS.md 并挂载 persona 装载）' },
            tools: { type: 'array', items: { type: 'string' }, description: '工具白名单（空数组/缺省 = 全部）' },
            maxSteps: { type: 'number', description: '步数预算（0 = 不限）' },
            settings: { type: 'object', description: '具名扩展设置（settings[具名]——已装插件在该 Agent 的行为）' },
          },
        },
      },
      required: ['fields'],
    },
  }],
  sections: [{
    name: 'GUIDELINES_TIMER',
    text: '主动安排：值得持续跟进或适时提醒的事项，主动用 timer(action="set") 安排，不必等用户指令。定时器 = 探测循环 + 判定脚本：宿主按脚本 next 周期探测，action 有值才唤醒你（静默轮零 token）——写脚本即设计自己的巡检/提醒节奏（可读状态、真随机、自适应间隔），并用 test 干跑验证、timer list 查健康度（lastError/triggeredCount）。',
    promise: true,
    gate: { toolsAny: ['timer'] },
  }],
  facts: ['singles', 'group'],
};

async function bootClient(dataRoot: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, loopRow]) {
    const f = ctx.plugin(row as any, undefined);
    await f;
    fibers.push(f);
  }
  const f = ctx.plugin(makeHostFaceClientRow({ dataRoot }) as any, undefined);
  await f;
  fibers.push(f);
  booted.push({ ctx, fibers });
  return ctx;
}

/** 触发 prepare 对账（真实链路 = run() 入口第一拍；测试直接跑一轮 run） */
async function runOnce(ctx: Context): Promise<void> {
  await ctx.agentLoop.run({ runId: 'probe-' + Math.random().toString(36).slice(2, 6), agent: 'a', model: 'mock', tools: [], messages: [] });
}

describe('宿主能力面壳侧行（cr-1121 缓存驱动 boot 面）', () => {
  it('boot 静态面：契约缓存在场 → 代理工具 + promise 段 boot 即在册（零 ipc，无需首 run）', async () => {
    const root = tmpRoot();
    seedCache(root, HOST_CONTRACT);
    const ctx = await bootClient(root);
    expect(ctx.tools.has('timer')).toBe(true);
    expect(ctx.tools.has('update_agent_profile')).toBe(true);
    const prompt = ctx.agentLoop.assemblePreview({ model: 'm', tools: ['timer'], conversationId: 'c1', messages: [] });
    expect(prompt).toContain('主动用 timer(action=\"set\")'); // promise 段静态文本
  });

  it('缓存缺席：boot 静态面空（冷启动盲窗如实），prepare 对账后收敛', async () => {
    const root = tmpRoot(); // 不种缓存、不起 fakeHost——首次 run 触发首连对账
    await fakeHost(root, HOST_CONTRACT);
    const ctx = await bootClient(root);
    expect(ctx.tools.has('timer')).toBe(false); // 盲窗如实
    await runOnce(ctx);
    expect(ctx.tools.has('timer')).toBe(true); // discover 对账收敛
    expect(readContractCache(root) === null).toBe(true); // 壳侧不写缓存（宿主单写）
  });

  it('宿主缺席：静态面照缓存、execute 报可读错误（boot 不阻塞——软降级语义保持）', async () => {
    const root = tmpRoot();
    seedCache(root, HOST_CONTRACT);
    const ctx = await bootClient(root);
    const r = await ctx.tools.execute({ name: 'timer', args: { action: 'list' }, agentId: 'a1' } as never);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('宿主能力面不可达');
  });

  it('execute 惰性连接：宿主在场 → 经宿主执行（boot 零连接，首调用建连）', async () => {
    const root = tmpRoot();
    await fakeHost(root, HOST_CONTRACT);
    seedCache(root, HOST_CONTRACT);
    const ctx = await bootClient(root);
    const r = await ctx.tools.execute({ name: 'timer', args: { action: 'list' }, agentId: 'a1' } as never);
    expect(r.ok).toBe(true);
    expect((r.output as { via: string }).via).toBe('host');
    // Shim：singles 判定经数据根（cr-973 迁 meta/sessions/）
    fs.mkdirSync(path.join(root, 'meta', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'meta', 'sessions', '.singles-registry.json'),
      JSON.stringify({ version: 2, entries: { 's-1': { id: 's-1' } } }), 'utf-8');
    const singles = ctx.get('singles') as unknown as { get(id: string): unknown };
    expect(singles.get('s-1')).toBeDefined();
    expect(singles.get('other')).toBeUndefined();
  });

  it('prepare 对账：契约与静态面漂移 → 重建 + emit tools/source-changed（cr-1114 事件面同构）', async () => {
    const root = tmpRoot();
    // 缓存只种 timer（update_agent_profile 缺席）+ 段文本异——宿主契约全量 = 漂移源
    seedCache(root, { ...HOST_CONTRACT, tools: [HOST_CONTRACT.tools[0]!] });
    await fakeHost(root, HOST_CONTRACT);
    const ctx = await bootClient(root);
    const diffs: Array<{ source: string; added: string[]; removed: string[]; changed: string[] }> = [];
    ctx.on('tools/source-changed', (d) => diffs.push(d as never));
    expect(ctx.tools.has('update_agent_profile')).toBe(false); // 缓存静态面
    await runOnce(ctx); // run() 入口 prepare → discover → 对账重建
    expect((ctx.tools.get('timer') as { description: string }).description).toContain('管理定时任务');
    expect(ctx.tools.has('update_agent_profile')).toBe(true); // 契约补齐
    // 事件面：与 MCP 对账同构（source 词区分，载荷结构相同）
    expect(diffs.length).toBe(1);
    expect(diffs[0]!.source).toBe('host-face');
    expect(diffs[0]!.added).toContain('update_agent_profile');
    // 基准面不累积：再跑一轮（恒等）零事件零重建
    await runOnce(ctx);
    expect(diffs.length).toBe(1);
  });

  it('prepare 对账：契约与静态面恒等 → 零操作（在册 spec 不变）', async () => {
    const root = tmpRoot();
    seedCache(root, HOST_CONTRACT); // 缓存 = 宿主聚合契约同款
    await fakeHost(root, HOST_CONTRACT);
    const ctx = await bootClient(root);
    const before = ctx.tools.listWithOwner().map((t) => t.name).sort().join(',');
    await runOnce(ctx);
    expect(ctx.tools.listWithOwner().map((t) => t.name).sort().join(',')).toBe(before);
    expect(ctx.tools.has('update_agent_profile')).toBe(true); // 静态面全量保持
  });

  it('段位占用：boot 静态段占位后 owner 同名注册抛错（位唯一性）', async () => {
    const root = tmpRoot();
    seedCache(root, HOST_CONTRACT);
    const ctx = await bootClient(root);
    // boot 即占位（不再需要 until 等待 discover）
    expect(() => ctx.agentLoop.registerPromptSection({ name: 'GUIDELINES_TIMER', text: '[本地段]' }, 'test')).toThrow();
    const prompt = ctx.agentLoop.assemblePreview({ model: 'm', tools: ['timer'], conversationId: 'c1', messages: [] });
    expect(prompt).toContain('主动用 timer'); // 静态面保持
  });
});
