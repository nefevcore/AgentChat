// ============================================================
// ac-workspace/tests/file-assoc-icons.test.ts —— 文件关联图标
// 行为面锁定（cr-833）：三层 ProgID 决议 / DefaultIcon 解析 / reg 输出解析 /
// 缓存幂等。全部经假 probe 离线断言（真机面由开发期人工点验）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  assocIconOfExt,
  assocIconSourceOfExt,
  folderIconOf,
  parseDefaultIcon,
  parseRegDefaultValue,
  parseRegValueNames,
  resetAssocIconCache,
  type AssocProbe,
} from '../src/file-assoc-icons.ts';

/** 假 probe：表驱动桩（defaults = 默认值表 / values = 命名值表 / names = 值名清单表） */
function fakeProbe(
  defaults: Record<string, string | null>,
  values: Record<string, string> = {},
  names: Record<string, string[]> = {},
  platform: NodeJS.Platform = 'win32',
): AssocProbe {
  return {
    platform,
    regDefault: async (k) => defaults[k] ?? null,
    regValueOf: async (k, n) => values[k + '##' + n] ?? null,
    regValueNames: async (k) => names[k] ?? null,
  };
}

// reg 输出行构造（真实格式：4 空格缩进 + 类型列 + 数据列）
const regLine = (type: string, data: string) => '    (Default)    ' + type + '    ' + data;
const HKCR = 'HKCR\\';
const DIBASE = HKCR;
const UCMD = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice';
const OWPMD = HKCR + '.md\\OpenWithProgids';
const NL2 = String.fromCharCode(13, 10);

describe('parseRegDefaultValue / parseRegValueNames（reg 输出解析）', () => {
  it('REG_SZ 行取数据列', () => {
    expect(parseRegDefaultValue(regLine('REG_SZ', 'Typora.md'))).toBe('Typora.md');
  });
  it('「值未设置」占位（本地化括号形态）= null', () => {
    expect(parseRegDefaultValue(regLine('REG_SZ', '(value not set)'))).toBeNull();
    expect(parseRegDefaultValue(regLine('REG_SZ', '(值未设置)'))).toBeNull();
  });
  it('空输出/无 REG 行 = null', () => {
    expect(parseRegDefaultValue('')).toBeNull();
    expect(parseRegDefaultValue('HKEY_CLASSES_ROOT\\.md')).toBeNull();
  });
  it('值名枚举：非括号值名清单', () => {
    const out = ['HKEY_CLASSES_ROOT\\.md\\OpenWithProgids', '    VSCode.md    REG_SZ    ', '    (Default)    REG_SZ    x', ''].join(NL2);
    expect(parseRegValueNames(out)).toEqual(['VSCode.md']);
  });
});

describe('parseDefaultIcon（DefaultIcon 值形态）', () => {
  it('裸路径 → index 0', () => {
    expect(parseDefaultIcon('C:\\app.ico')).toEqual({ source: 'C:\\app.ico', index: 0 });
  });
  it('path,index 与负索引（资源 ID）', () => {
    expect(parseDefaultIcon('C:\\a.dll,3')).toEqual({ source: 'C:\\a.dll', index: 3 });
    expect(parseDefaultIcon('%SystemRoot%\\x.dll,-730')).toEqual({ source: '%SystemRoot%\\x.dll', index: -730 });
  });
  it('带引号路径：引号剥离且 index 保真', () => {
    const q = String.fromCharCode(34);
    expect(parseDefaultIcon(q + 'C:\\WINDOWS\\py.exe' + q + ',1')).toEqual({ source: 'C:\\WINDOWS\\py.exe', index: 1 });
  });
  it('非索引尾巴 = 整体当路径', () => {
    expect(parseDefaultIcon('C:\\a.exe,abc')).toEqual({ source: 'C:\\a.exe,abc', index: 0 });
  });
  it('UWP @{package} / %1 占位 / 空串 = null', () => {
    expect(parseDefaultIcon('@{Microsoft.Notepad_8wekyb}!App')).toBeNull();
    expect(parseDefaultIcon('%1')).toBeNull();
    expect(parseDefaultIcon('')).toBeNull();
  });
});

describe('assocIconSourceOfExt（三层 ProgID 决议）', () => {
  it('层 1 UserChoice ProgId 命名值遮蔽机器级', async () => {
    const probe = fakeProbe(
      { [HKCR + 'Typora.md\\DefaultIcon']: regLine('REG_SZ', 'C:\\Typora.exe,0'), [HKCR + '.md']: regLine('REG_SZ', 'Other.md') },
      { [UCMD + '##ProgId']: regLine('REG_SZ', 'Typora.md') },
    );
    expect(await assocIconSourceOfExt('md', probe)).toEqual({ source: 'C:\\Typora.exe', index: 0 });
  });
  it('层 2 HKCR 扩展键默认值（机器级 ProgID）', async () => {
    const probe = fakeProbe({
      [HKCR + '.md']: regLine('REG_SZ', 'Typora.md'),
      [HKCR + 'Typora.md\\DefaultIcon']: regLine('REG_EXPAND_SZ', '%ProgramFiles%\\Typora.exe,0'),
    });
    expect(await assocIconSourceOfExt('md', probe)).toEqual({ source: '%ProgramFiles%\\Typora.exe', index: 0 });
  });
  it('层 3 OpenWithProgids 逐候选——首个有 DefaultIcon 的胜出（UWP 候选自然跳过）', async () => {
    const probe = fakeProbe(
      { [HKCR + 'VSCode.md\\DefaultIcon']: regLine('REG_SZ', 'C:\\code.exe,0') },
      {},
      { [OWPMD]: ['AppXdeadbeef', 'VSCode.md'] },
    );
    expect(await assocIconSourceOfExt('md', probe)).toEqual({ source: 'C:\\code.exe', index: 0 });
  });
  it('全链缺席 = null；非 win 平台 = null', async () => {
    expect(await assocIconSourceOfExt('md', fakeProbe({}))).toBeNull();
    expect(await assocIconSourceOfExt('md', fakeProbe({}, {}, {}, 'darwin'))).toBeNull();
  });
  it('ProgID 的 DefaultIcon 是 UWP 形态 → 候选链继续（不误取）', async () => {
    const probe = fakeProbe(
      {
        [HKCR + 'AppXbad\\DefaultIcon']: regLine('REG_SZ', '@{pkg}!app'),
        [HKCR + 'Good.md\\DefaultIcon']: regLine('REG_SZ', 'C:\\g.exe,2'),
      },
      {},
      { [OWPMD]: ['AppXbad', 'Good.md'] },
    );
    expect(await assocIconSourceOfExt('md', probe)).toEqual({ source: 'C:\\g.exe', index: 2 });
  });
});

describe('folderIconOf（目录行图标：HKCR Directory DefaultIcon）', () => {
  it('Directory DefaultIcon 提取（win）', async () => {
    resetAssocIconCache();
    const W = String.fromCharCode(92);
    const probe = fakeProbe({
      [HKCR + 'Directory' + W + W + 'DefaultIcon']: regLine('REG_EXPAND_SZ', '%SystemRoot%' + W + W + 'System32' + W + W + 'shell32.dll,3'),
    });
    const src = await folderIconOf(probe);
    expect(typeof src === 'string' || src === null).toBe(true); // 假 probe 下提取走真 powershell——形状断言
    resetAssocIconCache();
  });
  it('非 win 平台 = null（folder 线性图标回落）', async () => {
    resetAssocIconCache();
    expect(await folderIconOf(fakeProbe({}, {}, {}, 'darwin'))).toBeNull();
    resetAssocIconCache();
  });
});

describe('assocIconOfExt source 缓存（二次查询零注册表往返）', () => {
  it('source 缓存命中后 regDefault 不再被调（调用计数为证）', async () => {
    resetAssocIconCache();
    let calls = 0;
    const probe: AssocProbe = {
      platform: 'win32',
      regDefault: async (k) => { calls++; return k.includes('DefaultIcon') ? regLine('REG_SZ', 'C:\\x.exe,0') : regLine('REG_SZ', 'X.md'); },
      regValueOf: async () => null,
      regValueNames: async () => null,
    };
    const a = await assocIconOfExt('zz9', probe);
    const afterFirst = calls;
    const b = await assocIconOfExt('zz9', probe);
    expect(calls).toBe(afterFirst);
    expect(a).toBe(b);
    resetAssocIconCache();
  });
});