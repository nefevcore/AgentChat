// ============================================================
// ac-shell-subagent service 单测（M8.3）：替身子壳（内存队列）验服务面
// ——物化域 / 信封投递 / 终稿等待（多轮 baseline）/ list / delete 收割。
// 真子壳进程链路归 rows-import + e2e（本文件零子进程）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import { makeSubagentRow, type ShellProcess, type SpawnShellFn } from '../src/service.ts';
import { readChildConfig } from 'ac-agents-core';
import { acquireActivationLock, makeEnvelope, socketPathFor, type Envelope } from 'ac-envelope-core';
import { listenIpc, type IpcServer } from 'ac-envelope-core';

const ROOT = path.join('sandbox', 'test-subagent-' + process.pid);
const CATALOG = path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'row-catalog.json');
// cr-1022 批4：活装配行集替身（bootShell 注入面的测试直供——词面/物化定义源）
const SHELL_ROWS = ['fs-tools', 'fs-search', 'shell-tools', 'subagent', 'run-code']
  .map((id) => ({ id, tree: 'shell' as const, zone: 'capability' as const }));

// cr-1036 批3：身份 fixture 走 v3 写口（config.json 读窗退役）；tools 旧词形归一 rows
import { writeAgentConfig, writeAgentPatchV3At, writePluginConfigAt } from 'ac-agents-core';
function seedPapa(extra: Record<string, unknown> = {}): void {
  const { tools, ...rest } = extra as { tools?: unknown };
  writeAgentConfig(ROOT, {
    id: 'papa', model: 'mock',
    ...(tools !== undefined ? { rows: tools as string[] } : {}),
    ...rest,
  } as import('ac-agents-core').AgentConfig, { shellRows: SHELL_ROWS.map((r) => ({ ...r, path: undefined })) });
}
/** 子域最小物化（v3 空清单——config.json 在场判定的等价面）；originConversation 走 origin.json 单元（主写面） */
function seedChildRaw(childId: string, originConversation?: string): void {
  const dir = path.join(ROOT, 'agents', 'papa', 'children', childId);
  fs.mkdirSync(dir, { recursive: true });
  writeAgentPatchV3At(dir, [], {});
  if (originConversation !== undefined) {
    writePluginConfigAt(dir, 'origin', { originConversation });
  }
}

beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, 'agents', 'papa'), { recursive: true });
  seedPapa({ tools: ['fs-tools', 'shell-tools', 'fs-search'] });
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 内存替身子壳：deliver 落账真文件（验终稿读面），control/interrupt 记录 */
function fakeShell(): { spawn: SpawnShellFn; frames: Array<Record<string, unknown>>; envs: Array<{ requestId: string; text: string; budget: number; replyConversation?: string; access?: string }> } {
  const frames: Array<Record<string, unknown>> = [];
  const envs: Array<{ requestId: string; text: string; budget: number; replyConversation?: string; access?: string }> = [];
  let n = 0;
  const spawn: SpawnShellFn = (a) => {
    const proc: ShellProcess = {
      pid: 4000 + (n++),
      deliver: async (env) => {
        const text = (env.payload as { text?: string }).text ?? '';
        const replyConversation = (env.payload as { replyConversation?: string }).replyConversation;
        envs.push({ requestId: env.requestId, text, budget: env.budget, ...(replyConversation !== undefined ? { replyConversation } : {}), ...(env.access !== undefined ? { access: env.access } : {}) });
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
  const llmFiber = ctx.plugin(llmRow as unknown as Parameters<Context['plugin']>[0]);
  await llmFiber;
  const loopFiber = ctx.plugin(loopRow as unknown as Parameters<Context['plugin']>[0]);
  await loopFiber;
  const fiber = ctx.plugin(makeSubagentRow({
    dataRoot: ROOT, agentId: 'papa', bootFile: 'boot.ts', catalogFile: CATALOG, shellRows: SHELL_ROWS, spawnShell: spawn,
  }));
  await fiber;
  const svc = ctx.get('subagents', false) as unknown as {
    spawnOp(i: { name?: string; system?: string; task: string; tools?: string[]; waitMs?: number; replyConversation?: string }): Promise<{ childId: string; reply?: { text: string }; filtered?: string[] }>;
    sendOp(id: string, msg: string, mode: string, waitMs?: number, replyConversation?: string): Promise<{ delivered: boolean; reply?: { text: string } }>;
    awaitOp(id: string, ms: number, signal?: AbortSignal): Promise<{ text: string } | { interactionId: string; questions: Array<{ question: string }> } | null>;
    listOp(): Array<{ childId: string; name?: string; status: string; busy: boolean; exit?: { code: number | null; signal: string | null; aborted: boolean } }>;
    stopOp(id: string): Promise<{ stopped: boolean }>;
    deleteOp(id: string): Promise<{ deleted: boolean }>;
    ownsChild(id: string): boolean;
    deliverToChild(id: string, env: Envelope): Promise<boolean>;
  };
  return { ctx, svc, dispose: async () => {
    if (fiber.uid !== null) await fiber.dispose();
    if (loopFiber.uid !== null) await loopFiber.dispose();
    if (llmFiber.uid !== null) await llmFiber.dispose();
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

  // cr-711：异步任务的完成回执需要发起会话键（父壳据此投回 user⇄父 会话）；
  // sync / waitMs 由工具返回值交付结果——不重复挂键（否则同轮双份唤醒）。
  it('任务信封回带 replyConversation：async 挂、sync/waitMs 不挂', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: '异步任务', replyConversation: 'u-init~papa' });
      expect(fake.envs.at(-1)).toMatchObject({ budget: 2, replyConversation: 'u-init~papa' });
      // 续聊 async（工具 send 缺省）：同样挂发起会话键
      await svc.sendOp(a.childId, '异步追问', 'async', 0, 'u-init~papa');
      expect(fake.envs.at(-1)).toMatchObject({ budget: 2, replyConversation: 'u-init~papa' });
      // sync / waitMs：结果由返回值交付，不挂
      await svc.sendOp(a.childId, '同步追问', 'sync', 5_000, 'u-init~papa');
      expect(fake.envs.at(-1)?.replyConversation).toBeUndefined();
      await svc.spawnOp({ task: '等待任务', waitMs: 5_000, replyConversation: 'u-init~papa' });
      expect(fake.envs.at(-1)?.replyConversation).toBeUndefined();
    } finally { await dispose(); }
  });

  // cr-712：delete 收割改归档——子域账本保留（回放审计），list 隐去
  it('list / stop（控制帧 interrupt）/ delete（归档收割：账本保留 + list 隐去）', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: 't' });
      expect(svc.listOp().map((e) => e.childId)).toContain(a.childId);
      expect((await svc.stopOp(a.childId)).stopped).toBe(true);
      expect(fake.frames.at(-1)).toEqual({ ctrl: 'interrupt' });
      await svc.deleteOp(a.childId);
      expect(svc.listOp().map((e) => e.childId)).not.toContain(a.childId);
      const dir = path.join(ROOT, 'agents', 'papa', 'children', a.childId);
      expect(fs.existsSync(path.join(dir, 'archived.json'))).toBe(true);
      // 子域账本保留（任务行 + 终稿行仍在盘上）
      expect(fs.existsSync(path.join(dir, 'sessions', 'papa~' + a.childId, 'messages.jsonl'))).toBe(true);
      // 空工作区顺手回收（cr-754）：懒建的 files/<sub-id> 无产出即删；
      // 非空（子留有产出文件）保留——见下一断言
      expect(fs.existsSync(path.join(ROOT, 'files', a.childId))).toBe(false);
    } finally { await dispose(); }
  });

  it('工具在册 + execute 闭环：subagent(action=spawn) 经 tools 面可达', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    try {
      const tools = ctx.get('tools') as unknown as {
        list(): Array<{ name: string }>;
        execute(call: { name: string; args: Record<string, unknown>; agentId?: string; conversationId?: string }): Promise<{ ok: boolean; output?: unknown; error?: string }>;
      };
      expect(tools.list().map((t) => t.name)).toContain('subagent');
      const res = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '工具面任务', wait_time: 5 } });
      expect(res.ok).toBe(true);
      const out = res.output as { subagent_id: string; result?: { text: string } };
      expect(out.result?.text).toBe('回声[工具面任务]');
      expect(svc.listOp().map((e) => e.childId)).toContain(out.subagent_id);
      // cr-711：工具调用所在的发起会话键随任务信封下发（完成回执回投目标）
      const res2 = await tools.execute({
        name: 'subagent', args: { action: 'spawn', task: '带发起会话的任务' },
        agentId: 'papa', conversationId: 'u-init~papa',
      });
      expect(res2.ok).toBe(true);
      expect(fake.envs.at(-1)?.replyConversation).toBe('u-init~papa');
      // await 面先行查询（pending 不阻塞）
      const pending = await tools.execute({ name: 'subagent', args: { action: 'await', subagent_id: 'sub-none' } }).catch(() => null);
      expect(pending === null || pending.ok !== true).toBe(true); // 不在场 = fail-loud
    } finally { await dispose(); }
  });

  it('spawn tools 词过滤（cr-616 / cr-1022 批2 行 id 词形）：未命中/工具名词形滤除并回报，子 config 只剩有效行', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      // 'read' 是工具名非行 id——词形退役后与 'healthz' 同为未命中拒绝
      const out = await svc.spawnOp({ task: 't', tools: ['read', 'healthz', 'fs-search'] });
      expect(out.filtered).toEqual(['read', 'healthz']);
      const cfg = readChildConfig(ROOT, 'papa', out.childId);
      // cr-1022 批2：子物化 v3 菜单片段——rows = 骨架 ∪ 定义正清单
      expect((cfg?.rows as { include?: string[] })?.include).toEqual(['fs-search']); // 未命中词不再击穿子壳行集静态断言
    } finally { await dispose(); }
  });

  // cr-762：子 Agent 不能再派子孙——spawn 显式点名 subagent 被拒（filtered 回报），
  // 子 config 不物化 subagent 行；缺省继承路径由 boot 行集合成面剔除（boot.test 锁定）。
  it('spawn tools 显式点名 subagent 被拒（cr-762 防子孙无限增长）', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const out = await svc.spawnOp({ task: 't', tools: ['fs-tools', 'subagent'] });
      expect(out.filtered).toEqual(['subagent']);
      const cfg = readChildConfig(ROOT, 'papa', out.childId);
      expect((cfg?.rows as { include?: string[] })?.include).toEqual(['fs-tools']);
    } finally { await dispose(); }
  });

  // cr-758 工作区锚点继承：发起会话挂载工作区时，spawn 快照进子 config
  // settings.security.workdir——子会话键 parent~sub-x 是新对桶，singles
  // 挂载信息结构上到不了子壳，物化快照是唯一通道（R-5 同构）。
  it('cr-758 发起会话挂载工作区：子 config 快照 workdir 锚点；未挂载不写', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    // 挂载面替身：conversationWorkspaceRoot 命中 → 返回工作区根
    const WS = path.resolve(ROOT, 'proj-ws');
    fs.mkdirSync(WS, { recursive: true });
    const fiber = ctx.plugin({
      name: 'ws-anchor-stub',
      apply(c: Context) {
        c.plugin(class extends Service {
          constructor(cc: Context) { super(cc, 'workspace'); }
          conversationWorkspaceRoot(cid?: string): string | null {
            return cid === 'u-init~papa' ? WS : null;
          }
        });
      },
    } satisfies Parameters<Context['plugin']>[0]);
    await fiber;
    try {
      const a = await svc.spawnOp({ task: 't', replyConversation: 'u-init~papa' });
      const cfg = readChildConfig(ROOT, 'papa', a.childId);
      expect((cfg?.settings as { security?: { workdir?: string } })?.security?.workdir).toBe(WS);
      // 未挂载发起会话（或宿主直调无键）：不写 workdir——子保持专用空间基准
      const b = await svc.spawnOp({ task: 't', replyConversation: 'u-other~papa' });
      const cfgB = readChildConfig(ROOT, 'papa', b.childId);
      expect((cfgB?.settings as { security?: { workdir?: string } } | undefined)?.security?.workdir).toBeUndefined();
    } finally {
      await fiber.dispose();
      await dispose();
    }
  });

  // cr-758 模型继承：发起会话 conv-settings 的模型覆盖快照进子 config
  //（splitModelRef 拆 name@model → model/provider）——会话生效模型不在父
  // config（deliver 合并点产物），不快照则子回落默认模型。
  it('cr-758 会话模型覆盖继承：name@model 拆分快照；无覆盖不写', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    // conv-settings 替身：u-init~papa → 'poolB@glm-5.3'，u-bare~papa → 裸名
    const fiber = ctx.plugin({
      name: 'conv-settings-stub',
      apply(c: Context) {
        c.plugin(class extends Service {
          constructor(cc: Context) { super(cc, 'convSettings'); }
          get(cid: string): Record<string, string> {
            if (cid === 'u-init~papa') return { model: 'poolB@glm-5.3' };
            if (cid === 'u-bare~papa') return { model: 'glm-5.3-air' };
            return {};
          }
        });
      },
    } satisfies Parameters<Context['plugin']>[0]);
    await fiber;
    try {
      const a = await svc.spawnOp({ task: 't', replyConversation: 'u-init~papa' });
      expect(readChildConfig(ROOT, 'papa', a.childId)).toMatchObject({ model: 'glm-5.3', provider: 'poolB' });
      const bare = await svc.spawnOp({ task: 't', replyConversation: 'u-bare~papa' });
      expect(readChildConfig(ROOT, 'papa', bare.childId)).toMatchObject({ model: 'glm-5.3-air' });
      // 无覆盖会话：保持父静态 model（papa = mock）
      const none = await svc.spawnOp({ task: 't', replyConversation: 'u-none~papa' });
      expect(readChildConfig(ROOT, 'papa', none.childId)?.model).toBe('mock');
    } finally {
      await fiber.dispose();
      await dispose();
    }
  });

  // cr-758 模型继承：发起会话 conv-settings 的模型覆盖快照进子 config
  //（splitModelRef 拆 name@model → model/provider）——会话生效模型不在父
  // config（deliver 合并点产物），不快照则子回落默认模型。
  it('cr-758 会话模型覆盖继承：name@model 拆分快照；无覆盖不写', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    // conv-settings 替身：u-init~papa → 'poolB@glm-5.3'，u-bare~papa → 裸名
    const fiber = ctx.plugin({
      name: 'conv-settings-stub',
      apply(c: Context) {
        c.plugin(class extends Service {
          constructor(cc: Context) { super(cc, 'convSettings'); }
          get(cid: string): Record<string, string> {
            if (cid === 'u-init~papa') return { model: 'poolB@glm-5.3' };
            if (cid === 'u-bare~papa') return { model: 'glm-5.3-air' };
            return {};
          }
        });
      },
    } satisfies Parameters<Context['plugin']>[0]);
    await fiber;
    try {
      const a = await svc.spawnOp({ task: 't', replyConversation: 'u-init~papa' });
      expect(readChildConfig(ROOT, 'papa', a.childId)).toMatchObject({ model: 'glm-5.3', provider: 'poolB' });
      const bare = await svc.spawnOp({ task: 't', replyConversation: 'u-bare~papa' });
      expect(readChildConfig(ROOT, 'papa', bare.childId)).toMatchObject({ model: 'glm-5.3-air' });
      // 无覆盖会话：保持父静态 model（papa = mock）
      const none = await svc.spawnOp({ task: 't', replyConversation: 'u-none~papa' });
      expect(readChildConfig(ROOT, 'papa', none.childId)?.model).toBe('mock');
    } finally {
      await fiber.dispose();
      await dispose();
    }
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

  // cr-710：父壳回信面——子 Agent 直投（裸子 id 走邮局会拉起同 id 幽灵
  // 顶层身份）。在管句柄直投；父壳换代后（句柄面空）按物化域活锁直投。
  it('ownsChild + deliverToChild：在管句柄直投（不经邮局）+ 忙态随回信回落', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    const events: string[] = [];
    const off = ctx.on('subagents/updated', (_info: { id: string }, action: string) => { events.push(action); });
    try {
      const a = await svc.spawnOp({ task: 't' });
      expect(svc.ownsChild(a.childId)).toBe(true);
      expect(svc.ownsChild('ghost-child')).toBe(false);
      // async spawn 置忙（看板 running）——终稿前不得自行回落
      expect(svc.listOp().find((e) => e.childId === a.childId)?.busy).toBe(true);
      const before = fake.envs.length;
      const ok = await svc.deliverToChild(a.childId, makeEnvelope({
        uuid: 'papa~' + a.childId, requestId: 'reply-t1', sender: 'papa', to: a.childId,
        kind: 'message', budget: 0, payload: { text: '父壳回信' },
      }));
      expect(ok).toBe(true);
      expect(fake.envs.length).toBe(before + 1);
      expect(fake.envs.at(-1)).toMatchObject({ requestId: 'reply-t1', budget: 0 });
      // 回信 = 子壳上一轮已终稿：忙态回落 + settled 帧（旧实现 async 永远 running）
      expect(svc.listOp().find((e) => e.childId === a.childId)?.busy).toBe(false);
      expect(events.at(-1)).toBe('settled');
    } finally {
      off();
      await dispose();
    }
  });

  it('deliverToChild：父壳换代（句柄面空）按子壳 activation.lock 直投 ipc', async () => {
    const childId = 'kid-lock';
    const hint = socketPathFor(path.resolve(ROOT), 'papa--' + childId);
    const received: unknown[] = [];
    let server: IpcServer | null = null;
    try {
      server = await listenIpc(hint, (payload) => {
        received.push(payload);
        return { ack: 'x', fresh: true };
      });
      // 子壳物化域 + 活锁（pid=本进程——活锁即子壳在跑；父壳换代前留下的盘面）
      const childDir = path.join(ROOT, 'agents', 'papa', 'children', childId);
      fs.mkdirSync(childDir, { recursive: true });
      acquireActivationLock(childDir, {
        pid: process.pid, bootId: 'b-kid', acquiredAt: new Date().toISOString(), transportHint: hint,
      });
      const fake = fakeShell();
      // 新 service 实例 = 父壳换代：children 句柄面为空
      const { svc, dispose } = await makeService(fake.spawn);
      try {
        expect(svc.ownsChild(childId)).toBe(true); // 磁盘物化清单仍在管
        const ok = await svc.deliverToChild(childId, makeEnvelope({
          uuid: 'papa~' + childId, requestId: 'reply-lock', sender: 'papa', to: childId,
          kind: 'message', budget: 0, payload: { text: '换代回信' },
        }));
        expect(ok).toBe(true);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ requestId: 'reply-lock', to: childId });
      } finally { await dispose(); }
    } finally {
      if (server !== null) await server.close();
    }
  });

  // cr-724：子壳带任务硬退出（被杀/崩溃，无终稿行）——await 按需合成异常
  // 退出回执一次定性（不再永 pending），list 暴露死因（aborted 投影）。
  it('子壳硬退出：await 返回异常退出回执 + list 暴露死因 + 看板 error', async () => {
    const base = fakeShell();
    let exitCb: (code: number | null, signal: string | null) => void = () => {};
    const spawn: SpawnShellFn = (a) => {
      const proc = base.spawn(a);
      return {
        ...proc,
        deliver: async () => ({ fresh: true }), // 不落终稿行 = run 在飞
        onExit: (cb) => { exitCb = cb; },
      };
    };
    const { svc, dispose } = await makeService(spawn);
    try {
      const a = await svc.spawnOp({ task: '长任务' });
      exitCb(1, null); // 进程被杀（exit code 1）
      const reply = await svc.awaitOp(a.childId, 0) as { text: string } | null;
      expect(reply?.text).toContain('异常退出');
      expect(reply?.text).toContain('code=1');
      const entry = svc.listOp().find((e) => e.childId === a.childId);
      expect(entry?.exit).toMatchObject({ code: 1, signal: null, aborted: true });
      expect(entry?.busy).toBe(false);
    } finally { await dispose(); }
  });

  // cr-753：会话设置继承——发起会话 conv-settings（access/browserTier）
  // → 子 config 结构化字段快照；per-call access 与水位取高；tc-base/
  // base 不产生键（缺省无键）。
  it('会话设置继承：父会话覆盖值合入子 config 结构化字段（物化即快照）', async () => {
    const fake = fakeShell();
    const { ctx, dispose } = await makeService(fake.spawn);
    try {
      // 壳内 convSettings 垫片缺席场景先行验证：makeService 的裸 ctx 无 convSettings → 继承面只余 per-call access
      const tools = ctx.get('tools') as unknown as {
        execute(call: { name: string; args: Record<string, unknown>; conversationId?: string; access?: string }): Promise<{ ok: boolean; output?: { subagent_id?: string } }>;
      };
      const out = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '继承任务' }, conversationId: 'user~papa', access: 'full-access' });
      const childId = (out.output as { subagent_id: string }).subagent_id;
      const cfg = readChildConfig(ROOT, 'papa', childId);
      expect(cfg?.access).toBe('full-access'); // per-call 兜底并入（无 convSettings 面）
      const plain = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '无设置' }, conversationId: 'user~papa' });
      const plainId = ((plain.output as { subagent_id: string })).subagent_id;
      const plainCfg = readChildConfig(ROOT, 'papa', plainId);
      expect(plainCfg?.access ?? 'base-access').toBe('base-access'); // 无任何来源不产生键（父 base 时键缺席）
    } finally { await dispose(); }
  });

  it('会话设置继承：convSettings 垫片在场——access/browserTier 水位映射进结构化字段；tc-* 模式词不继承（cr-763）', async () => {
    const fake = fakeShell();
    const { Service } = await import('@agentchat/cordis');
    const { ctx, dispose } = await makeService(fake.spawn);
    try {
      // convSettings 桩（壳内垫片同形：get 按 conversationId）
      class ConvStub extends Service {
        constructor(c: unknown) { super(c as never, 'convSettings'); }
        get(id: string): Record<string, string> {
          return id === 'user~papa'
            ? { access: 'full-access', toolMode: 'tc-programmatic', browserTier: 'inject', issueSubmit: 'enabled' }
            : {};
        }
      }
      await ctx.plugin(ConvStub);
      const svc = ctx.get('subagents', false) as unknown as {
        spawnOp(i: { task: string; replyConversation?: string; access?: string }): Promise<{ childId: string }>;
      };
      const out = await svc.spawnOp({ task: '全设置继承', replyConversation: 'user~papa', access: 'sandbox-access' });
      const cfg = readChildConfig(ROOT, 'papa', out.childId);
      // 水位 full > per-call sandbox（取高）+ browserTier → levels.browser
      expect(cfg?.access).toBe('full-access');
      expect(cfg?.levels?.browser).toBe('inject');
      // tc-* 是交互形态非授权（cr-763）：会话 toolMode 不快照——
      // 子 rows 由 spawn tools 决定，父会话形态快照过来而子无 run-code 行
      // 时收窄出空面（工具全丢、子变纯聊天单步收束）。
      expect(cfg?.toolMode).toBeUndefined();
    } finally { await dispose(); }
  });

  // cr-763/cr-1021：子的交互形态 = 父形态 ∧ 子行集含 run-code 行（形态跟随
  // 装配）。cr-1021 修正：run-code 进基础集后「子行集含 run-code」对缺省继承
  // 恒真——仅凭行集判定会把常规父的 spawn 子翻转成程序化；父非程序化 → 子恒
  // 常规（父 toolMode 不继承）。spawn 显式点名 run_code 词被拒（filtered）。
  it('形态合成：程序化 = 父形态 ∧ 子行集含 run-code；常规父的子不翻转；spawn 点名 run_code 被拒', async () => {
    const fake = fakeShell();
    const { ctx, dispose } = await makeService(fake.spawn);
    try {
      // 父 config 带程序化形态 + rows 含 run-code（程序化 Agent 形态）
      seedPapa({ toolMode: 'tc-programmatic', access: 'full-access', tools: ['run-code', 'fs-tools', 'subagent'] });
      const tools = ctx.get('tools') as unknown as {
        execute(call: { name: string; args: Record<string, unknown>; conversationId?: string }): Promise<{ ok: boolean; output?: { subagent_id?: string; filtered?: string[]; note?: string } }>;
      };
      // ① 缺省继承（不传 tools）：程序化父 + 子行集含 run-code → 合成
      // tc-programmatic。cr-1022 批2：子物化 v3 正清单——rows = 骨架 ∪ 父
      // 行集定义（childTokens 直取，无闭包/no-op 滤除——run-code 显式在场）
      const inherit = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '缺省继承' } });
      const inheritId = (inherit.output as { subagent_id: string }).subagent_id;
      const inheritCfg = readChildConfig(ROOT, 'papa', inheritId);
      expect((inheritCfg?.rows as { include?: string[] })?.include ?? []).toEqual(expect.arrayContaining(['fs-tools', 'run-code', 'subagent']));
      expect(inheritCfg?.toolMode).toBe('tc-programmatic'); // 父程序化 ∧ 子行集含 run-code
      expect(inheritCfg?.access).toBe('full-access'); // 档位继承面不受影响
      // ② 显式点名子集（工具名词形全拒 → 空授予 = 纯推理子）：无模式词
      const subset = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '子集', tools: ['read', 'write'] } });
      const subsetId = ((subset.output as { subagent_id: string })).subagent_id;
      const subsetCfg = readChildConfig(ROOT, 'papa', subsetId);
      expect((subsetCfg?.rows as { include?: string[] })?.include ?? []).toEqual([]);
      expect(subsetCfg?.toolMode).toBeUndefined();
      // ③ 点名 run_code 词显式拒绝（cr-763：防子域程序化形态自废 spawn 授予面）
      const rejected = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '拒 run_code', tools: ['run_code', 'read'] } });
      expect(((rejected.output as { note?: string }).note ?? '')).toContain('run_code');
      // ④ cr-1021：常规父（无 toolMode）+ 子行集含 run-code（缺省继承）→
      // 不合成程序化——「行集含 run-code」不再单独构成形态信号
      seedPapa({ access: 'full-access', tools: ['run-code', 'fs-tools', 'subagent'] });
      const plain = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '常规父' } });
      const plainCfg = readChildConfig(ROOT, 'papa', (plain.output as { subagent_id: string }).subagent_id);
      expect((plainCfg?.rows as { include?: string[] })?.include ?? []).toContain('run-code'); // v3 正清单直读
      expect(plainCfg?.toolMode).toBeUndefined(); // 常规父的子恒常规
    } finally { await dispose(); }
  });

  // cr-728：提权继承——call.access 随任务信封下发（两档白名单窄化），
  // 子壳 receiveEnvelope → loop 既有链路生效；无提权不携带。
  it('任务信封携带 access：call.access=full-access 下发；非法档位/无提权不携带', async () => {
    const fake = fakeShell();
    const { ctx, dispose } = await makeService(fake.spawn);
    try {
      const tools = ctx.get('tools') as unknown as {
        execute(call: { name: string; args: Record<string, unknown>; conversationId?: string; access?: string }): Promise<{ ok: boolean }>;
      };
      await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '提权任务' }, access: 'full-access' });
      expect(fake.envs.at(-1)).toMatchObject({ budget: 2, access: 'full-access' });
      await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '无提权任务' } });
      expect(fake.envs.at(-1)!.access).toBeUndefined();
      await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '坏档位' }, access: 'root' as string });
      expect(fake.envs.at(-1)!.access).toBeUndefined();
    } finally { await dispose(); }
  });

  // cr-727：等待面遵守宿主中止（run_code 墙钟耗尽/用户 abort 经 call.signal
  // 下发）——中止立返，worker 才够得到检查点自收束（否则宽限后 terminate）。
  it('awaitOp 中止即返：signal abort 后轮询拍内返回 null（不等 timeout_s）', async () => {
    const base = fakeShell();
    const spawn: SpawnShellFn = (a) => {
      const proc = base.spawn(a);
      return { ...proc, deliver: async () => ({ fresh: true }) }; // 不落终稿行 = 永等
    };
    const { svc, dispose } = await makeService(spawn);
    try {
      const a = await svc.spawnOp({ task: '长任务' });
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 50);
      const t0 = Date.now();
      const reply = await svc.awaitOp(a.childId, 60_000, ctl.signal);
      expect(reply).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2_000); // 中止即返，不是 60s 超时
    } finally { await dispose(); }
  });

  // cr-729：子 Agent ask_questions 挂起对父可见 + 父可代答——await 返回
  // asking 载荷（盘读子域 interactions.jsonl）；answer 经控制帧投
  // interaction-reply admin op（子侧链路全既有）。
  it('ask 闭环：await 报 asking（含问题载荷）；answer 投 interaction-reply 帧；无 pending 抛错', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: 't' });
      // 无 pending：await 立即查询 = pending（不误报 asking）
      expect(await svc.awaitOp(a.childId, 0)).toBeNull();
      // 子域落一条 pending 提问（子壳 ask_questions 的盘面形态）
      const childRoot = path.join(ROOT, 'agents', 'papa', 'children', a.childId);
      fs.mkdirSync(childRoot, { recursive: true });
      fs.writeFileSync(path.join(childRoot, 'interactions.jsonl'), JSON.stringify({
        id: 'dur-x1', key: 'papa~' + a.childId, kind: 'ask_questions', state: 'pending',
        payload: { questions: [{ question: '怎么继续？', options: ['直接改', '出补丁'] }] },
      }) + '\n', 'utf-8');
      const asking = await svc.awaitOp(a.childId, 0);
      expect(asking).toMatchObject({ interactionId: 'dur-x1' });
      expect((asking as { questions: Array<{ question: string }> }).questions[0]?.question).toBe('怎么继续？');
      // 代答：控制帧形状逐字段对齐（子壳 admin-frame interaction-reply）
      const out = await (svc as unknown as { answerOp(id: string, ans: Array<string | string[] | null>): Promise<{ status: string }> })
        .answerOp(a.childId, ['直接改']);
      expect(out.status).toBe('answered');
      expect(fake.frames.at(-1)).toEqual({ ctrl: 'admin', agentId: a.childId, op: 'interaction-reply', id: 'dur-x1', answer: { answers: ['直接改'] } });
    } finally { await dispose(); }
  });

  // 引导返回：await 落空 / send(sync) 无回执不再只报 pending——附子状态
  // 快照（state + settled_runs + hint；asking 带 interaction_id 与问题载荷），
  // 调用方据 hint 决策而非猜测子运行状态。
  it('引导返回：await 落空报 running/asking 快照；send(sync) 无回执报 no_reply_yet + 快照', async () => {
    const fake = fakeShell();
    // deliver 不落终稿行 = run 永不收束（busy 常驻、无新终稿）
    const spawn: SpawnShellFn = (a) => ({ ...fake.spawn(a), deliver: async () => ({ fresh: true }) });
    const { ctx, dispose } = await makeService(spawn);
    try {
      const tools = ctx.get('tools') as unknown as {
        execute(call: { name: string; args: Record<string, unknown>; conversationId?: string; signal?: AbortSignal }): Promise<{ ok: boolean; output?: Record<string, unknown> }>;
      };
      const spawned = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '长任务' } });
      const id = (spawned.output as { subagent_id: string }).subagent_id;
      // ① await 落空：running 快照（busy 常驻）+ settled_runs=0 + hint 引导
      const pending = await tools.execute({ name: 'subagent', args: { action: 'await', subagent_id: id, timeout_s: 0 } });
      expect(pending.output).toMatchObject({ action: 'await', status: 'pending', state: 'running', settled_runs: 0 });
      expect(String(pending.output!.hint)).toContain('正在执行');
      // ② 子域落 pending 提问 → asking 快照（优先于 running；带问题载荷）
      fs.mkdirSync(path.join(ROOT, 'agents', 'papa', 'children', id), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'agents', 'papa', 'children', id, 'interactions.jsonl'), JSON.stringify({
        id: 'dur-b1', kind: 'ask_questions', state: 'pending',
        payload: { questions: [{ question: '格式？', options: ['Markdown', '纯文本'] }] },
      }) + '\n', 'utf-8');
      const asking = await tools.execute({ name: 'subagent', args: { action: 'await', subagent_id: id, timeout_s: 0 } });
      expect(asking.output).toMatchObject({ status: 'asking', interaction_id: 'dur-b1' });
      expect((asking.output!.questions as Array<{ question: string }>)[0]!.question).toBe('格式？');
      expect(String(asking.output!.note)).toContain('answer');
      // ③ send(sync) 中止（无回执）：status=no_reply_yet + 状态快照（asking 仍在盘）
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 100);
      const t0 = Date.now();
      const sync = await tools.execute({ name: 'subagent', args: { action: 'send', subagent_id: id, message: '追问', mode: 'sync' }, signal: ctl.signal });
      expect(Date.now() - t0).toBeLessThan(5_000); // 中止即返，不是 60s 超时
      expect(sync.output).toMatchObject({ action: 'send', status: 'no_reply_yet', state: 'asking' });
      expect(sync.output!.result).toBeUndefined();
    } finally { await dispose(); }
  });

  // status action：零等待状态查询——childBriefOf 七态快照 + progress 进度
  // 统计（journal 现算）。fakeShell 不落 journal（deliver 只写 messages.jsonl），
  // 无 journal = progress 全零值——另用手写 journal 文件验统计正确性。
  it('status：零等待快照（state/progress/hint）+ journal 统计正确', async () => {
    const fake = fakeShell();
    const spawn: SpawnShellFn = (a) => ({ ...fake.spawn(a), deliver: async () => ({ fresh: true }) });
    const { ctx, dispose } = await makeService(spawn);
    try {
      const tools = ctx.get('tools') as unknown as {
        execute(call: { name: string; args: Record<string, unknown> }): Promise<{ ok: boolean; output?: Record<string, unknown> }>;
      };
      const spawned = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '跑任务' } });
      const id = (spawned.output as { subagent_id: string }).subagent_id;
      // ① 无 journal：running 态 + progress 零值（不误报停滞）
      const s1 = await tools.execute({ name: 'subagent', args: { action: 'status', subagent_id: id } });
      expect(s1.output).toMatchObject({ action: 'status', subagent_id: id, state: 'running' });
      expect(s1.output!.progress).toMatchObject({ steps: 0, tokens: 0, tool_calls: 0 });
      expect(String(s1.output!.hint)).toContain('正在执行');
      // ② 手写 journal：settled run（2 步 100 tokens）+ 当前 run 已 1 步 40 tokens + 2 工具调用
      const jdir = path.join(ROOT, 'agents', 'papa', 'children', id, 'sessions', 'papa~' + id, 'journal');
      fs.mkdirSync(jdir, { recursive: true });
      const jlines = [
        { type: 'journal-step', run: 'run-1', step: 0, content: 's0', usage: { prompt: 30, completion: 20, total: 50 }, ts: Date.now() - 60_000 },
        { type: 'journal-step', run: 'run-1', step: 1, content: 's1', usage: { prompt: 30, completion: 20, total: 50 }, ts: Date.now() - 59_000 },
        { type: 'journal-settled', run: 'run-1', finish: 'ok', usage: { prompt: 60, completion: 40, steps: 2, total: 100 } },
        { type: 'journal-step', run: 'run-2', step: 0, content: 'r0', usage: { prompt: 25, completion: 15, total: 40 }, toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }, { id: 't2', name: 'grep', arguments: '{}' }], ts: Date.now() - 5_000 },
      ];
      fs.writeFileSync(path.join(jdir, 'partials.jsonl'), jlines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
      const s2 = await tools.execute({ name: 'subagent', args: { action: 'status', subagent_id: id } });
      expect(s2.output!.progress).toMatchObject({
        steps: 1,           // 当前 run（run-2，最后 settled 之后）
        total_steps: 3,     // run-1 的 2 步 + run-2 的 1 步
        tokens: 40,         // run-2 步行 usage
        total_tokens: 140,  // run-1 settled 100 + run-2 40
        tool_calls: 2,      // run-2 步行 toolCalls
      });
      const prog = s2.output!.progress as { steps: number; tokens: number; tool_calls: number; total_steps: number; total_tokens: number; since_last_step_ms?: number };
      expect(prog.since_last_step_ms).toBeGreaterThanOrEqual(0);
      // ③ 未知 id fail-loud（execute 包裹层吞异常转 ok:false）
      const ghost = await tools.execute({ name: 'subagent', args: { action: 'status', subagent_id: 'sub-ghost' } });
      expect(ghost.ok).toBe(false);
    } finally { await dispose(); }
  });

  // cr-730：子域提问推送——interactions.jsonl 落 pending ask 后 watch 触发，
  // subagents/ask 事件发射 + 注入面被调（本测试环境无 agentLoop/conversation
  // 服务——注入静默降级，事件面断言链路）；已通知 id 不重投。
  it('ask 推送：watch 发现新 pending → subagents/ask 事件（一次）；answered 后不再报', async () => {
    const fake = fakeShell();
    const { ctx, dispose } = await makeService(fake.spawn);
    const asks: Array<{ childId: string; interactionId: string }> = [];
    const off = ctx.on('subagents/ask', (a: { childId: string; interactionId: string }) => { asks.push(a); });
    try {
      const a = await svcSpawnOnly();
      const childRoot = path.join(ROOT, 'agents', 'papa', 'children', a);
      fs.mkdirSync(childRoot, { recursive: true });
      const line = JSON.stringify({
        id: 'dur-q1', kind: 'ask_questions', state: 'pending',
        payload: { questions: [{ question: '怎么走？', options: ['A 方案', 'B 方案'] }] },
      });
      fs.writeFileSync(path.join(childRoot, 'interactions.jsonl'), line + '\n', 'utf-8');
      await new Promise((r) => setTimeout(r, 700)); // watch 防抖 200ms + 余量
      expect(asks.filter((x) => x.interactionId === 'dur-q1')).toHaveLength(1);
      // 同文件再次触碰（追加写）——同 id 不重投
      fs.appendFileSync(path.join(childRoot, 'interactions.jsonl'), line + '\n', 'utf-8');
      await new Promise((r) => setTimeout(r, 400));
      expect(asks.filter((x) => x.interactionId === 'dur-q1')).toHaveLength(1);
    } finally {
      off();
      await dispose();
    }
    async function svcSpawnOnly(): Promise<string> {
      const s = (ctx.get('subagents', false) as unknown as { spawnOp(i: { task: string }): Promise<{ childId: string }> });
      const out = await s.spawnOp({ task: 't' });
      return out.childId;
    }
  });

  // cr-731：重启对账——子域盘面（pending ask + config.originConversation）在，
  // 父壳换代（children 句柄面空、内存态全蒸发）：boot 对账按幂等键补投通知
  // 到 originConversation（deliver requestId = ask-notice-<id>）。
  it('重启对账：新服务实例 boot 即补投漏通知（requestId 幂等键 + originConversation 盘读）', async () => {
    const childRoot = path.join(ROOT, 'agents', 'papa', 'children', 'sub-reboot');
    fs.mkdirSync(childRoot, { recursive: true });
    seedChildRaw('sub-reboot', 'u-init~papa');
    fs.writeFileSync(path.join(childRoot, 'interactions.jsonl'), JSON.stringify({
      id: 'dur-r1', kind: 'ask_questions', state: 'pending',
      payload: { questions: [{ question: '重启后的问题', options: ['继续', '放弃'] }] },
    }) + '\n', 'utf-8');
    const delivers: Array<Record<string, unknown>> = [];
    const ctx = new Context();
    ctx.provide('conversation', {
      deliver: async (agentId: string, message: string, options?: Record<string, unknown>) => {
        delivers.push({ agentId, message, ...(options ?? {}) });
        return { kind: 'queued' };
      },
    });
    const toolsFiber = ctx.plugin(toolsRow as unknown as Parameters<Context['plugin']>[0]);
    await toolsFiber;
    const llmFiber2 = ctx.plugin(llmRow as unknown as Parameters<Context['plugin']>[0]);
    await llmFiber2;
    const loopFiber2 = ctx.plugin(loopRow as unknown as Parameters<Context['plugin']>[0]);
    await loopFiber2;
    const fiber = ctx.plugin(makeSubagentRow({
      dataRoot: ROOT, agentId: 'papa', bootFile: 'boot.ts', catalogFile: CATALOG, shellRows: SHELL_ROWS, spawnShell: fakeShell().spawn,
    }));
    await fiber;
    try {
      await new Promise((r) => setTimeout(r, 50)); // deliver 是 fire-and-forget
      expect(delivers).toHaveLength(1);
      expect(delivers[0]).toMatchObject({
        agentId: 'papa',
        conversationId: 'u-init~papa',
        requestId: 'ask-notice-dur-r1',
      });
      expect(String(delivers[0]!.message)).toContain('重启后的问题');
    } finally {
      if (fiber.uid !== null) await fiber.dispose();
      if (toolsFiber.uid !== null) await toolsFiber.dispose();
    }
  });

  // cr-732：历史子回落——config 无 originConversation（cr-731 前 spawn）时
  // 读 inbox 任务信封 payload.replyConversation（cr-711 持久化），对账照投。
  it('注入目标回落：inbox 信封 replyConversation 恢复历史子的对账投递', async () => {
    const childRoot = path.join(ROOT, 'agents', 'papa', 'children', 'sub-legacy');
    const inboxDir = path.join(childRoot, 'sessions', 'papa~sub-legacy', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    seedChildRaw('sub-legacy'); // 无 originConversation
    fs.writeFileSync(path.join(inboxDir, 'sub-t1.json'), JSON.stringify({
      uuid: 'papa~sub-legacy', requestId: 'sub-t1', sender: 'papa', to: 'sub-legacy', kind: 'message',
      payload: { text: '任务', replyConversation: 'u-legacy~papa' },
    }), 'utf-8');
    fs.writeFileSync(path.join(childRoot, 'interactions.jsonl'), JSON.stringify({
      id: 'dur-legacy', kind: 'ask_questions', state: 'pending',
      payload: { questions: [{ question: '历史遗留问题', options: ['A', 'B'] }] },
    }) + '\n', 'utf-8');
    const delivers: Array<Record<string, unknown>> = [];
    const ctx = new Context();
    ctx.provide('conversation', {
      deliver: async (agentId: string, message: string, options?: Record<string, unknown>) => {
        delivers.push({ agentId, message, ...(options ?? {}) });
        return { kind: 'queued' };
      },
    });
    const toolsFiber = ctx.plugin(toolsRow as unknown as Parameters<Context['plugin']>[0]);
    await toolsFiber;
    const llmFiber3 = ctx.plugin(llmRow as unknown as Parameters<Context['plugin']>[0]);
    await llmFiber3;
    const loopFiber3 = ctx.plugin(loopRow as unknown as Parameters<Context['plugin']>[0]);
    await loopFiber3;
    const fiber = ctx.plugin(makeSubagentRow({
      dataRoot: ROOT, agentId: 'papa', bootFile: 'boot.ts', catalogFile: CATALOG, shellRows: SHELL_ROWS, spawnShell: fakeShell().spawn,
    }));
    await fiber;
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(delivers).toHaveLength(1);
      expect(delivers[0]).toMatchObject({ conversationId: 'u-legacy~papa', requestId: 'ask-notice-dur-legacy' });
      expect(String(delivers[0]!.message)).toContain('历史遗留问题');
    } finally {
      if (fiber.uid !== null) await fiber.dispose();
      if (toolsFiber.uid !== null) await toolsFiber.dispose();
    }
  });

  // cr-733：conversation 服务晚于 subagent 行装配（行序依赖）——boot 对账
  // 先拿不到会话面，500ms 重试链等到 provide 后补投成功。
  it('对账重试：conversation 延迟就位（行序后装）→ 重试链等到后投出通知', async () => {
    const childRoot = path.join(ROOT, 'agents', 'papa', 'children', 'sub-late');
    fs.mkdirSync(childRoot, { recursive: true });
    seedChildRaw('sub-late', 'u-late~papa');
    fs.writeFileSync(path.join(childRoot, 'interactions.jsonl'), JSON.stringify({
      id: 'dur-late', kind: 'ask_questions', state: 'pending',
      payload: { questions: [{ question: '延迟服务下的问题', options: ['A', 'B'] }] },
    }) + '\n', 'utf-8');
    const delivers: Array<Record<string, unknown>> = [];
    const ctx = new Context();
    const toolsFiber = ctx.plugin(toolsRow as unknown as Parameters<Context['plugin']>[0]);
    await toolsFiber;
    const llmFiber4 = ctx.plugin(llmRow as unknown as Parameters<Context['plugin']>[0]);
    await llmFiber4;
    const loopFiber4 = ctx.plugin(loopRow as unknown as Parameters<Context['plugin']>[0]);
    await loopFiber4;
    // conversation 此刻缺席（模拟行序后装）——subagent 行先起，对账空转
    const fiber = ctx.plugin(makeSubagentRow({
      dataRoot: ROOT, agentId: 'papa', bootFile: 'boot.ts', catalogFile: CATALOG, shellRows: SHELL_ROWS, spawnShell: fakeShell().spawn,
    }));
    await fiber;
    let offConv: (() => void) | undefined;
    try {
      await new Promise((r) => setTimeout(r, 100)); // boot 对账已跑：conversation 缺席 → 未投
      expect(delivers).toHaveLength(0);
      offConv = ctx.provide('conversation', {
        deliver: async (agentId: string, message: string, options?: Record<string, unknown>) => {
          delivers.push({ agentId, message, ...(options ?? {}) });
          return { kind: 'queued' };
        },
      });
      await new Promise((r) => setTimeout(r, 1_100)); // 重试链 500ms 拍
      expect(delivers).toHaveLength(1);
      expect(delivers[0]).toMatchObject({ conversationId: 'u-late~papa', requestId: 'ask-notice-dur-late' });
    } finally {
      if (offConv !== undefined) offConv();
      if (fiber.uid !== null) await fiber.dispose();
      if (toolsFiber.uid !== null) await toolsFiber.dispose();
    }
  });

  // cr-736：父壳换代后 answer 直投——children 句柄面空，按子域活锁
  // transportHint 连 IPC 发 interactionReply 标记信封（收方转 store.reply）。
  it('answer 换代直投：无句柄时按活锁 IPC 发标记信封；无活锁 fail-loud', async () => {
    const childId = 'kid-answer';
    const hint = socketPathFor(path.resolve(ROOT), 'papa--' + childId);
    const received: unknown[] = [];
    let server: IpcServer | null = null;
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn); // 新实例但不动 spawn——children 面空（模拟换代）
    try {
      server = await listenIpc(hint, (payload) => {
        received.push(payload);
        return { ack: 'x', fresh: true };
      });
      const childRoot = path.join(ROOT, 'agents', 'papa', 'children', childId);
      fs.mkdirSync(childRoot, { recursive: true });
      acquireActivationLock(childRoot, {
        pid: process.pid, bootId: 'b-kid-a', acquiredAt: new Date().toISOString(), transportHint: hint,
      });
      fs.writeFileSync(path.join(childRoot, 'interactions.jsonl'), JSON.stringify({
        id: 'dur-answ', kind: 'ask_questions', state: 'pending',
        payload: { questions: [{ question: '怎么走？', options: ['A', 'B'] }] },
      }) + '\n', 'utf-8');
      const out = await (svc as unknown as { answerOp(id: string, ans: Array<string | string[] | null>): Promise<{ interactionId: string; status: string }> })
        .answerOp(childId, ['A']);
      expect(out).toEqual({ interactionId: 'dur-answ', status: 'answered' });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ to: childId, payload: { interactionReply: { id: 'dur-answ', answer: { answers: ['A'] } } } });
      // 有 pending 提问但无活锁的子 = fail-loud（指引重生/收割）
      const nolockRoot = path.join(ROOT, 'agents', 'papa', 'children', 'kid-nolock');
      fs.mkdirSync(nolockRoot, { recursive: true });
      fs.writeFileSync(path.join(nolockRoot, 'interactions.jsonl'), JSON.stringify({
        id: 'dur-nolock', kind: 'ask_questions', state: 'pending',
        payload: { questions: [{ question: '？', options: ['A'] }] },
      }) + '\n', 'utf-8');
      await expect((svc as unknown as { answerOp(id: string, ans: Array<string | string[] | null>): Promise<unknown> })
        .answerOp('kid-nolock', ['A'])).rejects.toThrow('不在管理面');
    } finally {
      await dispose();
      if (server !== null) await server.close();
    }
  });

  // cr-738：list 会话域过滤——spawn 经工具面记 origin；当前会话只列自己
  // 派生的子 + 无键条目（防孤儿）；他会的子隐去；all=true 全量；触达懒回填。
  it('list 会话域：过滤命中/隐去/无键恒显/all 全量/懒回填 config', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    try {
      const tools = ctx.get('tools') as unknown as {
        execute(call: { name: string; args: Record<string, unknown>; conversationId?: string }): Promise<{ ok: boolean; output?: { agents?: Array<{ childId: string; origin_session?: string }> } }>;
      };
      const spawned = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '会话A任务' }, conversationId: 'conv-a' });
      expect(spawned.ok).toBe(true);
      const ownId = (spawned.output as unknown as { subagent_id: string }).subagent_id;
      // 盘上预置"会话 B"的子与无键子
      const bRoot = path.join(ROOT, 'agents', 'papa', 'children', 'sub-fromb');
      fs.mkdirSync(bRoot, { recursive: true });
      writeAgentPatchV3At(bRoot, [], {}); writePluginConfigAt(bRoot, 'origin', { originConversation: 'conv-b' });
      const uRoot = path.join(ROOT, 'agents', 'papa', 'children', 'sub-nokey');
      fs.mkdirSync(uRoot, { recursive: true });
      writeAgentPatchV3At(uRoot, [], {});
      // 会话 A 视角：own + 无键可见；conv-b 隐去
      const inA = await tools.execute({ name: 'subagent', args: { action: 'list' }, conversationId: 'conv-a' });
      const idsA = (inA.output?.agents ?? []).map((e) => e.childId);
      expect(idsA).toContain(ownId);
      expect(idsA).toContain('sub-nokey');
      expect(idsA).not.toContain('sub-fromb');
      expect((inA.output?.agents ?? []).find((e) => e.childId === ownId)?.origin_session).toBe('conv-a');
      // all = 全量
      const all = await tools.execute({ name: 'subagent', args: { action: 'list', all: true }, conversationId: 'conv-a' });
      expect((all.output?.agents ?? []).map((e) => e.childId)).toContain('sub-fromb');
      // 触达无键子（await 会 fail-loud 不在管理面——用 stop 无害触达）→ 单元文件补键
      //（cr-1004 批2：会话恢复键住 origin.json；config.json 存量读窗口）
      await tools.execute({ name: 'subagent', args: { action: 'stop', subagent_id: 'sub-nokey' }, conversationId: 'conv-a' });
      const backfilled = JSON.parse(fs.readFileSync(path.join(uRoot, 'origin.json'), 'utf-8')) as { originConversation?: string };
      expect(backfilled.originConversation).toBe('conv-a');
      void svc;
    } finally { await dispose(); }
  });

  // cr-862 换轨：send 恒走 deliver() 双层会合——活锁直投；死子（无锁/陈锁）
  // 落子域 inbox（落盘即送达）+ owner 重拉子壳（reviveChild——重拉壳 boot
  // recoverPendingInbox 消费落盘信）。归档子拒绝（归档即终局）。
  it('send 换代直投：活锁直投；死子落 inbox + owner 重拉；归档子拒绝', async () => {
    const childId = 'kid-send';
    const hint = socketPathFor(path.resolve(ROOT), 'papa--' + childId);
    const received: unknown[] = [];
    let server: IpcServer | null = null;
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn); // 新实例不 spawn——children 面空（模拟换代）
    try {
      server = await listenIpc(hint, (payload) => {
        received.push(payload);
        return { ack: 'x', fresh: true };
      });
      const childRoot = path.join(ROOT, 'agents', 'papa', 'children', childId);
      fs.mkdirSync(childRoot, { recursive: true });
      writeAgentPatchV3At(childRoot, [], {});
      acquireActivationLock(childRoot, {
        pid: process.pid, bootId: 'b-kid-s', acquiredAt: new Date().toISOString(), transportHint: hint,
      });
      // await 换代照常（盘读面——baseline 0、无终稿、无 pending → null 不抛）
      expect(await svc.awaitOp(childId, 0)).toBeNull();
      // send：活锁直投，任务信封形状与在管投递一致（budget=2 + replyConversation）
      const out = await svc.sendOp(childId, '换代续聊', 'async', 0, 'u-init~papa');
      expect(out.delivered).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ to: childId, budget: 2, payload: { text: '换代续聊', replyConversation: 'u-init~papa' } });
      // 死子（无活锁）：任务信封原子落子域 inbox（文件名 = requestId）+ owner
      // 重拉（spawnShell 替身被调——children 句柄回管）
      const deadRoot = path.join(ROOT, 'agents', 'papa', 'children', 'kid-dead');
      fs.mkdirSync(deadRoot, { recursive: true });
      writeAgentPatchV3At(deadRoot, [], {});
      const deadOut = await svc.sendOp('kid-dead', 'x', 'async');
      expect(deadOut.delivered).toBe(true); // 落盘即送达
      const inboxDir = path.join(deadRoot, 'sessions', 'papa~kid-dead', 'inbox');
      const stored = fs.readdirSync(inboxDir).filter((n) => n.endsWith('.json'));
      expect(stored).toHaveLength(1);
      const envStored = JSON.parse(fs.readFileSync(path.join(inboxDir, stored[0] as string), 'utf-8'));
      expect(envStored).toMatchObject({ to: 'kid-dead', budget: 2, payload: { text: 'x' } });
      expect(svc.listOp().find((e) => e.childId === 'kid-dead')?.status).toBe('ready'); // owner 重拉
    } finally {
      await dispose();
      if (server !== null) await server.close();
    }
  });

  // cr-862 换轨专项：死子复活链——send 对死子（无活锁）落子域 inbox（落盘
  // 即送达）+ owner 重拉（spawnShell 再被调、meta.exited 复位、看板 ready）。
  // 拉起单源 spawnProcess 与 spawnOp 同构——重拉壳 boot 的 recoverPendingInbox
  // 消费落盘信（真子进程链路归 e2e）。
  it('死子复活链：send 落 inbox + owner 重拉（exited 复位 + busy 在飞）', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: '首轮', waitMs: 5_000 });
      await svc.deleteOp(a.childId); // 模拟子死：句柄移出 + 归档
      fs.rmSync(path.join(ROOT, 'agents', 'papa', 'children', a.childId, 'archived.json'), { force: true }); // 解除归档（保留死形态）
      const out = await svc.sendOp(a.childId, '复活任务', 'async');
      expect(out.delivered).toBe(true); // 落盘即送达
      const inboxDir = path.join(ROOT, 'agents', 'papa', 'children', a.childId, 'sessions', 'papa~' + a.childId, 'inbox');
      const stored = fs.readdirSync(inboxDir).filter((n) => n.endsWith('.json'));
      expect(stored).toHaveLength(1);
      const envStored = JSON.parse(fs.readFileSync(path.join(inboxDir, stored[0] as string), 'utf-8'));
      expect(envStored).toMatchObject({ to: a.childId, budget: 2, payload: { text: '复活任务' } });
      const entry = svc.listOp().find((e) => e.childId === a.childId);
      expect(entry?.status).toBe('ready'); // owner 重拉——exited 复位
      expect(entry?.busy).toBe(true); // 复活任务在飞
      // 崩溃形态（死句柄在管、未 delete）：守卫判活句柄——同样重拉（非句柄存在）
      const b = await svc.spawnOp({ task: '崩溃前轮', waitMs: 5_000 });
      (svc as unknown as { children: Map<string, unknown> }).children.delete(b.childId); // 留 meta.exited=false 模拟竞态窗——先造崩溃态：
      const crashed = svc.listOp().find((e) => e.childId === b.childId);
      void crashed;
      // 直接验守卫判据：exited 置位 + 句柄在场（崩溃未 delete 形态）→ send 重拉
      const svcInner = svc as unknown as { childMeta: Map<string, { exited: boolean; exit?: unknown; busy: boolean; name?: string }>; children: Map<string, unknown> };
      const bm = svcInner.childMeta.get(b.childId);
      if (bm !== undefined) { bm.exited = true; bm.exit = { code: 1, signal: null, aborted: false }; }
      const out2 = await svc.sendOp(b.childId, '崩溃后任务', 'async');
      expect(out2.delivered).toBe(true);
      expect(svc.listOp().find((e) => e.childId === b.childId)?.status).toBe('ready');
    } finally { await dispose(); }
  });

  // cr-856：归档子拒绝新任务——ownsChild 对归档者维持 true（迟到回信防线），
  // 但 send 面不再受理（收割语义：归档即终局，不可再 send）。
  it('归档子拒发：archived.json 在场时 send fail-loud；未归档不受影响', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: 't', waitMs: 5_000 });
      // 未归档：正常投递
      expect((await svc.sendOp(a.childId, '追问', 'sync', 5_000)).delivered).toBe(true);
      await svc.deleteOp(a.childId);
      // 归档后：send 拒绝（归档即终局）
      await expect(svc.sendOp(a.childId, '再追问', 'async')).rejects.toThrow('不在管理面');
    } finally { await dispose(); }
  });

  // cr-712：主线消费面适配（collab send_agent 的 sub_ 分支）——get 在场
  // 查询 + send 薄包装（conversationId 即完成回执发起会话键）。
  it('get/send 主线消费面：在场投影 + send 挂 replyConversation（cr-711 回执链）', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn) as unknown as {
      svc: {
        spawnOp(i: { task: string; waitMs?: number }): Promise<{ childId: string }>;
        get(id: string): { id: string; parentId: string } | undefined;
        send(id: string, opts: { parentId: string; text: string; mode?: string; conversationId?: string }): Promise<{ delivered: string; info: { id: string } }>;
      };
      dispose: () => Promise<void>;
    };
    try {
      const a = await svc.spawnOp({ task: '首轮', waitMs: 5_000 });
      // get：物化域内即有投影（retired SubagentsService.get 面）
      expect(svc.get(a.childId)).toMatchObject({ id: a.childId, parentId: 'papa' });
      expect(svc.get('sub-none')).toBeUndefined();
      // send：async 投递 + 发起会话键随任务信封（终稿回执回发起会话）
      const out = await svc.send(a.childId, { parentId: 'papa', text: '追加任务', conversationId: 'u-init~papa' });
      expect(out.delivered).toBe('started');
      expect(out.info.id).toBe(a.childId);
      expect(fake.envs.at(-1)).toMatchObject({ text: '追加任务', replyConversation: 'u-init~papa' });
      // 不在管理面的 id fail-loud
      await expect(svc.send('sub-ghost', { parentId: 'papa', text: 'x' })).rejects.toThrow('不在管理面');
    } finally { await dispose(); }
  });

  // cr-863：childAsk 信封单源——盘 watch / 信封 / boot 对账三通道汇 notifyChildAsk，
  // 幂等门 + 盘校验（非当前 pending 不通知——滞留 inbox 跨代重放面）。P2：
  // reconcile 对活锁子重建 watch（换代蒸发面）。service 直调（信封通道由
  // conversation 拦截面转交——归 conversation 测试）。真子进程链路归 e2e。
  it('notifyChildAsk：幂等门 + 盘校验（非当前 pending 不通知）', async () => {
    const fake = fakeShell();
    const { ctx, svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: '提问任务', waitMs: 5_000 });
      const events: Array<{ childId: string; interactionId: string }> = [];
      ctx.on('subagents/ask', (p: { childId: string; interactionId: string }) => events.push(p));
      // 盘上落 pending ask（fakeShell 的 deliver 不产 interaction——手写 store 文件）
      const writeFile = (id: string, state: string) => {
        const f = path.join(ROOT, 'agents', 'papa', 'children', a.childId, 'interactions.jsonl');
        const line = JSON.stringify({ id, kind: 'ask_questions', state, payload: { questions: [{ question: '走哪条?', options: ['A', 'B'] }] }, ts: Date.now() });
        fs.appendFileSync(f, line + '\n', 'utf-8');
      };
      writeFile('ix-1', 'pending');
      // ① 信封通道形态（notifyChildAsk 直调——conversation 拦截面同款转交）
      (svc as unknown as { notifyChildAsk(c: string, i: string): void }).notifyChildAsk(a.childId, 'ix-1');
      expect(events).toHaveLength(1);
      // ② 同 id 再来（幂等门）
      (svc as unknown as { notifyChildAsk(c: string, i: string): void }).notifyChildAsk(a.childId, 'ix-1');
      expect(events).toHaveLength(1);
      // ③ 盘上非 pending（已答——信封滞留 inbox 跨代重放形态）：不通知
      writeFile('ix-1', 'answered');
      (svc as unknown as { notifyChildAsk(c: string, i: string): void }).notifyChildAsk(a.childId, 'ix-1');
      expect(events).toHaveLength(1);
      // ④ 新 pending：正常通知
      writeFile('ix-2', 'pending');
      (svc as unknown as { notifyChildAsk(c: string, i: string): void }).notifyChildAsk(a.childId, 'ix-2');
      expect(events).toHaveLength(2);
    } finally { await dispose(); }
  });

  it('P2 watch 重建：reconcile 对活锁子建 watch（换代蒸发面）', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const a = await svc.spawnOp({ task: '挂起任务', waitMs: 5_000 });
      const svcInner = svc as unknown as { askWatchers: Map<string, unknown>; children: Map<string, unknown>; reconcilePendingAsks(): void };
      // 模拟换代蒸发：children/askWatchers 全清（内存态蒸发）+ 留活锁（子还活着）
      svcInner.children.clear();
      svcInner.askWatchers.clear();
      acquireActivationLock(path.join(ROOT, 'agents', 'papa', 'children', a.childId), {
        pid: process.pid, bootId: 'watch-rebuild-test', acquiredAt: new Date().toISOString(), transportHint: 'noop',
      });
      svcInner.reconcilePendingAsks();
      expect(svcInner.askWatchers.has(a.childId)).toBe(true); // 子在管（spawn 句柄）→ watch 在场
      // 死子（无锁无句柄）不建——消费面无人
      const dead = 'sub-dead-1';
      fs.mkdirSync(path.join(ROOT, 'agents', 'papa', 'children', dead), { recursive: true });
      writeAgentPatchV3At(path.join(ROOT, 'agents', 'papa', 'children', dead), [], {});
      svcInner.reconcilePendingAsks();
      expect(svcInner.askWatchers.has(dead)).toBe(false);
    } finally { await dispose(); }
  });

});
