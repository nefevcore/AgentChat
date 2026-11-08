// ============================================================
// ac-run-code-core 测试：源码词法归一层（worker 迁入后首次单测覆盖）
// · normalizeStringNewlines：串内裸换行确定性转义（本修复主对象）
// · normalizeHashComments：# 注释归一（cr-59 回归锁定）
// · normalizeSource：组合 + stripTypeScriptTypes 全链（擦除救活）
// · findBannedModuleSyntax / scanFreeVariables：迁入函数回归锁定
// ============================================================
import { describe, it, expect } from 'vitest';
import * as nodeModule from 'node:module';
import {
  normalizeStringNewlines,
  normalizeSource,
  normalizeHashComments,
  findBannedModuleSyntax,
  scanFreeVariables,
} from '../src/index.ts';

const strip = (nodeModule as unknown as { stripTypeScriptTypes: (code: string, o?: { mode?: 'strip' }) => string }).stripTypeScriptTypes;
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

describe('normalizeStringNewlines', () => {
  it('串内裸 LF 转义为 \\n', () => {
    expect(normalizeStringNewlines("const s = 'a" + LF + "b';")).toBe("const s = 'a\\nb';");
  });
  it('CRLF / 孤立 CR 折叠为单个 \\n', () => {
    expect(normalizeStringNewlines("const s = 'a" + CR + LF + "b';")).toBe("const s = 'a\\nb';");
    expect(normalizeStringNewlines("'a" + CR + "b'")).toBe("'a\\nb'");
  });
  it('合法程序字节零触碰：无裸换行的串/模板串/注释原样', () => {
    // 注释内不构造「裸换行后闭引号」形态（那是漂移形态，归一是正确行为）
    const src = "const t = \`x${'a'}y\`; const s = 'ok'; // c" + LF + "const r = /'/;";
    expect(normalizeStringNewlines(src)).toBe(src);
  });
  it('零触碰用例自证：src 内确实不含「裸换行后闭引号」形态', () => {
    const src = "const s = 'ok'; const r = /'/;";
    expect(src.includes(String.fromCharCode(10))).toBe(false);
  });
  it('既有反斜杠转义对原样保留（含 \\ + 换行续行写法）', () => {
    // 串体：a、反斜杠+LF（合法续行写法）、b、裸 LF、c —— 续行原样、裸 LF 转义
    const input = "'a\\" + LF + "b" + LF + "c'";
    const expected = "'a\\" + LF + "b\\nc'";
    expect(normalizeStringNewlines(input)).toBe(expected);
  });
  it('未闭合串透传（strip 报准确的 unterminated）', () => {
    const src = "const s = 'unclosed";
    expect(normalizeStringNewlines(src)).toBe(src);
  });
  it('幂等：归一输出重复调用字节不变', () => {
    const once = normalizeStringNewlines("'a" + LF + "b'");
    expect(normalizeStringNewlines(once)).toBe(once);
  });
});

describe('normalizeSource（组合 + 擦除全链）', () => {
  it('# 注释与串内裸换行共存，一次归一双救活', () => {
    const out = normalizeSource("# 备注" + LF + "const s = 'a" + LF + "b';");
    expect(out).toBe("// 备注" + LF + "const s = 'a\\nb';");
  });
  it('全链：裸换行程序经 strip 擦除成功且语义正确（修复前 Invalid token）', async () => {
    const raw = "const s: string = '行一" + LF + "行二';" + LF + "return s.length;";
    const js = strip("(async () => {" + LF + normalizeSource(raw) + LF + "})()", { mode: 'strip' });
    const len = await (new Function('return ' + js)() as Promise<number>);
    // '行一' 2 字符 + \n 1 + '行二' 2 = 5
    expect(len).toBe(5);
  });
});

describe('normalizeHashComments（cr-59 回归）', () => {
  it('# 空格注释 → //；#x 私有字段形态不动', () => {
    expect(normalizeHashComments('# 备注')).toBe('// 备注');
    expect(normalizeHashComments('this.#x')).toBe('this.#x');
  });
});

describe('findBannedModuleSyntax（回归锁定）', () => {
  it('require(\'x\') / import(\'x\') 检出；字符串/注释里的词不误伤', () => {
    expect(findBannedModuleSyntax("const a = require('node:fs');")).toContain('require');
    expect(findBannedModuleSyntax("const s = \"require('x')\";")).toBeUndefined();
    expect(findBannedModuleSyntax('// import x from y' + LF + 'const a = 1;')).toBeUndefined();
  });
});

describe('scanFreeVariables（回归锁定）', () => {
  it('外围引用检出、自包含函数无告警', () => {
    expect(scanFreeVariables('(s) => s.slice(0, LIMIT)')).toContain('LIMIT');
    expect(scanFreeVariables("(s, n) => s.slice(0, n)")).toEqual([]);
  });
});