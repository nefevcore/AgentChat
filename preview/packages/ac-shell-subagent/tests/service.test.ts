// ============================================================
// ac-shell-subagent service 单测（M8.3）：替身子壳（内存队列）验服务面
// ——物化域 / 信封投递 / 终稿等待（多轮 baseline）/ list / delete 收割。
// 真子壳进程链路归 rows-import + e2e（本文件零子进程）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import { makeSubagentRow, type ShellProcess, type SpawnShellFn } from '../src/service.ts';
import { readChildConfig } from 'ac-agents-core';

const ROOT = path.join('preview', 'sandbox', 'test-subagent-' + process.pid);
const CATALOG = path.resolve('preview/apps/catalog/row-catalog.json');

beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, 'agents', 'papa'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents', 'papa', 'config.json'),
    JSON.stringify({ id: 'papa', model: 'mock', tools: ['fs-tools', 'shell-tools', 'fs-search'] }), 'utf-8');
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 内存替身子壳：deliver 落账真文件（验终稿读面），control/interrupt 记录 */
function fakeShell(): { spawn: SpawnShellFn; frames: Array<Record<string, unknown>>; envs: Array<{ requestId: string; text: string; budget: number }> } {
  const frames: Array<Record<string, unknown>> = [];
  const envs: Array<{ requestId: string; text: string; budget: number }> = [];
  let n = 0;
  const spawn: SpawnShellFn = (a) => {
    const proc: ShellProcess = {
      pid: 4000 + (n++),
      deliver: async (env) => {
        const text = (env.payload as { text?: string }).text ?? '';
        envs.push({ requestId: env.requestId, text, budget: env.budget });
        // 模拟子壳 conversation：落账入站行 + 终稿行（run 键——终稿判定面）
        const dir = path.join(a.dataRoot, 'agents', a.parentId, 'children', a.childId, 'sessions', a.parentId + '~' + a.childId);
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, 'messages.jsonl');
        const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '';
        const reply = { type: 'message', role: 'agent', content: '回声[' + text + ']', agent_id: a.childId, uuid: a.parentId + '~' + a.childId, requestId: 'r', run: 'run-x', timestamp: new Date().toISOString(), seq: 999 };
        fs.writeFileSync(f, lines + JSON.stringify({ type: 'message', role: 'agent', content: text, agent_id: a.parentId, uuid: a.parentId + '~' + a.childId, requestId: env.requestId, timestamp: new Date().toISOString(), seq: 998 }) + '\n' + JSON.stringify(reply) + '\n', 'utf-8');
        return { fresh: true };
      },
      control: async (frame) => { frames.push(frame); return { interrupted: frame.ctrl === 'interrupt' }; },
      shutdown: async () => {},
      onExit: () => {},
      kill: () => {},
    };
    return proc;
  };
  return { spawn, frames, envs };
}

async function makeService(spawn: SpawnShellFn) {
  const ctx = new Context();
  const toolsFiber = ctx.plugin(toolsRow as unknown as Parameters<Context['plugin']>[0]);
  await toolsFiber;
  const fiber = ctx.plugin(makeSubagentRow({
    dataRoot: ROOT, agentId: 'papa', bootFile: 'boot.ts', catalogFile: CATALOG, spawnShell: spawn,
  }));
  await fiber;
  const svc = ctx.get('subagents', false) as unknown as {
    spawnOp(i: { name?: string; system?: string; task: string; tools?: string[]; waitMs?: number }): Promise<{ childId: string; reply?: { text: string }; filtered?: string[] }>;
    sendOp(id: string, msg: string, mode: string, waitMs?: number): Promise<{ delivered: boolean; reply?: { text: string } }>;
    awaitOp(id: string, ms: number): Promise<{ text: string } | null>;
    listOp(): Array<{ childId: string; name?: string; status: string; busy: boolean }>;
    stopOp(id: string): Promise<{ stopped: boolean }>;
    deleteOp(id: string): Promise<{ deleted: boolean }>;
  };
  return { ctx, svc, dispose: async () => {
    if (fiber.uid !== null) await fiber.dispose();
    if (toolsFiber.uid !== null) await toolsFiber.dispose();
  } };
}

describe('M8.3 subagent 服务面（替身子壳）', () => {
  it('spawn：物化子域 + 首条任务投递 + sync 终稿', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const out = await svc.spawnOp({ task: '探查任务', waitMs: 5_000 });
      expect(out.reply?.text).toBe('回声[探查任务]');
      // 物化域：agents/papa/children/<id>/（R-5 域内嵌套）
      expect(readChildConfig(ROOT, 'papa', out.childId)?.id).toBe(out.childId);
      // 信封形状：budget=2（防自激面）、to=childId
      expect(fake.envs.at(-1)?.budget).toBe(2);
    } finally { await dispose(); }
  });

  it('send 多轮：终稿 baseline 区分新旧 + 第二轮 sync 取新终稿', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: '第一轮', waitMs: 5_000 });
      const out = await svc.sendOp(a.childId, '第二轮', 'sync', 5_000);
      expect(out.reply?.text).toBe('回声[第二轮]');
    } finally { await dispose(); }
  });

  it('list / stop（控制帧 interrupt）/ delete（收割物化目录）', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: 't' });
      expect(svc.listOp().map((e) => e.childId)).toContain(a.childId);
      expect((await svc.stopOp(a.childId)).stopped).toBe(true);
      expect(fake.frames.at(-1)).toEqual({ ctrl: 'interrupt' });
      await svc.deleteOp(a.childId);
      expect(svc.listOp().map((e) => e.childId)).not.toContain(a.childId);
      expect(fs.existsSync(path.join(ROOT, 'agents', 'papa', 'children', a.childId))).toBe(false);
    } finally { await dispose(); }
  });

  it('工具在册 + execute 闭环：subagent(action=spawn) 经 tools 面可达', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    try {
      const tools = ctx.get('tools') as unknown as {
        list(): Array<{ name: string }>;
        execute(call: { name: string; args: Record<string, unknown> }): Promise<{ ok: boolean; output?: unknown; error?: string }>;
      };
      expect(tools.list().map((t) => t.name)).toContain('subagent');
      const res = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '工具面任务', wait_time: 5 } });
      expect(res.ok).toBe(true);
      const out = res.output as { subagent_id: string; result?: { text: string } };
      expect(out.result?.text).toBe('回声[工具面任务]');
      expect(svc.listOp().map((e) => e.childId)).toContain(out.subagent_id);
      // await 面先行查询（pending 不阻塞）
      const pending = await tools.execute({ name: 'subagent', args: { action: 'await', subagent_id: 'sub-none' } }).catch(() => null);
      expect(pending === null || pending.ok !== true).toBe(true); // 不在场 = fail-loud
    } finally { await dispose(); }
  });

  it('spawn tools 词过滤（cr-616）：未命中目录的词滤除并回报，子 config 只剩有效词', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const out = await svc.spawnOp({ task: 't', tools: ['read', 'healthz', 'fs-search'] });
      expect(out.filtered).toEqual(['healthz']);
      const cfg = readChildConfig(ROOT, 'papa', out.childId);
      expect(cfg?.rows).toEqual(['read', 'fs-search']); // healthz 不再击穿子壳行集静态断言
    } finally { await dispose(); }
  });

  // cr-677：subagents/updated 发射点（前端 subagentBoard 帧驱动刷新唯一源）
  it('subagents/updated：spawn/send/stop/delete 各操作点发射（载荷 = infoOf 投影 + action 词）', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    const events: Array<{ id: string; action: string; info: Record<string, unknown> }> = [];
    const off = ctx.on('subagents/updated', (info: { id: string }, action: string) => {
      events.push({ id: info.id, action, info: info as unknown as Record<string, unknown> });
    });
    try {
      const out = await svc.spawnOp({ task: '发射点任务', name: '调研员', waitMs: 5_000 });
      const id = out.childId;
      // spawn 链：spawned（物化后）→ started（投递前）→ settled（终稿后）
      expect(events.map((e) => e.action)).toEqual(['spawned', 'started', 'settled']);
      // 载荷口径：parentId/displayStatus/task（infoOf 盘读统计）
      const settled = events.at(-1)!;
      expect(settled.info).toMatchObject({
        id, parentId: 'papa', name: '调研员', runs: 1, deleted: false,
      });
      // send 二轮 + stop + delete
      await svc.sendOp(id, '二轮', 'sync', 5_000);
      await svc.stopOp(id);
      await svc.deleteOp(id);
      expect(events.map((e) => e.action)).toEqual(['spawned', 'started', 'settled', 'started', 'settled', 'stopped', 'removed']);
      // delete 的载荷 = 墓碑形态（deleted: true）
      expect(events.at(-1)!.info).toMatchObject({ id, deleted: true });
      expect(events.at(-1)!.info.parentId).toBe('papa');
    } finally {
      off();
      await dispose();
    }
  });
});
