// ============================================================
// ac-fs-search：文件检索行生命周期冒烟（glob/grep 注册→执行→dispose 回收）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as sessionRow from 'ac-session';
import * as workspaceRow from 'ac-workspace';
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

describe('ac-fs-search 双黑名单结果过滤（access-tier §9.2）', () => {
  /** boot：workspace 全依赖（agents/agentStore/session）+ 真 workspace 行
   *  （黑名单锚定数据根）+ fs-search 行（基准 = 数据根） */
  async function bootWs(root: string) {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const [row, config] of [
      [toolsRow, undefined],
      [agentsRow, undefined],
      [agentStoreRow, { root }],
      [sessionRow, { root }],
      [workspaceRow, { root }],
      [fsSearchRow, { workdir: root }],
    ] as Array<[unknown, unknown]>) {
      const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    return { ctx, fibers };
  }

  it('glob/grep 结果过滤：持久化域树（agents/ 目录前缀）与机密文件（.env）不进结果', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-deny-'));
    makeTree(root);
    // 系统域树 + 机密文件（数据根下的敏感面）
    mkdirSync(join(root, 'agents', 'someone'), { recursive: true });
    writeFileSync(join(root, 'agents', 'someone', 'config.json'), '{"tags":["full-access"]}', 'utf8');
    writeFileSync(join(root, '.env'), 'SECRET=1', 'utf8');
    const { ctx } = await bootWs(root);

    // glob *.json：agents/ 树内文件被过滤（目录前缀禁——只查参数拦不住目录扫描）
    const g = await ctx.tools.execute({ name: 'glob', args: { pattern: '*.json' } });
    expect(g.ok).toBe(true);
    expect((g.output as { paths: string[] }).paths).not.toContain('agents/someone/config.json');

    // grep 独特词命中 a.txt（普通文件照常）
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE } });
    expect(r.ok).toBe(true);
    expect(((r.output as { groups: Array<{ path: string }> }).groups[0]!).path).toBe('a.txt');

    // grep 搜索根直接指向 agents 树 → 参数校验拒绝（根命中访问黑名单）
    const denied = await ctx.tools.execute({
      name: 'grep',
      args: { pattern: 'anything', path: join(root, 'agents') },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('黑名单');

    // .env 命中读黑名单（机密面）：glob 结果过滤
    const env = await ctx.tools.execute({ name: 'glob', args: { pattern: '.env*', path: root } });
    expect(env.ok).toBe(true);
    expect((env.output as { paths: string[] }).paths).toEqual([]);

    // full 档跳过读黑名单（.env 可见）但 accessDeny 仍拦（agents/ 仍过滤）
    ctx.agents.register({ id: 'boss', model: 'm', tags: ['full-access'] });
    const envFull = await ctx.tools.execute({ name: 'glob', args: { pattern: '.env*', path: root }, agentId: 'boss' });
    expect(envFull.ok).toBe(true);
    expect((envFull.output as { paths: string[] }).paths).toEqual(['.env']);
    const agentsFull = await ctx.tools.execute({ name: 'glob', args: { pattern: '*.json', path: root }, agentId: 'boss' });
    expect(agentsFull.ok).toBe(true);
    expect((agentsFull.output as { paths: string[] }).paths).not.toContain('agents/someone/config.json');
  });
});
