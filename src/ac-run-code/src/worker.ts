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
  return { ok: true, text: enforceOutputBudget(text, maxBytes), ...(note !== undefined ? { note } : {}) };
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
     * 2026-12 裁决：未指定执行函数则不予任何执行）——纯静态摘要，不执行
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
      const banned = findBannedModuleSyntax(src);
      if (banned !== undefined) {
        // define 失败 = 本程序收束 + 注册表不回写（tool.ts 失败回滚语义），后续 resolve 全部落空
        throw new Error(`lib.${name} 源码被拒：${banned.replace('程序体不允许', '库源码不允许')}——本程序将失败收束，本程序内 define 的库全部不生效；先修好源码再定义`);
      }
      // 试求值自检（定义期发现自由变量，而非使用期）
      evalLibSource(name, src);
      // 自由变量词法告警（2026-11-19 lib DX 增强：防呆不拒绝）。函数体内的
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

  // ── log：输出收集通道（复合返回协议）──
  // 程序内 log(...) 按序收集；return 有值 → valueVia='return'（return 优先）；
  // 无值有 log → 收集行合成 value（valueVia='logs'）；失败/中止 → 末 5 条随
  // done 作 logsTail（诊断线索）。条目上限 500 / 单条截 2000 字符——防循环
  // 刷 log 撑爆收集面（超限丢弃计数，合成时标注）。
  const LOG_ENTRY_LIMIT = 500;
  const LOG_CHAR_LIMIT = 2_000;
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
          return JSON.stringify(a) ?? String(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    logs.push(line.length > LOG_CHAR_LIMIT ? `${line.slice(0, LOG_CHAR_LIMIT)}…[log 条目截断：原始 ${line.length} 字符]` : line);
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
      // 降级说明并入 value（字段名 __serializeNote——模型可见但不破坏数据主体）
      result = ser.ok
        ? { ok: true, valueVia: 'return', value: ser.note === undefined ? JSON.parse(ser.text) : { ...JSON.parse(ser.text), __serializeNote: ser.note } }
        : { ok: false, error: ser.error };
    } else if (logs.length > 0) {
      // 无 return 值但有 log → 收集行按序合成 value（复合协议下半）
      const lines = [...logs, ...(logsDropped > 0 ? [`…[log 条目超限：丢弃 ${logsDropped} 条]`] : [])];
      result = { ok: true, valueVia: 'logs', value: enforceOutputBudget(lines.join('\n'), init.maxOutputBytes) };
    } else {
      // 无 return 无 log——ok 无值（旧协议兼容：步记录无 value 字段）
      result = { ok: true };
    }
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

// ── 自由变量扫描（lib.define 防呆告警，非安全边界）──

/** 词法白名单：JS/Node 常用全局 + 保留字——都不算自由变量 */
const LEXER_GLOBALS = new Set([
  // JS 内置
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Date',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'RegExp', 'BigInt', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'structuredClone', 'console', 'globalThis', 'Infinity', 'NaN', 'undefined',
  // Node 运行时（worker 内在场）
  'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  // 闭包内置参数（库内可调工具）
  'tools', 'lib', 'log', 'arguments', 'this',
]);
const LEXER_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'try', 'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of',
  'delete', 'void', 'await', 'yield', 'async', 'function', 'class', 'const', 'let', 'var',
  'extends', 'super', 'import', 'export', 'true', 'false', 'null', 'as', 'satisfies',
  'keyof', 'readonly', 'type', 'interface', 'enum', 'namespace', 'declare',
]);

/**
 * 词法级自由变量扫描（近似——告警用，非精确作用域分析）。
 *
 * 动机（2026-11-19 追记 Ⓐ 延伸实测）：lib.define('trap', (s) => s.slice(0, LIMIT))
 * 注册成功（试求值只造函数不执行体）、resolve 成功（返回可调用函数）、同程序直调
 * 原函数也成功（闭包活着）——唯独跨程序 resolve 后调用炸 ReferenceError。
 * 「测试时好、复用时炸」的完美静默陷阱，define 期就该露头。
 *
 * 近似策略（漏报可接受、误报尽量压）：剥字符串/模板/注释 → 收集声明名
 * （const/let/var/function/class）+ 参数名（所有「(...) =>」与「function (...)」
 * 的括号段标识符，含默认值/解构成员——误入参数集是漏报方向）→ 收集剩余裸
 * 标识符引用（跳过属性访问 .x / ?.x 与对象字面量 key x:）→ 差集即自由变量。
 */
function scanFreeVariables(src: string): string[] {
  // 1. 剥离字符串/模板/注释内容（等长空格——保留结构，与 findBannedModuleSyntax 同思路）
  let stripped = '';
  for (let i = 0; i < src.length; ) {
    const rest = src.slice(i);
    if (rest.startsWith('//')) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      stripped += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      stripped += ' '.repeat(end - i);
      i = end;
      continue;
    }
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j += 1; break; }
        j += 1;
      }
      stripped += ' '.repeat(j - i);
      i = j;
      continue;
    }
    stripped += src[i];
    i += 1;
  }
  // 2. 声明名 + 参数名收集（近似并集）
  const bound = new Set<string>();
  for (const m of stripped.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]!);
  // 参数列表：(...) => 与 function (...)（[^()] 不含嵌套，内层括号自成参数段）
  for (const m of stripped.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(p[0]);
  }
  for (const m of stripped.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(p[0]);
  }
  // 单参无括号箭头：x => ...
  for (const m of stripped.matchAll(/(^|[^\w$.])\s*([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[2]!);
  // catch (e)
  for (const m of stripped.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) bound.add(m[1]!);
  // 3. 引用收集：跳过属性访问（.x / ?.x）与对象字面量 key（x:）
  const free = new Set<string>();
  const identRe = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(stripped)) !== null) {
    const name = m[0];
    const before = stripped.slice(Math.max(0, m.index - 2), m.index);
    const after = stripped.slice(m.index + name.length).match(/^\s*:/);
    if (/[.?]$/.test(before) && before !== ' ?.') continue; // .x / ?.x（无空格形态）
    if (/\.\s*$/.test(before) || /\?\.$/.test(before)) continue;
    if (after) continue; // 对象字面量 key（漏报方向：三元分支中段也误跳——可容忍）
    if (LEXER_KEYWORDS.has(name) || LEXER_GLOBALS.has(name) || bound.has(name)) continue;
    free.add(name);
  }
  return [...free].slice(0, 5);
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
