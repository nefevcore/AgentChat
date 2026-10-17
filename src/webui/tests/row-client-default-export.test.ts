// ============================================================
// webui/tests/row-client-default-export.test.ts —— 行 client 半边
// default 出口的**跨行**一致性锁（cr-487 事故）。
//
// 契约：src/ac-*/client/index.ts（行 client 半边入口）必须具
// `export default <行插件>`——boot graph 装载器
//（src/webui/src/runtime/bootGraph.ts loadEntry）只认 mod.default.apply；
// 具名出口再全也不是装载面，缺 default 即整行静默跳过。
//
// 事故：cr-459 精简按「全仓 grep 零消费」删掉 ac-client-ui-singles 的
// default 出口（10 个消费点确实全走具名），ui-singles 整行前端面消失。
// 装载层真路径回归锁见 boot-graph.integration.test.ts 末节；本锁管
// 【31 行一个都不能漏】——下次精简再撞同一形态时在此红，而不是在浏览器
// console 里只留一行 warn。
//
// 形态：静态扫源码（不是 module 反射）——零模块求值（31 个入口含 .vue
// 链，eager 会拖慢并抬高全仓并发超时风险）。扫的是本仓打包面约定，
// 与源码同形即够；真反射证据住上面那条装载层用例。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const srcRoot = join(repoRoot, 'src');

/** src 下全部行 client 半边入口（与 vite rowClientsPlugin 同款发现口径） */
function rowClientEntries(): Array<{ row: string; file: string }> {
  return readdirSync(srcRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('ac-'))
    .map((d) => ({
      row: d.name.replace(/^ac-client-/, '').replace(/^ac-/, ''),
      file: join(srcRoot, d.name, 'client', 'index.ts'),
    }))
    .filter((e) => existsSync(e.file))
    .sort((a, b) => a.row.localeCompare(b.row));
}

/** 去注释（行/块）——注释里的示例字样不得算作出口 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('行 client 半边 default 出口契约（cr-487）', () => {
  const entries = rowClientEntries();

  it('发现口径成立（扫到全仓行 client 入口，非空）', () => {
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.map((e) => e.row)).toContain('ui-singles');
  });

  it('每个行 client 入口都有 `export default <标识符>` 出口', () => {
    const missing = entries
      .filter((e) => !/^export default\s+[A-Za-z_$][\w$]*;?\s*$/m.test(stripComments(readFileSync(e.file, 'utf8'))))
      .map((e) => e.row);
    expect(missing).toEqual([]);
  });
});
