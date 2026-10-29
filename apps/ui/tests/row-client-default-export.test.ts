// ============================================================
// row-client-default-export.test.ts —— 行 client 半边 default
// 出口的跨行一致性锁（cr-487 事故；cr-703 布局后由 cr-706 重建）。
//
// 契约：packages/ac-client-ui-*/client/index.ts（行 client 半边入口）
// 必须具 `export default <行插件>`——boot graph 装载器只认
// mod.default.apply；具名出口再全也不是装载面，缺 default 即整行
// 静默跳过（cr-487：ui-singles 整行前端面消失的根因）。
// 真装载路径回归在 boot.test.ts（走真 rowClientLoaders）；本锁管
// 【31 行一个都不能漏】——下次精简再撞同形态时在此红。
// 形态：静态扫源码（零模块求值——31 入口含 .vue 链）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkgsRoot = join(repoRoot, 'packages');

/** packages 下全部行 client 半边入口（与 vite rowClientsPlugin 同款发现口径） */
function rowClientEntries(): Array<{ row: string; file: string }> {
  return readdirSync(pkgsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('ac-client-ui-'))
    .map((d) => ({
      row: d.name.replace(/^ac-client-ui-/, ''),
      file: join(pkgsRoot, d.name, 'client', 'index.ts'),
    }))
    .filter((e) => existsSync(e.file))
    .sort((a, b) => a.row.localeCompare(b.row));
}

/** 去注释（行/块）——注释里的示例字样不得算作出口（cr-487 原版两段式：先块后行） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('行 client 半边 default 出口契约（cr-487；cr-706 重建）', () => {
  const entries = rowClientEntries();

  it('发现口径成立（扫到全仓行 client 入口，31 行）', () => {
    expect(entries.length).toBe(31);
    expect(entries.map((e) => e.row)).toContain('singles');
  });

  it('每个行 client 入口都有 `export default <标识符>` 出口', () => {
    const missing = entries
      .filter((e) => !/^export default\s+[A-Za-z_$][\w$]*;?\s*$/m.test(stripComments(readFileSync(e.file, 'utf8'))))
      .map((e) => e.row);
    expect(missing).toEqual([]);
  });
});
