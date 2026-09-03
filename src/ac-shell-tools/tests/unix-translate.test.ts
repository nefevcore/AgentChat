// ============================================================
// unix-translate：Unix → PowerShell 翻译单测
//（2026-09-02 反馈：`ls path 2>&1` 的 stderr 重定向被包成路径字面量）
// ============================================================
import { describe, it, expect } from 'vitest';
import { translateUnixToPowerShell } from '../src/unix-translate.ts';

describe('translateUnixToPowerShell', () => {
  it('ls 目标 + 重定向：2>&1 不进路径集，原样追加译文尾部', () => {
    const r = translateUnixToPowerShell('ls "src/foo" 2>&1');
    expect(r.translated).toBe(true);
    expect(r.command).toBe(`Get-ChildItem 'src/foo' 2>&1`);
  });

  it('2>/dev/null 归一为 PS 同形的 2>$null', () => {
    const r = translateUnixToPowerShell('ls src 2>/dev/null');
    expect(r.command).toBe(`Get-ChildItem 'src' 2>$null`);
  });

  it('rm/cp/mv 同款：重定向不进目标集', () => {
    expect(translateUnixToPowerShell('rm -rf dir 2>&1').command).toBe('Remove-Item -Recurse -Force dir 2>&1');
    expect(translateUnixToPowerShell('cp -r a b 2>&1').command).toBe('Copy-Item -Recurse a b 2>&1');
    expect(translateUnixToPowerShell('mv a b 2>&1').command).toBe('Move-Item a b 2>&1');
  });

  it('无重定向时行为不变', () => {
    expect(translateUnixToPowerShell('ls -la').command).toBe('Get-ChildItem -Force');
    expect(translateUnixToPowerShell('sleep 3 && echo done').command).toBe('Start-Sleep -Seconds 3&& echo done');
  });
});
