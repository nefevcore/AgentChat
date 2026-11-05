// ============================================================
// ac-host-face/tests/host-face.test.ts —— 宿主能力面端到端（cr-886）
//
// 真 ipc loopback：宿主行（listenIpcConns）× HostFaceClient——discover/
// execute（timer 双闸+update_agent_profile）/invalidate 广播。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import { HostFaceClient } from 'ac-host-face-core';
import { makeHostFaceRow, currentHostFace } from '../src/index.ts';

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
  const f1 = ctx.plugin(toolsRow as any, undefined);
  await f1;
  fibers.push(f1);
  const f2 = ctx.plugin(makeHostFaceRow({ dataRoot }) as any, undefined);
  await f2;
  fibers.push(f2);
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

describe('宿主能力面（cr-886）', () => {
  it('discover → 契约完整（tools/sections/facts）', async () => {
    const root = tmpRoot();
    await bootFace(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const contract = await client.discover();
    expect(contract.version).toBe(1);
    expect(contract.tools.map((t) => t.name).sort()).toEqual(['timer', 'update_agent_profile']);
    expect(contract.sections.map((s) => s.name)).toContain('GUIDELINES_TIMER');
    expect(contract.facts).toEqual(['singles', 'group']);
    client.close();
  });

  it('execute update_agent_profile：改自己落盘（agents-core 归一形态）；改他人非 admin 拒绝', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'agents', 'a1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'a1', 'config.json'), JSON.stringify({ id: 'a1', model: 'm' }), 'utf-8');
    fs.mkdirSync(path.join(root, 'agents', 'a2'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'a2', 'config.json'), JSON.stringify({ id: 'a2', model: 'm' }), 'utf-8');
    await bootFace(root);
    const client = new HostFaceClient();
    await client.connect(pipeOf(root));
    const self = await client.execute('update_agent_profile', { fields: { name: '新名字' } }, { agentId: 'a1' });
    expect(self.ok).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'a1', 'config.json'), 'utf-8'));
    expect(saved.name).toBe('新名字');
    // 宿主闸：非 admin 改他人 → 拒绝
    const other = await client.execute('update_agent_profile', { agent_id: 'a2', fields: { name: '越权' } }, { agentId: 'a1' });
    expect(other.ok).toBe(false);
    expect(other.error).toContain('admin');
    client.close();
  });

  it('invalidate：timers 变更 → 在连壳收到失效帧', async () => {
    const root = tmpRoot();
    const { ctx } = await bootFace(root);
    const client = new HostFaceClient();
    let invalidated = false;
    client.onInvalidate = () => { invalidated = true; };
    await client.connect(pipeOf(root));
    await client.ping();
    // 经宿主 ctx 直接触发（timers 行 save 尾挂的就是 currentHostFace().invalidate()）
    currentHostFace()?.invalidate();
    await new Promise((r) => setTimeout(r, 100));
    expect(invalidated).toBe(true);
    void ctx;
    client.close();
  });
});

/** 测试本地 pipe 地址（与 socketPathFor win32 分支同归一——避免引 socketPathFor 重复实现） */
function pipeOf(dataRoot: string): string {
  const posixPath = path.join(dataRoot.replaceAll('\\', '/'), 'ipc', 'host-face.sock');
  if (process.platform !== 'win32') return posixPath;
  return '\\\\.\\pipe\\agentchat-' + posixPath.replace(/[^a-zA-Z0-9]+/g, '-');
}