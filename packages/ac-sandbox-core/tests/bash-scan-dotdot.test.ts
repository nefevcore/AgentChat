import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { bashCommandViolation } from '../src/index.ts';

const WS = path.resolve('/ws/root');
const opts = { roots: [WS], cwd: WS };

// 相对上跳的路径越界检查。
// 缺口史（ISSUE-28）：① 前邻限界只认行首/空白 ⇒ 引号包覆整条绕过；
// ② 只认 token 起始处的 .. ⇒ ./../../x 与 x/../../../y 绕过；
// ③ cd 规则只认 \bcd\s+ ⇒ Set-Location/pushd/chdir 直接绕过。
describe('bash 扫描：相对 ../.. 越界（包覆符/前缀/换目录别名不得绕过）', () => {
 const up = path.join('..', '..', 'secret', 'x.txt');

 it('裸写越界 → 拦截（基线）', () => {
   expect(bashCommandViolation('Get-Content ' + up, opts)).toMatch(/相对路径引用/);
 });

 it('单引号 / 双引号包覆越界 → 拦截（缺口①）', () => {
   expect(bashCommandViolation("Get-Content '" + up + "'", opts)).toMatch(/相对路径引用/);
   expect(bashCommandViolation('Get-Content "' + up + '"', opts)).toMatch(/相对路径引用/);
 });

 it('./ 前缀越界 → 拦截（缺口②，人的自然写法）', () => {
   expect(bashCommandViolation("Get-Content './" + up + "'", opts)).toMatch(/相对路径引用/);
   expect(bashCommandViolation('Get-Content ./' + up, opts)).toMatch(/相对路径引用/);
 });

 it('路径中段越界 → 拦截（缺口②）', () => {
   expect(bashCommandViolation('Get-Content x/../../../y', opts)).toMatch(/相对路径引用/);
 });

 it('等号前缀（--file=../../x）→ 拦截', () => {
   expect(bashCommandViolation('tool --file=' + up, opts)).toMatch(/相对路径引用/);
 });

 it('换目录别名（Set-Location / pushd / chdir）越界 → 拦截（缺口③）', () => {
   for (const c of ['cd', 'Set-Location', 'pushd', 'chdir']) {
     expect(bashCommandViolation(c + ' ..; Get-Content x', opts), c).toMatch(/越出允许范围/);
   }
 });

 it('根内相对上跳 → 放行（防过度拦截）', () => {
   const inside = path.join('..', 'root', 'a.txt');
   expect(bashCommandViolation('cat ' + inside, opts)).toBeNull();
   expect(bashCommandViolation("cat '" + inside + "'", opts)).toBeNull();
 });

 it('./ 与相对目录内的常规路径 → 放行', () => {
   expect(bashCommandViolation('Get-Content ./a.txt', opts)).toBeNull();
   expect(bashCommandViolation('Get-Content sub/a.txt', opts)).toBeNull();
   expect(bashCommandViolation('cd sub', opts)).toBeNull();
   expect(bashCommandViolation('Set-Location sub', opts)).toBeNull();
 });

 it('token 内 .. （git diff a..b）与 URL → 不误拦', () => {
   expect(bashCommandViolation('git diff a..b', opts)).toBeNull();
   expect(bashCommandViolation('git log HEAD~1..HEAD --oneline', opts)).toBeNull();
   expect(bashCommandViolation('curl https://example.com/api | head -5', opts)).toBeNull();
   expect(bashCommandViolation('echo hello..world', opts)).toBeNull();
 });

  it('裸 .. 参数（无尾斜杠）越界 → 拦截（缺口⑤）', () => {
    // 上一条规则要求 .. 后跟斜杠，非 cd 命令的裸 .. 参数无人接住：
    // -Recurse .. 可枚举整棵父目录树（结构泄露，虽读不到文件内容）。
    for (const c of ['Get-ChildItem ..', 'Get-ChildItem -Recurse ..', 'dir /s ..', 'Get-Item ..', 'ls ..']) {
      expect(bashCommandViolation(c, opts), c).toMatch(/独立的 "\.\." 参数/);
    }
  });

  it('裸 .. 的防误伤：token 内双点与单点目录不受影响', () => {
    expect(bashCommandViolation('git log a..b', opts)).toBeNull();
    expect(bashCommandViolation('git diff HEAD~1..HEAD -- src/', opts)).toBeNull();
    expect(bashCommandViolation('echo ...', opts)).toBeNull();
    expect(bashCommandViolation('echo 12.5/3', opts)).toBeNull();
  });
});
