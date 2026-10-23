// ============================================================
// boot.ts —— 壳 boot 编排骨架（R3.2；D9 步 2 前半）
//
// 编排序（协议规格 D1 + R3.2）：
//   argv（dataRoot / agentId / 行集清单引用）
//   → acquire activation.lock（M1.3——锁辖域 agent 级）
//   → rowset 派生 + 静态断言（M2.3——warnings fail-loud）
//   → 行集装配（注册表逐行装配，缺装配器 fail-loud）
//   → stdout TSV 三节拍（boot.lock.acquired / boot.rows.ready / boot.ready）
//
// M3.2 范围 = 编排骨架与节拍协议；真实行（ledger/conversation/tools…）
// 随 M3.3/M3.4 接入——装配函数接 rowAssemblers 注册表。
//
// M8.2：收信面 = conversation 全链（信封 → ctx.conversation → ledger
// 落账 → ConversationMachine → ctx.agentLoop 全量真身 → settle + 跨壳
// 回信）；llm/delta → emitStream 流式旁带接线；--mock-provider 注册
// 确定性 mock（真子进程 e2e / 无凭据环境）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  acquireActivationLock, releaseActivationLock, socketPathFor,
  AdmissionGate, FrameDecoder, encodeFrame, isStreamFrame, streamFrameFromDelta,
  type ActivationLockInfo, type Envelope, type StreamFrame, type StreamMeta,
} from 'ac-envelope-core';
import * as net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context, FiberStates, type Fiber, type Plugin } from '@agentchat/cordis';
import { deriveShellRowset, mergeRowsetCatalog, readCatalog, readPluginRows, type DerivedRowset, type RowDescriptor } from 'ac-rowset-core';
import { readAgentConfig, readChildConfig } from 'ac-agents-core';
import { subjectFingerprint } from 'ac-fingerprint-core';
import { IMPORTED_ROWS, COMPANION_ROWS, rowOptionsFor, makeShimsRow, makeToolsGateRow, makeSessionQueryRow, makeArchiveRow, makePluginDevRow } from 'ac-shell-rows';
import { handleAdminFrame, type AdminFrame } from './admin-frame.ts';
import { startHostRevive } from './host-revive.ts';
import { makeLedgerRow } from 'ac-ledger';
import { scriptedBenchRow, type BenchRunOptions, type BenchReport } from 'ac-bench';
import { makeConversationRow } from 'ac-shell-conversation';
import { makeSubagentRow } from 'ac-shell-subagent';
import type { LlmStreamChunk } from 'ac-llm';

// —— stdout TSV 节拍（协议规格 D1——一行一事件，宿主 guardian 消费） ——

export function emitBootSignal(signal: string, ...fields: string[]): void {
  process.stdout.write([signal, ...fields].join('\t') + '\n');
}

// —— idle-exit 四条件探针（协议 D2：收割判据——run / inbox 待消费 / 在途
// 交互 / 活跃 job 四面全空才可收割；任一在场 = 阻止。软取服务面，缺席 =
// 行不在集 → 该面视闲——行集裁剪的合法降级） ——

export function shellIsIdle(ctx: Context): boolean {
  // ① run 在途（conversation busy——串行化门状态）
  const conv = ctx.get('conversation', false) as { isBusy(): boolean } | undefined;
  if (conv !== undefined && conv.isBusy()) return false;
  // ② inbox 待消费（ledger inbox durable——链跑队列事实源；跨全部会话扫描）
  const ledger = ctx.get('ledger', false) as
    | { inboxList(uuid: string): unknown[] } & { [k: string]: unknown }
    | undefined;
  if (ledger !== undefined && ledgerHasPendingInbox(ledger)) return false;
  // ③ 在途交互（durable pending——ask_questions 等待中）
  const durable = ctx.get('durableInteraction', false) as { listOpen(): unknown[] } | undefined;
  if (durable !== undefined && durable.listOpen().length > 0) return false;
  // ④ 活跃 job（jobs running/stopping——壳子进程 job 随进程蒸发，活跃 job 阻止收割）
  const jobs = ctx.get('jobs', false) as { list(): Array<{ status: string }> } | undefined;
  if (jobs !== undefined && jobs.list().some((j) => j.status === 'running' || j.status === 'stopping')) return false;
  return true;
}

/** inbox 扫描（ledger 会话目录直读——writer 注册表只持已活跃会话，durable
 * inbox 可能属于早已 idle 的会话；扫描 sessions/<uuid>/inbox/ 非空即有待消费） */
function ledgerHasPendingInbox(ledger: { inboxList(uuid: string): unknown[] } & { [k: string]: unknown }): boolean {
  // inboxList 按 uuid——本探针不能枚举会话（registry 是惰性 Map）。降级：
  // 检查 agent 域 sessions/<uuid>/inbox/ 目录（直接读盘——探针语义，非服务面）。
  const agentDir = (ledger as { agentDirOf?: () => string }).agentDirOf?.();
  if (agentDir === undefined) return false;
  try {
    for (const uuid of fs.readdirSync(path.join(agentDir, 'sessions'))) {
      const inboxDir = path.join(agentDir, 'sessions', uuid, 'inbox');
      try {
        if (fs.readdirSync(inboxDir).length > 0) return true;
      } catch { /* 该会话无 inbox 目录 */ }
    }
  } catch { /* sessions 目录缺席 */ }
  return false;
}

// —— argv 契约 ——

export interface ShellBootArgs {
  dataRoot: string;
  agentId: string;
  /** 行集清单引用：缺省 = 数据根内 row-catalog.json + AgentConfig.tools 派生 */
  catalogFile?: string;
  /** 父 agent id（影子形态：agentId 解析自 agents/<parent>/children/<child>/——锁辖域 = 子目录，不撞父锁） */
  parentId?: string;
  /** 注册确定性 mock provider（e2e / 无凭据环境——model 'mock' 路由命中） */
  mockProvider?: boolean;
  /** 邮局 ipc 地址（跨壳投递面；缺席 = CLI 直连形态无跨壳回信） */
  postOffice?: string;
  /** 常驻不随 stdin 收束自杀（父壳拉起的子壳形态——owner 失活子存活，R-5；
   * 控制帧经 stdin 行协议，shutdown 仍可用） */
  persist?: boolean;
  /** 宿主 boot 入口（D5 边 2 常态化 cr-612：邮局失联时壳侧复活宿主；
   * 与 --post-office 同在场才武装——CLI 直连形态无此职责） */
  hostBoot?: string;
  /** 宿主 web 端口（复活拉起时回填 --port；缺席 = 宿主缺省档） */
  hostPort?: number;
}

export function parseShellArgs(argv: string[]): ShellBootArgs {
  const out: Partial<ShellBootArgs> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (typeof val !== 'string') throw new Error('argv 形态错误：' + key + ' 缺值');
    if (key === '--data-root') out.dataRoot = val;
    else if (key === '--agent-id') out.agentId = val;
    else if (key === '--catalog') out.catalogFile = val;
    else if (key === '--parent-id') out.parentId = val;
    else if (key === '--post-office') out.postOffice = val;
    else if (key === '--persist') out.persist = val === '1' || val === 'true';
    else if (key === '--host-boot') out.hostBoot = val;
    else if (key === '--host-port') out.hostPort = Number(val);
    else if (key === '--mock-provider') out.mockProvider = val === '1' || val === 'true';
    else throw new Error('未知 argv 键：' + key);
  }
  if (!out.dataRoot || !out.agentId) {
    throw new Error('壳 boot 缺少必选参数：--data-root 与 --agent-id');
  }
  return out as ShellBootArgs;
}

// —— rowset 派生 + 静态断言 ——

/**
 * 行集静态断言（R3.2：行引用存在性——纯函数；warnings 非空 = fail-loud）。
 */
export function deriveAndAssertRowset(
  dataRoot: string,
  agentId: string,
  catalogFile: string | undefined,
  parentId?: string,
): DerivedRowset & { catalogRows: RowDescriptor[] } {
  // 目录 = 出厂目录 ∪ 插件行集（cr-543：install = 授权动作——宿主 plugin-registry
  // 行批准安装后物化 <dataRoot>/plugin-rows.json，壳侧合并即得可用行集；
  // 撞名出厂行在合并层丢弃——保留字护栏）
  const merged = mergeRowsetCatalog(
    readCatalog(catalogFile ?? path.join(dataRoot, 'row-catalog.json')),
    readPluginRows(path.resolve(dataRoot)),
  );
  const catalog = merged.catalog;
  const config = parentId !== undefined
    ? readChildConfig(dataRoot, parentId, agentId)
    : readAgentConfig(dataRoot, agentId);
  if (config === null) {
    throw new Error('agent 配置缺席：' + (parentId !== undefined
      ? path.join(dataRoot, 'agents', parentId, 'children', agentId, 'config.json')
      : path.join(dataRoot, 'agents', agentId, 'config.json')));
  }
  const derived = deriveShellRowset({ tools: config.tools }, catalog);
  if (derived.warnings.length > 0) {
    throw new Error('行集静态断言失败：\n  ' + derived.warnings.join('\n  '));
  }
  return { ...derived, catalogRows: catalog.rows };
}

/**
 * 插件行装配器（cr-543）：安装目录 manifest.entry 动态 import → ctx.plugin。
 * 装载 = 授权动作（A7/A10）——第三方代码只在壳进程内进进程，宿主进程不装载；
 * 行 id / 工具面来自 plugin-rows.json（宿主 plugin-registry 行物化，熔断/撞名
 * 已在宿主侧剔除）。装载失败由宿主 plugin/load-failure RPC 回报熔断（壳接线
 * 归 cutover/8.9 产品面收敛批）。
 */
export async function assemblePluginRow(row: RowDescriptor, ctx: Context): Promise<Fiber> {
  if (row.path === undefined || Array.isArray(row.path)) {
    // 插件行 path 恒单目录（安装目录单源）——数组形是出厂行的多包指代，不适用于插件
    throw new Error('插件行 path 非法（须为单安装目录）：' + row.id);
  }
  const installDir = row.path;
  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'manifest.json'), 'utf-8')) as { entry?: unknown };
  const entry = typeof manifest.entry === 'string' && manifest.entry !== '' ? manifest.entry : 'index.ts';
  const mod = await import(pathToFileURL(path.join(installDir, entry)).href) as unknown as Plugin;
  return ctx.plugin(mod);
}

// —— 装配面 ——

/** 可装配行注册表：行 id → 装配器（null = 占位行——只计就位不装配）。
 * cordis 行（IMPORTED_ROWS 命中）不经此面——M8.1 起真行优先 cordis 装配。
 * 装配器可返回 Fiber（ctx.plugin 的句柄）——assembleRows 统一做 ACTIVE
 * 终检与逆序 dispose（M8.2：ledger/conversation preview 实现行走此面）。 */
export type RowAssembler = (ctx: unknown) => Promise<Fiber | void> | Fiber | void;
const rowAssemblers = new Map<string, RowAssembler | null>();

export function registerRowAssembler(rowId: string, assemble: RowAssembler | null): void {
  rowAssemblers.set(rowId, assemble);
}

// M3.2 骨架预注册：目录内全部 shell 行占位（null）——真实装配器随 M3.3+
// 逐行注册替换；目录外行 id 仍 fail-loud（行集清单引用了不存在的行）。
export function seedPlaceholderAssemblers(catalogRows: Array<{ id: string; tree: string }>): void {
  for (const row of catalogRows) {
    if (row.tree === 'shell' && !rowAssemblers.has(row.id)) rowAssemblers.set(row.id, null);
  }
}

/**
 * 装配行集（M8.1 cordis 化）：真行两来源——
 *   ① IMPORTED_ROWS 命中（主线沿用行导入）→ ctx.plugin 装配（inject 声明
 *      推导依赖，PENDING 自然解析；数据根行 options 经 opts.rowOptions 注入）。
 *      同包多行（web-tools/browser 共享 src/ac-web-tools）按 Plugin 引用
 *      去重——同一行包装配一次，行集计数仍按行计；
 *   ② rowAssemblers 注册（占位 null / 后续批次装配器）。
 * 两者皆缺 = fail-loud（行集清单引用了 preview 尚未实现的行）。
 */
export async function assembleRows(
  rowIds: string[],
  ctx: Context | null,
  opts: {
    onRowReady?: (id: string) => void;
    /** 数据根行 options（IMPORTED_ROWS 的构造参数——config/memory/skill root） */
    rowOptions?: Record<string, unknown>;
  } = {},
): Promise<{ ready: number; fibers: Fiber[] }> {
  let ready = 0;
  const fibers: Fiber[] = [];
  const assembled = new Set<Plugin>();
  for (const id of rowIds) {
    if (id in IMPORTED_ROWS && ctx !== null) {
      const imported = IMPORTED_ROWS[id];
      if (!assembled.has(imported)) {
        assembled.add(imported);
        const config = opts.rowOptions?.[id];
        const fiber = config === undefined ? ctx.plugin(imported) : ctx.plugin(imported, config);
        await fiber;
        fibers.push(fiber);
        // 伴生服务行（catalog 行内并入件——如 fs-tools 的 file-snapshots）
        if (id in COMPANION_ROWS) {
          const companion = COMPANION_ROWS[id];
          const co = opts.rowOptions?.[companion.optionsKey];
          const coFiber = co === undefined ? ctx.plugin(companion.plugin) : ctx.plugin(companion.plugin, co);
          await coFiber;
          fibers.push(coFiber);
        }
      }
    } else {
      const assemble = rowAssemblers.get(id);
      if (assemble === undefined || assemble === null) {
        throw new Error('行 ' + id + ' 无装配器——preview 尚未实现该行（M8.1 批次推进中）');
      }
      const fiber = await assemble(ctx);
      if (fiber !== undefined) fibers.push(fiber as Fiber);
    }
    ready++;
    opts.onRowReady?.(id);
  }
  // 装配终检（cr-521）：排空至定点。PENDING fiber 的 await 立即返回不报错
  //（依赖未到——闭包/装配序缺口的静默面）——统一排空后断言 ACTIVE：倒序
  // 装配的瞬态在此收敛，行集闭包缺口（依赖行被排除/目录漂移）fail-loud。
  for (const fiber of fibers) await fiber;
  for (const fiber of fibers) {
    if (fiber.state !== FiberStates.ACTIVE) {
      throw new Error(
        '行 <' + fiber.name + '> 装配后未激活（PENDING——依赖行不在行集：requires 闭包缺口或被显式排除）',
      );
    }
  }
  return { ready, fibers };
}

// —— boot 主体 ——

export interface ShellBootResult {
  lockInfo: ActivationLockInfo;
  rowset: DerivedRowset & { catalogRows: RowDescriptor[] };
  rowsReady: number;
  /** 装配树（M8.1 cordis 通道——服务观测面；close() 即收割） */
  ctx: Context;
  transportHint: string;
  /** 主体指纹（R-7 boot 单元——boot.ready 自报同源） */
  fingerprint: { root: string; entries: Record<string, string> };
  /** B3 流式旁带发射面（壳 → 宿主单向；无订阅连接 = 丢弃返回 false） */
  emitStream(frame: StreamFrame): boolean;
  /** 控制帧面（拉起方 → 壳：interrupt / bench——stdin 行协议的内态实现） */
  control(frame: ControlFrame): Promise<unknown>;
  close(): Promise<void>;
}

/** 控制帧（拉起方控制通道——非信封数据面：动作即刻执行，无 uuid/budget 语义） */
export type ControlFrame =
  | { ctrl: 'interrupt' }
  | { ctrl: 'bench'; suite: string; options: BenchRunOptions }
  | { ctrl: 'tool'; name: string; args?: Record<string, unknown> }
  /** 装配预览（cr-552 跨进程 dry-run）：system-prompt 三档链干跑 / assembly 工具目录 */
  | { ctrl: 'preview'; what: 'system-prompt'; conversationId?: string }
  | { ctrl: 'preview'; what: 'assembly-tools' }
  /** 壳内管理面（cr-569）：goal / todo 等会话桶状态——宿主 RPC 面的壳内半边 */
  | AdminFrame;

/**
 * 壳 boot 编排（可测半边——emit/onExit 注入）。锁拒绝/断言失败 = 抛错
 *（调用方转退出码）。
 */
export async function bootShell(
  args: ShellBootArgs,
  opts: {
    emit?: (signal: string, ...fields: string[]) => void;
    onExit?: (handler: () => void) => void;
  } = {},
): Promise<ShellBootResult> {
  const emit = opts.emit ?? emitBootSignal;
  const bootId = crypto.randomUUID();
  const agentDir = args.parentId !== undefined
    ? path.join(args.dataRoot, 'agents', args.parentId, 'children', args.agentId)
    : path.join(args.dataRoot, 'agents', args.agentId);
  // 影子形态的 agent 域目录（ledger agentDirOverride 同源——M8.3 子壳账本嵌套域）
  const parentIdDir = args.parentId !== undefined ? agentDir : undefined;
  fs.mkdirSync(agentDir, { recursive: true });
  const endpointId = args.parentId !== undefined ? args.parentId + '--' + args.agentId : args.agentId;
  const transportHint = socketPathFor(path.resolve(args.dataRoot), endpointId);
  const lockInfo: ActivationLockInfo = {
    pid: process.pid,
    bootId,
    acquiredAt: new Date().toISOString(),
    transportHint,
  };
  const lock = acquireActivationLock(agentDir, lockInfo);
  if (lock.kind === 'refused') {
    throw new Error('activation 锁被进程 ' + lock.holder.pid + ' 持有（bootId=' + lock.holder.bootId + '）——单例语义拒绝');
  }
  emit('boot.lock.acquired', bootId, lockInfo.acquiredAt);
  opts.onExit?.(() => releaseActivationLock(agentDir, process.pid));

  const rowset = deriveAndAssertRowset(args.dataRoot, args.agentId, args.catalogFile, args.parentId);
  seedPlaceholderAssemblers(rowset.catalogRows);
  // 插件行装配器（cr-543）：行集内出现的插件行（安装态注入、非出厂目录行）
  // 按安装目录动态装载——插件行 id 由宿主 plugin-registry 行物化。
  // 装载失败（cr-550）：emit plugin.load-failed TSV 行 + 跳行——插件熔断
  // 归宿主裁决（阈值 3 → 行集条目剔除），壳自身 boot 不被第三方插件拖死
  //（fail-closed 对插件：该行缺席即其工具面缺席；宿主回报面由常驻监护
  // supervise 消费本节拍转发 pluginRegistry.reportLoadFailure）。
  for (const pluginRow of readPluginRows(path.resolve(args.dataRoot))) {
    if (!rowset.rowIds.includes(pluginRow.id)) continue;
    registerRowAssembler(pluginRow.id, async (c) => {
      try {
        return await assemblePluginRow(pluginRow, c as Context);
      } catch (err) {
        const name = path.basename(path.dirname(pluginRow.path as string));
        emit('plugin.load-failed', name, String(err).slice(0, 200));
        return undefined; // 跳行（无 fiber——assembleRows 的 void 分支）
      }
    });
  }
  // M8.1：cordis 装配通道——垫片行（agents/agentStore 数据根直读）先装，
  // 沿用行（IMPORTED_ROWS）按行集清单逐行 ctx.plugin；数据根行 options 显式
  // 注入（preview 数据根隔离红线——不走环境变量缺省）。
  const ctx = new Context();
  // 行 id → 工具名投影（cr-590）：AgentConfig.tools 词形是行 id——LLM 工具面
  //（conversation 服务 toolFaceOf）与主线服务词汇面（agents 垫片——collab
  // list_tools 等按 config.tools 过滤注册名）都要工具名；词汇 owning = 本
  // 目录，装配期投影。
  const rowTools: Record<string, string[]> = {};
  for (const row of rowset.catalogRows) {
    if (row.tree === 'shell' && row.tools !== undefined) rowTools[row.id] = row.tools;
  }
  const shimFiber = ctx.plugin(makeShimsRow(path.resolve(args.dataRoot), rowTools));
  await shimFiber;
  // M8.2 会话域行（ledger/conversation）经 rowAssemblers 注册面按行集装配
  //（与 IMPORTED_ROWS 两来源互补——catalog 行集清单是装配事实源：点名子集
  // 不含 conversation 行 = 不装，其 inject 依赖〔agentLoop/ledger〕缺席不构成
  // PENDING——行集闭包在目录 requires 层已保证点名行集的依赖完备）。boot
  // 前置注册（每 boot 覆写——装配器注册表无跨 boot 态）。
  registerRowAssembler('ledger', (c) => (c as Context).plugin(makeLedgerRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
    ...(parentIdDir !== undefined ? { agentDirOverride: parentIdDir } : {}),
    // usage 事件信投递面（cr-538：无邮局不发——CLI 直连形态计量只落 journal）
    ...(args.postOffice !== undefined ? { postOfficeAddress: args.postOffice } : {}),
  })));
  // 行 id → 工具名投影词汇见 ctx 创建处（rowTools——垫片与 conversation 共用）。
  registerRowAssembler('conversation', (c) => (c as Context).plugin(makeConversationRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
    ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
    ...(args.postOffice !== undefined ? { postOfficeAddress: args.postOffice } : {}),
    rowTools,
  })));
  // 会话查询行（cr-544）：D10 收敛为 agent 只搜自己——读面单源 = 本 agent
  // 账本域（agents/<id>/ 或影子物化域），不越域读其他 agent / user 账本
  registerRowAssembler('session-query', (c) => (c as Context).plugin(makeSessionQueryRow({
    agentDir,
    agentId: args.agentId,
  })));
  // 归档行（cr-546）：D11 全壳内——阈值检测/整理 run/归档重建全链壳内；
  // timer 的 archive-all 机制任务改批量唤醒信（宿主零 archive 职责）
  registerRowAssembler('archive', (c) => (c as Context).plugin(makeArchiveRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
  })));
  // 插件开发行（cr-553）：creator 模板装卸三件套——register 会话级装载
  // 壳内自持；install/uninstall 永久档经邮局信封请求宿主 plugin-registry 行
  registerRowAssembler('plugin-dev', (c) => (c as Context).plugin(makePluginDevRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
    ...(args.postOffice !== undefined ? { postOfficeAddress: args.postOffice } : {}),
  })));
  // subagent 行（M8.3）：子壳 boot 入口/catalog 显式注入（本文件与同树 catalog
  // ——import.meta.url 相对定位；父壳拉子壳的标准链）。
  registerRowAssembler('subagent', (c) => (c as Context).plugin(makeSubagentRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
    bootFile: fileURLToPath(new URL(import.meta.url)), catalogFile: args.catalogFile ?? path.join(path.resolve(args.dataRoot), 'row-catalog.json'),
    ...(args.postOffice !== undefined ? { postOfficeAddress: args.postOffice } : {}),
  })));
  const { ready: rowsReady, fibers } = await assembleRows(rowset.rowIds, ctx, {
    // durable-interaction 等 per-agent 域行随 agent 域锚定（影子 = 物化域，
    // 与 ledger agentDirOverride 同源——D4 每实例只写自己域）；agentId 随行
    // （cr-589：pwsh/fs 族沙箱 workdir = <dataRoot>/sandbox/<agentId>）
    rowOptions: rowOptionsFor(path.resolve(args.dataRoot), agentDir, args.agentId),
  });
  // tools 授权门（M8.6 cr-527，manifest R2 tools 行「授权门」半边）：行集
  // 含 tools 行即挂（无门禁壳非合法降级）——loop/before-run 每 run 前重读
  // 投影 + tool/before-execute MCP 服务器资产硬闸（fail-closed）。
  let gateFiber: Fiber | null = null;
  if (rowset.rowIds.includes('tools')) {
    gateFiber = ctx.plugin(makeToolsGateRow({
      dataRoot: path.resolve(args.dataRoot),
      agentId: args.agentId,
      ...(parentIdDir !== undefined ? { agentDirOverride: parentIdDir } : {}),
      rowset: new Set(rowset.rowIds),
    }));
    await gateFiber;
    fibers.push(gateFiber);
  }
  // 确定性 mock provider（e2e / 无凭据环境）：model 'mock' 路由命中——
  // 终稿 = 入站文本回声（多轮可辨）；llm 流式事件照常发射（旁带接线同链）。
  let mockFiber: Fiber | null = null;
  if (args.mockProvider === true) {
    mockFiber = ctx.plugin({
      name: 'shell-mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', () => ({
          stream: async function* (input: { messages: Array<{ role: string; content: string }> }) {
            const last = input.messages.filter((m) => m.role === 'user').at(-1);
            yield { delta: '[mock 回复 ' + (last?.content ?? '') + ']' };
            yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
          },
        }), { models: ['mock'] });
      },
    });
    await mockFiber;
    fibers.push(mockFiber);
    // bench 门薄行（mock 壳评测面——[[BENCH_SCRIPT]] 脚本化全链，零真 LLM；
    // 行集声明面：bench 行在集才挂——控制帧可用性随行集走）
    if (rowset.rowIds.includes('bench')) {
      const benchFiber = ctx.plugin(scriptedBenchRow() as unknown as Plugin);
      await benchFiber;
      fibers.push(benchFiber);
    }
  }
  emit('boot.rows.ready', bootId, String(rowsReady));

  // 主体指纹自报（R-7：入指纹 = 行集推导一切——config + catalog + 行包内容；
  // 无 path 的占位行不入行集指纹面〔未实现 = 未生效〕）。boot.ready 第四域。
  const fingerprint = subjectFingerprint({
    configJson: fs.readFileSync(path.join(agentDir, 'config.json'), 'utf-8'),
    catalogJson: fs.readFileSync(args.catalogFile ?? path.join(args.dataRoot, 'row-catalog.json'), 'utf-8'),
    rows: rowset.catalogRows
      // 树限定：基座行双计（host 版与 shell 版同 id），壳指纹只认 shell 版——
      // host 版补 path 后（cr-537）双计条目会混入指纹树，与宿主侧同口径走散
      .filter((row) => row.tree === 'shell' && rowset.rowIds.includes(row.id) && row.path !== undefined)
      // path 数组（一行跨多包——fs-tools 并入 file-snapshots）= 每包一条指纹项，
      // 项名 <rowId>/<i> 区分同行的多个包根
      .flatMap((row) => (Array.isArray(row.path) ? row.path : [row.path!])
        .map((p, i) => ({ id: Array.isArray(row.path) ? row.id + '/' + i : row.id, root: path.resolve(p) }))),
  });

  // 投递监听（M8.2 conversation 全链收信面）：信封 → requestId 幂等
  //（AdmissionGate——进程内；跨重启幂等在 ledger writer requestId 准入）
  // → ack（A2 落账即确认——ack 与落账同点发出）→ ctx.conversation 驱动
  //（inbox 决策 + 落账 + ConversationMachine + agentLoop 真身 + settle +
  // 跨壳回信）。错误不吞：落账失败即断连（fail-loud——at-least-once 由
  // 发送方重发兜底，requestId 幂等保证不重复）。
  // B3 流式旁带：llm/delta 事件 → emitStream 帧（壳→宿主单向上抛，瞬态
  // ——不幂等不确认不入发件箱）；无连接时丢弃（壳死即丢语义的镜像：
  // 订阅方不在场即丢，账本兜底）。
  const admission = new AdmissionGate();
  // B3 旁带上行连接集合（8.5d 修）：tap 订阅与邮局投递连接并存——每连接
  // 独立收旁带帧（单 uplink 插槽被后到连接覆盖 = 先到订阅者静默失流；
  // 多订阅广播，无订阅返回 false）。
  const uplinks = new Set<net.Socket>();
  const emitStreamFrame = (frame: StreamFrame): boolean => {
    let delivered = false;
    for (const sock of uplinks) {
      if (sock.destroyed) continue;
      try {
        sock.write(encodeFrame(frame));
        delivered = true;
      } catch { /* 该连接失效——集合成员在 close 时移除 */ }
    }
    return delivered;
  };
  const server = net.createServer((socket) => {
    uplinks.add(socket);
    socket.on('close', () => uplinks.delete(socket));
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (isStreamFrame(frame)) continue; // 旁带单向（壳→宿主）——入站旁带帧忽略
        const env = frame as Envelope;
        if (typeof env === 'object' && typeof env.requestId === 'string') {
          const fresh = admission.admit(env.requestId);
          socket.write(encodeFrame({ ack: env.requestId, fresh }));
          if (fresh) {
            // archive-all 唤醒信（D11）：壳内批量归档——机制信分发面（payload
            // mechTask 键；账本照常落账、archiveAll 触发面在信封消费前）
            const mech = (env.payload as { mechTask?: string } | null)?.mechTask;
            if (mech === 'archive-all') {
              const archive = ctx.get('archive', false) as
                | { archiveAll(): Promise<unknown> }
                | undefined;
              if (archive !== undefined) {
                void archive.archiveAll().catch((err: unknown) => {
                  process.stderr.write('[shell] archive-all 执行失败：' + String(err) + '\n');
                });
              }
            }
            // 软取 preview conversation 实现（键 'conversation' 类型被主线行
            // 占用——运行时注册的是 preview ConversationService，含信封入站面）
            const conv = ctx.get('conversation', false) as
              | { receiveEnvelope(env: Envelope, ack: { fresh: boolean }): Promise<void> }
              | undefined;
            if (conv === undefined) throw new Error('conversation 服务缺席——boot 装配不完整');
            void conv.receiveEnvelope(env, { fresh }).catch((err: unknown) => {
              process.stderr.write('[shell] 信封处理失败：' + String(err) + '\n');
            });
          }
        }
      }
    });
    socket.on('error', () => socket.destroy());
  });
  // llm/delta → B3 旁带帧（stream id = stepId——宿主按步路由；delta 增量
  // 与 end 收束同流。发射失败静默（无连接即丢）——瞬态语义。meta 全套
  // 路由键随帧携带（8.5d：前端按 agent/conversationId/stepId 寻址——
  // loop 组装的 input.meta 即身份贯通面）。
  ctx.on('llm/delta', (input: { meta?: StreamMeta }, chunk: LlmStreamChunk) => {
    for (const frame of streamFrameFromDelta(input.meta, chunk)) emitStreamFrame(frame);
  });
  // run 收束旁带（cr-591，run-error 泛化）：conversation/run-settled →
  // run-settled 帧（宿主 ShellStreamBridge 桥接成主线 loop/after-run——前端
  // 收束三件套：清 busy / 终稿入列 / 权威行重拉）。meta 全套路由键随帧
  // 携带（同 llm/delta 8.5d 口径）。发射失败静默（瞬态）。
  ctx.on('conversation/run-settled', (p: { conversationId: string; runId: string; finish: 'ok' | 'error' | 'interrupted'; text: string; message?: string; sender: string; source: string }) => {
    emitStreamFrame({
      stream: p.runId,
      kind: 'run-settled',
      finish: p.finish,
      text: p.text,
      ...(p.message !== undefined ? { message: p.message } : {}),
      meta: { agent: args.agentId, conversationId: p.conversationId, sender: p.sender, source: p.source, runId: p.runId },
    });
  });
  // run 生命周期旁带（cr-592）：主线 loop 边界/步级事件 → 对应帧（宿主
  // ShellStreamBridge 桥接成主线 loop/run-started / loop/step-started /
  // loop/after-step 前端帧——前端的思考卡载体只在 step-started 帧消费里
  // 创建，缺席 = reasoning 分片无载体可挂、思考直播零渲染；meta 全套
  // 路由键随帧携带）。发射失败静默（瞬态）。
  ctx.on('loop/run-started', (request: { runId?: string; agent?: string; conversationId?: string; sender?: string; source?: string }) => {
    if (request.runId === undefined) return;
    emitStreamFrame({
      stream: request.runId,
      kind: 'run-started',
      meta: {
        agent: request.agent ?? args.agentId,
        conversationId: request.conversationId,
        sender: request.sender,
        source: request.source,
        runId: request.runId,
      },
    });
  });
  ctx.on('loop/step-started', (
    agent: string | undefined,
    index: number,
    _messages: unknown,
    envelope: { runId?: string; stepId?: string; conversationId?: string; sender?: string; source?: string } | undefined,
  ) => {
    const stepId = envelope?.stepId;
    if (stepId === undefined) return;
    emitStreamFrame({
      stream: stepId,
      kind: 'step-started',
      index,
      meta: {
        agent: agent ?? args.agentId,
        conversationId: envelope?.conversationId,
        sender: envelope?.sender,
        source: envelope?.source,
        runId: envelope?.runId,
        stepId,
      },
    });
  });
  ctx.on('loop/after-step', (
    agent: string | undefined,
    step: unknown,
    envelope: { runId?: string; stepId?: string; conversationId?: string; sender?: string; source?: string } | undefined,
  ) => {
    const stepId = envelope?.stepId;
    if (stepId === undefined) return;
    emitStreamFrame({
      stream: stepId,
      kind: 'after-step',
      step,
      meta: {
        agent: agent ?? args.agentId,
        conversationId: envelope?.conversationId,
        sender: envelope?.sender,
        source: envelope?.source,
        runId: envelope?.runId,
        stepId,
      },
    });
  });
  // 工具执行旁带（cr-593）：主线 tool/started·progress·after-execute →
  // 对应帧（宿主直转主线同名前端帧——工具卡执行期直播：结果回填/长任务
  // 进度；缺席 = 工具行直播期恒空 + 收束重拉误判在途 → 终稿双卡）。
  // call 透传（路由身份在 call 上）；发射失败静默（瞬态）。
  type ToolCallLike = { agentId?: string; conversationId?: string; toolCallId?: string; runId?: string };
  const toolFrameMeta = (call: ToolCallLike): StreamMeta => ({
    agent: call.agentId ?? args.agentId,
    conversationId: call.conversationId,
    ...(call.runId !== undefined ? { runId: call.runId } : {}),
  });
  ctx.on('tool/started', (call: ToolCallLike) => {
    const stream = call.toolCallId ?? call.runId;
    if (stream === undefined) return;
    emitStreamFrame({ stream, kind: 'tool-started', call, meta: toolFrameMeta(call) });
  });
  ctx.on('tool/progress', (call: ToolCallLike, chunk: string) => {
    const stream = call.toolCallId ?? call.runId;
    if (stream === undefined) return;
    emitStreamFrame({ stream, kind: 'tool-progress', call, chunk, meta: toolFrameMeta(call) });
  });
  ctx.on('tool/after-execute', (call: ToolCallLike, result: unknown, error?: unknown) => {
    const stream = call.toolCallId ?? call.runId;
    if (stream === undefined) return;
    emitStreamFrame({
      stream,
      kind: 'tool-result',
      call,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      meta: toolFrameMeta(call),
    });
  });
  // 队列快照旁带（cr-579）：conversation/queue-changed → queue-changed 帧
  //（stream = conversationId；宿主桥接成主线同名前端帧——权威快照直接套用）。
  ctx.on('conversation/queue-changed', (
    _agentId: string,
    conversationId: string,
    handle: string,
    items: Array<{ id: string; preview: string; sender: string; source: string; queuedAt: number }>,
  ) => {
    emitStreamFrame({
      stream: conversationId,
      kind: 'queue-changed',
      handle,
      items,
      meta: { agent: args.agentId, conversationId },
    });
  });
  // 持久化交互旁带（cr-625）：durable-interaction/opened·replied·closed →
  // 对应帧（宿主桥接成主线同名前端帧——ask_questions 弹窗/审批卡 live
  // 面唯一驱动源，恢复路径 interaction/list 只管刷新）。record 原样透传
  //（wire 整形住宿主桥接，与主线 ws-bridge 同归属）；发射失败静默（瞬态）。
  type InteractionLike = { id: string; owner?: string };
  const interactionMeta = (record: InteractionLike): StreamMeta => ({ agent: record.owner ?? args.agentId });
  ctx.on('durable-interaction/opened', (record: InteractionLike) => {
    emitStreamFrame({ stream: record.id, kind: 'interaction-opened', record, meta: interactionMeta(record) });
  });
  ctx.on('durable-interaction/replied', (record: InteractionLike) => {
    emitStreamFrame({ stream: record.id, kind: 'interaction-replied', record, meta: interactionMeta(record) });
  });
  ctx.on('durable-interaction/closed', (record: InteractionLike) => {
    emitStreamFrame({ stream: record.id, kind: 'interaction-closed', record, meta: interactionMeta(record) });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(transportHint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  emit('boot.ready', bootId, transportHint, fingerprint.root);
  const control = async (frame: ControlFrame): Promise<unknown> => {
    if (frame.ctrl === 'admin') return handleAdminFrame(ctx, frame);
    if (frame.ctrl === 'interrupt') {
      const conv = ctx.get('conversation', false) as
        | { interrupt(): boolean }
        | undefined;
      if (conv === undefined) throw new Error('conversation 服务缺席——interrupt 无面');
      return { interrupted: conv.interrupt() };
    }
    if (frame.ctrl === 'tool') {
      const tools = ctx.get('tools', false) as
        | { execute(call: { name: string; args: Record<string, unknown> }): Promise<unknown> }
        | undefined;
      if (tools === undefined) throw new Error('tools 服务缺席——行集不含 tools 行');
      return tools.execute({ name: frame.name, args: frame.args ?? {} });
    }
    // preview（cr-552）：装配链住壳进程——宿主 agent-admin 行经控制帧往返取预览。
    // 干跑只读：不落账、不占串行化门、无 LLM 调用。
    if (frame.ctrl === 'preview') {
      const conv = ctx.get('conversation', false) as
        | {
            previewSystemPrompt(conversationId?: string): Promise<string>;
            assemblyToolsView(): { tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>; enabled: string[] };
          }
        | undefined;
      if (conv === undefined) throw new Error('conversation 服务缺席——行集不含 conversation 行');
      return frame.what === 'system-prompt'
        ? { systemPrompt: await conv.previewSystemPrompt(frame.conversationId) }
        : conv.assemblyToolsView();
    }
    // bench：ctx.bench 直调（bench 行不在行集时缺席 fail-loud）
    const bench = ctx.get('bench', false) as
      | { run(suite: string, options: BenchRunOptions): Promise<BenchReport> }
      | undefined;
    if (bench === undefined) throw new Error('bench 服务缺席——行集不含 bench 行');
    const report = await bench.run(frame.suite, frame.options);
    emit('bench.report', JSON.stringify(report)); // TSV 尾域 = 报告 JSON（拉起方解析）
    return report;
  };
  return {
    lockInfo, rowset, rowsReady, ctx, transportHint, fingerprint,
    emitStream: emitStreamFrame,
    control,
    close: async () => {
      // cordis 树收割：fiber 逆序 dispose（主线测试同款语义），再收 ipc。
      for (const fiber of [...fibers].reverse()) {
        if (fiber.uid !== null) await fiber.dispose();
      }
      if (shimFiber.uid !== null) await shimFiber.dispose();
      // 强制断连（M8.4 listenIpc 同款语义）：邮局投递连接池常驻连着本 server，
      // server.close 回调等连接断尽永挂——关停路径强制销毁 uplinks 安全。
      for (const sock of uplinks) sock.destroy();
      uplinks.clear();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

// —— 进程入口（CLI 直连形态：node boot.ts --data-root … --agent-id …） ——

export async function main(argv: string[]): Promise<number> {
  let args: ShellBootArgs;
  try {
    args = parseShellArgs(argv);
  } catch (err) {
    process.stderr.write('boot 参数错误：' + String(err) + '\n');
    return 2;
  }
  try {
    const result = await bootShell(args, { onExit: (h) => process.on('exit', h) });
    process.stderr.write('[shell] boot 完成：agent=' + args.agentId + ' rows=' + result.rowsReady + '\n');
    // 常驻（监护下的常命壳）：stdin = 控制通道（拉起方行协议）——
    // 'shutdown' 行 = 优雅退出；{"ctrl":...} JSON 行 = 控制帧（interrupt/bench，
    // 经 bootShell.control 执行，回执写 stdout TSV ctrl.done/ctrl.error）。
    // stdin 管道关闭：--persist（父壳拉起的子壳）不自杀——owner 失活子存活
    //（R-5：收割 = 显式 stop/delete，非连带死亡）；缺省自杀（防孤儿）。
    // 监护物理面（协议 D1/D2 钉值 cr-528）：guardian.ping 心跳 30s（stdout
    // TSV）+ idle-exit 四条件探针（15min 无 run / 无 inbox 待消费 / 无在途
    // 交互 / 无活跃 job → resolve 收割，退码 0——来件由宿主按需重拉）。
    const HEARTBEAT_MS = 30_000;
    const IDLE_EXIT_MS = 15 * 60_000;
    const IDLE_PROBE_MS = 30_000;
    let lastActiveAt = Date.now();
    const noteActive = () => { lastActiveAt = Date.now(); };
    // 活跃证据源：run 节拍（loop 事件 emit）+ durable 交互开答
    //（ask_questions 等待中 = 在途交互）。落 inbox 未消费的信封不经此面——
    // 由 idle 探针的 inbox 盘面扫描阻止收割（四面之一）。
    result.ctx.on('loop/run-started', noteActive);
    result.ctx.on('loop/after-run', noteActive);
    result.ctx.on('durable-interaction/opened', noteActive);
    result.ctx.on('durable-interaction/replied', noteActive);
    // D5 边 2 常态化（cr-612）：邮局在场 + 宿主入口已知 = 本壳承担宿主复活
    // 职责（探测/停机戳/仲裁锁/退避全在 host-revive——boot 只接线与收面）。
    // 宿主死后 stdout/stderr 管道断裂——TSV 心跳/复活信号写死管必须不崩
    //（EPIPE 是异步 error 事件，不挂 handler = uncaughtException 壳全灭）
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    const revive = args.postOffice !== undefined && args.hostBoot !== undefined
      ? startHostRevive({
          postOffice: args.postOffice,
          dataRoot: path.resolve(args.dataRoot),
          hostBoot: args.hostBoot,
          ...(args.hostPort !== undefined ? { hostPort: args.hostPort } : {}),
          emit: emitBootSignal,
        })
      : null;
    await new Promise<void>((resolve) => {
      const heartbeat = setInterval(() => {
        emitBootSignal('guardian.ping', new Date().toISOString());
      }, HEARTBEAT_MS);
      heartbeat.unref();
      const idleProbe = setInterval(() => {
        if (Date.now() - lastActiveAt < IDLE_EXIT_MS) return;
        if (shellIsIdle(result.ctx)) resolve();
      }, IDLE_PROBE_MS);
      idleProbe.unref();
      let pending = '';
      process.stdin.on('data', (c: Buffer) => {
        noteActive();
        pending += c.toString();
        let idx: number;
        while ((idx = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, idx).trim();
          pending = pending.slice(idx + 1);
          if (line === '') continue;
          if (line === 'shutdown') { resolve(); return; }
          if (!line.startsWith('{')) continue; // 非协议行忽略
          let frame: ControlFrame;
          try { frame = JSON.parse(line) as ControlFrame; } catch { continue; }
          void result.control(frame)
            .then((reply) => emitBootSignal('ctrl.done', JSON.stringify(reply)))
            .catch((err: unknown) => emitBootSignal('ctrl.error', String(err)));
        }
      });
      // stdin EOF 语义随复活职责翻转（cr-612 根因修复）：宿主死 = 管道断 =
      // EOF——带复活职责的壳把它当失联旁证（立即 kick 探测 + 保持存活，
      // idle-exit 15min 仍是收割兜底），不再自杀；无职责壳维持防孤儿自杀。
      if (args.persist !== true) process.stdin.on('end', () => {
        if (revive !== null) revive.kick();
        else resolve();
      });
      process.stdin.resume();
      process.on('SIGTERM', () => resolve());
    });
    revive?.stop();
    await result.close();
    return 0;
  } catch (err) {
    process.stderr.write('[shell] boot 失败：' + String(err) + '\n');
    return 1;
  }
}

// 直接运行时自举（import as module 时不执行）
if (process.argv[1].replaceAll('\\', '/').endsWith('boot.ts')) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
