// ============================================================
// ac-fs-search：文件检索行生命周期冒烟（glob/grep 注册→执行→dispose 回收）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as fsSearchRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** boot：工具注册中心 + fs-search 行（沙箱基准 = 临时目录，行选项名以实现为准：workdir） */
async function boot(workdir: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const f1 = ctx.plugin(toolsRow as any);
  await f1;
  fibers.push(f1);
  const f2 = ctx.plugin(fsSearchRow as any, { workdir });
  await f2;
  fibers.push(f2);
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

/** a.txt 里的独特词（grep 断言用——不与仓库/系统文件撞词） */
const UNIQUE = 'ACFSSEARCH_UNIQUE_TOKEN_9x7';

/** 建测试树：a.txt（含独特词）+ sub/b.md */
function makeTree(root: string): void {
  writeFileSync(join(root, 'a.txt'), `第一行 ${UNIQUE} 内容\n第二行普通内容\n`, 'utf8');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'b.md'), 'markdown 笔记（无独特词）\n', 'utf8');
}

describe('ac-fs-search', () => {
  it('注册面：行挂载后 glob/grep 进入注册表', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    const { ctx } = await boot(root);
    expect(ctx.tools.has('glob')).toBe(true);
    expect(ctx.tools.has('grep')).toBe(true);
  });

  it('glob：不含 / 的模式按文件名匹配任意深度（*.txt / *.md）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);

    const txt = await ctx.tools.execute({ name: 'glob', args: { pattern: '*.txt' } });
    expect(txt.ok).toBe(true);
    expect((txt.output as { paths: string[] }).paths).toEqual(['a.txt']);

    // 模式不含 / → 匹配任意深度的文件名（子目录里的 b.md 也命中）
    const md = await ctx.tools.execute({ name: 'glob', args: { pattern: '*.md' } });
    expect(md.ok).toBe(true);
    expect((md.output as { paths: string[] }).paths).toEqual(['sub/b.md']);
  });

  it('grep：独特词命中且按文件分组返回行号与预览', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);

    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE } });
    expect(r.ok).toBe(true);
    const out = r.output as {
      total: number;
      groups: Array<{ path: string; matches: Array<{ line: number; preview: string }> }>;
    };
    expect(out.total).toBe(1);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.path).toBe('a.txt');
    expect(out.groups[0]!.matches[0]!.line).toBe(1);
    expect(out.groups[0]!.matches[0]!.preview).toContain(UNIQUE);
  });

  it('grep：空 pattern 拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: '' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('pattern');
  });

  it('dispose：fs-search fiber 卸载后 glob/grep 回收', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx, fibers } = await boot(root);
    await fibers[1]!.dispose();
    expect(ctx.tools.has('glob')).toBe(false);
    expect(ctx.tools.has('grep')).toBe(false);
    expect((await ctx.tools.execute({ name: 'glob', args: { pattern: '*.txt' } })).ok).toBe(false);
  });
});
