// ============================================================
// ac-run-code/src/tool.ts —— run_code 工具体（主线程侧）
//
// 链路：resolveEffectiveTools（与 router 工具可见面合成同链）→
// buildSdkProjection → worker（双入口引导，计划 §五.2）→ 桥接执行
// （子调用一律 ctx.tools.execute——能力轴/档位/黑名单/扫描/脱敏/
// 事件面全自动生效）→ 摘要步记录（裁决 #1：程序体全文不回上下文）。
//
// 预算冻结（2026-02 ask 挂起重构后，子调用挂起源主要是 approval；ask_questions 已即返）：本 run 子调用挂起 durable-interaction（
// approval——均以 correlationId=子调用 toolCallId 落盘）期间，墙钟看门狗
// 暂停、子调用计费剔除冻结区间——预算约束机器时间，人的应答时间不是
// 机器时间（「审批等待不计 compute」口径的执行化）。
//
// worker 引导（实验结论 2026-09-17）：
//   dev   = new URL('./worker.ts', import.meta.url)（TS 直跑）
//   bundle= 同目录 worker.mjs（build-bundle 第二入口产物）
//   回退  = 两处都不存在 → 报可诊断错误（eval 自举留异常部署）
// ============================================================
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const requireShim = createRequire(import.meta.url);
import type { Context } from '@agentchat/cordis';
import type { ToolCall, ToolDefinition, ToolResult } from 'ac-tools';
import type { AgentConfig } from 'ac-agents';
import { formDeniedBy, resolveToolNames, toolAllowedFor } from 'ac-agents';
import { buildSdkProjection } from 'ac-run-code-core';
import { PROTOCOL_VERSION } from './protocol.ts';
import type { MainToWorker, WorkerDone, WorkerToMain, RunSummary, SubcallTrace } from './protocol.ts';

/**
 * 子调用并发分类词表（写路径 ∪ 命令类按提交序串行）。
 * 单源优先：ac-security 的 WRITE_PATH_TOOLS/COMMAND_TOOLS（安全域事实源，
 * 与路径复检/命令扫描同一份名单）；ac-security 缺席（独立发布形态——
 * run_code 不强绑宿主安全行）时回落内置等值名单 + 启动告警。两份名单的
 * 一致性由 ac-run-code 测试锁定（词表单源断言）。
 */
const FALLBACK_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
const FALLBACK_COMMAND_TOOLS = new Set(['pwsh', 'bash']);
function serialWordlists(): { write: Set<string>; command: Set<string> } {
  try {
    // 动态 require 形态的静态可达 import——esbuild 正常打包；缺席时
    // try/catch 兜底（独立性：不把 ac-security 声明为硬依赖）
    const security = require('ac-security') as {
      WRITE_PATH_TOOLS: Set<string>;
      COMMAND_TOOLS: Set<string>;
    };
    if (security.WRITE_PATH_TOOLS instanceof Set && security.COMMAND_TOOLS instanceof Set) {
      return { write: security.WRITE_PATH_TOOLS, command: security.COMMAND_TOOLS };
    }
  } catch { /* ac-security 未装配——回落内置 */ }
  return { write: FALLBACK_WRITE_TOOLS, command: FALLBACK_COMMAND_TOOLS };
}
const SERIAL_LISTS = serialWordlists();

/** 预算缺省（行 config 可覆盖）。墙钟是唯一时间防线（宿主侧单源——不进参数表，Agent 不可见/不可改） */
export interface RunCodeRowOptions {
  defaultMaxWallMs?: number;
  defaultMaxOutputBytes?: number;
}

/**
 * 墙钟缺省 720s（2026-09-23 收敛定标）：8145 条实战记录自然完成 MAX≈4min
 * （240s），3x≈12min 取整。覆盖长命令等待与正当编排；durable 挂起（人的
 * 应答）冻结豁免不受影响。
 * 输出预算缺省 32KB（实测复盘 a7828839：编辑工作流需经 return 回传待改
 * 文件全文——12.8KB 常态贴近 16KB 旧上限，中大型文件会中段截断；模型已
 * 自适应 offset/limit 分段读，预算再紧会切断「读全文→编辑」正当路径）。
 */
const DEFAULTS = { maxWallMs: 720_000, maxOutputBytes: 32 * 1024 };

/** trace 上限（超出截断计 traceTruncated——卡片列表可视上限，防长循环程序撑爆步记录） */
const TRACE_LIMIT = 50;

/**
 * 会话级 lib 注册表（lib 扩展，2026-09-17）：key = `${agentId ?? '~'}|${conversationId ?? '~'}`，
 * value = Map<库名, 源码>。跨 run_code 调用共享（worker 即用即弃，主线程是
 * 持有方）；会话维度的生命周期 = 注册表随会话演进累积，容量闸在 worker define
 * 侧（64KB/32 条）。不设显式清理——量级由容量闸封顶，进程重启自然清空。
 */
const libStores = new Map<string, Map<string, string>>();
function libStoreOf(agentId: string | undefined, conversationId: string | undefined): Map<string, string> {
  const key = `${agentId ?? '~'}|${conversationId ?? '~'}`;
  let store = libStores.get(key);
  if (store === undefined) {
    store = new Map();
    libStores.set(key, store);
  }
  return store;
}

/**
 * 子调用一句话简述（卡片「工具调用」行文案）：关键参数优先，回落
 * 结果摘要字段（count/total/result 等标量），截 80。与前端 toolLabel
 * 的 argDetail 同族但独立实现——桥接层不可 import 前端包。
 */
function subcallBrief(name: string, args: Record<string, unknown>, result: ToolResult | undefined): string {
  const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const str = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
  // 参数面：工具语义主参数（与 toolLabel.ts argDetail 的词表对齐）
  const argPick = (): string => {
    switch (name) {
      case 'read': case 'write': case 'edit':
        return str(args.file_path ?? args.filePath ?? args.path);
      case 'glob': return str(args.pattern);
      case 'grep': return str(args.pattern).slice(0, 40);
      case 'pwsh': case 'bash': return str(args.description) || str(args.command).slice(0, 60);
      case 'web_search': return str(args.query).slice(0, 50) || str(args.description);
      case 'math': return str(args.expression).slice(0, 50);
      case 'subagent': return str(args.action) || 'spawn';
      default: {
        // 通用：第一个字符串型参数（大多数工具的主参数形态）
        for (const v of Object.values(args)) {
          const s = str(v);
          if (s) return clip(s, 60);
        }
        return '';
      }
    }
  };
  const a = argPick();
  // 结果面：标量摘要字段（存在才拼）
  const out = result?.output;
  const resultPick = (): string => {
    if (out === null || out === undefined || typeof out !== 'object') {
      return typeof out === 'string' ? clip(out, 30) : '';
    }
    const o = out as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['count', 'total', 'total_lines', 'result', 'ok_count', 'lines']) {
      const v = o[k];
      if (typeof v === 'number' || typeof v === 'string') parts.push(`${k}=${String(v)}`);
      if (parts.length >= 2) break;
    }
    return parts.join(' ');
  };
  const r = resultPick();
  if (a && r) return clip(`${a} · ${r}`);
  return clip(a || r || '');
}

/**
 * 生效工具集解析（与 router RouterService.execute 的可见面合成同链——
 * 能力面 → resolveToolNames → 形态面终滤；计划 §二同源纪律）。
 * router 私有逻辑不 import（三条红线），此处按同一单源函数复算；
 * tag 展开告警接 logger.warn（对齐 router 文案口径）。
 *
 * 口径（2026-09-17 互斥形态改版）：
 *   · scope='llm'——LLM 可见面：能力面 → include/exclude → 形态面。
 *     互斥形态（AgentConfig.tools = ['run_code']）下其余工具被 include
 *     收出 LLM 面，但仍在能力面内（tags 授权未变）。
 *   · scope='projection'——投影源：**能力面直取**（跳过 include/exclude
 *     收窄——互斥形态的投影要涵盖全部已授权工具，否则程序里除了
 *     run_code 什么都调不了）。include/exclude 的语义边界收窄为
 *     「LLM 直调面」；投影面 = tags 即工具面的授权真理。安全无碍：
 *     子调用执行照走 ctx.tools.execute 全门禁（能力轴逐调用复检），
 *     投影声明宽 = fail-safe（声明了但无权执行会被拒），不越权。
 * 两口径都过形态面终滤（single 裁剪与 router 同口径——坑 #10）。
 */
export function resolveEffectiveTools(
  ctx: Context,
  agentId: string | undefined,
  conversationId: string | undefined,
  scope: 'llm' | 'projection' = 'llm',
): ToolDefinition[] {
  // agents 为可选能力（ctx.get 非 strict）；capabilitySetOf 需 agents 面
  // ——本工具行 inject 只声明 tools，按受限调用方纪律手工合成能力集
  const agents = ctx.get('agents', false) as { get(id: string): AgentConfig | undefined } | undefined;
  const agent = agentId === undefined ? undefined : agents?.get(agentId);
  const caps = new Set<string>(['base']);
  if (agentId !== undefined) {
    caps.add(`agent:${agentId}`);
    for (const t of agent?.tags ?? []) caps.add(t);
  }
  const visible = ctx.tools.list().filter((t) => t.injection !== 'mode' && toolAllowedFor(t, caps));
  if (scope === 'projection') {
    // 投影源：能力面全量（授权真理）——不经 include/exclude 收窄，
    // mode 工具（run_code 等）排除（递归防护在投影层：程序内再造程序
    // 无意义且套计费）；requiresInteraction 工具随交互面终滤
    return visible.filter((d) => !formDenied(ctx, d, conversationId));
  }
  const resolved = resolveToolNames(
    agent?.tools,
    visible,
    (tag) => {
      ctx.logger.warn(`[run_code] tools 引用 'tag:${tag}' 展开为空（标签不存在或无工具声明它），相关条目已静默落空——Agent ${agentId ?? '无身份'}`);
    },
    (name) => {
      ctx.logger.warn(`[run_code] tools 点名 '${name}' 不在当前可见工具面（不存在/不可见/已改名），该条目落空——Agent ${agentId ?? '无身份'}`);
    },
  ) ?? visible.map((t) => t.name);
  return resolved
    .map((name) => ctx.tools.get(name))
    .filter((d): d is ToolDefinition => d !== undefined && !formDenied(ctx, d, conversationId));
}

/**
 * 形态面（single/self）判定：formDeniedBy 单源（ac-agents——router
 * formAllowed 同口径，坑 #10）。含自会话（a~a）：run_code 程序内子调用
 * 的可见面与 router 信封一致。
 */
function formDenied(ctx: Context, def: ToolDefinition, conversationId: string | undefined): boolean {
  return formDeniedBy(ctx, def, conversationId);
}

/**
 * ── worker 引导快照缓存（立项①防退化护栏）──
 *
 * 回退目标不依赖发布 bundle（dev 检出形态不存在）——改为「上次成功引导
 * 的 worker 源码快照」：每次 run 顺利收到 done（= worker 机制完整存活的
 * 证据），把 spawn 时读到的 dev worker.ts 源码经 stripTypeScriptTypes 擦除
 * 后缓存。双层：进程内存（本会话最新鲜）+ tmpdir 磁盘（跨重启；hash-gated
 * 写入，内容未变不重复写盘）。dev 会话里 run_code 高频使用，事故场景
 * （会话中途改坏 worker.ts）进程内早有成功引导记录——快照几乎总是新鲜。
 *
 * 时效性闸 = 协议版本：快照文件名含 PROTOCOL_VERSION，ready 握手互认——
 * 版本错配即拒用该快照并告警（宁可重试坏 dev 也让错误可见）。
 */
/** 进程内最新快照（擦除后 JS 源码；null = 本进程尚无成功引导） */
let lastGoodWorkerJs: string | null = null;

/** worker 候选入口点（单点收敛——测试钩子可覆写以模拟部署形态：
 * dev 检出（worker.ts 在场）/ bundle（仅 worker.mjs）/ 残缺形态） */
let workerDevEntryFn: () => string = () => stripQuery_(new URL('./worker.ts', import.meta.url));
let workerBundleEntryFn: () => string = () => stripQuery_(new URL('./worker.mjs', import.meta.url));
function workerDevEntry(): string { return workerDevEntryFn(); }
function workerBundleEntry(): string { return workerBundleEntryFn(); }

/** 快照磁盘目录（tmpdir 下按进程用户隔离——OS 周期清理可接受：重启后丢
 * 快照 = 回到「无护栏」基线，不劣于现状） */
function workerSnapshotDir(): string {
  return joinPath(tmpdir(), 'agentchat-run-code-worker-cache');
}

/** entry 绝对路径 → 稳定短名（快照文件名；含协议版本——版本闸的一半） */
function workerSnapshotFile(entry: string): string {
  const h = createHash('sha256').update(entry).digest('hex').slice(0, 16);
  return joinPath(workerSnapshotDir(), `v${PROTOCOL_VERSION}-${h}.mjs`);
}

/** 极简 path.join（免 node:path 依赖形态——本文件既有 import 面窄） */
function joinPath(a: string, b: string): string {
  const aEnds = a.endsWith('/') || a.endsWith('\\');
  return aEnds ? a + b : a + '/' + b;
}

/**
 * 成功引导后刷新快照（strip 校验 + 长度上限——防把坏源码/篡改内容写进
 * 缓存）。hash-gated：读盘比较，内容未变不重复写（省 tmpdir 写放大）。
 */
function refreshWorkerSnapshot(devEntry: string, source: string): void {
  let js: string;
  try {
    js = stripWorkerTypes(source);
  } catch {
    return; // 擦除失败不缓存（此时 worker 明明跑成了——文件刚被改；保守跳过）
  }
  lastGoodWorkerJs = js;
  const file = workerSnapshotFile(devEntry);
  try {
    mkdirSync(workerSnapshotDir(), { recursive: true });
    try {
      if (readFileSync(file, 'utf8') === js) return; // 内容未变——不重写
    } catch { /* 无既有文件 */ }
    writeFileSync(file, js, 'utf8');
  } catch {
    // tmpdir 不可写等——内存快照仍有效（本进程内回退不受影响）
  }
}

/**
 * 主线程侧 strip（快照缓存用——与 worker 侧同 API 同 mode）。主线程无
 * worker 环境的 @types/node 缺声明问题：any 一次性桥接。
 */
function stripWorkerTypes(source: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (requireShim('node:module') as any);
  return m.stripTypeScriptTypes(source, { mode: 'strip' }) as string;
}

/** 读磁盘快照（无/坏/版本不符 → undefined） */
function readWorkerSnapshot(devEntry: string): string | undefined {
  try {
    return readFileSync(workerSnapshotFile(devEntry), 'utf8');
  } catch {
    return undefined;
  }
}

/** URL → 本地路径（剥 ?v= 查询后缀——vitest/transformer 下 import.meta.url 可能带） */
function stripQuery_(u: URL): string {
  return fileURLToPath(new URL(u.pathname, 'file://'));
}

/** 工具体入口（ac-run-code/src/index.ts 注册进 ctx.tools） */
export async function executeRunCode(
  ctx: Context,
  options: RunCodeRowOptions,
  args: Record<string, unknown>,
  call: ToolCall,
): Promise<ToolResult> {
  const code = typeof args.code === 'string' ? args.code : '';
  if (!code.trim()) return { ok: false, error: '缺少 code 参数（可擦除 TS 程序体）' };
  const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fb);
  // 墙钟唯一化（2026-09-23 收敛）：compute 预算全套退役；墙钟为唯一防线
  // ——宿主侧单源，不进参数表（Agent 不可见/不可改）。定标依据见 DEFAULTS。
  const maxWallMs = options.defaultMaxWallMs ?? DEFAULTS.maxWallMs;
  const maxOutputBytes = num(args.max_output_bytes, options.defaultMaxOutputBytes ?? DEFAULTS.maxOutputBytes);

  // 投影说明：模型可见面是 loop/before-run 注入的 system 块（见
  // prompt.ts——每次 run 同源现算）；工具体内不算投影（发送即丢弃
  // 的形态已在 2026-09-17 实测复盘修正）。

  const runId = call.toolCallId ?? `run-${Date.now().toString(36)}`;
  // lib 注入：会话级注册表快照（非空才注入——省协议体积）
  const libStore = libStoreOf(call.agentId, call.conversationId);
  const libSource = libStore.size > 0 ? Object.fromEntries(libStore) : undefined;
  // execArgv = 父进程继承集 ∪ --no-warnings：消音 stripTypeScriptTypes 的
  // ExperimentalWarning（experimental 类警告无视 'warning' 监听器仍直写
  // stderr——实测；进程级 flag 是唯一干净路径。worker 是受控执行体，
  // 顺带静默其一切运行时警告可接受）。
  const execArgv = process.execArgv.includes('--no-warnings')
    ? process.execArgv
    : [...process.execArgv, '--no-warnings'];

  // —— worker 引导链（立项①防退化护栏）——
  // 候选序：dev worker.ts → 内存快照 → 磁盘快照。快速路径：spawn 前对 dev
  // 源码试擦除，语法坏直接跳过 dev 候选（省一次 spawn 周期；strip 通过仍
  // 可能运行期坏——握手检测兜底）。失败传递：候选在 ready 之前 error /
  // 非零 exit / exit(0) / 握手超时 → terminate 换下一候选；全部失败 →
  // 可诊断错误（指明恢复动作）。检测边界：仅 workerReady=false 阶段判死——
  // 程序自身错误不触发降级（dev 行为不被护栏遮蔽）。
  const devEntry = workerDevEntry();
  const devExists = existsSync(devEntry);
  let devSource: string | undefined;
  if (devExists) {
    try {
      devSource = readFileSync(devEntry, 'utf8');
    } catch { /* 读失败（权限/竞态）——当坏态处理，走快照 */ }
  }
  let devSyntacticallyOk = false;
  if (devSource !== undefined) {
    try {
      stripWorkerTypes(devSource);
      devSyntacticallyOk = true;
    } catch { /* strip 失败 = 语法坏——跳过 dev 候选 */ }
  }
  const memSnapshot = lastGoodWorkerJs;
  const diskSnapshot = devEntry !== '' ? readWorkerSnapshot(devEntry) : undefined;
  // 握手超时（毫秒）：正常 worker 引导 <1s；10s 覆盖慢盘/冷启动且远小于
  // maxWallMs 缺省（超时只是换候选，不占程序预算——boot 阶段 wallStart
  // 尚未起算，语义干净）。
  const BOOT_HANDSHAKE_MS = 10_000;
  /** spawn 单候选并握手探测：ready（版本匹配）→ 成功；error/exit/超时/版本错配 → fail */
  const bootCandidate = (kind: string, entryPath: string): Promise<{ worker: Worker } | { fail: string }> =>
    new Promise((resolveBoot) => {
      let settled = false;
      const finish = (r: { worker: Worker } | { fail: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', onReady);
        worker.off('error', onErr);
        worker.off('exit', onExit);
        resolveBoot(r);
      };
      let worker: Worker;
      try {
        worker = new Worker(entryPath, { execArgv });
      } catch (err: unknown) {
        resolveBoot({ fail: `候选 ${kind} 构造失败：${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      if (typeof worker.unref === 'function') worker.unref();
      const timer = setTimeout(() => {
        void worker.terminate();
        finish({ fail: `候选 ${kind} 引导握手超时（${BOOT_HANDSHAKE_MS}ms 无 ready）` });
      }, BOOT_HANDSHAKE_MS);
      if (typeof timer.unref === 'function') timer.unref();
      const onReady = (m: unknown): void => {
        if (typeof m === 'object' && m !== null && (m as { type?: string }).type === 'ready') {
          const v = (m as { protocolVersion?: number }).protocolVersion ?? 1;
          if (v !== PROTOCOL_VERSION) {
            void worker.terminate();
            finish({ fail: `候选 ${kind} 协议版本错配（ready v${v} ≠ 当前 v${PROTOCOL_VERSION}）——快照过期，拒用` });
            return;
          }
          finish({ worker });
          return;
        }
      };
      const onErr = (err: Error): void => {
        finish({ fail: `候选 ${kind} 引导错误：${err.message}` });
      };
      const onExit = (c: number): void => {
        finish({ fail: `候选 ${kind} 引导期退出（code=${c}）` });
      };
      worker.on('message', onReady);
      worker.on('error', onErr);
      worker.on('exit', onExit);
    });
  /** 内存快照落盘到临时文件再 spawn（ESM 静态 import 需真文件路径） */
  const spawnMemSnapshot = (js: string): Promise<{ worker: Worker } | { fail: string }> => {
    const file = joinPath(workerSnapshotDir(), `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.mjs`);
    try {
      mkdirSync(workerSnapshotDir(), { recursive: true });
      writeFileSync(file, js, 'utf8');
    } catch (err: unknown) {
      return Promise.resolve({ fail: `内存快照落盘失败：${err instanceof Error ? err.message : String(err)}` });
    }
    return bootCandidate('snapshot:mem', file);
  };
  const attempts: Array<{ kind: string; start: () => Promise<{ worker: Worker; bootedFrom: string } | { fail: string }> }> = [];
  if (devExists && devSyntacticallyOk) {
    attempts.push({
      kind: 'dev',
      start: () => bootCandidate('dev', devEntry).then((r) => ('worker' in r ? { worker: r.worker, bootedFrom: 'dev' } : r)),
    });
  } else if (devExists) {
    ctx.logger.warn(`[run_code] dev worker.ts 语法预检失败（strip 不通过）——跳过 dev 候选直接走快照回退。恢复：修好 ${devEntry} 后重试`);
  }
  // bundle 候选（发布形态正源：dist/worker.mjs 与 agentchat.mjs 同目录——
  // build-bundle 第二入口产物。1391f7a1 多候选链重写时误删，2026-09-22
  // 线上 0.8.11 实测回归：bundle 形态首次运行无快照 → attempts 空 →
  // 「部署形态不完整」假报错。候选序语义：bundle 是产物非源码，dev 在场
  // 时优先（真源码可改），bundle 次之，快照垫底。)
  const bundleEntry = workerBundleEntry();
  if (existsSync(bundleEntry)) {
    attempts.push({
      kind: 'bundle',
      start: () => bootCandidate('bundle', bundleEntry).then((r) => ('worker' in r ? { worker: r.worker, bootedFrom: 'bundle' } : r)),
    });
  }
  if (memSnapshot !== null) {
    attempts.push({
      kind: 'snapshot:mem',
      start: () => spawnMemSnapshot(memSnapshot).then((r) => ('worker' in r ? { worker: r.worker, bootedFrom: 'mem-snapshot' } : r)),
    });
  }
  if (diskSnapshot !== undefined) {
    const file = workerSnapshotFile(devEntry);
    attempts.push({
      kind: 'snapshot:disk',
      start: () => bootCandidate('snapshot:disk', file).then((r) => ('worker' in r ? { worker: r.worker, bootedFrom: file } : r)),
    });
  }
  if (attempts.length === 0) {
    return {
      ok: false,
      error: 'run_code worker 引导文件缺失（dev ./worker.ts 或 bundle ./worker.mjs 均不存在，且无引导快照）——部署形态不完整',
    };
  }
  let boot: { worker: Worker; bootedFrom: string } | undefined;
  let bootError: string | undefined;
  let bootDegradedNotice: string | undefined;
  for (const attempt of attempts) {
    const outcome = await attempt.start();
    if ('fail' in outcome) {
      bootError = outcome.fail;
      ctx.logger.warn(`[run_code] worker 引导候选 ${attempt.kind} 失败：${outcome.fail}`);
      continue;
    }
    boot = outcome;
    // 降级路径（快照候选中选）→ 结果告警透出（验收形态：工具面不停摆 + 模型可见降级事实）；
    // bundle 中选是发布形态正常路径（无 dev 源码可降），不告警
    if (outcome.bootedFrom !== 'dev' && outcome.bootedFrom !== 'bundle') {
      bootDegradedNotice = `dev worker 引导失败（${bootError ?? '未知错误'}），已降级至${outcome.bootedFrom === 'mem-snapshot' ? '进程内' : '磁盘'}快照回退——快照可能落后当前 worker.ts（协议版本 v${PROTOCOL_VERSION}）；修复 dev 文件后自动恢复`;
    }
    break;
  }
  if (boot === undefined) {
    const recovery = devExists
      ? `恢复：检查/修复 ${devEntry}（git checkout 该文件或手动修复语法）后重试`
      : '恢复：确认部署形态（dev 检出应有 src/ac-run-code/src/worker.ts；bundle 应有 worker.mjs）';
    return { ok: false, error: `worker 引导失败（候选耗尽：${attempts.map((a) => a.kind).join(' → ')}）——${bootError ?? '未知错误'}。${recovery}` };
  }
  const worker = boot.worker;
  if (typeof worker.unref === 'function') worker.unref();
  // 中止控制器（compute 预算 / 墙钟看门狗 / 用户 signal 共用——一处
  // abort 全链生效：子调用 signal + worker abort 消息）。run 级先行创建：
  // 修复旧惰性 bug——旧代码 invoke 时刻 abortCtl 未创建时子调用拿到
  // undefined signal，在飞等待型工具（如 approval 挂起）永远收不到中止，
  // 弹窗悬空 pending（write-ahead 兜底也只剩 late-reply 一条路）。
  const abortCtl = new AbortController();
  const wallStart = Date.now();
  let workerReady = false;

  // —— 预算冻结（软依赖 durableInteraction；缺席 = 行为同旧版）——
  // 冻结区间（毫秒墙钟）：本 run 挂起 durable 交互的等待期（2026-02 ask 挂起
  // 重构后主要源 = approval；ask_questions 已即返）。区间内墙钟不计
  // maxWallMs（看门狗暂停）、不进子调用计费。区间由 opened/replied/closed
  // 三事件对账（圈定键 = correlationId 前缀 runId#——桥接层拼子调用
  // toolCallId 的既有约定，挂起工具的 open 均按它落盘）。
  // 2026-09-23 收敛：冻结唯一豁免源 = 人（durable）。等待他方 Agent
  //（send_agent wait 等）不再冻结——墙钟 720s 直罩（被杀不丢数据：迟到
  // 回复经薄通知注入回投，见 collab-tools）；compute 轴整体退役。
  const pauseSpans: Array<{ from: number; to: number }> = [];
  let pauseFrom = 0;
  const frozen = (): boolean => pauseFrom !== 0;
  const enterFreeze = (): void => {
    if (pauseFrom !== 0) return;
    pauseFrom = Date.now();
    if (wallTimer !== undefined) {
      clearTimeout(wallTimer);
      wallTimer = undefined;
    }
  };
  const exitFreeze = (): void => {
    if (pauseFrom === 0) return;
    pauseSpans.push({ from: pauseFrom, to: Date.now() });
    pauseFrom = 0;
    armWallTimer();
  };
  const pausedBetween = (from: number, to: number): number => {
    let sum = 0;
    for (const s of pauseSpans) sum += Math.max(0, Math.min(s.to, to) - Math.max(s.from, from));
    if (pauseFrom !== 0) sum += Math.max(0, to - Math.max(pauseFrom, from));
    return sum;
  };
  const wallElapsedNow = (): number => Date.now() - wallStart - pausedBetween(wallStart, Date.now());
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  /** 墙钟预算耗尽（超时回调 + 解冻补算共用出口） */
  const wallExhausted = (): void => {
    abortCtl.abort();
    worker.postMessage({ type: 'abort', reason: `墙钟预算耗尽（maxWallMs=${maxWallMs}ms）` } satisfies MainToWorker);
    setTimeout(() => void worker.terminate(), 5_000).unref();
  };
  /** 挂看门狗（剩余 = 预算 - 机器墙钟；冻结中不挂，解冻时重挂） */
  const armWallTimer = (): void => {
    if (wallTimer !== undefined) {
      clearTimeout(wallTimer);
      wallTimer = undefined;
    }
    if (maxWallMs <= 0 || frozen()) return;
    const remain = maxWallMs - wallElapsedNow();
    if (remain <= 0) {
      wallExhausted();
      return;
    }
    wallTimer = setTimeout(() => {
      wallTimer = undefined;
      if (frozen() || !workerReady) return; // 竞态：冻结已发生由解冻重挂；worker 未就绪由 error/exit 兜底
      wallExhausted();
    }, remain);
    if (typeof wallTimer.unref === 'function') wallTimer.unref();
  };
  // 订阅对账：opened 增冻结 / 全部终态解冻（refresh 幂等——事件只是触发重查）
  const disposeFreeze: Array<() => void> = [];
  const di = ctx.get('durableInteraction', false) as
    | { listOpen(): Array<{ correlationId?: string }> }
    | undefined;
  if (di !== undefined) {
    const prefix = `${runId}#`;
    const ours = (rec: { correlationId?: string }): boolean =>
      typeof rec.correlationId === 'string' && rec.correlationId.startsWith(prefix);
    const refresh = (): void => {
      if (di.listOpen().some(ours)) enterFreeze();
      else exitFreeze();
    };
    for (const evt of ['durable-interaction/opened', 'durable-interaction/replied', 'durable-interaction/closed'] as const) {
      disposeFreeze.push(
        (ctx.on as unknown as (name: string, listener: () => void, options?: { description?: string }) => () => void)(
          evt,
          refresh,
          { description: 'run_code 预算冻结对账（durable 交互挂起期不计预算，如 approval）' },
        ),
      );
    }
    refresh(); // 初始对账（订阅先于首个子调用——窗口防御，幂等）
  }

  // —— 主线程桥接：子调用 → ctx.tools.execute（全安全面）——
  let computeUsed = 0; // 统计展示用（compute 预算 2026-09-23 退役——墙钟唯一防线）
  const summary: RunSummary = { calls: 0, ok: 0, failed: 0, computeMs: 0, wallMs: 0, denied: [], serialized: [], trace: [] };
  let traceTruncated = 0;
  let serialChain: Promise<void> = Promise.resolve();

  const invoke = (name: string, invokeArgs: Record<string, unknown>, seq: number): Promise<void> => {
    const isSerial = SERIAL_LISTS.write.has(name) || SERIAL_LISTS.command.has(name);
    if (isSerial) summary.serialized.push(seq);
    const task = (): Promise<void> =>
      new Promise((resolve) => {
        let settled = false;
        const t0 = Date.now();
        const done = (r: ToolResult) => {
          if (settled) return;
          settled = true;
          const dur = Date.now() - t0;
          // computeMs 仅统计展示（2026-09-23 收敛：不再作预算处决——墙钟唯一
          // 防线）；仍剔除冻结区间（durable 用户应答等待），卡片数值保持
          // 「机器时间」口径。
          computeUsed += Math.max(0, dur - pausedBetween(t0, Date.now()));
          summary.calls++;
          if (r.ok) summary.ok++;
          else summary.failed++;
          if (!r.ok && r.error && /权限|档位|黑名单|拒绝/.test(r.error)) {
            summary.denied.push({ name, error: r.error.slice(0, 200) });
          }
          // 轨迹收集（UI 卡片数据源）：上限 50，超出只计数
          if (summary.trace.length < TRACE_LIMIT) {
            const entry: SubcallTrace = {
              seq,
              name,
              ok: r.ok,
              ms: dur,
              brief: subcallBrief(name, invokeArgs, r),
              ...(!r.ok && r.error ? { error: r.error.slice(0, 200) } : {}),
            };
            summary.trace.push(entry);
          } else {
            traceTruncated++;
          }
          worker.postMessage({ type: 'result', seq, ok: r.ok, ...(r.output !== undefined ? { output: r.output } : {}), ...(r.error ? { error: r.error } : {}) } satisfies MainToWorker);
          resolve();
        };
        void ctx.tools
          .execute({
            name,
            args: invokeArgs,
            ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
            ...(call.conversationId !== undefined ? { conversationId: call.conversationId } : {}),
            toolCallId: `${runId}#${seq}`,
            signal: abortCtl.signal,
            ...(call.elevation ? { elevation: call.elevation } : {}),
            // 子调用标记（实测复盘 #B）：ToolCall 开放词汇面——UI/审计
            // 据此区分「run_code 程序内子调用」与「模型直接调用」（tool_call_id
            // 形如 <runId>#<seq> 是提示不是判据——显式标记才可编程消费）
            runCodeSubcall: true,
          })
          .then(done, (err: unknown) => done({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      });
    if (!isSerial) {
      void task();
      return Promise.resolve();
    }
    // 写路径/命令类：按提交序串行（前一个完成后再执行）
    serialChain = serialChain.then(task, task);
    return serialChain;
  };

  // 程序体全文入 host 日志（实测复盘 #D：裁决 #1 的诊断去向——步记录
  // 只有 programHash，排查需按哈希回捞全文）
  ctx.logger.debug('[run_code] 程序体（%s）：\n%s', hashText(code), code);
  const done = await new Promise<WorkerDone>((resolveDone, rejectDone) => {
    // 引导链改造：ready 消息已被 bootCandidate 握手探针消费——主流程挂
    // 监听后立即补发 init（不再等 ready）。sendInit 幂等（防御性保留 ready
    // 分支：未来若改回不消费 ready 的引导形态，双路径均成立）。
    let initSent = false;
    const sendInit = (): void => {
      if (initSent) return;
      initSent = true;
      worker.postMessage({
        type: 'init',
        runId,
        code,
        maxWallMs,
        maxOutputBytes,
        ...(libSource !== undefined ? { libSource } : {}),
      } satisfies MainToWorker);
      workerReady = true;
      armWallTimer(); // boot 竞态补挂：看门狗若在 ready 前空转（回调空返回），此处按剩余重挂
    };
    worker.on('message', (m: WorkerToMain) => {
      if (m.type === 'ready') {
        sendInit();
        return;
      }
      if (m.type === 'invoke') {
        void invoke(m.name, m.args, m.seq);
        return;
      }
      // 前两支已返回，此处 m 穷举至 done（WorkerToMain 三员联合）
      resolveDone(m);
    });
    worker.on('error', (err) => {
      rejectDone(err);
    });
    worker.on('exit', (code_) => {
      if (code_ !== 0) rejectDone(new Error(`worker 异常退出（code=${code_}）`));
      else resolveDone({ type: 'done', ok: false, error: 'worker 提前退出', summary: { calls: 0, ok: 0, failed: 0, computeMs: 0, wallMs: 0, denied: [], serialized: [], trace: [] } });
    });
    // 主线程侧看门狗：机器墙钟预算（用户应答等待经预算冻结豁免）——
    // worker 自身无 timer 面
    armWallTimer();
    sendInit(); // bootCandidate 已消费 ready——此处直接补发 init（幂等，见 sendInit 注释）
    // 用户中止监听：先判后听（竞态守卫）——signal 在监听注册前已 abort
    //（worker boot 慢/并行负载下常见）时 addEventListener 永不触发，中止
    // 静默丢失、程序跑完返回成功。已 aborted 直接当场走同一处置路径。
    const onUserAbort = (): void => {
      if (wallTimer !== undefined) {
        clearTimeout(wallTimer);
        wallTimer = undefined;
      }
      abortCtl.abort();
      worker.postMessage({ type: 'abort', reason: '用户中止' } satisfies MainToWorker);
      // 物理处决（2026-09-23）：postMessage 只对协作型程序生效（postMessage
      // 边界检查点）；纯计算死循环无边界——terminate 是唯一可达手段（实测
      // ~18ms 即时）。宽限 1s：让协作型 worker 先自收束发 done(interrupted)
      // （保留步记录与 interrupt 载荷——测试锁定的语义）；死循环不会发 done，
      // 1s 后 terminate 兜底。
      setTimeout(() => void worker.terminate(), 1_000).unref();
    };
    if (call.signal?.aborted) onUserAbort();
    else call.signal?.addEventListener('abort', onUserAbort, { once: true });
  }).finally(() => {
    void worker.terminate();
    for (const d of disposeFreeze) d();
    exitFreeze(); // durable 源收口（悬空交互不阻塞——run 已结束，wallTimer 无人在等）
    }
  );

  summary.computeMs = computeUsed;
  summary.wallMs = Date.now() - wallStart;
  const frozenMs = pausedBetween(wallStart, Date.now());
  if (frozenMs > 0) summary.frozenMs = frozenMs;
  // lib 注册表回写：done 快照 → 会话级 store（全量覆写——含程序未 define 的
  // 存量；失败/interrupted 的 run 不回写——注册表只反映成功程序的状态）
  if (done.ok && done.libExports !== undefined) {
    libStore.clear();
    for (const [name, src] of Object.entries(done.libExports)) libStore.set(name, src);
  }
  // 引用悬空坏条目剔除（立项③-C）：调用期爆 ReferenceError 的条目从会话级
  // store 剔除——下 run 起不再注入（与「失败不回写」正交：即使本 run 失败，
  // 坏条目也该剔——它们已经证明不可用）。
  const libRottedNotice =
    done.libRotted !== undefined && done.libRotted.length > 0
      ? `。lib 坏条目已剔除：${done.libRotted.join('、')}（调用期引用悬空——如需保留请修复源码后重新 define 同名覆盖）`
      : '';
  if (done.libRotted !== undefined) {
    for (const name of done.libRotted) libStore.delete(name);
  }
  // 引导快照刷新（立项①）：收到结构化 done = worker 机制完整存活的证据——
  // dev 源码可用时刷新快照（本次 spawn 读到的源码；boot 用快照跑的 run 不
  // 刷新——dev 坏着呢，刷新会把坏源码写进缓存）。
  if (devSource !== undefined && boot.bootedFrom === 'dev') {
    refreshWorkerSnapshot(devEntry, devSource);
  }
  // 程序体哈希（步记录入摘要——裁决 #1）
  const programHash = hashText(code);
  const output = {
    summary: {
      ...done.summary,
      ...summary,
      computeMs: Math.max(done.summary.computeMs, summary.computeMs),
      wallMs: Math.max(done.summary.wallMs, summary.wallMs),
      ...(traceTruncated > 0 ? { traceTruncated } : {}),
    },
    programHash,
    ...(bootDegradedNotice !== undefined ? { bootDegraded: bootDegradedNotice } : {}),
    ...(done.libRotted !== undefined && done.libRotted.length > 0 ? { libRotted: done.libRotted } : {}),
    ...(done.value !== undefined ? { value: done.value } : {}),
    ...(done.valueVia !== undefined ? { valueVia: done.valueVia } : {}),
    ...(done.logsTail !== undefined ? { logsTail: done.logsTail } : {}),
  };
  if (done.interrupted) {
    return { ok: false, error: done.error ?? '程序中止', interrupt: { type: 'run-code-interrupted', reason: done.error ?? '程序中止' }, output };
  }
  if (!done.ok) {
    // P1（9eaf3f03 复盘 ③④）：失败全量回滚是设计语义（注册表只反映成功程序），
    // 但须显式提示丢弃事实——否则模型以为注册仍在，后续 resolve 连环落空（实测一次程序失败连丢 patchFile/readSeg 两库）
    const dropped = done.libDefined !== undefined && done.libDefined.length > 0
      ? `。本程序 lib.define 的 ${done.libDefined.join('、')} 已随失败丢弃（注册表只保留成功程序的状态）——重新使用须在下次程序重新 define`
      : '';
    return { ok: false, error: (done.error ?? '程序执行失败') + dropped + libRottedNotice, output };
  }
  return { ok: true, output };
}

/** 简单稳定哈希（FNV-1a 32bit hex——摘要用途，非密码学） */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── 测试钩子（仅集成测试消费——生产代码不引用）──
// 事故场景无法直接复现（不能真改 worker.ts——会污染工作区），以钩子注入
// 形态验证引导链：种快照/坏 store 条目/重置进程内状态。
export const __runCodeTestHooks = {
  /** 覆写进程内快照（null = 清空） */
  setMemSnapshot(js: string | null): void {
    lastGoodWorkerJs = js;
  },
  /** 种磁盘快照（写 tmpdir 快照文件——返回路径） */
  seedDiskSnapshot(entry: string, js: string): string {
    const file = workerSnapshotFile(entry);
    mkdirSync(workerSnapshotDir(), { recursive: true });
    writeFileSync(file, js, 'utf8');
    return file;
  },
  /** 读进程内快照现状 */
  getMemSnapshot(): string | null {
    return lastGoodWorkerJs;
  },
  /** 覆写 worker 候选入口点（模拟部署形态；restore 还原——返回还原函数） */
  overrideWorkerEntries(dev: () => string, bundle: () => string): () => void {
    const prevDev = workerDevEntryFn;
    const prevBundle = workerBundleEntryFn;
    workerDevEntryFn = dev;
    workerBundleEntryFn = bundle;
    return () => { workerDevEntryFn = prevDev; workerBundleEntryFn = prevBundle; };
  },
  /** 直接注入会话级 lib store（坏条目形态验证） */
  seedLibStore(agentId: string | undefined, conversationId: string | undefined, entries: Record<string, string>): void {
    const store = libStoreOf(agentId, conversationId);
    for (const [name, src] of Object.entries(entries)) store.set(name, src);
  },
  /** 读会话级 lib store 键集 */
  libStoreKeys(agentId: string | undefined, conversationId: string | undefined): string[] {
    return [...libStoreOf(agentId, conversationId).keys()];
  },
};
