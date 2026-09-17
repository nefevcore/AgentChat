// ============================================================
// ac-security（access-tier 重设计）：
//   · 能力轴门禁（requiredTags AND / tags 单源 / owner 合成 / 无身份）
//   · 权限轴矩阵（needPermission × 档位 × 有人/无人桶 × elevation）
//   · 询问提权流（批准 / 拒绝 / 中止）
//   · 双黑名单（accessDenyPaths 读+写双禁 / readDenyPaths 仅读禁 / 目录前缀）
//   · bash 扫描 / 输出脱敏 / 唆使防御注入（loop/before-run 落点 A）
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as credentialsRow from 'ac-credentials';
import * as durableRow from 'ac-durable-interaction';
import * as sessionRow from 'ac-session';
import * as sreRow from 'ac-str-replace-editor';
import * as toolsRow from 'ac-tools';
import * as workspaceRow from 'ac-workspace';
import * as securityRow from '../src/index.ts';
import type { LoopRunCall } from 'ac-agent-loop';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sec-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

interface BootOpts {
  /** 行级 options（ac-security） */
  options?: Record<string, unknown>;
  /** 挂 workspace 行（缺省 true；false = G3 fail-closed 场景） */
  withWorkspace?: boolean;
  /** 挂 durable-interaction 行（询问提权场景；缺省 true） */
  withDurable?: boolean;
}

async function boot(root: string, o: BootOpts = {}) {
  const { options = {}, withWorkspace = true, withDurable = true } = o;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [agentsRow, undefined],
    [agentStoreRow, { root }],
    [sessionRow, { root }],
    [credentialsRow, { root }],
    ...(withDurable ? ([[durableRow, { root }]] as Array<[unknown, unknown]>) : []),
    ...(withWorkspace ? ([[workspaceRow, { root }]] as Array<[unknown, unknown]>) : []),
    [securityRow, { workdir: root, ...options }],
  ];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).agents && (ctx as any).credentials) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---- 共用注册：档位 Agent + 权限工具 ----

/** 注册三档 Agent + 有人/无人会话键 */
function registerTierAgents(ctx: Context) {
  ctx.agents.register({ id: 'basea', model: 'm' });
  ctx.agents.register({ id: 'sandboxa', model: 'm', tags: ['sandbox-access'] });
  ctx.agents.register({ id: 'fulla', model: 'm', tags: ['full-access'] });
}

/** 需权限的写类 / 非路径类 mock 工具（真实行为归 fs/web 行，本行只测门面） */
function registerPermissionTools(ctx: Context) {
  ctx.tools.register({
    name: 'write',
    needPermission: true,
    execute: () => ({ ok: true, output: 'wrote' }),
  });
  ctx.tools.register({
    name: 'bash',
    needPermission: true,
    execute: () => ({ ok: true, output: 'ran' }),
  });
  ctx.tools.register({
    name: 'web_search',
    needPermission: true,
    execute: () => ({ ok: true, output: 'searched' }),
  });
  ctx.tools.register({ name: 'read', execute: () => ({ ok: true, output: 'read' }) });
}

describe('ac-security 能力轴门禁（requiredTags；tags 单源）', () => {
  it('requiredTags AND 语义：缺标签 veto，错误可读；tags 放行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({
      name: 'admin-thing',
      requiredTags: ['admin'],
      execute: () => ({ ok: true }),
    });
    ctx.tools.register({
      name: 'dev-admin-thing',
      requiredTags: ['dev', 'admin'],
      execute: () => ({ ok: true }),
    });
    ctx.agents.register({ id: 'plain', model: 'm' });
    ctx.agents.register({ id: 'dev', model: 'm', tags: ['dev'] });
    ctx.agents.register({ id: 'boss', model: 'm', tags: ['dev', 'admin'] });

    const deny = await exec(ctx, { name: 'admin-thing', agentId: 'plain' });
    expect(deny.ok).toBe(false);
    expect(deny.error).toContain('admin');

    const half = await exec(ctx, { name: 'dev-admin-thing', agentId: 'dev' });
    expect(half.ok).toBe(false);
    expect(half.error).toContain('需要能力标签');

    const pass = await exec(ctx, { name: 'dev-admin-thing', agentId: 'boss' });
    expect(pass.ok).toBe(true);

    // 无身份（宿主直调）：门禁不适用（缺省能力集 base，requiredTags admin 仍拦截）
    const anon = await exec(ctx, { name: 'admin-thing' });
    expect(anon.ok).toBe(false);
    const anonBase = await exec(ctx, { name: 'admin-thing', agentId: undefined });
    expect(anonBase.ok).toBe(false);
  });

  it('capabilities 覆盖层已删除（§9.4 回归锁定）：存量值不再放行、无提示日志', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'shared-tool', requiredTags: ['agent:owner1'], execute: () => ({ ok: true }) });
    // 只写 tags（单源）——运行时门禁直接生效
    ctx.agents.register({ id: 'buyer', model: 'm', tags: ['agent:owner1'] });
    const allowed = await exec(ctx, { name: 'shared-tool', agentId: 'buyer' });
    expect(allowed.ok).toBe(true);

    const logCalls: string[] = [];
    const logger = (ctx as unknown as { logger: { info(...args: unknown[]): void } }).logger;
    const origInfo = logger.info.bind(logger);
    logger.info = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(' '));
      origInfo(...args);
    };
    // 存量覆盖层值不生效（能力授权单源 = tags）
    ctx.agents.register({ id: 'legacy', model: 'm', settings: { security: { capabilities: ['admin', 'agent:owner1'] } } });
    const viaOverlay = await exec(ctx, { name: 'shared-tool', agentId: 'legacy' });
    expect(viaOverlay.ok).toBe(false);
    expect(logCalls.filter((w) => w.includes('覆盖层生效中'))).toHaveLength(0); // 提示段随键删除
  });

  it('owner 合成（M23 E1）：base 恒在 + agent:<id>；无身份不合成 owner 段', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({
      name: 'owner-tool',
      requiredTags: ['agent:owner1'],
      execute: () => ({ ok: true, output: 'private' }),
    });
    ctx.agents.register({ id: 'owner1', model: 'm' }); // 未声明 tags
    ctx.agents.register({ id: 'stranger', model: 'm' });

    const self = await exec(ctx, { name: 'owner-tool', agentId: 'owner1' });
    expect(self.ok).toBe(true);
    const other = await exec(ctx, { name: 'owner-tool', agentId: 'stranger' });
    expect(other.ok).toBe(false);
    expect(other.error).toContain('agent:owner1');
    // 无身份不产生 agent:undefined 合成段
    ctx.tools.register({ name: 'undef-trap', requiredTags: ['agent:undefined'], execute: () => ({ ok: true }) });
    const trap = await exec(ctx, { name: 'undef-trap' });
    expect(trap.ok).toBe(false);
    expect(trap.error).not.toContain('agent:undefined，');
  });

  it('settings[security].enabled=false 软停用：门禁/权限轴/脱敏都不生效', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { options: { extraSecrets: ['topsecretvalue'] } });
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    ctx.agents.register({
      id: 'off',
      model: 'm',
      settings: { security: { enabled: false } },
    });
    // 能力轴停
    ctx.tools.register({ name: 'admin-thing', requiredTags: ['admin'], execute: () => ({ ok: true, output: 'sk-abcdefghij0123456789abcd' }) });
    const r = await exec(ctx, { name: 'admin-thing', agentId: 'off' });
    expect(r.ok).toBe(true);
    // 权限轴停（无人桶 base 本应拒）
    const w = await exec(ctx, { name: 'write', args: { file_path: 'x.txt', content: 'x' }, agentId: 'off' });
    expect(w.ok).toBe(true);
    // 脱敏停
    expect(r.output).toBe('sk-abcdefghij0123456789abcd');
  });
});

describe('ac-security 权限轴矩阵（needPermission × 档位）', () => {
  it('needPermission=false 工具（read）：全档无权限门', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    const r = await exec(ctx, { name: 'read', args: { file_path: 'a.txt' }, agentId: 'basea', conversationId: 'basea~other' });
    expect(r.ok).toBe(true);
  });

  it('full 档：自由（越白名单写放行；accessDeny 复检不随档位跳过）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    // 越白名单（他人专用空间）写：full 放行（跳过沙箱复检）
    const outside = path.join(root, 'files', 'other', 'x.txt');
    const w = await exec(ctx, { name: 'write', args: { file_path: outside, content: 'x' }, agentId: 'fulla' });
    expect(w.ok).toBe(true);
    // 系统域 accessDeny 不跳过（full 也拦）
    const cfg = path.join(root, 'agents', 'somebody', 'config.json');
    const denied = await exec(ctx, { name: 'write', args: { file_path: cfg, content: 'x' }, agentId: 'fulla' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('访问黑名单');
    // bash 自由（跳过扫描——"不做任何限制"的字面义）
    const b = await exec(ctx, { name: 'bash', args: { command: 'cat /etc/passwd' }, agentId: 'fulla' });
    expect(b.ok).toBe(true);
    // 非路径类（web 等）自由
    const ws = await exec(ctx, { name: 'web_search', args: { query: 'x' }, agentId: 'fulla' });
    expect(ws.ok).toBe(true);
  });

  it('sandbox 档：白名单内自由；越界视同 base（D3：有人桶询问）；非路径类自由', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    // 白名单内（Agent 专用空间 files/sandboxa）写：自由
    const inside = path.join(root, 'files', 'sandboxa', 'note.txt');
    const w = await exec(ctx, { name: 'write', args: { file_path: inside, content: 'x' }, agentId: 'sandboxa' });
    expect(w.ok).toBe(true);
    // 越界 + 无人桶（a~a）：拒绝 + 指引
    const outside = path.join(root, 'files', 'other', 'x.txt');
    const d = await exec(ctx, { name: 'write', args: { file_path: outside, content: 'x' }, agentId: 'sandboxa', conversationId: 'sandboxa~sandboxa' });
    expect(d.ok).toBe(false);
    expect(d.error).toContain('人工审批面');
    expect(d.error).toContain('sandbox-access');
    // 非路径类（web_search）：sandbox 自由（D2 门禁只在 base 生效）
    const ws = await exec(ctx, { name: 'web_search', args: { query: 'x' }, agentId: 'sandboxa', conversationId: 'sandboxa~sandboxa' });
    expect(ws.ok).toBe(true);
  });

  it('base 档：无人桶（a~a / agent~agent / 群 / 未知形态 / 无会话键）拒绝；无身份 fail-closed', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    for (const conversationId of ['basea~basea', 'basea~other', 'weird-shape', undefined]) {
      const r = await exec(ctx, { name: 'bash', args: { command: 'echo hi' }, agentId: 'basea', ...(conversationId ? { conversationId } : {}) });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('人工审批面');
    }
    // 无身份（宿主直调）：fail-closed，引导走服务方法
    const anon = await exec(ctx, { name: 'bash', args: { command: 'echo hi' } });
    expect(anon.ok).toBe(false);
    expect(anon.error).toContain('无执行身份');
  });

  it('D1 专属空间写豁免：base 写 files/<id>/** 免询问（有人桶也不问）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    const memory = path.join(root, 'files', 'basea', 'memory', 'basea~user.md');
    const w = await exec(ctx, {
      name: 'write',
      args: { file_path: memory, content: '记忆' },
      agentId: 'basea',
      conversationId: 'basea~user', // 有人桶——仍免询问
    });
    expect(w.ok).toBe(true);
    // 相对路径锚定专用空间同样豁免
    const rel = await exec(ctx, {
      name: 'write',
      args: { file_path: 'memo.md', content: 'x' },
      agentId: 'basea',
      conversationId: 'basea~user',
    });
    expect(rel.ok).toBe(true);
    // 他人专用空间不豁免（有人桶 → 询问而非直接执行）
    const other = path.join(root, 'files', 'other', 'x.md');
    const ask = exec(ctx, {
      name: 'write',
      args: { file_path: other, content: 'x' },
      agentId: 'basea',
      conversationId: 'basea~user',
    });
    await new Promise((r) => setTimeout(r, 50));
    const open = ctx.durableInteraction.listOpen({ kind: 'approval' });
    expect(open).toHaveLength(1); // 询问中（未被免询问放行）
    ctx.durableInteraction.close(open[0].id, 'consumed');
    const settled = await ask;
    expect(settled.ok).toBe(false);
  });

  it('elevation（机制提权/审批注入）：sandbox 覆盖写；full 跳过沙箱但保留 accessDeny', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    // base Agent + elevation sandbox-access（归档整理 run 形态）：
    // 写自己空间 = 白名单内 → 覆盖（无人桶也放行）
    const inside = path.join(root, 'files', 'basea', 'summary', 's.md');
    const w = await exec(ctx, {
      name: 'write',
      args: { file_path: inside, content: 'x' },
      agentId: 'basea',
      conversationId: 'basea~user',
      elevation: 'sandbox-access',
    });
    expect(w.ok).toBe(true);
    // elevation full（审批注入形态）：越白名单放行 + accessDeny 仍拦
    const outside = path.join(root, 'files', 'other', 'x.txt');
    const w2 = await exec(ctx, {
      name: 'write',
      args: { file_path: outside, content: 'x' },
      agentId: 'basea',
      elevation: 'full-access',
    });
    expect(w2.ok).toBe(true);
    const cfg = path.join(root, 'config.json');
    const denied = await exec(ctx, {
      name: 'write',
      args: { file_path: cfg, content: 'x' },
      agentId: 'basea',
      elevation: 'full-access',
    });
    expect(denied.ok).toBe(false);
  });
});

describe('ac-security 询问提权流（§六：base + 有人桶）', () => {
  it('批准 → 本次调用按 full 执行（write-ahead + 单次有效）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    const target = path.join(root, 'files', 'other', 'shared.txt');
    const pending = exec(ctx, {
      name: 'write',
      args: { file_path: target, content: 'x' },
      agentId: 'basea',
      conversationId: 'basea~user', // 有人桶（对桶含 user）
      toolCallId: 'call-42',
    });
    // write-ahead：interaction 先落盘（kind/correlationId/owner/参数摘要）
    await new Promise((r) => setTimeout(r, 50));
    const open = ctx.durableInteraction.listOpen({ kind: 'approval' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'approval',
      correlationId: 'call-42',
      owner: 'basea',
      key: 'basea~user',
    });
    expect((open[0].payload as { tool: string }).tool).toBe('write');
    ctx.durableInteraction.reply(open[0].id, true); // 批准（旧形：单布尔——scope='call'）
    const r = await pending;
    expect(r.ok).toBe(true);
    // 批准单次有效：下一次同类调用再次询问
    const again = exec(ctx, {
      name: 'write',
      args: { file_path: target, content: 'y' },
      agentId: 'basea',
      conversationId: 'basea~user',
    });
    await new Promise((res) => setTimeout(res, 50));
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(1);
    const open2 = ctx.durableInteraction.listOpen({ kind: 'approval' });
    ctx.durableInteraction.close(open2[0].id, 'consumed');
    const r2 = await again;
    expect(r2.ok).toBe(false);
  });

  it('run 级批准（scope=run）→ 本轮后续免询问；after-run 清除；跨会话隔离（2026-12 功能增强）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    const target = path.join(root, 'files', 'other', 'shared.txt');

    // 第一次：询问 + run 级批准
    const p1 = exec(ctx, {
      name: 'write',
      args: { file_path: target, content: 'x' },
      agentId: 'basea',
      conversationId: 'basea~user',
      toolCallId: 'c1',
    });
    await new Promise((r) => setTimeout(r, 50));
    const open1 = ctx.durableInteraction.listOpen({ kind: 'approval' });
    expect(open1).toHaveLength(1);
    ctx.durableInteraction.reply(open1[0].id, { approved: true, scope: 'run' });
    const r1 = await p1;
    expect(r1.ok).toBe(true);

    // 第二次（同 run 窗口、同会话、另一工具）：免询问直接放行
    const r2 = await exec(ctx, {
      name: 'bash',
      args: { command: 'echo hi' },
      agentId: 'basea',
      conversationId: 'basea~user',
    });
    expect(r2.ok).toBe(true);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0); // 无新询问

    // 跨会话隔离：另一 Agent 会话不吃本会话的 run 授权（仍要询问）
    const p3 = exec(ctx, {
      name: 'write',
      args: { file_path: target, content: 'z' },
      agentId: 'sandboxa', // sandbox 档写越白名单 → 视同 base，走询问
      conversationId: 'sandboxa~user',
      toolCallId: 'c3',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(1);
    ctx.durableInteraction.reply(ctx.durableInteraction.listOpen({ kind: 'approval' })[0].id, false);
    const r3 = await p3;
    expect(r3.ok).toBe(false);

    // run 收束（loop/after-run）→ 授权清除，重新询问
    ctx.emit('loop/after-run', { agent: 'basea', conversationId: 'basea~user', model: 'm', messages: [] }, {
      steps: [], text: '', finish: 'stop', usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    });
    const p4 = exec(ctx, {
      name: 'write',
      args: { file_path: target, content: 'w' },
      agentId: 'basea',
      conversationId: 'basea~user',
      toolCallId: 'c4',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(1);
    ctx.durableInteraction.close(ctx.durableInteraction.listOpen({ kind: 'approval' })[0].id, 'consumed');
    const r4 = await p4;
    expect(r4.ok).toBe(false);
  });

  it('拒绝 → {ok:false, error 明确}；interaction 关闭', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    const pending = exec(ctx, {
      name: 'bash',
      args: { command: 'rm -rf /' },
      agentId: 'basea',
      conversationId: 'user~basea',
    });
    await new Promise((r) => setTimeout(r, 50));
    const open = ctx.durableInteraction.listOpen({ kind: 'approval' });
    expect(open).toHaveLength(1);
    // 参数摘要 = bash 全文（原文不截断——审批卡全文展示）
    expect((open[0].payload as { args: unknown }).args).toBe('rm -rf /');
    ctx.durableInteraction.reply(open[0].id, false); // 拒绝
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('拒绝');
  });

  it('durableInteraction 不可用 → fail-closed 拒绝（无法询问）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { withDurable: false });
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    const r = await exec(ctx, {
      name: 'bash',
      args: { command: 'echo hi' },
      agentId: 'basea',
      conversationId: 'basea~user',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('durableInteraction');
  });
});

describe('ac-security 双黑名单（accessDenyPaths / readDenyPaths）', () => {
  it('系统域读+写双禁：控制面 + 持久化域树（含 agents/<id>/config.json 档位提权洞修复）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    // preset 沙箱根 = 数据根（白名单全放行，只有黑名单在拦）；full 档
    // 跳过权限轴与沙箱复检——直达 accessDeny 面（域规则与档位正交）
    ctx.agents.register({ id: 'preset', model: 'm', preset: true, tags: ['full-access'] });
    for (const rel of [
      path.join('agents', 'victim', 'config.json'), // 本次核查发现的洞
      path.join('agents', 'victim', 'memory', 'm.md'),
      path.join('sessions', 'a~b.jsonl'),
      path.join('subagents', 'index.json'),
      path.join('usage', 'u.jsonl'),
      path.join('backups', 'b.json'),
      path.join('plugins', 'registry.json'),
      'credentials.json',
      'config.json',
      'cordis.patch.yml',
    ]) {
      const w = await exec(ctx, { name: 'write', args: { file_path: path.join(root, rel), content: 'x' }, agentId: 'preset' });
      expect(w.ok, `write ${rel}`).toBe(false);
      expect(w.error).toContain('黑名单');
      const r = await exec(ctx, { name: 'read', args: { file_path: path.join(root, rel) }, agentId: 'preset' });
      expect(r.ok, `read ${rel}`).toBe(false);
    }
    // 普通文件不受影响
    const ok = await exec(ctx, { name: 'write', args: { file_path: path.join(root, 'notes.md'), content: 'x' }, agentId: 'preset' });
    expect(ok.ok).toBe(true);
  });

  it('读黑名单（用户域机密）：base/sandbox 拦、full 跳过；访问黑名单优先且全档', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    ctx.agents.register({ id: 'preset', model: 'm', preset: true });
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1', 'utf-8');
    fs.writeFileSync(path.join(root, 'server.key'), 'KEY', 'utf-8');
    // base/sandbox：readDeny 拦（读不设防但黑名单在拦）
    for (const agentId of ['basea', 'sandboxa']) {
      const env = await exec(ctx, { name: 'read', args: { file_path: path.join(root, '.env') }, agentId });
      expect(env.ok, agentId).toBe(false);
      expect(env.error).toContain('读黑名单');
      const key = await exec(ctx, { name: 'read', args: { file_path: path.join(root, 'server.key') }, agentId });
      expect(key.ok, agentId).toBe(false);
    }
    // full：readDeny 跳过（accessDeny 才全档）
    const fullEnv = await exec(ctx, { name: 'read', args: { file_path: path.join(root, '.env') }, agentId: 'fulla' });
    expect(fullEnv.ok).toBe(true);
    // accessDeny 不随档位跳过（§9.2）
    const fullCfg = await exec(ctx, { name: 'read', args: { file_path: path.join(root, 'config.json') }, agentId: 'fulla' });
    expect(fullCfg.ok).toBe(false);
  });

  it('accessDenyPaths 追加（per-Agent；内置表不可覆盖）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    ctx.agents.register({
      id: 'picky',
      model: 'm',
      settings: { security: { accessDenyPaths: [path.join(root, 'vault')] } },
    });
    const denied = exec(ctx, {
      name: 'write',
      args: { file_path: path.join(root, 'vault', 'key.txt'), content: 'x' },
      agentId: 'picky',
      conversationId: 'picky~user',
    });
    // 注：vault 不在白名单（workdir=files/picky）——先过权限轴（询问），
    // 批准后 accessDeny 复检拒绝
    await new Promise((r) => setTimeout(r, 50));
    const open = ctx.durableInteraction.listOpen({ kind: 'approval' });
    expect(open).toHaveLength(1);
    ctx.durableInteraction.reply(open[0].id, true);
    const r = await denied;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('黑名单');
  });

  it('读路径脱离工作区沙箱（§9.1 放宽）：白名单外可读（非黑名单即可）', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'outside.txt'), '内容', 'utf-8');
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    ctx.agents.register({ id: 'confined', model: 'm', settings: { security: { workdir: path.join(root, 'sub2') } } });
    fs.mkdirSync(path.join(root, 'sub2'), { recursive: true });
    // read 越白名单：可读（读不设防）
    const r = await exec(ctx, { name: 'read', args: { file_path: path.join(root, 'sub', 'outside.txt') }, agentId: 'confined' });
    expect(r.ok).toBe(true);
    // write 越白名单：仍拦（写侧防线不动——有人桶询问）
    const wPending = exec(ctx, {
      name: 'write',
      args: { file_path: path.join(root, 'sub', 'escape.txt'), content: 'x' },
      agentId: 'confined',
      conversationId: 'confined~user',
    });
    await new Promise((res) => setTimeout(res, 50));
    const open = ctx.durableInteraction.listOpen({ kind: 'approval' });
    expect(open).toHaveLength(1);
    ctx.durableInteraction.close(open[0].id, 'consumed');
    const w = await wPending;
    expect(w.ok).toBe(false);
  });

  it('workspace 不可用 → fail-closed：路径类工具拒绝 + 显式告警（G3 ②）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { withWorkspace: false });
    const warnCalls: string[] = [];
    const logger = (ctx as unknown as { logger: { warn(...args: unknown[]): void } }).logger;
    const origWarn = logger.warn.bind(logger);
    logger.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(' '));
      origWarn(...args);
    };
    registerTierAgents(ctx);
    registerPermissionTools(ctx);

    const blocked = await exec(ctx, { name: 'read', args: { file_path: 'ok.txt' }, agentId: 'basea' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/workspace.*不可用|fail-closed/);
    // 显式告警只发一次
    await exec(ctx, { name: 'read', args: { file_path: 'other.txt' }, agentId: 'basea' });
    expect(warnCalls.filter((w) => w.includes('workspace 服务不可用'))).toHaveLength(1);
    // 非路径工具不受影响（bash 走原解析器——deny 面本就不进 bash 扫描；
    // 无人桶 base 仍会被权限轴拦，这里用有人桶 → 询问 → 关闭）
    const bashPending = exec(ctx, { name: 'bash', args: { command: 'echo hi' }, agentId: 'basea', conversationId: 'basea~user' });
    await new Promise((r) => setTimeout(r, 50));
    const open = ctx.durableInteraction.listOpen({ kind: 'approval' });
    expect(open).toHaveLength(1);
    ctx.durableInteraction.reply(open[0].id, true);
    const bashOk = await bashPending;
    expect(bashOk.ok).toBe(true);
  });
});

describe('ac-security bash 命令扫描', () => {
  it('越界命令 veto；heredoc 载荷不误判；full 跳过', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    registerTierAgents(ctx);
    registerPermissionTools(ctx);
    // sandbox 档有人桶（不触发询问，直接进扫描）
    const bad = await exec(ctx, {
      name: 'bash',
      args: { command: 'cat /etc/passwd' },
      agentId: 'sandboxa',
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/沙箱/);
    const okCmd = await exec(ctx, {
      name: 'bash',
      args: { command: "cat > s.txt <<'EOF'\nregex /const\\s+/ sample\nEOF\ntype s.txt" },
      agentId: 'sandboxa',
    });
    expect(okCmd.ok).toBe(true);
  });
});

describe('ac-security 唆使防御注入（§八 落点 A：loop/before-run）', () => {
  async function runBeforeRun(ctx: Context, request: Partial<LoopRunCall['request']>): Promise<LoopRunCall['request']> {
    const call: LoopRunCall = { request: { model: 'm', messages: [], ...request } as LoopRunCall['request'] };
    await ctx.waterfall('loop/before-run', call, async () => null as never);
    return call.request;
  }

  it('梯度触发：base sender → full 接收方注入 <security-notice>；同档/降向不注入', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'kid', model: 'm' });
    ctx.agents.register({ id: 'mid', model: 'm', tags: ['sandbox-access'] });
    ctx.agents.register({ id: 'boss', model: 'm', tags: ['full-access'] });

    const hit = await runBeforeRun(ctx, { agent: 'boss', sender: 'kid', source: 'agent', system: 'BASE' });
    expect(hit.system).toContain('<security-notice>');
    expect(hit.system).toContain('kid');
    expect(hit.system).toContain('base-access');
    expect(hit.system?.startsWith('BASE')).toBe(true); // push 收尾（前置内容保留）

    // 同档（boss → boss 不可能；mid → mid）不注入
    const same = await runBeforeRun(ctx, { agent: 'mid', sender: 'mid', source: 'agent', system: 'BASE' });
    expect(same.system).toBe('BASE');
    // 降向（full sender → base 接收方）不注入
    const down = await runBeforeRun(ctx, { agent: 'kid', sender: 'boss', source: 'agent', system: 'BASE' });
    expect(down.system).toBe('BASE');
    // source 非 agent 不注入
    const user = await runBeforeRun(ctx, { agent: 'boss', sender: 'kid', source: 'user', system: 'BASE' });
    expect(user.system).toBe('BASE');
    // 无 system 时直接以 notice 开块
    const bare = await runBeforeRun(ctx, { agent: 'boss', sender: 'kid', source: 'agent' });
    expect(bare.system).toContain('<security-notice>');
  });

  it('未注册 sender 视作 base（宁多注不漏注）；enabled=false 不注入', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'boss', model: 'm', tags: ['full-access'] });
    const hit = await runBeforeRun(ctx, { agent: 'boss', sender: 'sub_legacy1', source: 'agent' });
    expect(hit.system).toContain('<security-notice>');

    ctx.agents.register({ id: 'off', model: 'm', tags: ['full-access'], settings: { security: { enabled: false } } });
    const off = await runBeforeRun(ctx, { agent: 'off', sender: 'kid2', source: 'agent', system: 'BASE' });
    expect(off.system).toBe('BASE');
  });
});

describe('ac-security 输出脱敏（transform-result）', () => {
  it('凭据库明文 + sk- 模式；递归 output 对象；error 字段也脱敏', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.credentials.setGlobal('tavily', 'tvly-real-secret-key-123456');
    ctx.tools.register({
      name: 'leaky',
      execute: () => ({
        ok: true,
        output: {
          text: 'key=tvly-real-secret-key-123456 and sk-abcdefghij0123456789abcd',
          nested: { token: 'password = hunter2hunter2xy' },
        },
      }),
    });
    ctx.tools.register({
      name: 'leaky-error',
      execute: () => ({ ok: false, error: 'failed with tvly-real-secret-key-123456' }),
    });
    const r = await exec(ctx, { name: 'leaky', agentId: 'a' });
    expect(r.output.text).not.toContain('tvly-real-secret-key-123456');
    expect(r.output.text).toContain('***');
    expect(r.output.text).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(r.output.nested.token).toBe('password =***');
    const e = await exec(ctx, { name: 'leaky-error', agentId: 'a' });
    expect(e.error).not.toContain('tvly-real-secret-key-123456');
  });

  it('行级 extraSecrets 注入脱敏', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { options: { extraSecrets: ['rowlevelsecret99'] } });
    ctx.tools.register({
      name: 'echoer',
      execute: (args) => ({ ok: true, output: String(args.t) }),
    });
    const r = await exec(ctx, { name: 'echoer', args: { t: 'has rowlevelsecret99 inside' }, agentId: 'a' });
    expect(r.output).toBe('has *** inside');
  });
});
