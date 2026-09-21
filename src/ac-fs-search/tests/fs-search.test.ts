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

  it('grep：默认内联 50 条——total 恒报命中总数，shown=50，note 提示', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    // 80 行命中：验证默认页 50 条截断与总数上报
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 80 }, (_, i) => `line ${i} ${UNIQUE}`).join('\n') + '\n', 'utf8');
    const { ctx } = await boot(root);

    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE } });
    expect(r.ok).toBe(true);
    const out = r.output as {
      total: number; shown: number; note?: string;
      groups: Array<{ path: string; matches: unknown[] }>;
    };
    expect(out.total).toBe(80);            // 命中总数（告知命中记录）
    expect(out.shown).toBe(50);             // 默认内联 50
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.matches).toHaveLength(50);
    expect(out.note).toContain('共 80 条匹配');
    expect(out.note).toContain('limit');
  });

  it('grep：limit 参数上调——80 命中传 limit 250 全量内联（无截断 note）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 80 }, (_, i) => `line ${i} ${UNIQUE}`).join('\n') + '\n', 'utf8');
    const { ctx } = await boot(root);

    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE, limit: 250 } });
    expect(r.ok).toBe(true);
    const out = r.output as { total: number; shown: number; note?: string; groups: Array<{ matches: unknown[] }> };
    expect(out.total).toBe(80);
    expect(out.shown).toBe(80);
    expect(out.groups[0]!.matches).toHaveLength(80);
    expect(out.note).toBeUndefined();       // 全量展示不产生截断提示
  });

  it('grep：limit 越界钳制——limit 999 等价 250，limit 0 回落默认 50', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 80 }, (_, i) => `line ${i} ${UNIQUE}`).join('\n') + '\n', 'utf8');
    const { ctx } = await boot(root);

    const over = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE, limit: 999 } });
    expect((over.output as { shown: number }).shown).toBe(80); // 999 钳到 250 ≥ 80 命中——全量

    const zero = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE, limit: 0 } });
    expect((zero.output as { shown: number }).shown).toBe(50); // 0 非法——回落默认
  });

  it('grep：空 pattern 拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: '' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('pattern');
  });

  it('grep：>1MB 大文件走流式行扫描（跨块多字节字符不丢行、行号正确）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    const { ctx } = await boot(root);
    // 构造 >1MB 文件：2621 行×100B 头 + 一行「中文+独特词+中文」（UTF-8 字节
    // 恰好跨越首个 256KB 读块边界）+ 长尾，强制流式轨道与 StringDecoder 生效
    const L = 'a'.repeat(99) + '\n';
    const cross = `中文${UNIQUE}中文\n`;
    const big = join(root, 'big.txt');
    writeFileSync(big, L.repeat(2621) + cross + L.repeat(8000));
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE, path: big } });
    expect(r.ok).toBe(true);
    const out = r.output as { groups: Array<{ matches: Array<{ line: number; preview: string }> }> };
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.matches[0]!.line).toBe(2622); // 头 2621 行之后
    expect(out.groups[0]!.matches[0]!.preview).toContain(UNIQUE);
  });

  it('grep：字面量预筛保守性——括号/量词拆分的模式不丢真命中', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);
    // 捕获组把必需字面量拆成两段：预筛需两段都在全文中才放行（都在）
    const g = await ctx.tools.execute({ name: 'grep', args: { pattern: `(ACFSSEARCH_UN)IQUE_TOKEN_9x7` } });
    expect(g.ok).toBe(true);
    expect((g.output as { total: number }).total).toBe(1);
    // 尾部 .* 断开运行：前缀字面量仍足以预筛放行
    const h = await ctx.tools.execute({ name: 'grep', args: { pattern: `${UNIQUE}.*内容` } });
    expect(h.ok).toBe(true);
    expect((h.output as { total: number }).total).toBe(1);
  });

  it('Ⓒ grep 转义建议：括号未转义的 pattern 编译失败 → 附转义后建议（2026-11-19 画像）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: 'async records(' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无效的正则表达式');
    expect(r.error).toContain('async records\\('); // 建议版已转义
  });

  it('Ⓒ grep 0 命中 + pattern 含未转义元字符 → note 提示字面量搜索', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);
    // 可编译但含未转义 . 与 () 的形态（成对括号合法）；测试树无命中 → 0 命中分支
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: 'this.journalStep()' } });
    expect(r.ok).toBe(true);
    expect(String((r.output as { note?: string }).note ?? '')).toContain('fixed: true');
    expect(String((r.output as { note?: string }).note ?? '')).toContain('this\\.journalStep\\(\\)');
  });

  it('Ⓒ grep fixed: true——调用式字面量直通（括号/点不解释为正则，09-20 画像 §①）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);
    // 命中行含 UNIQUE；用 fixed 搜含元字符的字面量（. 与括号在 a.txt 中不存在——用 UNIQUE 前缀 + 元字符组合验证不炸）
    writeFileSync(join(root, 'c.ts'), 'const x = await this.journalStep(1);\n', 'utf8');
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: 'this.journalStep(1)', fixed: true } });
    expect(r.ok).toBe(true);
    expect((r.output as { total: number }).total).toBe(1);
    expect(((r.output as { groups: Array<{ path: string }> }).groups[0]!).path).toBe('c.ts');
    // 反例：同 pattern 不加 fixed 时 . 与 ( 的正则语义不匹配该行（( 未闭合会编译失败——
    // 这里用成对合法形态验证语义差异）
    const plain = await ctx.tools.execute({ name: 'grep', args: { pattern: 'this[.]journalStep[(]1[)]' } });
    expect((plain.output as { total: number }).total).toBe(1); // 显式字符类等价——fixed 正确性的交叉验证
  });

  it('Ⓒ grep 路径不存在 + 近邻目录（编辑距离 ≤2）→ error 附建议（09-20 画像 §⑤）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    const { ctx } = await boot(root);
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE, path: 'subb' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('路径不存在');
    expect(r.error).toContain('sub'); // 建议近邻 subb→sub
    // 无近邻时不建议（a.txt 是文件且形态不同）
    const none = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE, path: 'zzzzz' } });
    expect(none.ok).toBe(false);
    expect(String(none.error)).not.toContain('最近邻');
  });

  it('Ⓒ grep/glob 默认跳过构建产物目录（dist 等）+ note 透出 skippedRoots（09-20 画像 §③）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-fssearch-'));
    makeTree(root);
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'bundle.js'), `built ${UNIQUE}\n`, 'utf8');
    const { ctx } = await boot(root);
    // grep 全库搜：dist 内命中不进结果，note 说明跳过
    const r = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE } });
    expect(r.ok).toBe(true);
    expect((r.output as { total: number }).total).toBe(1); // 只有 a.txt
    expect(String((r.output as { note?: string }).note ?? '')).toContain('dist');
    // path 直接指向 dist 时（单目录搜索）仍可搜——用户明确要搜产物的通道保留
    const direct = await ctx.tools.execute({ name: 'grep', args: { pattern: UNIQUE, path: 'dist' } });
    expect(direct.ok).toBe(true);
    expect((direct.output as { total: number }).total).toBe(1);
    // glob 同口径
    const g = await ctx.tools.execute({ name: 'glob', args: { pattern: '*.js' } });
    expect((g.output as { paths: string[] }).paths).toEqual([]);
    expect(String((g.output as { note?: string }).note ?? '')).toContain('dist');
  });

  it('dispose：fs-search fiber 升级后 glob/grep 回收', async () => {
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
