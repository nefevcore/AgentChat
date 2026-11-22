// ============================================================
// process.test.ts —— 输出归因纯函数单测（buildErrorMessage /
// looksLikeInvocationError）：cr-1223（PS7 中文形态归因 + 管道护栏）
// 与 cr-1227（点名后补管道病因提示）的回归护栏。
// 这些函数只在真跑 PowerShell 时才被执行，纯文本输入即可覆盖全分支。
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildErrorMessage, looksLikeInvocationError } from '../src/process.ts';

/** PS 7.7 zh-CN 实测措辞（术语 X 不会被识别为…） */
const ZH_TERM = (name: string): string =>
  `${"term"} : 术语 ${name} 不会被识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。`;

describe('looksLikeInvocationError（invocation-error 判定单源）', () => {
  it('命令未找到形态（含 PS7 中文「不会被识别为」）判 invocation-error', () => {
    expect(looksLikeInvocationError(ZH_TERM('xyz-abc'))).toBe(true);
    expect(looksLikeInvocationError("'foo' is not recognized as an internal or external command")).toBe(true);
    expect(looksLikeInvocationError('无法将“foo”项识别为 cmdlet')).toBe(true);
  });
  it('ParserError 判 invocation-error；测试红灯不判（command-feedback）', () => {
    expect(looksLikeInvocationError('ParserError: Missing closing \'}\'')).toBe(true);
    expect(looksLikeInvocationError('FAIL src/a.test.ts > 1 failed')).toBe(false);
    expect(looksLikeInvocationError('')).toBe(false);
  });
});

describe('buildErrorMessage（cr-1223 归因）', () => {
  it('PS7 中文形态点名真正缺失的命令（不再错指命令首词）', () => {
    // 旧行为：兜底取 command 首个 ASCII 词 → 错报 Get-Content（该命令存在）
    const msg = buildErrorMessage('Get-ChildItem . | Select-String -Pattern TODO|NOTE', ZH_TERM('NOTE'), 1);
    expect(msg).toContain('找不到命令“NOTE”');
    expect(msg).not.toContain('找不到命令“Get-ChildItem”');
  });
  it('cr-1227：命令含组合符时补管道病因提示（建议③）', () => {
    const piped = buildErrorMessage('echo 观察|待办', ZH_TERM('待办'), 1);
    expect(piped).toContain('组合符');
    expect(piped).toContain('加引号');
  });
  it('cr-1227：无组合符时不补管道提示（避免噪声）', () => {
    const single = buildErrorMessage('NoSuchCmd-xyz', ZH_TERM('NoSuchCmd-xyz'), 1);
    expect(single).toContain('找不到命令“NoSuchCmd-xyz”');
    expect(single).not.toContain('组合符');
  });
  it('无具体名字可提取且命令是组合形态 → 不猜名，给拆段指引（ISSUE-18 兜底护栏）', () => {
    const msg = buildErrorMessage('cmd-a | cmd-b', 'term: The term zzz is not recognized as a name of a cmdlet', 1);
    expect(msg).toContain('管道/组合形态');
    expect(msg).toContain('拆成单条命令');
    expect(msg).not.toContain('找不到命令“cmd-a”');
  });
  it('UTF8 裸编码形态给专用指引', () => {
    expect(buildErrorMessage('x', ZH_TERM('utf8'), 1)).toContain('[System.Text.Encoding]::UTF8');
  });
  it('无归因输出返回空串（调用方回落基线文案）', () => {
    expect(buildErrorMessage('echo hi', 'hello', 0)).toBe('');
  });
});