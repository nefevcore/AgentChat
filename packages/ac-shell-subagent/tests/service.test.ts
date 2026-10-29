// ============================================================
// ac-shell-subagent service 单测（M8.3）：替身子壳（内存队列）验服务面
// ——物化域 / 信封投递 / 终稿等待（多轮 baseline）/ list / delete 收割。
// 真子壳进程链路归 rows-import + e2e（本文件零子进程）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import { makeSubagentRow, type ShellProcess, type SpawnShellFn } from '../src/service.ts';
import { readChildConfig } from 'ac-agents-core';
import { acquireActivationLock, makeEnvelope, socketPathFor, type Envelope } from 'ac-envelope-core';
import { listenIpc, type PostOfficeServer } from 'ac-post-office';

const ROOT = path.join('sandbox', 'test-subagent-' + process.pid);
const CATALOG = path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'row-catalog.json');

beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, 'agents', 'papa'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents', 'papa', 'config.json'),
    JSON.stringify({ id: 'papa', model: 'mock', tools: ['fs-tools', 'shell-tools', 'fs-search'] }), 'utf-8');
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 内存替身子壳：deliver 落账真文件（验终稿读面），control/interrupt 记录 */
function fakeShell(): { spawn: SpawnShellFn; frames: Array<Record<string, unknown>>; envs: Array<{ requestId: string; text: string; budget: number; replyConversation?: string; elevation?: string }> } {
  const frames: Array<Record<string, unknown>> = [];
  const envs: Array<{ requestId: string; text: string; budget: number; replyConversation?: string; elevation?: string }> = [];
  let n = 0;
  const spawn: SpawnShellFn = (a) => {
    const proc: ShellProcess = {
      pid: 4000 + (n++),
      deliver: async (env) => {
        const text = (env.payload as { text?: string }).text ?? '';
        const replyConversation = (env.payload as { replyConversation?: string }).replyConversation;
        envs.push({ requestId: env.requestId, text, budget: env.budget, ...(replyConversation !== undefined ? { replyConversation } : {}), ...(env.elevation !== undefined ? { elevation: env.elevation } : {}) });
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

  // cr-762：子 Agent 不能再派子孙——spawn 显式点名 subagent 被拒（filtered 回报），
  // 子 config 不物化 subagent 行；缺省继承路径由 boot 行集合成面剔除（boot.test 锁定）。
  it('spawn tools 显式点名 subagent 被拒（cr-762 防子孙无限增长）', async () => {
    const fake = fakeShell();
    const { svc, dispose } = await makeService(fake.spawn);
    try {
      const out = await svc.spawnOp({ task: 't', tools: ['read', 'subagent'] });
      expect(out.filtered).toEqual(['subagent']);
      const cfg = readChildConfig(ROOT, 'papa', out.childId);
      expect(cfg?.rows).toEqual(['read']);
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
    let server: PostOfficeServer | null = null;
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

  // cr-753：会话设置继承——发起会话 conv-settings（elevation/toolMode/
  // browserTier/issueSubmit）→ 子 config tags 等效词快照；per-call elevation
  // 与水位取高；tc-base/base 不产生词（缺省无词可加）。
  it('会话设置继承：父会话覆盖值合入子 config.tags（物化即快照）', async () => {
    const fake = fakeShell();
    const { ctx, dispose } = await makeService(fake.spawn);
    try {
      // 壳内 convSettings 垫片缺席场景先行验证：makeService 的裸 ctx 无 convSettings → 继承面只余 per-call elevation
      const tools = ctx.get('tools') as unknown as {
        execute(call: { name: string; args: Record<string, unknown>; conversationId?: string; elevation?: string }): Promise<{ ok: boolean; output?: { subagent_id?: string } }>;
      };
      const out = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '继承任务' }, conversationId: 'user~papa', elevation: 'full-access' });
      const childId = (out.output as { subagent_id: string }).subagent_id;
      const cfg = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'agents', 'papa', 'children', childId, 'config.json'), 'utf-8'),
      ) as { tags?: string[] };
      expect(cfg.tags).toContain('full-access'); // per-call 兜底并入（无 convSettings 面）
      const plain = await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '无设置' }, conversationId: 'user~papa' });
      const plainId = ((plain.output as { subagent_id: string })).subagent_id;
      const plainCfg = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'agents', 'papa', 'children', plainId, 'config.json'), 'utf-8'),
      ) as { tags?: string[] };
      expect(plainCfg.tags ?? []).not.toContain('full-access'); // 无任何来源不产生词（父无 tags 时键缺席）
    } finally { await dispose(); }
  });

  it('会话设置继承：convSettings 垫片在场——toolMode/browserTier/issueSubmit/水位全映射；水位与 per-call 取高', async () => {
    const fake = fakeShell();
    const { Service } = await import('@agentchat/cordis');
    const { ctx, dispose } = await makeService(fake.spawn);
    try {
      // convSettings 桩（壳内垫片同形：get 按 conversationId）
      class ConvStub extends Service {
        constructor(c: unknown) { super(c as never, 'convSettings'); }
        get(id: string): Record<string, string> {
          return id === 'user~papa'
            ? { elevation: 'full-access', toolMode: 'tc-programmatic', browserTier: 'inject', issueSubmit: 'enabled' }
            : {};
        }
      }
      await ctx.plugin(ConvStub);
      const svc = ctx.get('subagents', false) as unknown as {
        spawnOp(i: { task: string; replyConversation?: string; elevation?: string }): Promise<{ childId: string }>;
      };
      const out = await svc.spawnOp({ task: '全设置继承', replyConversation: 'user~papa', elevation: 'sandbox-access' });
      const cfg = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'agents', 'papa', 'children', out.childId, 'config.json'), 'utf-8'),
      ) as { tags?: string[] };
      // 水位 full > per-call sandbox（取高）+ 模式词 + grants 全链
      for (const t of ['full-access', 'tc-programmatic', 'web', 'observe', 'manipulate', 'inject', 'issue-report']) {
        expect(cfg.tags).toContain(t);
      }
    } finally { await dispose(); }
  });

  // cr-728：提权继承——call.elevation 随任务信封下发（两档白名单窄化），
  // 子壳 receiveEnvelope → loop 既有链路生效；无提权不携带。
  it('任务信封携带 elevation：call.elevation=full-access 下发；非法档位/无提权不携带', async () => {
    const fake = fakeShell();
    const { ctx, dispose } = await makeService(fake.spawn);
    try {
      const tools = ctx.get('tools') as unknown as {
        execute(call: { name: string; args: Record<string, unknown>; conversationId?: string; elevation?: string }): Promise<{ ok: boolean }>;
      };
      await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '提权任务' }, elevation: 'full-access' });
      expect(fake.envs.at(-1)).toMatchObject({ budget: 2, elevation: 'full-access' });
      await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '无提权任务' } });
      expect(fake.envs.at(-1)!.elevation).toBeUndefined();
      await tools.execute({ name: 'subagent', args: { action: 'spawn', task: '坏档位' }, elevation: 'root' as string });
      expect(fake.envs.at(-1)!.elevation).toBeUndefined();
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
    fs.writeFileSync(path.join(childRoot, 'config.json'), JSON.stringify({ id: 'sub-reboot', originConversation: 'u-init~papa' }), 'utf-8');
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
    const fiber = ctx.plugin(makeSubagentRow({
      dataRoot: ROOT, agentId: 'papa', bootFile: 'boot.ts', catalogFile: CATALOG, spawnShell: fakeShell().spawn,
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
    fs.writeFileSync(path.join(childRoot, 'config.json'), JSON.stringify({ id: 'sub-legacy' }), 'utf-8'); // 无 originConversation
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
    const fiber = ctx.plugin(makeSubagentRow({
      dataRoot: ROOT, agentId: 'papa', bootFile: 'boot.ts', catalogFile: CATALOG, spawnShell: fakeShell().spawn,
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
    fs.writeFileSync(path.join(childRoot, 'config.json'), JSON.stringify({ id: 'sub-late', originConversation: 'u-late~papa' }), 'utf-8');
    fs.writeFileSync(path.join(childRoot, 'interactions.jsonl'), JSON.stringify({
      id: 'dur-late', kind: 'ask_questions', state: 'pending',
      payload: { questions: [{ question: '延迟服务下的问题', options: ['A', 'B'] }] },
    }) + '\n', 'utf-8');
    const delivers: Array<Record<string, unknown>> = [];
    const ctx = new Context();
    const toolsFiber = ctx.plugin(toolsRow as unknown as Parameters<Context['plugin']>[0]);
    await toolsFiber;
    // conversation 此刻缺席（模拟行序后装）——subagent 行先起，对账空转
    const fiber = ctx.plugin(makeSubagentRow({
      dataRoot: ROOT, agentId: 'papa', bootFile: 'boot.ts', catalogFile: CATALOG, spawnShell: fakeShell().spawn,
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
    let server: PostOfficeServer | null = null;
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
      fs.writeFileSync(path.join(bRoot, 'config.json'), JSON.stringify({ id: 'sub-fromb', originConversation: 'conv-b' }), 'utf-8');
      const uRoot = path.join(ROOT, 'agents', 'papa', 'children', 'sub-nokey');
      fs.mkdirSync(uRoot, { recursive: true });
      fs.writeFileSync(path.join(uRoot, 'config.json'), JSON.stringify({ id: 'sub-nokey' }), 'utf-8');
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
      // 触达无键子（await 会 fail-loud 不在管理面——用 stop 无害触达）→ config 补键
      await tools.execute({ name: 'subagent', args: { action: 'stop', subagent_id: 'sub-nokey' }, conversationId: 'conv-a' });
      const backfilled = JSON.parse(fs.readFileSync(path.join(uRoot, 'config.json'), 'utf-8')) as { originConversation?: string };
      expect(backfilled.originConversation).toBe('conv-a');
      void svc;
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

});
