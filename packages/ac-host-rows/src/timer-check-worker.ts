// ============================================================
// ac-host-rows/src/timer-check-worker.ts —— 定时检测脚本 runner
//（cr-1147 脚本化重做：worker containment——检测逻辑下沉为可擦除 TS
//  判定脚本，本文件是它的执行体）
//
// 与 run_code worker 的关系：同款内核模式（strip-only 擦除 + new Function
// 求值 + 墙钟约束 + abort），但无 tools/lib/log 全家桶——定时脚本是纯
// 谓词，无工具调用面（M2 若开受限只读 API 再扩协议）。双入口形态与
// run_code 同构：dev 直跑本 .ts（Node 原生 strip-only，父进程 execArgv
// 继承）；bundle 形态补 dist 第二入口。
//
// 协议（结构化克隆，无函数面）：
//   main → worker：{ type:'init', code, args, utilsConfig } | { type:'abort' }
//   worker → main：{ type:'ready' } | { type:'done', ok, verdict?, error?, interrupted? }
// utilsConfig = { tz, holidays, makeupWorkdays }——worker 内经 makeTimerUtils
// 构造纯函数包注入脚本第二参（per-owner 配置随检测传，worker 无状态）。
// verdict 序列化失败按错误处理（脚本 return 了函数/Symbol——fail-loud）。
// ============================================================
import { parentPort } from 'node:worker_threads';
// stripTypeScriptTypes：Node ≥22.13 原生（engines ≥22.18 满足）；@types/node
// 20 类型层缺失——运行时具名导入 + 类型侧声明合并补齐（strip-only 模式，
// ac-run-code/src/worker.ts 同款先例）。
import * as nodeModule from 'node:module';
import { normalizeSource, findBannedModuleSyntax, scanFreeVariables, snippetAt, indexCodeHash, HASH_HINT } from 'ac-run-code-core';
import { makeTimerUtils, type TimerUtils } from 'ac-timer-core';

declare module 'node:module' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stripTypeScriptTypes(code: string, options?: { mode?: 'strip' | 'transform'; sourceMap?: boolean; sourceUrl?: boolean }): string;
}
const stripTypeScriptTypes: (code: string, options?: { mode?: 'strip' | 'transform' }) => string =
  (nodeModule as unknown as { stripTypeScriptTypes?: (code: string, options?: { mode?: 'strip' | 'transform' }) => string }).stripTypeScriptTypes
  ?? ((code: string) => code); // 兜底：极老 Node——透传（可擦除语法仍可执行）

const port = parentPort;
if (port === null) throw new Error('timer-check worker 必须以 worker_threads 启动');

function send(msg: unknown): void {
  port!.postMessage(msg);
}

/** 中止旗标（abort 消息置位；求值前的检查点） */
let aborted = false;
function checkAbort(): void {
  if (aborted) throw new Error('检测已中止');
}

function hintSyntaxRecovery(code: string): string {
  const hints: string[] = [];
  if (code.includes('`')) {
    hints.push("模板串内嵌反引号须转义（`用 \\`pwsh\\` 执行`）或改用单/双引号串");
    hints.push("多行文本优先 ['行1', '行2'].join('\\n') 拼接，避免模板串跨行");
  }
  if (code.includes('$' + '{')) hints.push("模板串内 ${ 会按插值表达式解析——要输出字面 ${ 写 \\${");
  const hashAt = indexCodeHash(code);
  if (hashAt !== undefined) hints.push(`${HASH_HINT}（附近：${snippetAt(code, hashAt)}）`);
  return hints.length > 0 ? `——常见嫌疑：${hints.join('；')}` : '';
}


async function evalCheck(code: string, args: unknown, utils: TimerUtils): Promise<unknown> {
  checkAbort();
  const src = normalizeSource(code);
  const banned = findBannedModuleSyntax(src);
  if (banned !== undefined) throw new Error('判定脚本被拒：' + banned.replace('程序体不允许', '脚本不允许'));
  let js: string;
  try {
    js = stripTypeScriptTypes('(' + src + ')', { mode: 'strip' });
  } catch (err: unknown) {
    throw new Error('检测脚本类型擦除失败（限可擦除 TS 语法）：' + (err instanceof Error ? err.message : String(err)) + hintSyntaxRecovery(src));
  }
  // 双参注入（a=args 快照，u=utils 纯函数包）——与 run_code 的 tools/lib 双参同构
  const make = new Function('a', 'u', '"use strict"; return (' + js + ');') as (a: unknown, u: unknown) => unknown;
  const fn = make(undefined, utils);
  if (typeof fn !== 'function') throw new Error('判定脚本求值结果不是函数（code 须为双参 (a, u) => { … }）');
  const out = await (fn as (a: unknown, u: TimerUtils) => unknown)(args, utils);
  checkAbort();
  return out;
}

async function main(): Promise<void> {
  send({ type: 'ready' });
  port!.on('message', (m: { type: string; code?: string; args?: unknown; utilsConfig?: { tz?: string; holidays?: string[]; makeupWorkdays?: string[] }; reason?: string }) => {
    if (m.type === 'abort') {
      aborted = true;
      return;
    }
    if (m.type !== 'init') return;
    const code = typeof m.code === 'string' ? m.code : '';
    const utils = makeTimerUtils(m.utilsConfig ?? {});
    void (async () => {
      try {
        const verdict = await evalCheck(code, m.args, utils);
        if (verdict !== undefined && verdict !== null && (typeof verdict === 'function' || typeof verdict === 'symbol')) {
          send({ type: 'done', ok: false, error: 'verdict 须为纯数据对象（action/next/state/active）——不能是函数或 Symbol' });
          return;
        }
        send({ type: 'done', ok: true, verdict });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const free = (() => { try { return scanFreeVariables(code); } catch { return [] as string[]; } })();
        send({ type: 'done', ok: false, error: msg + (aborted ? '（已中止）' : '') + (free.length > 0 ? '——脚本引用了外围变量 ' + free.join('、') + '（须自包含）' : '') });
      }
    })();
  });
}

main().catch((err: unknown) => {
  send({ type: 'done', ok: false, error: 'worker 引导失败：' + (err instanceof Error ? err.message : String(err)) });
});
