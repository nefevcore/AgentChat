// ============================================================
// webui/tests/css-color-tokens.test.ts —— 颜色令牌三元组契约（cr-32）
//
// 背景：基线 WebView 92 不解析 color-mix()（Chrome 111+），tint 一律改写
// rgba(var(--x-rgb), α)。三元组与色值分处两行，人工极容易改一处漏一处
// ——本测试把两条锁死：
//   ① 同步锁：tokens.css 里 --x 的 hex 与 --x-rgb 的三元组必须逐位一致；
//   ② 存在锁：源码里 var(--x-rgb) 引用的每个名必须有定义（或属运行时内联
//      注入白名单——星色 --sc/--tc 由组件内联给值，CSS 侧无从派生）。
// 构建期另有棘轮守门（scripts/check-webview-baseline.mjs 判据④）管
// 「产物里 color-mix 不得新增」，本测试管「三元组本身对不对」。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = join(repo, 'src');

/** 收集 src 下所有 .css 与 .vue（后者含 <style> 块） */
function collectStyleFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectStyleFiles(p, out);
    else if (extname(name) === '.css' || extname(name) === '.vue') out.push(p);
  }
  return out;
}

const FILES = collectStyleFiles(SRC);
const tokensCss = readFileSync(join(SRC, 'webui-kit/src/base/tokens.css'), 'utf8');

/** 运行时内联注入的伴随三元组（CSS 侧无从派生）：星色 --sc/--tc */
const INLINE_INJECTED = new Set(['sc-rgb', 'tc-rgb']);

/** 注释中的泛型占位（文档写作 var(--x-rgb) 示例，非真实引用） */
const DOC_PLACEHOLDER = new Set(['x-rgb']);

describe('颜色令牌三元组契约（cr-32）', () => {
  it('① 同步锁：--x 的 hex 与 --x-rgb 三元组逐位一致（tokens.css）', () => {
    const tripletRe = /--([\w-]+)-rgb:\s*(\d+),\s*(\d+),\s*(\d+)\s*;/g;
    const mismatches: string[] = [];
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = tripletRe.exec(tokensCss)) !== null) {
      const [full, name, r, g, b] = m;
      // 回溯找同块内最近的 --name: #hex;
      const before = tokensCss.slice(0, m.index);
      const hexRe = new RegExp('--' + name + '\\s*:\\s*#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\s*;', 'g');
      let hit: RegExpExecArray | null = null;
      let h: RegExpExecArray | null;
      while ((h = hexRe.exec(before)) !== null) hit = h;
      if (!hit) continue; // 别名层（var(...) 形式）由断言②的引用链覆盖
      let hex = hit[1]!;
      if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
      const want = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const got = [Number(r), Number(g), Number(b)];
      if (want[0] !== got[0] || want[1] !== got[1] || want[2] !== got[2]) {
        mismatches.push(name + ': hex=#' + hex + ' 期望 ' + want.join(',') + ' 实得 ' + got.join(','));
      }
      checked++;
      void full;
    }
    expect(checked).toBeGreaterThan(6); // 至少覆盖双主题的语义色
    expect(mismatches).toEqual([]);
  });

  it('② 存在锁：源码引用的每个 --x-rgb 均有定义或属内联注入白名单', () => {
    const defined = new Set<string>();
    let text = '';
    for (const f of FILES) text += readFileSync(f, 'utf8');
    for (const m of text.matchAll(/--([\w-]+)-rgb\s*:/g)) defined.add(m[1] + '-rgb');
    const missing = new Set<string>();
    for (const m of text.matchAll(/var\(\s*--([\w-]+)-rgb/g)) {
      const name = m[1] + '-rgb';
      if (!defined.has(name) && !INLINE_INJECTED.has(name) && !DOC_PLACEHOLDER.has(name)) missing.add(name);
    }
    expect([...missing]).toEqual([]);
  });

  it('③ 反向锁：定义的三元组名不得为死条目（须至少被 var() 引用一次）', () => {
    let text = '';
    for (const f of FILES) text += readFileSync(f, 'utf8');
    const dead = new Set<string>();
    for (const m of text.matchAll(/--([\w-]+)-rgb\s*:/g)) {
      const name = m[1] + '-rgb';
      if (INLINE_INJECTED.has(name)) continue;
      // 真实消费 = 出现在某处 var(--name...)；定义行自身写作 --name: 故不构成自证
      if (!text.includes('var(--' + name)) dead.add(name);
    }
    expect([...dead]).toEqual([]);
  });
});