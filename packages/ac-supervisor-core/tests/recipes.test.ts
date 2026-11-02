// ============================================================
// recipes.test.ts —— 配方盘面单测（cr-859 §五.1）
// 数据根纪律：恒 sandbox/ 独立目录。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeRecipe, readRecipes, readRecipe, removeRecipe, recipePath, recipesDir } from '../src/index.ts';

const ROOT = path.join('sandbox', 'test-recipes-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const hostRecipe = {
  id: 'host',
  boot: { cmd: process.execPath, args: ['apps/host/boot.ts', '--data-root', ROOT] },
  policy: 'crash' as const,
  residency: 'resident' as const,
  owner: 'supervisor' as const,
  writtenAt: '2026-11-02T00:00:00.000Z',
};

describe('配方盘面', () => {
  it('写 → 读往返：形状完整保留', () => {
    writeRecipe(ROOT, hostRecipe);
    const r = readRecipe(ROOT, 'host')!;
    expect(r.boot).toEqual(hostRecipe.boot);
    expect(r.residency).toBe('resident');
    expect(r.policy).toBe('crash');
    expect(r.owner).toBe('supervisor');
  });

  it('目录缺席 = 空数组（新数据根不炸读者）', () => {
    expect(readRecipes(path.join(ROOT, 'never'))).toEqual([]);
  });

  it('坏文件跳过、好文件照常读（盘面退化不炸）', () => {
    writeRecipe(ROOT, hostRecipe);
    fs.writeFileSync(path.join(recipesDir(ROOT), 'broken.json'), '{not json');
    const all = readRecipes(ROOT);
    expect(all.map((r) => r.id)).toEqual(['host']);
  });

  it('缺必需字段的形状判坏为 null', () => {
    const dir = recipesDir(ROOT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'bad' })); // 无 boot/residency/owner
    expect(readRecipe(ROOT, 'bad')).toBeNull();
    expect(readRecipes(ROOT)).toEqual([]);
  });

  it('原子写：目标文件永不为半文（tmp 文件不残留为 .json）', () => {
    writeRecipe(ROOT, hostRecipe);
    const files = fs.readdirSync(recipesDir(ROOT));
    expect(files.filter((n) => n.startsWith('host.json.tmp'))).toEqual([]);
    expect(files).toContain('host.json');
  });

  it('id 防穿越：路径段直接抛错', () => {
    expect(() => recipePath(ROOT, 'a/b')).toThrow();
    expect(() => recipePath(ROOT, '..')).toThrow();
    expect(() => recipePath(ROOT, '')).toThrow();
    expect(() => writeRecipe(ROOT, { ...hostRecipe, id: 'x\\y' })).toThrow();
  });

  it('removeRecipe 幂等（缺席不抛）', () => {
    removeRecipe(ROOT, 'host'); // 未写过
    writeRecipe(ROOT, hostRecipe);
    removeRecipe(ROOT, 'host');
    expect(readRecipe(ROOT, 'host')).toBeNull();
  });

  it('shell 配方 id（shell:<agentId> 冒号合法）', () => {
    const shell = { ...hostRecipe, id: 'shell:alpha', residency: 'on-demand' as const, policy: 'business' as const };
    writeRecipe(ROOT, shell);
    expect(readRecipe(ROOT, 'shell:alpha')?.residency).toBe('on-demand');
  });
});
