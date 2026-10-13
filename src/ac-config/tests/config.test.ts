// ============================================================
// ac-config：读写 / 点路径 / 原子写 / 热重载 / config/changed
// + 深等价提交去重 / 写侧快照隔离 / 载荷变更键（cr-377）
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

  it('set 不变异 get/all 返回的引用（读侧快照隔离）', async () => {
    const ctx = await boot(tmpRoot());
    ctx.config.set('a.b', 1);
    const snap = ctx.config.all();
    (snap as Record<string, any>).a.b = 999;
    expect(ctx.config.get('a.b')).toBe(1);
  });

  it('set 值深拷贝入内存（写侧快照隔离）：调用方事后变异不渗漏', async () => {
    const ctx = await boot(tmpRoot());
    const value = { nested: { x: 1 } };
    ctx.config.set('a', value);
    value.nested.x = 999; // 调用方存引用后变异——服务内态必须不受影响
    expect(ctx.config.get('a')).toEqual({ nested: { x: 1 } });
    const file = path.join(tmpRootLast(), 'config.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk).toEqual({ a: { nested: { x: 1 } } }); // 盘上同样未被渗漏污染
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

  it('config/changed 事件：set/merge 广播（reload 深等价静默）；载荷 = 文件路径 + 变更键', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    const events: Array<{ p: string; changed?: string[] }> = [];
    ctx.on('config/changed', (p, changed) => events.push({ p, changed }));
    ctx.config.set('a', 1);
    ctx.config.merge({ b: 2 });
    ctx.config.reload(); // 深等价（盘 = 内存合成态）——不广播
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ p: path.join(root, 'config.json'), changed: ['a'] });
    expect(events[1]).toEqual({ p: path.join(root, 'config.json'), changed: ['b'] });
  });

  it('深等价提交静默：同值 set 不写盘不广播（写入时间戳不变）', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.config.set('a', { x: 1 });
    const file = path.join(root, 'config.json');
    const mtime1 = fs.statSync(file).mtimeMs;
    let fires = 0;
    ctx.on('config/changed', () => fires++);
    await new Promise((r) => setTimeout(r, 5));
    ctx.config.set('a', { x: 1 }); // 深等价（内容相同、引用不同）
    const mtime2 = fs.statSync(file).mtimeMs;
    expect(fires).toBe(0);
    expect(mtime2).toBe(mtime1); // 未写盘
    expect(ctx.config.get('a')).toEqual({ x: 1 });
  });

  it('reload：外部改文件后热重载生效（载荷携带变更顶层键）', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.config.set('a', 1);
    ctx.config.set('b', 2);
    const seen: Array<{ changed?: string[] }> = [];
    ctx.on('config/changed', (_p, changed) => seen.push({ changed }));
    // 外部直改文件（绕过服务——模拟手工编辑）
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ a: 100, b: 2 }), 'utf-8');
    expect(ctx.config.get('a')).toBe(1); // 未重载前内存态不变
    expect(ctx.config.reload()).toBe(true);
    expect(ctx.config.get('a')).toBe(100);
    expect(ctx.config.get('b')).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].changed).toEqual(['a']); // 只有 a 变了
  });

  it('reload 内容等价：true 但不广播（等价唤醒是纯空转）', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.config.set('a', 1);
    let fires = 0;
    ctx.on('config/changed', () => fires++);
    expect(ctx.config.reload()).toBe(true); // 文件存在且内容与内存等价
    expect(fires).toBe(0);
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

  it('merge 值深拷贝（写侧隔离）+ 载荷 = 顶层键', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    const events: string[][] = [];
    ctx.on('config/changed', (_p, changed) => events.push(changed ?? []));
    const val = { deep: { y: 2 } };
    ctx.config.merge({ m: val });
    val.deep.y = 999;
    expect(ctx.config.get('m')).toEqual({ deep: { y: 2 } });
    expect(events).toEqual([['m']]);
  });
});

// 最近一次 tmpRoot() 产物（写侧隔离用例取盘上文件）
function tmpRootLast(): string {
  return tmps[tmps.length - 1];
}
