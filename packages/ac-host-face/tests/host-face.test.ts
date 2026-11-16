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

/** 测试本地 pipe 地址（与 socketPathFor win32 分支同归一——避免引 socketPathFor 重复实现） */
function pipeOf(dataRoot: string): string {
  const posixPath = path.join(dataRoot.replaceAll('\\', '/'), 'ipc', 'host-face.sock');
  if (process.platform !== 'win32') return posixPath;
  return '\\\\.\\pipe\\agentchat-' + posixPath.replace(/[^a-zA-Z0-9]+/g, '-');
}
