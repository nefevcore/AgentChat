// ============================================================
// ac-host-face/tests/host-face.test.ts —— 宿主能力面端到端（cr-886 → cr-1121）
//
// 真 ipc loopback：宿主行（listenIpcConns + HostFaceRegistry）× 贡献行
//（timer-face/profile-face）× HostFaceClient——discover 聚合契约 /
// execute 贡献行路由 / 注册面变更 invalidate 广播 + 契约缓存落盘。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { HostFaceClient } from 'ac-host-face-core';
import { readAgentConfig, writeAgentConfig } from 'ac-agents-core';
import { makeHostFaceRow, makeTimerFaceRow, makeProfileFaceRow, currentHostFace, contractCachePath } from '../src/index.ts';

const tmps: string[] = [];
const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-face-'));
  tmps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function bootFace(dataRoot: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    makeHostFaceRow({ dataRoot }),
    makeTimerFaceRow(),
    makeProfileFaceRow({ dataRoot }),
  ];
  for (const row of rows) {
    const f = ctx.plugin(row as any, undefined);
    await f;
    fibers.push(f);
  }
  booted.push({ ctx, fibers });
  // listen 在 fiber.effect 内异步起——轮询等端点就绪（上限 2s）
  const probe = new HostFaceClient();
  for (let i = 0; i < 40; i++) {
    try {
      await probe.connect(pipeOf(dataRoot));
      probe.close();
      return { ctx };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  probe.close();
  throw new Error('host-face 端点 2s 内未就绪');
}

describe('宿主能力面注册面（cr-1121）', () => {
  it('discover → 聚合契约（tools/sections/facts = 贡献行并集）+ 缓存落盘', async () => {
    const root = tmpRoot();
    await bootFace(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const contract = await client.discover();
    expect(contract.version).toBe(1);
    expect(contract.tools.map((t) => t.name).sort()).toEqual(['timer', 'update_agent_profile']);
    expect(contract.sections.map((s) => s.name)).toContain('GUIDELINES_TIMER');
    expect(contract.facts).toEqual(['singles', 'group']);
    // 契约缓存（宿主写——壳侧 boot 静态面数据源）
    const cached = JSON.parse(fs.readFileSync(contractCachePath(root), 'utf-8')) as typeof contract;
    expect(cached.tools.map((t) => t.name).sort()).toEqual(['timer', 'update_agent_profile']);
    client.close();
  });

  it('execute update_agent_profile：改自己落盘；改他人非 admin 拒绝（贡献行路由 + 宿主闸）', async () => {
    const root = tmpRoot();
    writeAgentConfig(root, { id: 'a1', model: 'm' }); // cr-1036 批3：v3 写口
    writeAgentConfig(root, { id: 'a2', model: 'm' });
    await bootFace(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const self = await client.execute('update_agent_profile', { fields: { name: '新名字' } }, { agentId: 'a1' });
    expect(self.ok).toBe(true);
    expect(readAgentConfig(root, 'a1')?.name).toBe('新名字'); // patch 主写读回（cr-918）
    // 宿主闸：非 admin 改他人 → 拒绝
    const other = await client.execute('update_agent_profile', { agent_id: 'a2', fields: { name: '越权' } }, { agentId: 'a1' });
    expect(other.ok).toBe(false);
    expect(other.error).toContain('admin');
    client.close();
  });

  it('execute update_agent_profile settings：授权工件键（security/permission-gate）禁写（cr-1262）——自写即自授；其余具名键照常', async () => {
    const root = tmpRoot();
    writeAgentConfig(root, { id: 'a1', model: 'm' });
    await bootFace(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    // security（沙箱 allowedPaths 边界）——mathematician 实证提权口，fail-loud
    const sec = await client.execute('update_agent_profile', { fields: { settings: { security: { enabled: true, allowedPaths: ['X:/esc'] } } } }, { agentId: 'a1' });
    expect(sec.ok).toBe(false);
    expect(sec.error).toContain('授权工件');
    // permission-gate（审批链第二层 onAsk）——同型
    const gate = await client.execute('update_agent_profile', { fields: { settings: { 'permission-gate': { onAsk: 'allow' } } } }, { agentId: 'a1' });
    expect(gate.ok).toBe(false);
    expect(gate.error).toContain('授权工件');
    // 落盘核验：两个键都未进 settings
    const cfg = readAgentConfig(root, 'a1');
    expect(cfg?.settings?.security).toBeUndefined();
    expect(cfg?.settings?.['permission-gate']).toBeUndefined();
    // 其余具名键照常（回归）
    const okWrite = await client.execute('update_agent_profile', { fields: { settings: { 'my-plugin': { x: 1 } } } }, { agentId: 'a1' });
    expect(okWrite.ok).toBe(true);
    expect(readAgentConfig(root, 'a1')?.settings?.['my-plugin']).toEqual({ x: 1 });
    client.close();
  });

  it('execute timer：timers 服务缺席 → 可读错误（贡献行 use-time 软取）', async () => {
    const root = tmpRoot();
    await bootFace(root); // 未装 timers 行
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const r = await client.execute('timer', { action: 'list' }, { agentId: 'a1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timers 服务未装配');
    client.close();
  });

  it('注册面变更 → invalidate 广播 + 缓存收敛（摘贡献行 = 该面从契约消失）', async () => {
    const root = tmpRoot();
    const { ctx } = await bootFace(root);
    const client = new HostFaceClient();
    let invalidated = false;
    client.onInvalidate = () => { invalidated = true; };
    await client.connect(pipeOf(root));
    await client.ping();
    expect(invalidated).toBe(false);
    // 动态贡献：注册即归属（fiber effect 回收）——契约与缓存随注册面收敛
    const f = ctx.plugin({
      name: 'probe-contrib',
      inject: ['hostFaceRegistry'],
      apply(c: Context) {
        c.get('hostFaceRegistry')!.contribute(c, 'probe', {
          tools: [{ name: 'probe-tool', description: 'd', parameters: { type: 'object' } }],
          sections: [],
          executor: () => ({ ok: true, result: { via: 'probe' } }),
        });
      },
    } as any, undefined);
    await f;
    await new Promise((r) => setTimeout(r, 100));
    expect(invalidated).toBe(true);
    const c1 = await client.discover();
    expect(c1.tools.map((t) => t.name)).toContain('probe-tool');
    expect((await client.execute('probe-tool', {}, { agentId: 'x' })).result).toEqual({ via: 'probe' });
    // 摘贡献行 = 契约面消失 + invalidate 再广播 + 缓存收敛
    invalidated = false;
    if (f.uid !== null) await f.dispose();
    await new Promise((r) => setTimeout(r, 100));
    expect(invalidated).toBe(true);
    expect(currentHostFace()!.contributors()).not.toContain('probe');
    const c2 = await client.discover();
    expect(c2.tools.map((t) => t.name)).not.toContain('probe-tool');
    const cached = JSON.parse(fs.readFileSync(contractCachePath(root), 'utf-8')) as { tools: Array<{ name: string }> };
    expect(cached.tools.map((t) => t.name)).not.toContain('probe-tool');
    client.close();
  });
});

describe('timer-face 行为（cr-1167）', () => {
  async function bootWithTimers(dataRoot: string) {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const { PostOffice } = await import('ac-post-office');
    const { TimerService } = await import('@agentchat/cordis-timer');
    const { ConfigService } = await import('ac-config');
    const { makeTimersHostRow } = await import('ac-host-rows');
    const po = new PostOffice({ dataRoot });
    writeAgentConfig(dataRoot, { id: 'a1', model: 'mock' } as never);
    const rows: unknown[] = [
      TimerService,
      class extends ConfigService { constructor(c: Context) { super(c, { root: dataRoot }); } },
      makeTimersHostRow({ dataRoot, postOffice: po }),
      makeHostFaceRow({ dataRoot }),
      makeTimerFaceRow(),
    ];
    for (const row of rows) {
      const f = ctx.plugin(row as never, undefined as never);
      await f;
      fibers.push(f);
    }
    booted.push({ ctx, fibers });
    const probe = new HostFaceClient();
    for (let i = 0; i < 40; i++) {
      try { await probe.connect(pipeOf(dataRoot)); probe.close(); return { po }; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    probe.close();
    throw new Error('端点未就绪');
  }

  it('set 携带 v2 参数（code）→ fail-loud 不落盘', async () => {
    const root = tmpRoot();
    const { po } = await bootWithTimers(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const r = await client.execute('timer', { action: 'set', code: '(a,u)=>({})', text: 'x' }, { agentId: 'a1' } as never);
    expect(r.error).toContain('v2 定时器词汇');
    expect(r.error).toContain('未生效');
    client.close();
    await po.close();
  });

  it('test 携带 until:{count:2} → 预览截断为 2 条（cr-1167 实测漏洞回归锁）', async () => {
    const root = tmpRoot();
    const { po } = await bootWithTimers(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const r = await client.execute('timer', { action: 'test', when: [{ kind: 'every', iv: '1h' }], until: { count: 2 } }, { agentId: 'a1' } as never);
    expect((r.result as { fires: unknown[] }).fires).toHaveLength(2);
    client.close();
    await po.close();
  });

  it('set conversationId（cr-1170）：归属放行 / 越界拒 / 落条目', async () => {
    const root = tmpRoot();
    const { po } = await bootWithTimers(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    // 越界：nana~user 不属于 a1 → 拒
    const bad = await client.execute('timer', { action: 'set', when: [{ kind: 'daily', at: '09:00' }], text: 'x', conversationId: 'nana~user' }, { agentId: 'a1' } as never);
    expect(bad.error).toContain('不属于本 Agent');
    // 归属：a1~a1 自会话 → 落条目
    const ok1 = await client.execute('timer', { action: 'set', when: [{ kind: 'daily', at: '09:00' }], text: 'x', conversationId: 'a1~a1' }, { agentId: 'a1' } as never);
    expect((ok1.result as { conversationId?: string }).conversationId).toBe('a1~a1');
    // a1~other（一侧为己方）→ 放行
    const ok2 = await client.execute('timer', { action: 'set', when: [{ kind: 'daily', at: '09:00' }], text: 'x', conversationId: 'a1~other' }, { agentId: 'a1' } as never);
    expect((ok2.result as { conversationId?: string }).conversationId).toBe('a1~other');
    // 缺省 = 发起会话（回归：identity.conversationId 烘焙不变）
    const def = await client.execute('timer', { action: 'set', when: [{ kind: 'daily', at: '09:00' }], text: 'x' }, { agentId: 'a1', conversationId: 'user~a1' } as never);
    expect((def.result as { conversationId?: string }).conversationId).toBe('user~a1');
    client.close();
    await po.close();
  });

  it('cr-1171：update 幂等改写（继承未传字段）+ cancel 归档 + list 平铺 conversationId', async () => {
    const root = tmpRoot();
    const { po } = await bootWithTimers(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    // set 一条
    const s = await client.execute('timer', { action: 'set', when: [{ kind: 'daily', at: '09:00' }], text: '原始', conversationId: 'a1~a1' }, { agentId: 'a1' } as never);
    const id = (s.result as { entry_id: string }).entry_id;
    // update：只改 text——when/conversationId 继承
    const u = await client.execute('timer', { action: 'update', entry_id: id, text: '改后' }, { agentId: 'a1' } as never);
    expect((u.result as { conversationId?: string }).conversationId).toBe('a1~a1');
    // list 平铺核验
    const l = await client.execute('timer', { action: 'list' }, { agentId: 'a1' } as never);
    const listed = ((l.result as { entries: Array<{ id: string; text: string; conversationId: string; when: unknown[] }> }).entries).find((e) => e.id === id)!;
    expect(listed.text).toBe('改后');
    expect(listed.conversationId).toBe('a1~a1');
    expect(listed.when).toEqual([{ kind: 'daily', at: '09:00' }]);
    // cancel → 归档留痕
    const c = await client.execute('timer', { action: 'cancel', entry_id: id }, { agentId: 'a1' } as never);
    expect((c.result as { archived?: boolean }).archived).toBe(true);
    const archive = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'a1', 'entries', 'timer-archive.json'), 'utf-8')) as Array<{ id: string; status: string; reason?: string }>;
    expect(archive.find((a) => a.id === id)).toMatchObject({ status: 'cancelled' });
    client.close();
    await po.close();
  });

  it('set 携带 label → 落盘 timer.json（cr-1181：曾构造条目漏带 label，返回回显而磁盘无字段）', async () => {
    const root = tmpRoot();
    const { po } = await bootWithTimers(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const r = await client.execute('timer', { action: 'set', when: [{ kind: 'daily', at: '09:00' }], text: 'x', label: '晨报' }, { agentId: 'a1' } as never);
    const id = (r.result as { entry_id: string }).entry_id;
    expect((r.result as { label?: string }).label).toBe('晨报');
    // 回归锁核验磁盘（bug 本质 = 返回体回显而 timer.json 无该字段）
    const disk = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'a1', 'entries', 'timer.json'), 'utf-8')) as { version: number; entries: Array<{ id: string; label?: string }> };
    expect(disk.entries.find((en) => en.id === id)?.label).toBe('晨报');
    client.close();
    await po.close();
  });

  it('test 纯源指向未就绪源 → warning 提示 dormant', async () => {
    const root = tmpRoot();
    const { po } = await bootWithTimers(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const r = await client.execute('timer', { action: 'test', when: [{ kind: 'source', source: 'fs', view: 'none', on: 'rows-added' }] }, { agentId: 'a1' } as never);
    expect((r.result as { warning?: string }).warning).toContain('源未就绪');
    client.close();
    await po.close();
  });
});

/** 测试本地 pipe 地址（与 socketPathFor win32 分支同归一——避免引 socketPathFor 重复实现） */
function pipeOf(dataRoot: string): string {
  const posixPath = path.join(dataRoot.replaceAll('\\', '/'), 'ipc', 'host-face.sock');
  if (process.platform !== 'win32') return posixPath;
  return '\\\\.\\pipe\\agentchat-' + posixPath.replace(/[^a-zA-Z0-9]+/g, '-');
}
