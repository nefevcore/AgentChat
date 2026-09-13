// ============================================================
// ac-bench/src/eval.ts —— 调用对拍纯函数（零 cordis 依赖，可独立单测）
//
// BFCL AST 评测的工程化子集：
//   · parseCallString —— `func(a=1, b='x')` Python 风格调用串 → 规格
//     （v1 answer 形态；v3 结构化 ground_truth 不经此路径）；
//   · compareCalls —— 期望集 vs 实际集的多重集对拍（回溯匹配同名
//     多调用场景；平行类目次序不敏感是 BFCL 语义）。
// ============================================================
import type { BenchActualCall, BenchCallSpec } from './contract.ts';

// ---- Python 风格字面量解析（递归下降） ----

interface Cursor {
  text: string;
  pos: number;
}

function skipWs(c: Cursor): void {
  while (c.pos < c.text.length && /\s/.test(c.text[c.pos])) c.pos++;
}

/** 解析一个值：字符串/数字/布尔/None/列表/字典；失败返回 undefined（不抛） */
function parseValue(c: Cursor): unknown {
  skipWs(c);
  const ch = c.text[c.pos];
  if (ch === undefined) return undefined;
  // 字符串（单/双引号，支持反斜杠转义）
  if (ch === "'" || ch === '"') {
    const quote = ch;
    c.pos++;
    let out = '';
    while (c.pos < c.text.length) {
      const k = c.text[c.pos];
      if (k === '\\') {
        const next = c.text[c.pos + 1];
        if (next === undefined) return undefined;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        c.pos += 2;
        continue;
      }
      if (k === quote) {
        c.pos++;
        return out;
      }
      out += k;
      c.pos++;
    }
    return undefined; // 未闭合
  }
  // 列表
  if (ch === '[') {
    c.pos++;
    const items: unknown[] = [];
    skipWs(c);
    if (c.text[c.pos] === ']') {
      c.pos++;
      return items;
    }
    for (;;) {
      const v = parseValue(c);
      if (v === undefined) return undefined;
      items.push(v);
      skipWs(c);
      if (c.text[c.pos] === ',') {
        c.pos++;
        continue;
      }
      if (c.text[c.pos] === ']') {
        c.pos++;
        return items;
      }
      return undefined;
    }
  }
  // 字典
  if (ch === '{') {
    c.pos++;
    const obj: Record<string, unknown> = {};
    skipWs(c);
    if (c.text[c.pos] === '}') {
      c.pos++;
      return obj;
    }
    for (;;) {
      skipWs(c);
      // 键：字符串或裸标识符
      let key: string | undefined;
      if (c.text[c.pos] === "'" || c.text[c.pos] === '"') {
        const v = parseValue(c);
        if (typeof v !== 'string') return undefined;
        key = v;
      } else {
        const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(c.text.slice(c.pos));
        if (!m) return undefined;
        key = m[0];
        c.pos += m[0].length;
      }
      skipWs(c);
      if (c.text[c.pos] !== ':') return undefined;
      c.pos++;
      const v = parseValue(c);
      if (v === undefined) return undefined;
      obj[key] = v;
      skipWs(c);
      if (c.text[c.pos] === ',') {
        c.pos++;
        continue;
      }
      if (c.text[c.pos] === '}') {
        c.pos++;
        return obj;
      }
      return undefined;
    }
  }
  // 数字（含负数/小数/指数）
  const numMatch = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(c.text.slice(c.pos));
  if (numMatch && numMatch[0].length > 0) {
    c.pos += numMatch[0].length;
    const raw = numMatch[0];
    return raw.includes('.') || /[eE]/.test(raw) ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
  }
  // 布尔 / None
  const word = /^[A-Za-z_]+/.exec(c.text.slice(c.pos));
  if (word) {
    const w = word[0];
    if (w === 'True') {
      c.pos += 4;
      return true;
    }
    if (w === 'False') {
      c.pos += 5;
      return false;
    }
    if (w === 'None') {
      c.pos += 4;
      return null;
    }
  }
  return undefined;
}

/**
 * 解析 `func(a=1, b='x')` 风格调用串 → BenchCallSpec。
 * 容错：裸函数名（无括号）→ 无参规格；参数值解析失败 → 该值以原文串占位
 * （不吞用例——对拍按字符串回退比较）。
 */
export function parseCallString(input: string): BenchCallSpec | null {
  const text = input.trim();
  if (!text) return null;
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(text);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  let pos = name.length;
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  if (pos >= text.length || text[pos] !== '(') return { name }; // 裸名 = 无参
  const c: Cursor = { text, pos: pos + 1 };
  const argsSpec: Record<string, unknown[]> = {};
  skipWs(c);
  if (c.text[c.pos] === ')') return { name, argsSpec };
  for (;;) {
    skipWs(c);
    const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(c.text.slice(c.pos));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    c.pos += key.length;
    skipWs(c);
    if (c.text[c.pos] !== '=') return null;
    c.pos++;
    const valueStart = c.pos;
    const value = parseValue(c);
    if (value === undefined) {
      // 容错回退：吃掉到下一个顶层逗号/右括号的原文作字符串值
      let depth = 0;
      let end = c.pos;
      for (; end < c.text.length; end++) {
        const k = c.text[end];
        if (k === '[' || k === '{' || k === '(') depth++;
        if (k === ']' || k === '}' || k === ')') {
          if (depth === 0) break;
          depth--;
        }
        if (k === ',' && depth === 0) break;
      }
      argsSpec[key] = [text.slice(valueStart, end).trim()];
      c.pos = end;
    } else {
      argsSpec[key] = [value];
    }
    skipWs(c);
    if (c.text[c.pos] === ',') {
      c.pos++;
      continue;
    }
    if (c.text[c.pos] === ')') return { name, argsSpec };
    return null;
  }
}

/** 宽松相等：数字↔数字串互认、布尔↔'true'/'false'、null↔undefined、串首尾空白忽略 */
export function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'string') {
    const n = Number.parseFloat(b);
    return Number.isFinite(n) && n === a;
  }
  if (typeof b === 'number' && typeof a === 'string') {
    const n = Number.parseFloat(a);
    return Number.isFinite(n) && n === b;
  }
  if (typeof a === 'boolean' && typeof b === 'string') return String(a) === b.trim().toLowerCase();
  if (typeof b === 'boolean' && typeof a === 'string') return String(b) === a.trim().toLowerCase();
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  // 数组/对象递归（BFCL 列表参数）
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => looseEq(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => looseEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** 默认形状值：可选参省略时的可接受缺省（BFCL optional-param 语义——答案侧 ["",0] 即默认值编码） */
function isDefaultValueish(value: unknown): boolean {
  return value === '' || value === 0 || value === false || value === null;
}

/**
 * 单调用对拍：名相同 + 参数集是规格键的子集（多余键失配）+ 每个在场参数
 * 取到可接受值 + 缺省参数仅在可接受列表含默认形状值（""/0/false/null）
 * 时放行（模型省略可选参 = 取默认，2026-09-11 真实跑批 simple_2/8/12
 * 误判根因；列表无默认形状值的缺省仍是失配——必填参不能丢）。
 */
export function callMatches(actual: BenchActualCall, spec: BenchCallSpec): boolean {
  if (actual.name !== spec.name) return false;
  const argsSpec = spec.argsSpec ?? {};
  const specKeys = Object.keys(argsSpec);
  if (specKeys.length === 0) return Object.keys(actual.args).length === 0;
  for (const key of Object.keys(actual.args)) {
    if (!(key in argsSpec)) return false; // 幻觉参数
  }
  return specKeys.every((key) => {
    const acceptable = argsSpec[key] ?? [];
    if (!(key in actual.args)) {
      return acceptable.some(isDefaultValueish); // 省略 = 默认值
    }
    return acceptable.some((v) => looseEq(actual.args[key], v));
  });
}

export interface CallVerdict {
  pass: boolean;
  reason?: string;
}

/**
 * 调用集对拍（多重集；同名多调用回溯匹配）。
 *   · expected 空 = 反例用例：实际非空即败；
 *   · 次序不敏感（parallel 语义），数量与内容都必须对上。
 */
export function compareCalls(expected: BenchCallSpec[], actual: BenchActualCall[]): CallVerdict {
  if (expected.length === 0) {
    return actual.length === 0
      ? { pass: true }
      : { pass: false, reason: `反例用例但调用了工具：${formatCalls(actual)}` };
  }
  if (actual.length === 0) {
    return { pass: false, reason: `未调用任何工具，期望 ${formatSpecs(expected)}` };
  }
  if (actual.length !== expected.length) {
    return {
      pass: false,
      reason: `调用数不符：期望 ${expected.length} 个（${formatSpecs(expected)}），实际 ${actual.length} 个（${formatCalls(actual)}）`,
    };
  }
  // 回溯二部图匹配（期望规格 ≤ 实际调用一一配对）
  const used = new Array<boolean>(actual.length).fill(false);
  const matchOf = (ei: number): boolean => {
    if (ei === expected.length) return true;
    for (let ai = 0; ai < actual.length; ai++) {
      if (used[ai]) continue;
      if (!callMatches(actual[ai], expected[ei])) continue;
      used[ai] = true;
      if (matchOf(ei + 1)) return true;
      used[ai] = false;
    }
    return false;
  };
  if (matchOf(0)) return { pass: true };
  // 定位失配明细（诊断与判定同口径 some()：2026-09-11 simple_370 误报根因——
  // 旧诊断只对比每键首个可接受值，把实际通过的键报成失配）
  const details = expected.map((spec, i) => {
    const act = actual[i];
    if (!act) return `${spec.name} 缺失`;
    if (act.name !== spec.name) return `第 ${i + 1} 个调用名不符：期望 ${spec.name}，实际 ${act.name}`;
    const argsSpec = spec.argsSpec ?? {};
    const problems: string[] = [];
    for (const key of Object.keys(act.args)) {
      if (!(key in argsSpec)) problems.push(`多余参数 ${key}=${JSON.stringify(act.args[key])}`);
    }
    for (const [key, acceptable] of Object.entries(argsSpec)) {
      if (!(key in act.args)) {
        if (!acceptable.some(isDefaultValueish)) {
          problems.push(`${spec.name}.${key} 缺失（期望 ${JSON.stringify(acceptable)}）`);
        }
      } else if (!acceptable.some((v) => looseEq(act.args[key], v))) {
        problems.push(`${spec.name}.${key} 不符：期望 ${JSON.stringify(acceptable)}，实际 ${JSON.stringify(act.args[key])}`);
      }
    }
    if (problems.length > 0) return problems.join('；');
    return `${spec.name} 组合失配（单键均可接受但多重集无完全匹配）`;
  });
  return { pass: false, reason: details.join('；') };
}

function formatSpecs(specs: BenchCallSpec[]): string {
  return specs
    .map((s) => `${s.name}(${Object.entries(s.argsSpec ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v[0])}`).join(', ')})`)
    .join(' ');
}

function formatCalls(calls: BenchActualCall[]): string {
  return calls.map((c) => `${c.name}(${Object.entries(c.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`).join(' ');
}
