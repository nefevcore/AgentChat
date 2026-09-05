// ============================================================
// ac-str-replace-editor：精准编辑器行生命周期冒烟（view/str_replace/create→dispose 回收）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as editorRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** boot：工具注册中心 + 编辑器行（沙箱基准 = 临时目录，行选项名以实现为准：workdir） */
async function boot(workdir: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const f1 = ctx.plugin(toolsRow as any);
  await f1;
  fibers.push(f1);
  const f2 = ctx.plugin(editorRow as any, { workdir });
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

const FILE = 'file.txt';
// 不带尾换行：split('\n') 的行数即正文行数（尾换行会计入空末行——实现语义）
const BEFORE = '第一行 alpha\nSECOND unique line\n第三行 gamma';
const OLD_STR = 'SECOND unique line';
const NEW_STR = '替换后的第二行';

describe('ac-str-replace-editor', () => {
  it('注册面：行挂载后 str_replace_editor 进入注册表', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    const { ctx } = await boot(root);
    expect(ctx.tools.has('str_replace_editor')).toBe(true);
    expect(ctx.tools.get('str_replace_editor')?.requiredTags).toEqual(['fs_minimal']);
  });

  it('view：带行号输出（cat -n 风格，6 宽右对齐 + 两空格）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx } = await boot(root);

    const r = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: FILE } });
    expect(r.ok).toBe(true);
    const out = r.output as { type: string; total_lines: number; content: string };
    expect(out.type).toBe('file');
    expect(out.total_lines).toBe(3);
    expect(out.content).toContain('     1  第一行 alpha');
    expect(out.content).toContain(`     2  ${OLD_STR}`);
    expect(out.content).toContain('     3  第三行 gamma');
  });

  it('str_replace：old_str 唯一时替换成功且盘上内容真的变了', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx } = await boot(root);

    const r = await ctx.tools.execute({
      name: 'str_replace_editor',
      args: { command: 'str_replace', path: FILE, old_str: OLD_STR, new_str: NEW_STR },
    });
    expect(r.ok).toBe(true);
    expect((r.output as { replacements: number }).replacements).toBe(1);
    // 盘上事实：读临时目录里的真实文件
    expect(readFileSync(join(root, FILE), 'utf8')).toBe(`第一行 alpha\n${NEW_STR}\n第三行 gamma`);
  });

  it('create：新文件写入成功；已存在文件拒绝（不可覆盖）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx } = await boot(root);

    const fresh = await ctx.tools.execute({
      name: 'str_replace_editor',
      args: { command: 'create', path: 'new.txt', file_text: '全新内容\n' },
    });
    expect(fresh.ok).toBe(true);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('全新内容\n');

    const clash = await ctx.tools.execute({
      name: 'str_replace_editor',
      args: { command: 'create', path: FILE, file_text: '覆盖尝试\n' },
    });
    expect(clash.ok).toBe(false);
    expect(clash.error).toContain('已存在');
    expect(readFileSync(join(root, FILE), 'utf8')).toBe(BEFORE); // 原文件未被破坏
  });

  it('dispose：编辑器 fiber 卸载后工具回收', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx, fibers } = await boot(root);
    await fibers[1]!.dispose();
    expect(ctx.tools.has('str_replace_editor')).toBe(false);
    const r = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: FILE } });
    expect(r).toEqual({ ok: false, error: 'unknown tool: str_replace_editor' });
  });
});
