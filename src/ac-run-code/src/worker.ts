// ============================================================
// ac-run-code/src/worker.ts —— worker 宿主（双入口形态，见计划 §五.2）
//
// dev：new Worker(new URL('./worker.ts', import.meta.url)) 直跑 TS
//      （Node 原生 strip-only，父进程 execArgv 继承）；
// bundle：build-bundle.mjs 第二入口产出 dist/worker.mjs。
// 两种形态加载的都是本文件（真模块：可 typecheck/可单测）。
//
// 职责边界（containment 非 boundary）：
//   · eval 程序体（可擦除 TS 先经 stripTypeScriptTypes 擦除）；
//   · tools proxy：属性访问 → postMessage invoke → 等 result；
//   · 资源约束：computeMs/maxWallMs/maxOutputBytes（超限即中止）；
//   · 中止：主线程 abort 消息 → AbortController → 微任务边界检查。
// 全部工具执行都在主线程（ctx.tools.execute），本文件零 cordis 面。
// ============================================================
import { parentPort } from 'node:worker_threads';
// stripTypeScriptTypes：Node ≥22.13 原生（engines ≥22.18 满足）；@types/node
// 20 类型层缺失——运行时具名导入 + 类型侧声明合并补齐（strip-only 模式）。
import * as nodeModule from 'node:module';
import type { MainToWorker, WorkerInvoke, WorkerToMain, RunSummary } from './protocol.ts';

declare module 'node:module' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stripTypeScriptTypes(code: string, options?: { mode?: 'strip' | 'transform'; sourceMap?: boolean; sourceUrl?: boolean }): string;
}
const stripTypeScriptTypes: (code: string, options?: { mode?: 'strip' | 'transform' }) => string =
  (nodeModule as unknown as { stripTypeScriptTypes?: (code: string, options?: { mode?: 'strip' | 'transform' }) => string }).stripTypeScriptTypes
  ?? ((code: string) => code); // 兜底：极老 Node——透传（可擦除语法仍可执行，类型标注会被 new Function 视为注释失败——正常环境不会走到）

const port = parentPort;
if (port === null) throw new Error('run_code worker 必须以 worker_threads 启动');

let aborted = false;
let abortReason = '';

function send(msg: WorkerToMain): void {
  port!.postMessage(msg);
}

/** 中止检查点（每条 postMessage 边界调用——轻量、无 timer 泄漏） */
function checkAbort(): void {
  if (aborted) throw new Error(`程序已中止：${abortReason}`);
}

/**
 * 判定返回值可序列化并序列化（结构化克隆口）。
 * 降级链（实测复盘 0d55714a-W1：return 大 grep 结果时 stringify 抛错被包装成
 * 程序级失败——子调用全部成功却因出口序列化丢弃全部结果，模型还误读为
 * 「结果太大」改写规避）：
 *   ① 原生 JSON.stringify（快路径——绝大多数程序 return 普通数据）
 *   ② 抛错 → 降级 replacer：循环引用 / BigInt / function / symbol 值替换为
 *      占位标注（"[Circular]"/"[BigInt 123n]"/"[Function]"/"[Symbol]"），
 *      保住可序列化主体；返回值标注「含不可序列化字段（已降级标注）」
 *      ——程序不失败，模型看得见哪些字段出了问题。
 */
function serializeValue(value: unknown, maxBytes: number): { ok: true; text: string; note?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, text: 'undefined' };
  let text: string;
  let note: string | undefined;
  try {
    text = JSON.stringify(value, null, 0) ?? 'null';
  } catch {
    // 降级序列化：占位替换不可序列化值
    const seen = new WeakSet<object>();
    text = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'bigint') return `[BigInt ${v}n]`;
      if (typeof v === 'function') return `[Function${v.name ? ` ${v.name}` : ''}]`;
      if (typeof v === 'symbol') return `[Symbol ${String(v)}]`;
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }, 0) ?? 'null';
    // 注意：说明走独立 note 字段——text 必须保持纯 JSON（下游 JSON.parse 消费）
    note = 'return 值含不可序列化字段（循环引用/BigInt/函数等，已降级标注）——建议 return 纯数据对象';
  }
  if (maxBytes > 0 && Buffer.byteLength(text, 'utf8') > maxBytes) {
    // 中段截断（保头尾），标注原始长度
    const head = Math.floor(maxBytes * 0.6);
    const tail = Math.floor(maxBytes * 0.2);
    text = `${text.slice(0, head)}…[输出超预算截断：原始 ${Buffer.byteLength(text, 'utf8')} 字节 > ${maxBytes}]…${text.slice(-tail)}`;
  }
  return { ok: true, text, ...(note !== undefined ? { note } : {}) };
}

async function main(): Promise<void> {
  // 先声明 ready（引导握手：主线程收到 online 即发 init——不互相等待，
  // 防死锁），init 到达后挂 invoke/result/abort 处理器
  const init = await new Promise<Extract<MainToWorker, { type: 'init' }>>((resolve) => {
    send({ type: 'ready' });
    const onInit = (m: MainToWorker) => {
      if (m.type === 'init') {
        port!.off('message', onInit);
        resolve(m);
      }
    };
    port!.on('message', onInit);
  });
  port!.on('message', (m: MainToWorker) => {
    if (m.type === 'abort') {
      aborted = true;
      abortReason = m.reason;
    }
  });

  const wallStart = Date.now();
  // 主线程为摘要权威（trace/denied 在桥接层收集）；worker 侧骨架只填墙钟
  const summary: RunSummary = { calls: 0, ok: 0, failed: 0, computeMs: 0, wallMs: 0, denied: [], serialized: [], trace: [] };
  const pending = new Map<number, { resolve: (r: { ok: boolean; output?: unknown; error?: string }) => void }>();
  let seq = 0;

  port!.on('message', (m: MainToWorker) => {
    if (m.type === 'result') {
      const entry = pending.get(m.seq);
      if (entry) {
        pending.delete(m.seq);
        entry.resolve({ ok: m.ok, ...(m.output !== undefined ? { output: m.output } : {}), ...(m.error ? { error: m.error } : {}) });
      }
    }
  });

  /** tools proxy 成员：发 invoke 等结果（附中止检查） */
  function invokeTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: unknown; error?: string }> {
    checkAbort();
    const mySeq = ++seq;
    summary.calls++;
    if (summary.calls > 200) throw new Error('子调用数超限（200）——run_code 程序应编排成批操作，不是逐条循环刷调用');
    const p = new Promise<{ ok: boolean; output?: unknown; error?: string }>((resolve) => {
      pending.set(mySeq, { resolve });
    });
    const msg: WorkerInvoke = { type: 'invoke', seq: mySeq, name, args };
    send(msg);
    return p;
  }

  const tools = new Proxy({} as Record<string, (args: Record<string, unknown>) => Promise<{ ok: boolean; output?: unknown; error?: string }>>, {
    get(_t, prop: string | symbol) {
      if (typeof prop !== 'string') throw new Error(`tools 只接受字符串方法名（收到 ${String(prop)}）`);
      if (prop === 'run_code') throw new Error('递归防护：run_code 程序内不能再调用 run_code（投影已排除）');
      checkAbort();
      return (args: Record<string, unknown>) => invokeTool(prop, args ?? {});
    },
  });

  // ── lib：会话级临时库（2026-09-17 扩展）──
  // 生命周期：主线程在 run 间持源码注册表（同 agent+conversation 命名空间），
  // init 注入 / done 快照带出；worker 侧每次前置求值成对象，经闭包第二参数
  // 传入程序体：(async (tools, lib) => { … })(tools, lib)。
  // 安全：① 源码过同款 findBannedModuleSyntax（防借道注入 eval 拼装）；
  // ② define 试求值自检（自由变量在干净作用域即 ReferenceError——报「必须
  // 自包含」）；③ 求值闭包只有 tools/lib（无 require/import 面）；④ 注册表
  // 容量上限（源码总量 64KB + 条目 32——防注册表无限膨胀）。
  const libRegistry = new Map<string, string>();
  if (init.libSource !== undefined) {
    for (const [name, src] of Object.entries(init.libSource)) libRegistry.set(name, src);
  }
  /** 单条库源码 → 值（函数直接求值；程序体形态包裹后求值取 return） */
  function evalLibSource(name: string, src: string): unknown {
    checkAbort();
    const banned = findBannedModuleSyntax(src);
    if (banned !== undefined) {
      throw new Error(`lib.${name} 源码被拒：${banned.replace('程序体不允许', '库源码不允许')}`);
    }
    const isFnForm = /^\s*(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(src);
    let js: string;
    try {
      // 函数形态：裸源码 strip（类型标注在参数/返回位）；程序体形态：先包裹
      // 再 strip（顶层 return 在 module 语境非法——与主程序同坑，见上方包裹注释）
      js = isFnForm
        ? stripTypeScriptTypes(src, { mode: 'strip' })
        : stripTypeScriptTypes(`(function(){\n${src}\n})()`, { mode: 'strip' });
    } catch (err: unknown) {
      throw new Error(`lib.${name} 类型擦除失败（限可擦除 TS 语法）：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if (isFnForm) {
        // 函数源码：直接 Function 求值（箭头函数同样成立）
        const make = new Function('tools', `"use strict"; return (${js});`) as (t: typeof tools) => unknown;
        return make(tools);
      }
      // 程序体形态：包裹求值取 return（同步执行——库不应发起工具调用）
      const make = new Function('tools', `"use strict"; return ${js};`) as (t: typeof tools) => unknown;
      return make(tools);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`lib.${name} 求值失败：${msg}——库必须自包含（外部值经参数或内联常量进入）`);
    }
  }
  const lib = {
    /** 查看当前可用的库（名 → 已求值对象）——无参调用返回全部 */
    resolve: (name?: string): unknown => {
      if (name === undefined) {
        const all: Record<string, unknown> = {};
        for (const n of libRegistry.keys()) all[n] = evalLibSource(n, libRegistry.get(n)!);
        return all;
      }
      const src = libRegistry.get(name);
      if (src === undefined) throw new Error(`lib.${name} 未注册（可用：${[...libRegistry.keys()].join('、') || '无'}）`);
      return evalLibSource(name, src);
    },
    /**
     * 注册临时库。value 为函数时取源码（fn.toString()，TS 标注原样保留）；
     * 为程序体字符串时直接存。注册即试求值自检：自由变量在干净作用域会
     * ReferenceError——库函数必须自包含（外部值经参数或内联常量进入）。
     */
    define: (name: string, value: unknown): { ok: boolean; registered: string; sizeBytes: number } => {
      checkAbort();
      if (typeof name !== 'string' || !/^[\w-$]{1,64}$/.test(name)) {
        throw new Error(`lib 名必须为 1-64 位标识符（收到 ${String(name)}）`);
      }
      let src: string;
      if (typeof value === 'function') src = value.toString();
      else if (typeof value === 'string' && value.trim() !== '') src = value;
      else throw new Error('lib.define 第二参数须为函数或含 return 的程序体字符串');
      const banned = findBannedModuleSyntax(src);
      if (banned !== undefined) {
        throw new Error(`lib.${name} 源码被拒：${banned.replace('程序体不允许', '库源码不允许')}`);
      }
      // 试求值自检（定义期发现自由变量，而非使用期）
      evalLibSource(name, src);
      // 容量闸：源码总量 64KB / 条目 32
      const prev = libRegistry.get(name);
      const total = [...libRegistry.entries()].reduce((n, [k, v]) => n + (k === name ? 0 : v.length), 0) + src.length;
      if (total > 64 * 1024) throw new Error(`lib 注册表超容量（总量 ${total}B > 64KB）——请精简或复用已有库`);
      if (libRegistry.size >= 32 && prev === undefined) throw new Error('lib 条目数超限（32）');
      libRegistry.set(name, src);
      return { ok: true, registered: name, sizeBytes: src.length };
    },
  };

  // 程序体：先包裹（async IIFE——顶层 return 合法化）再类型擦除。
  // 禁 import/require（静态 import 语法在 strip 后仍会触发模块语义——
  // 用源文本预检拒绝）。
  const raw = init.code;
  const banned = findBannedModuleSyntax(raw);
  if (banned !== undefined) {
    send({ type: 'done', ok: false, error: banned, summary: finishSummary(summary, wallStart) });
    return;
  }
  let js: string;
  try {
    // 包裹后擦除：raw 内的类型标注在函数体内被正常 strip（顶层 return
    // 在 module 语境非法——先包裹即合法）
    js = stripTypeScriptTypes(`(async () => {\n${raw}\n})()`, { mode: 'strip' });
  } catch (err: unknown) {
    send({ type: 'done', ok: false, error: `程序体类型擦除失败（限可擦除 TS 语法）：${err instanceof Error ? err.message : String(err)}`, summary: finishSummary(summary, wallStart) });
    return;
  }

  let result: { ok: boolean; value?: unknown; error?: string; interrupted?: boolean };
  try {
    const fn = new Function('tools', 'lib', `return ${js};`) as (t: typeof tools, l: typeof lib) => Promise<unknown>;
    const value = await fn(tools, lib);
    checkAbort();
    const ser = serializeValue(value, init.maxOutputBytes);
    // 降级说明并入 value（字段名 __serializeNote——模型可见但不破坏数据主体）
    result = ser.ok
      ? { ok: true, value: ser.note === undefined ? JSON.parse(ser.text) : { ...JSON.parse(ser.text), __serializeNote: ser.note } }
      : { ok: false, error: ser.error };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (aborted || /程序已中止/.test(msg)) {
      result = { ok: false, interrupted: true, error: msg };
    } else {
      result = { ok: false, error: msg };
    }
  }
  // lib 注册表快照随 done 带出（主线程 run 间持有；空表省略——旧协议兼容）
  const libExports = libRegistry.size > 0 ? Object.fromEntries(libRegistry) : undefined;
  send({ type: 'done', ...result, summary: finishSummary(summary, wallStart), ...(libExports !== undefined ? { libExports } : {}) });
}

function finishSummary(summary: RunSummary, wallStart: number): RunSummary {
  summary.wallMs = Date.now() - wallStart;
  return summary;
}

/**
 * import/require 预检（实测复盘 4cd1a90d：旧正则 /\b(?:import|require)\s*\(?
 * 连字符串字面量与注释一起杀——模型把 node -e 命令文本写进 pwsh 参数、
 * 注释里提到 require 一词均被拒，四连败后被迫放弃验证路径）。
 *
 * 判定收窄到真模块语义：
 *   ① 静态 import——行首（含缩进）import …（from 'x' / 'x' / type）；
 *   ② 动态 require 调用——require('x' | "x") 字面量参数形态；
 *   ③ 动态 import 调用——同上。
 * 字符串/模板字面量/注释中出现的词不再命中（排除法：剥掉再测）。
 * 恶意拼装（eval('req'+'uire')…）本就不防——containment 边界在工具桥，
 * 预检是防呆不是安全边界（worker 头注释口径）。
 */
function findBannedModuleSyntax(code: string): string | undefined {
  // 剥除注释与字符串/模板字面量后再匹配——只测「代码」
  let stripped = '';
  const rejectedAt = (kind: string, index: number): string =>
    `程序体不允许 ${kind}（工具调用经 tools.* 桥接）——命中位置：${snippetAt(code, index)}`;
  for (let i = 0; i < code.length; ) {
    const rest = code.slice(i);
    // 行注释 / 块注释
    if (rest.startsWith('//')) {
      const nl = code.indexOf('\n', i);
      const end = nl === -1 ? code.length : nl;
      stripped += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = code.indexOf('*/', i + 2);
      const end = close === -1 ? code.length : close + 2;
      stripped += ' '.repeat(end - i);
      i = end;
      continue;
    }
    // 字符串 / 模板字面量（保守：不解析模板内插值——${…} 里的代码
    // 一并跳过；插值中写 require('x') 属拼装规避，不在防呆面内）。
    // 掩蔽保留首尾引号、只抹内容（等长）：调用检测正则要看到
    // require('…') 的引号才能命中——全抹成空格会让 require('node:fs')
    // 漏检（实测：动态 import('node:fs') 曾因此在 worker 里真跑通）
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === quote) { j += 1; break; }
        j += 1;
      }
      const closed = j - i >= 2 && code[j - 1] === quote;
      stripped += quote + ' '.repeat(Math.max(0, j - i - (closed ? 2 : 1))) + (closed ? quote : '');
      i = j;
      continue;
    }
    stripped += code[i];
    i += 1;
  }
  // ① 静态 import：行首 import（模块语法在函数体内非法，但 strip 前
  // 源文本可判；strip 后模块语义会导致 new Function 编译错，预检给出
  // 更友好的报错）
  const importRe = /^[ \t]*import[\s{*'"]/m;
  const importMatch = importRe.exec(stripped);
  if (importMatch) {
    return rejectedAt('import 语法', importMatch.index);
  }
  // ② require('x') / ③ import('x')——带字面量参数的调用形态
  const callRe = /\b(?:require|import)\s*\(\s*['"]/g;
  const callMatch = callRe.exec(stripped);
  if (callMatch) {
    return rejectedAt(callMatch[0].startsWith('require') ? 'require() 调用' : 'import() 调用', callMatch.index);
  }
  return undefined;
}

/** 命中位置前后各 ~30 字符的源文本预览（错误信息可定位） */
function snippetAt(code: string, index: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(code.length, index + 40);
  return `…${code.slice(start, end).replace(/\s+/g, ' ')}…`;
}

main().catch((err: unknown) => {
  send({ type: 'done', ok: false, error: `worker 引导失败：${err instanceof Error ? err.message : String(err)}`, summary: { calls: 0, ok: 0, failed: 0, computeMs: 0, wallMs: 0, denied: [], serialized: [], trace: [] } });
});
