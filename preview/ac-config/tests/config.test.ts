// ============================================================
// ac-config：读写 / 点路径 / 原子写 / 热重载 / config/changed
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as configRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-config-'));
  tmps.push(dir);
  return dir;
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(root: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(configRow as any, { root });
  await fiber;
  booted.push({ ctx, fibers: [fiber] });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) if (fiber.uid !== null) await fiber.dispose();
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-config', () => {
  it('空根目录：all 为空对象，get 走 fallback', async () => {
    const ctx = await boot(tmpRoot());
    expect(ctx.config.all()).toEqual({});
    expect(ctx.config.get('missing', 'fb')).toBe('fb');
    expect(ctx.config.get('missing')).toBeUndefined();
  });

  it('set/get 点路径 + 全量落盘（重启回读）', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.config.set('llm.model', 'glm-5.3');
    ctx.config.set('llm.temperature', 0.5);
    ctx.config.set('top', 1);
    expect(ctx.config.get<string>('llm.model')).toBe('glm-5.3');
    expect(ctx.config.all()).toEqual({ llm: { model: 'glm-5.3', temperature: 0.5 }, top: 1 });

    const file = path.join(root, 'config.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk).toEqual({ llm: { model: 'glm-5.3', temperature: 0.5 }, top: 1 });
    expect(fs.readdirSync(root)).toEqual(['config.json']); // 原子写不留临时文件

    // 重启回读（持久化语义）
    const ctx2 = await boot(root);
    expect(ctx2.config.get<string>('llm.model')).toBe('glm-5.3');
  });

  it('set 不变异 get/all 返回的引用（快照隔离）', async () => {
    const ctx = await boot(tmpRoot());
    ctx.config.set('a.b', 1);
    const snap = ctx.config.all();
    (snap as Record<string, any>).a.b = 999;
    expect(ctx.config.get('a.b')).toBe(1);
  });

  it('merge 浅合并顶层；delete 删键', async () => {
    const ctx = await boot(tmpRoot());
    ctx.config.set('x', 1);
    ctx.config.set('y', 2);
    ctx.config.merge({ y: 20, z: 30 });
    expect(ctx.config.all()).toEqual({ x: 1, y: 20, z: 30 });
    ctx.config.delete('y');
    expect(ctx.config.all()).toEqual({ x: 1, z: 30 });
  });

  it('config/changed 事件：set/merge/reload 均广播；载荷 = 文件路径', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    const paths: string[] = [];
    ctx.on('config/changed', (p) => paths.push(p));
    ctx.config.set('a', 1);
    ctx.config.merge({ b: 2 });
    ctx.config.reload();
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(path.join(root, 'config.json'));
  });

  it('reload：外部改文件后热重载生效', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.config.set('a', 1);
    // 外部直改文件（绕过服务——模拟手工编辑）
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ a: 100, b: 2 }), 'utf-8');
    expect(ctx.config.get('a')).toBe(1); // 未重载前内存态不变
    expect(ctx.config.reload()).toBe(true);
    expect(ctx.config.get('a')).toBe(100);
    expect(ctx.config.get('b')).toBe(2);
  });

  it('reload 失败保守：文件损坏 → false 且内存态保持', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.config.set('a', 1);
    fs.writeFileSync(path.join(root, 'config.json'), '{broken json', 'utf-8');
    expect(ctx.config.reload()).toBe(false);
    expect(ctx.config.get('a')).toBe(1);
  });

  it('点路径中途覆盖标量 → 建新对象', async () => {
    const ctx = await boot(tmpRoot());
    ctx.config.set('flag', true);
    ctx.config.set('flag.nested', 'x'); // flag 从标量变对象
    expect(ctx.config.get('flag')).toEqual({ nested: 'x' });
  });
});
