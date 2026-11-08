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
//   · 资源约束：maxWallMs/maxOutputBytes（墙钟唯一时间防线 + 输出体积；2026-09-23 compute 轴退役）；
//   · log 收集：程序内 log(...) 按序收集——无 return 值时合成返回值；
//   · 中止：主线程 abort 消息 → AbortController → 微任务边界检查。
// 全部工具执行都在主线程（ctx.tools.execute），本文件零 cordis 面。
// ============================================================
import { parentPort } from 'node:worker_threads';
// stripTypeScriptTypes：Node ≥22.13 原生（engines ≥22.18 满足）；@types/node
// 20 类型层缺失——运行时具名导入 + 类型侧声明合并补齐（strip-only 模式）。
import * as nodeModule from 'node:module';
import { PROTOCOL_VERSION } from './protocol.ts';
import type { MainToWorker, WorkerInvoke, WorkerToMain, RunSummary } from './protocol.ts';
import { normalizeSource, indexCodeHash, findBannedModuleSyntax, scanFreeVariables, snippetAt, HASH_HINT } from 'ac-run-code-core';

declare module 'node:module' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stripTypeScriptTypes(code: string, options?: { mode?: 'strip' | 'transform'; sourceMap?: boolean; sourceUrl?: boolean }): string;
}
const stripTypeScriptTypes: (code: string, options?: { mode?: 'strip' | 'transform' }) => string =
  (nodeModule as unknown as { stripTypeScriptTypes?: (code: string, options?: { mode?: 'strip' | 'transform' }) => string }).stripTypeScriptTypes
  ?? ((code: string) => code); // 兜底：极老 Node——透传（可擦除语法仍可执行，类型标注会被 new Function 视为注释失败——正常环境不会走到）

const port = parentPort;
if (port === null) throw new Error('run_code worker 必须以 worker_threads 启动');
// 注：stripTypeScriptTypes 的 ExperimentalWarning 消音不在本文件做——
// experimental 类警告无视 'warning' 监听器仍直写 stderr（实测），进程级
// 根治 = 主线程创建本 worker 时 execArgv 追加 --no-warnings（见 tool.ts）。

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
function serializeValue(value: unknown, maxBytes: number): { ok: true; text: string; truncated: boolean; note?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, text: 'undefined', truncated: false };
  let text: string;
  let note: string | undefined;
  try {
    text = JSON.stringify(value, null, 0);
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
    }, 0);
    // 注意：说明走独立 note 字段——text 必须保持纯 JSON（下游 JSON.parse 消费）
    note = 'return 值含不可序列化字段（循环引用/BigInt/函数等，已降级标注）——建议 return 纯数据对象';
  }
  const budgeted = enforceOutputBudget(text, maxBytes);
  return { ok: true, text: budgeted, truncated: budgeted !== text, ...(note !== undefined ? { note } : {}) };
}

/** UTF-8 字节偏移 → 字符索引（偏移落在多字节码点内部时左移到码点起始，不撕裂字符） */
function byteOffsetToIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const total = Buffer.byteLength(text, 'utf8');
  if (byteOffset >= total) return text.length;
  const buf = Buffer.from(text, 'utf8');
  let i = byteOffset;
  while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i--;
  return buf.slice(0, i).toString('utf8').length;
}

/** 输出预算执行：超限中段截断（保头 60% / 尾 20%），标注原始长度（return 值与 log 合成文本共用）。
 *  预算按字节判定，切割偏移同为字节——经 byteOffsetToIndex 换算成字符索引再 slice。
 *  实测复盘：旧实现把 head/tail 字节数直接当字符索引用，CJK 文本（3B/字符）实际
 *  保留 3x 预算字节——10000B 预算对两万汉字返回约 24000B，预算形同虚设；纯 ASCII
 *  下两口径等价，行为不变。 */
function enforceOutputBudget(text: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (maxBytes > 0 && totalBytes > maxBytes) {
    const headIdx = byteOffsetToIndex(text, Math.floor(maxBytes * 0.6));
    const tailIdx = byteOffsetToIndex(text, totalBytes - Math.floor(maxBytes * 0.2));
    return `${text.slice(0, headIdx)}…[输出超预算截断：原始 ${totalBytes} 字节 > ${maxBytes}]…${text.slice(tailIdx)}`;
  }
  return text;
}

async function main(): Promise<void> {
  // 先声明 ready（引导握手：主线程收到 online 即发 init——不互相等待，
  // 防死锁），init 到达后挂 invoke/result/abort 处理器
  const init = await new Promise<Extract<MainToWorker, { type: 'init' }>>((resolve) => {
    send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
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
      return (args: Record<string, unknown>) => invokeTool(prop, args);
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
  // 本程序内 define 成功的库名（P1：失败收束时宿主据此提示注册已丢弃）
  const definedInRun = new Set<string>();
  if (init.libSource !== undefined) {
    for (const [name, src] of Object.entries(init.libSource)) libRegistry.set(name, src);
  }
  /**
   * 类型擦除失败的修复提示（转义税治理——run-code-hardening-backlog 立项②）：
   * 头号失败形态 = 模板串跨行文本（内嵌反引号/未转义 ${ ——09-20 画像 §②
   * 占失败 2/3，11-19 三次实证升回该修项）。源码特征对上给针对性正解，
   * 否则只给不可擦除语法通用指引。
   */
  function hintSyntaxRecovery(code: string): string {
    const hints: string[] = [];
    if (code.includes('`')) {
      hints.push("模板串内嵌反引号须转义（`用 \\`pwsh\\` 执行`）或改用单/双引号串");
      hints.push("多行文本优先 ['行1', '行2'].join('\\n') 拼接，避免模板串跨行");
    }
    if (code.includes('$' + '{')) hints.push("模板串内 ${ 会按插值表达式解析——要输出字面 ${ 写 \\${");
    const hashAt = indexCodeHash(code);
    if (hashAt !== undefined) hints.push(`${HASH_HINT}（附近：${snippetAt(code, hashAt)}）`);
    const lead = hints.length > 0 ? `——常见嫌疑：${hints.join('；')}` : '';
    return `${lead}。enum/命名空间/参数属性不可擦除——改普通常量/对象/显式赋值`;
  }

  /** define 收到的 value 类型简述（错误信息用） */
  function describeLibValue(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `数组（${value.length} 项）`;
    if (typeof value === 'object') return '对象';
    return `${typeof value} "${String(value).slice(0, 40)}"`;
  }

  // 调用期发现引用悬空的坏条目（立项③-C：done.libRotted 带出——主线程从
  // 会话级注册表剔除，下 run 起不再注入）
  const libRottedNames = new Set<string>();

  /**
   * 函数形态库值的包裹层（立项③-B）：把裸 ReferenceError 改写为指向
   * define 闭包陷阱的可读错误，并记名（不管程序是否捕获异常，rot 事实
   * 已发生——done 统一带出）。仅函数形态包裹；同步函数保持同步（Promise
   * 结果挂 .catch 装饰，不改原函数的 sync/async 语义），length/name 透传。
   */
  function wrapCallable(name: string, value: unknown): unknown {
    if (typeof value !== 'function') return value;
    const rewrite = (err: unknown): unknown => {
      if (err instanceof ReferenceError) {
        libRottedNames.add(name);
        return new Error(
          `lib.${name} 调用报 ReferenceError（${err.message}）——该库注册时引用了外围变量（fn.toString() 只带走源码，不带闭包环境），跨程序调用必炸。` +
          `修复：外部值经参数进入或内联为常量后重新 define 同名覆盖；本条目已记入待剔除清单。`,
        );
      }
      return err;
    };
    const wrapper = function (...args: unknown[]): unknown {
      try {
        const out = (value as (...a: unknown[]) => unknown)(...args);
        if (out instanceof Promise) return out.catch((err: unknown) => { throw rewrite(err); });
        return out;
      } catch (err: unknown) {
        throw rewrite(err);
      }
    };
    try {
      Object.defineProperty(wrapper, 'name', { value: (value as { name?: string }).name ?? name, configurable: true });
      Object.defineProperty(wrapper, 'length', { value: (value as { length?: number }).length ?? 0, configurable: true });
    } catch { /* 透传失败不致命——包装语义优先 */ }
    return wrapper;
  }

  /** 库源码形态判定（函数形 vs 程序体）：求值分支与 resolve() 摘要单源 */
  function isFnFormSrc(src: string): boolean {
    return /^\s*(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(src);
  }

  /** 单条库源码 → 值（函数直接求值；程序体形态包裹后求值取 return） */
  function evalLibSource(name: string, src: string): unknown {
    checkAbort();
    const banned = findBannedModuleSyntax(src);
    if (banned !== undefined) {
      throw new Error(`lib.${name} 源码被拒：${banned.replace('程序体不允许', '库源码不允许')}`);
    }
    const isFnForm = isFnFormSrc(src);
    let js: string;
    try {
      // 函数形态：括号包裹后 strip（表达式语境化）。裸 strip 对匿名 function
      // 报 "Expected ident"（strip 只认语句位的函数声明——实测 9eaf3f03 复盘
      // ①：匿名 fn 串与 fn.toString() 带类型的函数直传均炸，具名/箭头侥幸过），
      // 包裹后匿名/具名/箭头/带类型一律成立；程序体形态：先包裹再 strip
      //（顶层 return 在 module 语境非法——与主程序同坑，见上方包裹注释）
      js = isFnForm
        ? stripTypeScriptTypes(`(${src})`, { mode: 'strip' })
        : stripTypeScriptTypes(`(function(){\n${src}\n})()`, { mode: 'strip' });
    } catch (err: unknown) {
      // 程序体形态含 await 是高頻误用（9eaf3f03 复盘：sync 包裹里 await 解析必炸）——给针对性正解
      const awaitHint = !isFnForm && /\bawait\b/.test(src)
        ? '——常见嫌疑：程序体形态按同步求值不能含 await，要调 tools 请改 async 函数形态（具名函数或箭头函数源码）'
        : '';
      throw new Error(`lib.${name} 类型擦除失败（限可擦除 TS 语法）：${err instanceof Error ? err.message : String(err)}${awaitHint}${hintSyntaxRecovery(src)}`);
    }
    try {
      if (isFnForm) {
        // 函数源码：直接 Function 求值（箭头函数同样成立）。返回值经
        // wrapCallable 包裹（立项③-B）：调用期 ReferenceError → 可读错误
        // （指向 define 闭包陷阱）+ 记入 libRotted（done 带出，主线程剔除）
        const make = new Function('tools', `"use strict"; return (${js});`) as (t: typeof tools) => unknown;
        return wrapCallable(name, make(tools));
      }
      // 程序体形态：包裹求值取 return（同步执行——库不应发起工具调用）
      const make = new Function('tools', `"use strict"; return ${js};`) as (t: typeof tools) => unknown;
      return make(tools);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const awaitHint = /await/.test(msg) ? '——await 仅 async 函数形态可用（具名/箭头函数源码须带 async）' : '';
      throw new Error(`lib.${name} 求值失败：${msg}${awaitHint}——库必须自包含（外部值经参数或内联常量进入）`);
    }
  }
  // 保留名（Proxy 不代理到注册表）：define/resolve 防被已注册库名遮蔽；
  // then/catch/finally 防被当 Promise 探测（await lib 误入注册表查询）。
  const LIB_RESERVED = new Set([
    'define', 'resolve', 'then', 'catch', 'finally',
    'toJSON', 'valueOf', 'toString', 'constructor',
  ]);
  const libMethods = {
    /**
     * 取用库：resolve('名') 返回求值本体（使用路径）；无参 = 清单（立项③-A，
     * 2026-09-21 裁决：未指定执行函数则不予任何执行）——纯静态摘要，不执行
     * 任何库源码（旧形态全量求值有两宗罪：查看行为带执行副作用；单条
     * 坏库炸整次列举）。逐条 try/catch 隔离，摘要失败给 error 占位不炸整表。
     */
    resolve: (name?: string): unknown => {
      if (name === undefined) {
        const all: Record<string, unknown> = {};
        for (const [n, src] of libRegistry.entries()) {
          try {
            all[n] = {
              kind: isFnFormSrc(src) ? 'function' : 'program',
              size: src.length,
              preview: src.length > 120 ? src.slice(0, 120) + '…' : src,
            };
          } catch {
            all[n] = { error: 'lib.' + n + ' 摘要生成失败' };
          }
        }
        return all;
      }
      const src = libRegistry.get(name);
      if (src === undefined) throw new Error('lib.' + name + ' 未注册（可用：' + ([...libRegistry.keys()].join('、') || '无') + '）');
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
      else
        throw new Error(
          `lib.define 第二参数须为函数或含 return 的程序体字符串（收到 ${describeLibValue(value)}）。` +
            (typeof value === 'object' && value !== null
              ? '对象/数组无法跨程序传递——注册读取/加工逻辑的函数（数据经参数进入、调用时现算），或把纯计算逻辑写成源码字符串；正确示例：lib.define("pick", "(obj, keys) => keys.map(k => obj[k]).join(\\" | \\")")'
              : typeof value === 'string'
                ? '空字符串不是有效源码——写函数源码或含 return 的程序体字符串'
                : '正确示例：lib.define("pick", "(obj, keys) => keys.map(k => obj[k]).join(\\" | \\")")'),
        );
      src = normalizeSource(src);
      const banned = findBannedModuleSyntax(src);
      if (banned !== undefined) {
        // define 失败 = 本程序收束 + 注册表不回写（tool.ts 失败回滚语义），后续 resolve 全部落空
        throw new Error(`lib.${name} 源码被拒：${banned.replace('程序体不允许', '库源码不允许')}——本程序将失败收束，本程序内 define 的库全部不生效；先修好源码再定义`);
      }
      // 试求值自检（定义期发现自由变量，而非使用期）
      evalLibSource(name, src);
      // 自由变量词法告警（2026-09-21 lib DX 增强：防呆不拒绝）。函数体内的
      // 外围引用试求值抓不到（只造函数不执行体）——词法扫描在 define 期露头：
      // 注册/resolve/同程序直调原函数都成功（闭包活着），唯独跨程序 resolve
      // 后调用炸 ReferenceError——「测试时好、复用时炸」的静默陷阱。
      let warning: string | undefined;
      const freeVars = scanFreeVariables(src);
      if (freeVars.length > 0) {
        warning =
          'lib.' + name + ' 引用了外围变量 ' + freeVars.join('、') +
          '——跨程序复用时这些变量不存在（fn.toString() 只带走源码，不带闭包环境），调用将报 ReferenceError。' +
          '修复：外部值经参数进入（第二参数写 (n, LIMIT) => … 把外围值收为参数）或内联为常量。';
      }
      // 容量闸：源码总量 64KB / 条目 32
      const prev = libRegistry.get(name);
      const total = [...libRegistry.entries()].reduce((n, [k, v]) => n + (k === name ? 0 : v.length), 0) + src.length;
      if (total > 64 * 1024) throw new Error(`lib 注册表超容量（总量 ${total}B > 64KB）——lib 存小型工具函数而非数据本体：请把「读取+加工」逻辑包成函数（数据经参数传入、调用时现算），或精简/复用已有库`);
      if (libRegistry.size >= 32 && prev === undefined) throw new Error('lib 条目数超限（32）');
      libRegistry.set(name, src);
      definedInRun.add(name);
      return { ok: true, registered: name, sizeBytes: src.length, ...(warning !== undefined ? { warning } : {}) };
    },
  };

  // 直调糖（lib DX 增强）：lib.已注册名 与 lib.resolve('名') 同通道同结果
  const lib = new Proxy(libMethods, {
    get(target, prop: string | symbol) {
      if (typeof prop === 'string' && !LIB_RESERVED.has(prop)) {
        const src = libRegistry.get(prop);
        if (src !== undefined) return evalLibSource(prop, src);
        if (prop !== 'inspect' && prop !== 'nodejs.util.inspect.custom') {
          throw new Error(
            'lib.' + prop + ' 未注册（可用：' + ([...libRegistry.keys()].join('、') || '无') +
            '）。注册：lib.define(\'' + prop + '\', fn)；取用：lib.resolve(\'' + prop + '\') 或直调 lib.' + prop + '(...)',
          );
        }
      }
      return Reflect.get(target, prop);
    },
  }) as typeof libMethods;

  // ── log：输出收集通道（复合返回协议）——与 return 通道同预算口径 ──
  // 程序内 log(...) 按序收集；return 有值 → valueVia='return'（return 优先）；
  // 无值有 log → 收集行合成 value（valueVia='logs'）；失败/中止 → 末 5 条随
  // done 作 logsTail（诊断线索）。条目上限 500——防循环刷 log 撑爆收集面
  // （超限丢弃计数，合成时标注）；单条体积与 return 同走 maxOutputBytes 头尾
  // 保留截断（cr-534：退役独立 2000 字符上限——两套口径是认知税）。
  const LOG_ENTRY_LIMIT = 500;
  const logs: string[] = [];
  let logsDropped = 0;
  const log = (...args: unknown[]): void => {
    if (logs.length >= LOG_ENTRY_LIMIT) {
      logsDropped++;
      return;
    }
    const line = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    logs.push(enforceOutputBudget(line, init.maxOutputBytes));
  };

  // 程序体：先包裹（async IIFE——顶层 return 合法化）再类型擦除。
  // 禁 import/require（静态 import 语法在 strip 后仍会触发模块语义——
  // 用源文本预检拒绝）。
  const raw = normalizeSource(init.code);
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
    send({ type: 'done', ok: false, error: `程序体类型擦除失败（限可擦除 TS 语法）：${err instanceof Error ? err.message : String(err)}${hintSyntaxRecovery(raw)}`, summary: finishSummary(summary, wallStart) });
    return;
  }

  let result: { ok: boolean; value?: unknown; valueVia?: 'return' | 'logs'; error?: string; interrupted?: boolean };
  try {
    // 闭包三参数：tools / lib / log（log = 输出收集通道，复合返回协议）
    const fn = new Function('tools', 'lib', 'log', `return ${js};`) as (t: typeof tools, l: typeof lib, g: typeof log) => Promise<unknown>;
    const value = await fn(tools, lib, log);
    checkAbort();
    if (value !== undefined && value !== null) {
      // return 有值（null 视为无值——走 log 回退）→ return 优先（复合协议上半）
      const ser = serializeValue(value, init.maxOutputBytes);
      if (!ser.ok) {
        result = { ok: false, error: ser.error };
      } else if (ser.truncated) {
        // 截断后的文本不再是合法 JSON（中段丢弃破坏结构位）——JSON.parse 往返
        // 必炸、成功程序被假判失败（2026-10-11 审计修复）：截断文本直接作字符串
        // value 带回（与 log 合成通道同形），截断标注随文本可见
        result = { ok: true, valueVia: 'return', value: ser.text };
      } else {
        result = { ok: true, valueVia: 'return', value: ser.note === undefined ? JSON.parse(ser.text) : { ...JSON.parse(ser.text), __serializeNote: ser.note } };
      }
    } else if (logs.length > 0) {
      // 无 return 值但有 log → 收集行按序合成 value（复合协议下半）
      const lines = [...logs, ...(logsDropped > 0 ? [`…[log 条目超限：丢弃 ${logsDropped} 条]`] : [])];
      result = { ok: true, valueVia: 'logs', value: enforceOutputBudget(lines.join('\n'), init.maxOutputBytes) };
    } else {
      // 无 return 无 log——ok 无值（旧协议兼容：步记录无 value 字段）
      result = { ok: true };
    }
  } catch (err: unknown) {
    // SyntaxError 且代码位残留 #（如 class 外 #x）——V8 报错无行号难定位，附提示
    let msg = err instanceof Error ? err.message : String(err);
    if (err instanceof SyntaxError) {
      const hashAt = indexCodeHash(raw);
      if (hashAt !== undefined) msg += `——${HASH_HINT}（附近：${snippetAt(raw, hashAt)}）`;
    }
    // 失败时程序已有 log → 尾行并进 error（模型读的是 error 字段——
    // logsTail 只进宿主轨迹不进 LLM 面，2026-10-09 复盘：崩溃现场恰恰
    // 最需要已收集的诊断线索）
    const tail = logs.length > 0 ? logs.slice(-3) : [];
    // 尾行并入同受总预算约束（cr-534）：单条放宽后 3 条尾行可达数倍预算——
    // error 回 LLM 面，合成后一次截断防撑爆
    const withTail = tail.length > 0 ? `${msg}\n〔程序内 log（末 ${tail.length} 条）〕\n${enforceOutputBudget(tail.join('\n'), init.maxOutputBytes)}` : msg;
    if (aborted || /程序已中止/.test(msg)) {
      result = { ok: false, interrupted: true, error: withTail };
    } else {
      result = { ok: false, error: withTail };
    }
  }
  // lib 注册表快照随 done 带出（主线程 run 间持有；空表省略——旧协议兼容）
  const libExports = libRegistry.size > 0 ? Object.fromEntries(libRegistry) : undefined;
  // 本程序 define 的库名（P1 失败提示数据源；失败收束也如实带出）
  const libDefined = definedInRun.size > 0 ? [...definedInRun] : undefined;
  // 调用期引用悬空的坏条目（立项③-C：主线程从会话级注册表剔除——剔除
  // 的是存量坏条目，与「失败 run 不回写」的回滚语义正交）
  const libRotted = libRottedNames.size > 0 ? [...libRottedNames] : undefined;
  // 失败/中止且程序已有 log → 末 5 条随行（诊断线索；成功路径不带）
  const logsTail = !result.ok && logs.length > 0 ? logs.slice(-5) : undefined;
  send({ type: 'done', ...result, summary: finishSummary(summary, wallStart), ...(libExports !== undefined ? { libExports } : {}), ...(libDefined !== undefined ? { libDefined } : {}), ...(libRotted !== undefined ? { libRotted } : {}), ...(logsTail !== undefined ? { logsTail } : {}) });
}

function finishSummary(summary: RunSummary, wallStart: number): RunSummary {
  summary.wallMs = Date.now() - wallStart;
  return summary;
}

main().catch((err: unknown) => {
  send({ type: 'done', ok: false, error: `worker 引导失败：${err instanceof Error ? err.message : String(err)}`, summary: { calls: 0, ok: 0, failed: 0, computeMs: 0, wallMs: 0, denied: [], serialized: [], trace: [] } });
});
