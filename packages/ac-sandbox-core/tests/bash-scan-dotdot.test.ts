import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { bashCommandViolation } from '../src/index.ts';

const WS = path.resolve('/ws/root');
const opts = { roots: [WS], cwd: WS };

// 相对上跳的路径越界检查：前邻限界须覆盖引号等包覆符。
// 缺口史：原实现用 (?:^|\\s) 要求 .. 前是行首或空白，`cat '../../x'` 的
// .. 前是引号 ⇒ 整条绕过扫描（无引号拦、单双引号均放行）。
describe('bash 扫描：相对 ../.. 越界（引号包覆不得绕过）', () => {
  const up = path.join('..', '..', 'secret', 'x.txt');

  it('无引号越界 → 拦截（基线）', () => {
    expect(bashCommandViolation('Get-Content ' + up, opts)).toMatch(/相对路径引用/);
  });

  it('单引号包覆越界 → 拦截（原缺口）', () => {
    expect(bashCommandViolation("Get-Content '" + up + "'", opts)).toMatch(/相对路径引用/);
  });

  it('双引号包覆越界 → 拦截（原缺口）', () => {
    expect(bashCommandViolation('Get-Content "' + up + '"', opts)).toMatch(/相对路径引用/);
  });

  it('等号前缀（--file=../../x）→ 拦截', () => {
    expect(bashCommandViolation('tool --file=' + up, opts)).toMatch(/相对路径引用/);
  });

  it('根内相对上跳 → 放行（防过度拦截）', () => {
    const inside = path.join('..', 'root', 'a.txt');
    expect(bashCommandViolation('cat ' + inside, opts)).toBeNull();
    expect(bashCommandViolation("cat '" + inside + "'", opts)).toBeNull();
  });

  it('token 内 .. （git diff a..b）→ 不放行也不误拦', () => {
    expect(bashCommandViolation('git diff a..b', opts)).toBeNull();
    expect(bashCommandViolation('git log v1..v2 --oneline', opts)).toBeNull();
  });
});
