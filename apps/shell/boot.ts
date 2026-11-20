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
  acquireActivationLock, releaseActivationLock, socketPathFor, writeBootProgress, appendRollingLine,
  makeEnvelope, issueRequestId,
  AdmissionGate, FrameDecoder, encodeFrame, isStreamFrame, makeManageReply, isManageRequest,
  streamFrameFromDelta,
  type ActivationLockInfo, type Envelope, type StreamFrame, type StreamMeta,
} from 'ac-envelope-core';
import * as net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context, FiberStates, type Fiber, type Plugin } from '@agentchat/cordis';
import { readCatalog, fitInstalledRows, readAssemblyPatch, resolveReplacements, mergeMenu, applyAssemblyLayer, menuDefinitionFingerprint, type RowDescriptor, type MenuEntry } from 'ac-rowset-core';
import { readRegistryFailSoft } from 'ac-plugin-core';
import { DEV_MODE } from 'ac-sandbox-core';
import { readAgentConfig, readChildConfig, readAgentPatchV3At, writeAgentPatchV3At, migrateAgentPatchAt, needsConfigMigration, runConfigMigration, aggregateConfigChains, type ConfigMigrationEdge } from 'ac-agents-core';
import { subjectFingerprint } from 'ac-fingerprint-core';
import { IMPORTED_ROWS, COMPANION_ROWS, COMPANION_ROW_ROOTS, rowOptionsFor, makeShimsRow, makeToolsGateRow, makeSessionQueryRow, makeArchiveRow, makePluginDevRow, makeRestartRow, makeAutoTitleRow, guardPluginModule } from 'ac-shell-rows';
import { makeHostFaceClientRow } from 'ac-host-face-client';
import { handleAdminFrame, type AdminFrame } from './admin-frame.ts';
import { shellSelfRoot, startHostRevive } from './host-revive.ts';
import { makeLedgerRow } from 'ac-ledger';
import { scriptedBenchRow, type BenchRunOptions, type BenchReport } from 'ac-bench';
import { makeConversationRow } from 'ac-shell-conversation';
import { makeSubagentRow } from 'ac-shell-subagent';
import type { LlmStreamChunk } from 'ac-llm';
import type { LoopRunRequest, LoopRunResult } from 'ac-agent-loop';

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

/** 快照落盘（原子写；审计视图——装配链快照非承重面，写失败仅警告）。
 * cr-1022 批2：工具面 = 装配后注册面 dump（行→工具归属经 fiber 名反查——
 * tools 声明词汇退役）。 */
/** 仓库根定位（config 迁移链聚合锚——上溯找 pnpm-workspace.yaml；8 层未中 = 起点自身） */
function repoRootOf(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function writeBootGraphSnapshot(
  dataRoot: string,
  agentId: string,
  parentId: string | undefined,
  rowset: ShellMenuRowset,
  rowTools: Record<string, string[]>,
): void {
  try {
    const dir = parentId !== undefined
      ? path.join(dataRoot, 'agents', parentId, 'children', agentId)
      : path.join(dataRoot, 'agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'boot-graph.json');
    const toolNames = [...new Set(Object.values(rowTools).flat())].sort();
    const body = JSON.stringify({
      agentId,
      ...(parentId !== undefined ? { parentId } : {}),
      at: new Date().toISOString(),
      rows: rowset.rowIds,
      tools: toolNames,
      rowTools,
    }, null, 2) + '\n';
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, body, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err: unknown) {
    process.stderr.write('[shell] boot-graph 快照写失败（审计面，不阻断）：' + String(err) + '\n');
  }
}

/** 菜单装配行集（cr-1022 批2：mergeMenu 合成产物——rows = 行定义投影） */
export interface ShellMenuRowset {
  rowIds: string[];
  rows: RowDescriptor[];
  notices: string[];
  errors: string[];
  replacedIds: Set<string>;
}

/** workspace 依赖闭包（cr-1022 批3 指纹足迹面）：包根 → 自身 + 递归
 * package.json dependencies（workspace:/link: 协议——运行时足迹；dev
 * 依赖不入）。环安全（visited）；解析失败链路原样保留（坏 package.json
 * 不阻断 boot——该包根自身仍入指纹）。 */
export function workspaceClosureRoots(pkgRoot: string): string[] {
  const repoRoot = (() => {
    let dir = pkgRoot;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return pkgRoot;
  })();
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (dir: string): void => {
    const resolved = path.resolve(dir);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    out.push(resolved);
    let deps: Record<string, string> = {};
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>;
      };
      deps = pkg.dependencies ?? {};
    } catch {
      return; // 无/坏 package.json——叶节点
    }
    for (const [name, spec] of Object.entries(deps)) {
      if (!spec.startsWith('workspace:') && !spec.startsWith('link:')) continue;
      // workspace 协议：包名即依赖键（spec 只是版本约束）；解析 = pnpm
      // workspace 惯例 packages/<name>（apps 域回退）
      for (const cand of [path.join(repoRoot, 'packages', name), path.join(repoRoot, 'apps', name)]) {
        if (fs.existsSync(path.join(cand, 'package.json'))) {
          walk(cand);
          break;
        }
      }
    }
  };
  walk(pkgRoot);
  return out;
}

/** 目录行 → 菜单行定义（name = link: 装载路径——installed 行 = link: 安装目录） */
function rowToMenuEntry(row: RowDescriptor): MenuEntry {
  return {
    id: row.id,
    ...(row.path !== undefined ? { name: 'link:' + row.path } : {}),
    ...(row.requires !== undefined ? { requires: row.requires } : {}),
  };
}

/**
 * 行集静态断言（R3.2：行引用存在性——纯函数；warnings 非空 = fail-loud）。
 * cr-1022 批2：菜单合成（mergeMenu）取代差量求值——骨架 ∪ patch 定义 ∪
 * installed；存量 v2 差量/config.rows 经桥换算（批3 migrate 后退役）。
 */
export function deriveAndAssertRowset(
  dataRoot: string,
  agentId: string,
  catalogFile: string | undefined,
  parentId?: string,
  configChains?: Record<string, ConfigMigrationEdge[]>,
): ShellMenuRowset {
  // cr-1022 批2：菜单合成（mergeMenu）——骨架 ∪ patch 定义 ∪ installed；
  // 用户全局层只做停用与 config（replace 先行换向）；存量 v2 差量/config.rows
  // 经 legacyToMenuDefs 桥换算（批3 migrate 换轨后退役）。
  const dataRootAbs = path.resolve(dataRoot);
  const catalogBase = readCatalog(catalogFile ?? path.join(dataRoot, 'row-catalog.json'));
  const shellRows = catalogBase.rows.filter((r) => r.tree === 'shell');
  const installed = fitInstalledRows(dataRootAbs, 'shell', agentId);
  if (installed.warnings.length > 0) {
    process.stderr.write('[shell] installed 登记对账警告：' + installed.warnings.join('；') + '\n');
  }
  // 用户全局差量层（shell.patch.yml——cr-909 停用 / cr-1003 except 豁免 +
  // replace 替换）：用户手写文档，全程警告降级不阻断 boot
  const layer = readAssemblyPatch(path.join(dataRootAbs, 'profile'), 'shell');
  const replaced = resolveReplacements(shellRows, layer.replace, dataRootAbs);
  if (layer.warnings.length > 0 || replaced.warnings.length > 0) {
    process.stderr.write('[shell] shell.patch.yml 用户差量层：'
      + [...layer.warnings, ...replaced.warnings].join('；') + '\n');
  }
  const skeletonRows = replaced.rows.filter((r) => r.zone === 'skeleton');
  const capabilityRows = replaced.rows.filter((r) => r.zone === 'capability' || r.zone === undefined);
  const skeleton = skeletonRows.map(rowToMenuEntry);
  const capability = capabilityRows.map(rowToMenuEntry);
  const installedDefs = installed.rows.map(rowToMenuEntry);
  const agentDirAbs = parentId !== undefined
    ? path.join(dataRootAbs, 'agents', parentId, 'children', agentId)
    : path.join(dataRootAbs, 'agents', agentId);
  // 实例装配：v3 菜单片段唯一读面（cr-1022 批3 + cr-1036 批3 惰性走链）：
  // v0/v1 存量 → 链驱动迁移到 v2 + config.json 收编（原子纪律同 §2.3——
  // writeAgentPatchV3At 临时文件 + fsync + rename + 留一代备份）；不可迁
  // （对账失败等）= throw fail-loud；无身份 = 原指路迁移报错
  // （cr-1067：v2 基线戳漂移门退役——基座/安装态演化经下方定义面校准
  // 自动传导，不再阻断 boot / restart_shell 自我迭代闭环）
  let v3 = readAgentPatchV3At(agentDirAbs);
  const lazyNotices: string[] = [];
  if (v3 === null) {
    const lazy = migrateAgentPatchAt({ dir: agentDirAbs, skeleton, capability });
    if (lazy !== null) {
      const trail = lazy.reports.map((r) => 'v' + r.from + '→v' + r.to).join(' ');
      lazyNotices.push('惰性迁移：agent.patch v' + lazy.fromVersion + ' → v2（' + trail + '）——config.json 已收编（cr-1036 批3）');
      for (const note of lazy.notices) lazyNotices.push('迁移 notice：' + note);
      v3 = readAgentPatchV3At(agentDirAbs);
    }
  }
  if (v3 === null) {
    const config = parentId !== undefined
      ? readChildConfig(dataRoot, parentId, agentId)
      : readAgentConfig(dataRoot, agentId);
    throw new Error(
      'agent.patch.yml v3 菜单片段缺席（惰性迁移不可达——无身份或形态不可识别'
      + (config === null ? '且配置缺席' : '——检测到旧形态配置') + '）——'
      + '先迁移（node scripts/migrate-agent-patch.mjs ' + dataRootAbs + '）：' + agentDirAbs,
    );
  }
  // 对账校准面（§2.3——定义副本是缓存，不是数据）：现算来源定义指纹 ≠
  // patch 内指纹 → 定义面自动重写为来源定义（行内 config 原样保留），
  // 来源消亡的孤儿定义丢弃——行定义无保守升级语义，保留旧定义是漂移
  const calibrationNotices: string[] = [];
  let defs = v3.defs;
  // 来源定义全集（校准与 config 迁移共用——指纹重算面）
  const sources = new Map<string, MenuEntry>();
  for (const src of [...capability, ...installedDefs]) {
    if (!sources.has(src.id)) sources.set(src.id, src);
  }
  if (defs.some((d) => d.id in v3.fingerprints)) {
    let dirty = false;
    const next: MenuEntry[] = [];
    for (const def of defs) {
      const stored = def.id in v3.fingerprints ? v3.fingerprints[def.id] : undefined;
      if (stored === undefined) {
        next.push(def); // 无溯源戳（手写 installed 定义等）——原样保留
        continue;
      }
      const source = sources.get(def.id);
      if (source === undefined) {
        calibrationNotices.push('校准：行 ' + def.id + ' 出厂/installed 来源已消亡——定义丢弃');
        dirty = true;
        continue;
      }
      if (menuDefinitionFingerprint(source) !== stored) {
        calibrationNotices.push('校准：行 ' + def.id + ' 定义重写为来源定义（config 保留）');
        next.push({ ...source, ...(def.config !== undefined ? { config: def.config } : {}) });
        dirty = true;
      } else {
        next.push(def);
      }
    }
    if (dirty) {
      defs = next;
      const fingerprints: Record<string, string> = {};
      for (const def of defs) {
        const source = sources.get(def.id);
        if (source !== undefined) fingerprints[def.id] = menuDefinitionFingerprint(source);
      }
      writeAgentPatchV3At(agentDirAbs, defs, fingerprints);
    }
  }
  // 行内 config 惰性迁移（cr-1037 批2——config 面有策略，与定义面指纹校准
  // 同节奏）：stored configVersion < 链 current → 逐边应用 → 原子落盘（同
  // writeAgentPatchV3At 备份纪律）；链缺边/不可迁 → config.legacy + notice
  // 明示手动重设（显式麻烦用户，不静默猜）。链注入缺省空 = 零迁移（无声明
  // 行的合法零态）。
  const configMigrationNotices: string[] = [];
  if (configChains !== undefined) {
    const migrated: MenuEntry[] = [];
    for (const def of defs) {
      if (!(def.id in configChains)) { migrated.push(def); continue; }
      const chain = configChains[def.id];
      if (!needsConfigMigration(chain, def.config)) { migrated.push(def); continue; }
      const out = runConfigMigration(chain, def.config, def.id);
      if (out.reports.length > 0) {
        const trail = out.reports.map((r) => 'v' + r.from + '→v' + r.to).join(' ');
        configMigrationNotices.push('config 迁移：行 ' + def.id + ' ' + trail + '——已自动升级（cr-1037）');
      }
      configMigrationNotices.push(...out.notices); // legacy 路径 notice（手动重设明示）
      migrated.push({ ...def, config: out.config });
    }
    if (migrated.some((d, i) => d !== defs[i])) {
      defs = migrated;
      const fingerprints: Record<string, string> = {};
      for (const def of defs) {
        const source = sources.get(def.id);
        if (source !== undefined) fingerprints[def.id] = menuDefinitionFingerprint(source);
      }
      writeAgentPatchV3At(agentDirAbs, defs, fingerprints);
    }
  }
  const menu = mergeMenu({ skeleton, patch: defs, installed: installedDefs });
  if (menu.errors.length > 0) {
    throw new Error('行集静态断言失败：\n  ' + menu.errors.join('\n  '));
  }
  // 用户全局层应用（停用/config；骨架区 = 恒装面——批3 起骨架即席位护栏本体）。
  // 键面自述（cr-1037 批3）：目录行 configKeys → 未知键 warn 比对源
  const seatIds = skeletonRows.map((r) => r.id);
  const rowConfigKeys = new Map(replaced.rows
    .filter((r) => r.configKeys !== undefined)
    .map((r) => [r.id, r.configKeys as string[]]));
  const applied = applyAssemblyLayer(menu, layer.entries, agentId, seatIds, rowConfigKeys);
  // cr-762：子壳行集恒剔 subagent 行（防子孙无限增长）——子壳没有 spawn 面
  //（孙辈授权语义未定义；缺省继承/显式点名/存量子 config 三路同断）。子壳仍可
  // 经 list 查父面板等读面，但永不能再 spawn。
  const entries = parentId !== undefined
    ? applied.entries.filter((entry) => entry.id !== 'subagent')
    : applied.entries;
  const skeletonIds = new Set(skeletonRows.map((r) => r.id));
  const rows: RowDescriptor[] = entries.map((entry) => ({
    id: entry.id,
    tree: 'shell' as const,
    ...(skeletonIds.has(entry.id) ? { zone: 'skeleton' as const } : {}),
    ...(entry.name !== undefined ? { path: entry.name.replace(/^link:/, '') } : {}),
    ...(entry.requires !== undefined ? { requires: entry.requires } : {}),
  }));
  return {
    rowIds: rows.map((r) => r.id),
    rows,
    // notice 单通道（cr-1037 裁决 #2）：惰性迁移/校准/config 迁移/用户层全部
    // 汇聚 rowset.notices（calibrationNotices 此前漏汇入——顺手修正）
    notices: [...lazyNotices, ...calibrationNotices, ...configMigrationNotices, ...menu.notices, ...applied.notices],
    errors: [],
    replacedIds: replaced.replacedIds,
  };
}

/**
 * 插件行装配器（cr-543）：安装目录 manifest.entry 动态 import → ctx.plugin。
 * 装载 = 授权动作（A7/A10）——第三方代码只在壳进程内进进程，宿主进程不装载；
 * 行 id / 工具面来自 installed.yml 反向适配投影（安装器登记，熔断/撞名
 * 已在宿主侧剔除）。装载失败由宿主 plugin/load-failure RPC 回报熔断（壳接线
 * 归 cutover/8.9 产品面收敛批）。
 */
export async function assemblePluginRow(row: RowDescriptor, ctx: Context): Promise<Fiber> {
  if (row.path === undefined || Array.isArray(row.path)) {
    // 插件行 path 恒单目录（安装目录单源）——数组形是出厂行的多包指代，不适用于插件
    throw new Error('插件行 path 非法（须为单安装目录）：' + row.id);
  }
  const installDir = row.path;
  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'manifest.json'), 'utf-8')) as { entry?: unknown; name?: unknown };
  const entry = typeof manifest.entry === 'string' && manifest.entry !== '' ? manifest.entry : 'index.ts';
  const mod = await import(pathToFileURL(path.join(installDir, entry)).href) as unknown as Plugin;
  // 装载边界硬闸（cr-1074 批3）：官方命名空间冒充即拒载 + fiber 名钉死
  // manifest.name（无名模块归属确定——owner/信任面/grants 查询键单源）
  const manifestName = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : row.id;
  return ctx.plugin(guardPluginModule(mod, manifestName));
}

/**
 * 插件 risk 授予快照查询工厂（cr-1074 批3 D11）：registry.json 授予面 →
 * Set<manifest.name>。fail-soft（registry 损坏 = 空集——所有插件恒不可信，
 * fail-closed 方向）。
 */
function makeRiskGranted(dataRoot: string): (owner: string) => boolean {
  const { doc } = readRegistryFailSoft(dataRoot);
  const granted = new Set<string>();
  for (const [name, rec] of Object.entries(doc.plugins)) {
    if (rec !== undefined && rec.permissions.includes('risk')) granted.add(name);
  }
  return (owner: string) => granted.has(owner);
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
 *      同包多行（web-tools/browser 共享 packages/ac-web-tools）按 Plugin 引用
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
    /** 替换行（shell-custom replace——id 命中 = 绕过 IMPORTED_ROWS 出厂实现，
     * 走 rowAssemblers 的替换件动态装载） */
    customImplIds?: ReadonlySet<string>;
  } = {},
): Promise<{ ready: number; fibers: Fiber[]; fiberNames: Record<string, string> }> {
  let ready = 0;
  const fibers: Fiber[] = [];
  // 行 id → fiber 名（cr-1022 批2：工具归属反查锚——注册面 owner 即 fiber 名）
  const fiberNames: Record<string, string> = {};
  const assembled = new Set<Plugin>();
  for (const id of rowIds) {
    if (id in IMPORTED_ROWS && ctx !== null && !opts.customImplIds?.has(id)) {
      const imported = IMPORTED_ROWS[id];
      if (!assembled.has(imported)) {
        assembled.add(imported);
        const config = opts.rowOptions?.[id];
        const fiber = config === undefined ? ctx.plugin(imported) : ctx.plugin(imported, config);
        await fiber;
        fibers.push(fiber);
        fiberNames[id] = fiber.name;
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
      if (fiber !== undefined) {
        fibers.push(fiber as Fiber);
        fiberNames[id] = (fiber as Fiber).name;
      }
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
  return { ready, fibers, fiberNames };
}

// —— boot 主体 ——

export interface ShellBootResult {
  lockInfo: ActivationLockInfo;
  rowset: ShellMenuRowset;
  rowsReady: number;
  /** 装配树（M8.1 cordis 通道——服务观测面；close() 即收割） */
  ctx: Context;
  transportHint: string;
  /** 主体指纹（R-7 boot 单元——boot.ready 自报同源） */
  fingerprint: { root: string; entries: Record<string, string> };
  /** 行 id → 工具名（cr-1114 批1：boot 收尾快照——审计面专用；承重路径走活查询回调） */
  rowTools: Record<string, string[]>;
  /** B3 流式旁带发射面（壳 → 宿主单向；无订阅连接 = 丢弃返回 false） */
  emitStream(frame: StreamFrame): boolean;
  /** 控制帧面（拉起方 → 壳：interrupt / bench——stdin 行协议的内态实现） */
  control(frame: ControlFrame): Promise<unknown>;
  /** 「已重启」注入面（cr-1163）：take = 退出路径取走未投键（并入重启
   * marker，下代投递）——注入不再与退出竞态；无注入面（CLI 直连无邮局
   * 等形态）= undefined。 */
  restartedNoteTake(): string[];
  close(): Promise<void>;
}

/** 控制帧（拉起方控制通道——非信封数据面：动作即刻执行，无 uuid/budget 语义） */
export type ControlFrame =
  | { ctrl: 'interrupt'; conversationId?: string }
  | { ctrl: 'bench'; suite: string; options: BenchRunOptions }
  | { ctrl: 'tool'; name: string; args?: Record<string, unknown>; conversationId?: string }
  /** 装配预览（cr-552 跨进程 dry-run）：system-prompt 三档链干跑 / assembly 工具目录 */
  | { ctrl: 'preview'; what: 'system-prompt'; conversationId?: string }
  | { ctrl: 'preview'; what: 'assembly-tools' }
  /** 壳内管理面（cr-569）：goal / todo 等会话桶状态——宿主 RPC 面的壳内半边 */
  | AdminFrame
  /** 系统面（换代接管 §4.1）：shutdown = 优雅退出请求（接管宿主经 socket 下发——与 stdin 'shutdown' 行同语义） */
  | { ctrl: 'system'; op: 'shutdown' };

/**
 * 壳 boot 编排（可测半边——emit/onExit 注入）。锁拒绝/断言失败 = 抛错
 *（调用方转退出码）。
 */
/** ③ answered 交互重放（cr-636）：壳换代后无人消费的作答——重投开新 run。
 * 兜在 R2 inbox 恢复之后（排队在途的答案信不在重放面，不双投）；cr-1015
 * S1 断根：并行直调时 R4 的队列在途跳过快照早于 R2 重投 → 同一答案双投
 * 双跑——R4 起跑必须晚于 inboxRecovery 兑现（回归锁在 boot.test.ts）。
 * fire-and-forget：恢复 run 走正常事件面，不阻塞 boot 返回。 */
export function replayAnsweredAfterInbox(
  convSvc: { replayAnsweredInteractions?(): Promise<number> } | undefined,
  inboxRecovery: Promise<void>,
  emit: (signal: string, ...fields: string[]) => void,
): void {
  if (convSvc?.replayAnsweredInteractions !== undefined) {
    void inboxRecovery.then(() => convSvc.replayAnsweredInteractions!()).then((n) => {
      if (n > 0) emit('interaction.replayed', String(n));
    }).catch((err: unknown) => {
      process.stderr.write('[shell] answered 交互重放失败：' + String(err) + '\n');
    });
  }
}

/**
 * 「已重启」注入面（cr-1163）：注入不再是与退出竞态的漂浮任务——本代在
 * 途工作，带取消契约（take）。时序不变量（cr-658）：注入 gated on
 * inboxRecovery；restart-ready 只在 activeRuns 全空时发出，而注入投递本
 * 身就是一个 run 在 activeRuns 上——take 时投递必不在途（无半途泄漏），
 * 未投键 = 必然还挂在恢复面队列里。退出路径同步 take：未投键并入本次重
 * 启 marker（下代投递）——通知跨代恰好一次，进程内不再有能在关闭窗起跑
 * 的游离起跑点（cr-1159 现场根修：注入撞 exit-42 关闭窗被杀 → error 假红）。
 */
export function restartedNoteDelivery(
  keys: string[],
  inboxRecovery: Promise<void>,
  receive: (uuid: string) => Promise<unknown>,
  emit: (msg: string) => void,
): { take(): string[] } {
  let pending = [...keys];
  if (pending.length === 0) return { take: () => [] };
  // 在途头（cr-1163）：restart-ready 在注入 run 收束点同步发射，此刻投递
  // 循环仍悬在 await receive 上、shift 未执行——take 若取走在途头即重复
  // 注入（下代再投一次）。在途头的 run 已收束，receive 只剩微任务收尾、
  // 必在本代完成——take 排除之。
  let delivering: string | null = null;
  void inboxRecovery.then(async () => {
    while (pending.length > 0) {
      delivering = pending[0]!;
      try {
        await receive(delivering);
        pending.shift();
      } catch (err) {
        emit('「已重启」注入失败：' + String(err));
      }
      delivering = null;
    }
  });
  return {
    take: () => {
      const un = delivering !== null ? pending.slice(1) : [...pending];
      pending = [];
      return un;
    },
  };
}

export async function bootShell(
  args: ShellBootArgs,
  opts: {
    onExit?: (handler: () => void) => void;
    /** 优雅退出请求面（换代接管：system/shutdown 帧 → 进程入口 resolve 0） */
    onShutdown?: () => void;
  } = {},
): Promise<ShellBootResult> {
  // cr-1129 批 4：stdout TSV 信号面退役——节拍/装载失败/指纹全量落
  // boot-progress.json（批 1/2 已就位），诊断行走 stderr。
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
  opts.onExit?.(() => releaseActivationLock(agentDir, process.pid));
  // cr-651：本壳即 restart_shell 的换代结果——复活标记已兑现，自清（宿主
  // boot 扫标记兜底重拉时，标记在我们 boot 完成后不再需要）。自清前读出
  // 会话键（cr-658）——恢复面据此注入「已重启」续跑通知。
  let restartedConversations: string[] = [];
  try {
    // cr-663：标记可能已被宿主原子领取成 <agentId>.<pid>.claimed——两种名
    // 形态都认（领者宿主只 rename 不删，兑现与自清仍归本壳）。多标记同名
    // 前缀取最新 mtime 一份，其余清扫。
    const markerDir = path.join(path.resolve(args.dataRoot), '.runtime', 'restart-shell');
    const candidates = fs.readdirSync(markerDir)
      .filter((n) => n === args.agentId + '.json' || n === args.agentId + '.claimed' || (n.startsWith(args.agentId + '.') && n.endsWith('.claimed')))
      .map((n) => ({ n, mtime: fs.statSync(path.join(markerDir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) {
      const markerPath = path.join(markerDir, candidates[0]!.n);
      try {
        // cr-1159：键集读取（conversationIds[]）+ 旧单值形态兼容（存代壳
        // 写的 marker）——去重去空。
        const raw = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { conversationId?: unknown; conversationIds?: unknown };
        const keys = new Set<string>();
        if (typeof raw.conversationId === 'string' && raw.conversationId !== '') keys.add(raw.conversationId);
        if (Array.isArray(raw.conversationIds)) {
          for (const k of raw.conversationIds) if (typeof k === 'string' && k !== '') keys.add(k);
        }
        restartedConversations = [...keys];
      } catch { /* 坏标记——仍清文件 */ }
      for (const c of candidates) fs.rmSync(path.join(markerDir, c.n), { force: true });
    }
  } catch { /* 无标记目录 */ }

  // 行内 config 迁移链聚合（cr-1037 批2：仓库内声明扫描——dev/部署态同树）。
  // 聚合失败（坏声明/坏模块）= boot fail-loud：链声明是构建物的一部分。
  const configChains = (await aggregateConfigChains(repoRootOf(import.meta.url))).chains;
  const rowset = deriveAndAssertRowset(args.dataRoot, args.agentId, args.catalogFile, args.parentId, configChains);
  // 编译产物快照（cr-909 批6 切片四 / cr-901 §4.3 审计视图）：派生终态
  // 落盘「这个 Agent 实际装了什么」——行集 + 目录行摘要 + 警告，主壳
  // agents/<id>/ 与子壳 children/<parentId>/<id>/ 分域；每 boot 覆写。
  seedPlaceholderAssemblers(rowset.rows);
  // 插件行装配器（cr-543）：行集内出现的插件行（installed 菜单注入、非出
  // 厂目录行）按安装目录动态装载。
  // 装载失败（cr-550）：emit plugin.load-failed TSV 行 + 跳行——插件熔断
  // 归宿主裁决（阈值 3 → 行集条目剔除），壳自身 boot 不被第三方插件拖死
  //（fail-closed 对插件：该行缺席即其工具面缺席；宿主回报面由常驻监护
  // supervise 消费本节拍转发 pluginRegistry.reportLoadFailure）。
  // 装载失败清单（cr-1126 双写期）：emit 之外同步入 boot-progress 文件
  //（批 4 stdout 行退役后文件为唯一承载——宿主读进度即得）。
  const pluginLoadFailures: Array<{ plugin: string; error: string }> = [];
  const menuRows = fitInstalledRows(path.resolve(args.dataRoot), 'shell', args.agentId).rows;
  for (const pluginRow of menuRows) {
    if (!rowset.rowIds.includes(pluginRow.id)) continue;
    registerRowAssembler(pluginRow.id, async (c) => {
      try {
        return await assemblePluginRow(pluginRow, c as Context);
      } catch (err) {
        const name = path.basename(path.dirname(pluginRow.path as string));
        pluginLoadFailures.push({ plugin: name, error: String(err).slice(0, 200) });
        return undefined; // 跳行（无 fiber——assembleRows 的 void 分支）
      }
    });
  }
  // 替换行装配器（cr-1003 shell-custom replace）：被替换的基座行绕过
  // IMPORTED_ROWS 出厂实现，按换向后的 path 动态装载替换件（装载失败
  // 同款跳行 + plugin.load-failed 回报——替换件按插件同fail-closed口径）
  for (const row of rowset.rows) {
    if (!rowset.replacedIds.has(row.id) || !rowset.rowIds.includes(row.id)) continue;
    registerRowAssembler(row.id, async (c) => {
      try {
        return await assemblePluginRow(row, c as Context);
      } catch (err) {
        pluginLoadFailures.push({ plugin: row.id, error: String(err).slice(0, 200) });
        return undefined;
      }
    });
  }
  // M8.1：cordis 装配通道——垫片行（agents/agentStore 数据根直读）先装，
  // 沿用行（IMPORTED_ROWS）按行集清单逐行 ctx.plugin；数据根行 options 显式
  // 注入（preview 数据根隔离红线——不走环境变量缺省）。
  const ctx = new Context();
  // 行 id → 工具名投影（cr-590 → cr-1022 批2 → cr-1114 批1 活查询化）：
  // boot 一次性回填退役——懒注册行（host-face-client 承诺面 / MCP）追不上
  // 静态快照（cr-1114 根因 1）。承重面改活查询：rowToolFace 回调 use-time
  // 现算（listWithOwner 按 fiber 归属分组 → fiber 名经 fiberNames 桥回行 id）。
  // boot 回填只剩审计快照职责（boot-graph.json 落盘——非承重面）。
  const allRowIds: string[] = rowset.rowIds;
  const rowToolFace = (): Record<string, string[]> => {
    const toolsSvc = ctx.get('tools', false) as
      | { listWithOwner(): Array<{ name: string; owner: string }> }
      | undefined;
    if (toolsSvc === undefined) return {};
    // fiber 名 → 行 id 集（同包多行并集——行粒度随声明词汇退役，cr-1025 裁决）
    const byFiber = new Map<string, string[]>();
    for (const [id, fiberName] of Object.entries(fiberNames)) {
      const list = byFiber.get(fiberName);
      if (list === undefined) byFiber.set(fiberName, [id]);
      else list.push(id);
    }
    const out: Record<string, string[]> = {};
    for (const t of toolsSvc.listWithOwner()) {
      const rowIds = byFiber.get(t.owner);
      if (rowIds === undefined) continue; // 动态插件等未桥接 owner——不可白名单点名
      for (const id of rowIds) (out[id] ??= []).push(t.name);
    }
    return out;
  };
  const shimFiber = ctx.plugin(makeShimsRow(path.resolve(args.dataRoot), rowToolFace, args.postOffice, args.parentId));
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
  // 行 id → 工具名投影词汇见 ctx 创建处（rowToolFace 活查询——垫片与 conversation 共用）。
  registerRowAssembler('conversation', (c) => (c as Context).plugin(makeConversationRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
    ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
    ...(args.postOffice !== undefined ? { postOfficeAddress: args.postOffice } : {}),
    catalogFile: args.catalogFile ?? path.join(path.resolve(args.dataRoot), 'row-catalog.json'),
    rowToolFace,
    allRowIds,
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
  // 安全重启行（cr-629）：restart_shell（中止回队 + 重启码退出）/
  // restart_host（信封请求宿主 graceful 重启）
  registerRowAssembler('restart', (c) => (c as Context).plugin(makeRestartRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
    ...(args.postOffice !== undefined ? { postOfficeAddress: args.postOffice } : {}),
  })));
  // 会话命名行（cr-672）：首步后 LLM 一句概括（含 Agent 首步理解）→ 信封请求
  // 宿主 singles 行落盘（标题写权归宿主；无邮局形态不命名——标题留派生面）
  registerRowAssembler('auto-title', (c) => (c as Context).plugin(makeAutoTitleRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
    ...(args.postOffice !== undefined ? { postOfficeAddress: args.postOffice } : {}),
  })));
  // 宿主能力面壳侧行（cr-886）：discover 宿主契约 → 代理工具（timer/
  // update_agent_profile）+ 远程段 + singles/group Shim；invalidate 重拉；
  // 宿主缺席软降级（零装配——CLI 直连形态现状不变）
  registerRowAssembler('host-face-client', (c) => (c as Context).plugin(makeHostFaceClientRow({
    dataRoot: path.resolve(args.dataRoot),
  })));
  // subagent 行（M8.3）：子壳 boot 入口/catalog 显式注入（本文件与同树 catalog
  // ——import.meta.url 相对定位；父壳拉子壳的标准链）。
  registerRowAssembler('subagent', (c) => (c as Context).plugin(makeSubagentRow({
    dataRoot: path.resolve(args.dataRoot), agentId: args.agentId,
    bootFile: fileURLToPath(new URL(import.meta.url)), catalogFile: args.catalogFile ?? path.join(path.resolve(args.dataRoot), 'row-catalog.json'),
    shellRows: rowset.rows, // cr-1022 批4：活装配行集（spawn 词面/子物化定义源）
    ...(args.postOffice !== undefined ? { postOfficeAddress: args.postOffice } : {}),
  })));
  const { ready: rowsReady, fibers, fiberNames } = await assembleRows(rowset.rowIds, ctx, {
    // durable-interaction 等 per-agent 域行随 agent 域锚定（影子 = 物化域，
    // 与 ledger agentDirOverride 同源——D4 每实例只写自己域）；fs/shell 族
    // 沙箱基准单源 = WorkspaceShim（files/<agentId> 懒建——cr-754 退役
    // 行 options 注入面）
    rowOptions: {
      ...rowOptionsFor(path.resolve(args.dataRoot), agentDir),
      // 权限门精确信任面（cr-1074 批3 D11）：插件 risk 授予查询——boot 期
      // 读 registry 快照一次（插件重装需重启壳才装载，快照与装载面同步）
      'permission-gate': { riskGranted: makeRiskGranted(path.resolve(args.dataRoot)) },
    },
    customImplIds: rowset.replacedIds,
  });
  // 审计快照（cr-1114 批1 改动6）：rowTools 回填退役为 boot-graph 专用——
  // 承重路径（垫片/conversation）已换 rowToolFace 活查询，此处一次性快照仅审计落盘。
  writeBootGraphSnapshot(path.resolve(args.dataRoot), args.agentId, args.parentId, rowset, rowToolFace());
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
            // 延迟档（cr-668）：AGENTCHAT_MOCK_DELAY_MS 首流前挂起——活体诊断
            //（restart/断线实验造 mid-run 窗口；缺省 0 = 即时回声）。
            const delay = Number(process.env.AGENTCHAT_MOCK_DELAY_MS ?? '0');
            if (Number.isFinite(delay) && delay > 0) await new Promise((r) => setTimeout(r, delay));
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
  // cr-1126 节拍 2 落 boot-progress（原子覆写；批 1 宿主探测面已消费）
  writeBootProgress(agentDir, { bootId, writtenAt: new Date().toISOString(), rows: rowsReady, pluginLoadFailures });

  // 主体指纹自报（R-7：入指纹 = 行集推导一切——config + catalog + 行包内容；
  // 无 path 的占位行不入行集指纹面〔未实现 = 未生效〕）。boot.ready 第四域。
  const fingerprint = subjectFingerprint({
    // cr-918/920：身份源 = readAgentConfig（patch 赢 + 单元文件合成——
    // config.json 镜像退役后裸读必 ENOENT；指纹值随身份形态换代漂移一次
    // 属预期，R-7 自报漂移即信号）
    configJson: JSON.stringify(readAgentConfig(path.resolve(args.dataRoot), args.agentId)),
    catalogJson: fs.readFileSync(args.catalogFile ?? path.join(args.dataRoot, 'row-catalog.json'), 'utf-8'),
    // cr-1022 批3：行包足迹 = 条目包根 × package.json workspace 依赖闭包
    //（纯库链接〔edit-core 级〕全入指纹面——packs 数组盲区闭合）∪ 伴生
    // 行包根（装配代码真值——非依赖、闭包不可达）
    rows: rowset.rows
      .filter((row) => row.path !== undefined)
      .flatMap((row) => {
        const roots = [...workspaceClosureRoots(path.resolve(row.path!))];
        const companion = row.id in COMPANION_ROW_ROOTS ? COMPANION_ROW_ROOTS[row.id] : undefined;
        if (companion !== undefined) roots.push(...workspaceClosureRoots(path.resolve(companion)));
        return roots.map((root, i) => ({ id: i === 0 ? row.id : row.id + '/' + path.basename(root), root }));
      }),
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
  // 控制面（cr-675）：同一个 control() 既服务 stdin 控制帧（拉起方管道），
  // 也服务 transportHint socket 上的 manage 帧——外壳换代后活壳仍可受控。
  const control = async (frame: ControlFrame): Promise<unknown> => {
    if (frame.ctrl === 'system') {
      if (opts.onShutdown === undefined) throw new Error('system 帧无面（进程入口未接优雅退出）');
      opts.onShutdown();
      return { shutdown: true };
    }
    if (frame.ctrl === 'admin') return handleAdminFrame(ctx, frame);
    if (frame.ctrl === 'interrupt') {
      const conv = ctx.get('conversation', false) as
        | { interrupt(conversationId?: string): boolean }
        | undefined;
      if (conv === undefined) throw new Error('conversation 服务缺席——interrupt 无面');
      return { interrupted: conv.interrupt(frame.conversationId) };
    }
    if (frame.ctrl === 'tool') {
      const tools = ctx.get('tools', false) as
        | { execute(call: { name: string; args: Record<string, unknown>; conversationId?: string }): Promise<unknown> }
        | undefined;
      if (tools === undefined) throw new Error('tools 服务缺席——行集不含 tools 行');
      // conversationId 透传（cr-763）：工具的会话身份决定 conv-settings 继承
      //（subagent spawn 等会话域分支）——控制帧不带键 = 宿主直调形态，
      // 覆盖不到「发起会话设置 → 子工具面」链路。缺席照旧不传（向后兼容）。
      return tools.execute({
        name: frame.name,
        args: frame.args ?? {},
        ...(frame.conversationId !== undefined && frame.conversationId !== '' ? { conversationId: frame.conversationId } : {}),
      });
    }
    // preview（cr-552）：装配链住壳进程——宿主 agent-admin 行经控制帧往返取预览。
    // 干跑只读：不落账、不占串行化门、无 LLM 调用。
    if (frame.ctrl === 'preview') {
      const conv = ctx.get('conversation', false) as
        | {
            previewSystemPrompt(conversationId?: string): Promise<string>;
            assemblyToolsView(): { rows: Array<{ name: string; description: string; parameters: Record<string, unknown> }>; enabled: string[] };
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
    return report;
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
        // 控制面 socket 帧（cr-675）：宿主换代后活壳的 stdin 管道已随旧宿主
        // 消失，管理往返改走本壳 transportHint（与信封同一条 ipc 连接）——
        // 入口与控制帧同一个 control()，不另开语义。回执由请求方按 id 取。
        if (isManageRequest(frame)) {
          const { id, frame: ctrl } = frame.manage;
          void control(ctrl as ControlFrame).then(
            (value) => {
              try { socket.write(encodeFrame(makeManageReply(id, { ok: true, value }))); } catch { /* 连接已断——回执丢（请求方超时） */ }
            },
            (err: unknown) => {
              const error = err instanceof Error ? err.message : String(err);
              try { socket.write(encodeFrame(makeManageReply(id, { ok: false, error }))); } catch { /* 同上 */ }
            },
          );
          continue;
        }
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
  // run 收束旁带（cr-591）随 cr-976 B 案退役：前端收敛信号 = run-end 行
  // durable 落盘（ledger/event-appended 投影出 run/settled 帧——与重拉权威
  // 同一因果链，E-2 根治）；瞬态 run-settled 旁带帧不再双发。
  // 事件日志落账旁带（cr-976 B 案，D3-2 壳 ipc 事件面）：ledger/event-appended
  // → ledger-event 帧（宿主投影转发成 step/journaled · tool/result ·
  // run/settled——帧 = 事件日志 append 的视图，seq 锚直通）。发射失败静默
  //（瞬态——帧丢失由重连重拉/探针兜底，事实永不丢：已在日志）。
  ctx.on('ledger/event-appended', (p: { conversationId: string; rows: Array<Record<string, unknown>> }) => {
    const withRun = p.rows.find((r) => typeof r.run === 'string' && r.run !== '');
    const withStep = p.rows.find((r) => typeof r.stepId === 'string' && r.stepId !== '');
    emitStreamFrame({
      stream: (withRun?.run as string | undefined) ?? p.conversationId,
      kind: 'ledger-event',
      rows: p.rows,
      meta: {
        agent: args.agentId,
        conversationId: p.conversationId,
        ...(withRun !== undefined ? { runId: withRun.run as string } : {}),
        ...(withStep !== undefined ? { stepId: withStep.stepId as string } : {}),
      },
    });
  });
  // run 生命周期旁带（cr-592）：loop/run-started → run-started 帧（宿主桥接
  // 成主线 loop/run-started 前端帧——run 级忙态点亮 + 计时锚重置；流时序
  // 帧，D3-1 两时标承认不经落盘。step-started/after-step 旁带随 cr-976 退役
  // ——durable 步事实走 ledger-event，载体创建改前端惰性（delta 按 stepId
  // 直达）。发射失败静默（瞬态）。
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
  // 工具执行旁带（cr-593）：tool/started·progress → 对应帧（宿主直转主线
  // 同名前端帧——run_code 子调用占位 / 长任务进度；流时序帧，D3-1 两时标
  // 承认不经落盘）。after-execute 前端旁带随 cr-976 退役——工具终值 =
  // durable 事实（step/tool-call-result 行经 ledger-event 投影 tool/result）。
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
  // 上下文注入旁带（cr-625）：session/context-injected → context-injected 帧
  //（宿主直转主线同名前端帧——前端 feed 事件分隔行：已收到用户回答等
  // label 直出；主线 ws-bridge wire 恒等透传同形）。发射失败静默（瞬态）。
  ctx.on('session/context-injected', (
    conversationId: string,
    agent: string | undefined,
    meta: { source: string; injectionId?: string; label?: string } | undefined,
  ) => {
    if (conversationId === '' || meta === undefined) return;
    emitStreamFrame({
      stream: conversationId,
      kind: 'context-injected',
      source: meta.source,
      ...(meta.label !== undefined ? { label: meta.label } : {}),
      ...(meta.injectionId !== undefined ? { injectionId: meta.injectionId } : {}),
      meta: { agent: agent ?? args.agentId, conversationId },
    });
  });
  // 后台任务旁带（cr-677）：job/started · job/settled（壳内 ac-jobs 行 emit）
  // → job-event 帧（宿主桥接成主线同名前端帧——jobBoard 帧驱动刷新唯一源；
  // bash 后台与 subagent 委派统一词汇，job = JobSnapshot 透传）。发射失败
  // 静默（瞬态）。
  ctx.on('job/started', (job: { id?: string }) => {
    if (job.id === undefined) return;
    emitStreamFrame({ stream: job.id, kind: 'job-event', phase: 'started', job, meta: { agent: args.agentId } });
  });
  ctx.on('job/settled', (job: { id?: string }) => {
    if (job.id === undefined) return;
    emitStreamFrame({ stream: job.id, kind: 'job-event', phase: 'settled', job, meta: { agent: args.agentId } });
  });
  // 子Agent 清单变更旁带（cr-677）：subagents/updated（壳内 subagent 行 emit）
  // → subagents-updated 帧（宿主桥接成主线同名前端帧——subagentBoard 帧驱动
  // 刷新唯一源）。info/action 原样透传。发射失败静默（瞬态）。
  ctx.on('subagents/updated', (info: { id?: string; parentId?: string }, action: string) => {
    if (info.id === undefined) return;
    emitStreamFrame({
      stream: info.id,
      kind: 'subagents-updated',
      info,
      action,
      meta: { agent: info.parentId ?? args.agentId },
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(transportHint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // cr-1126 终拍进度（rows + fingerprint + 装载失败清单全量）落盘
  writeBootProgress(agentDir, { bootId, writtenAt: new Date().toISOString(), rows: rowsReady, fingerprintRoot: fingerprint.root, pluginLoadFailures });
  // boot 恢复面（cr-629；cr-974 起孤儿收口退役——D-3 读方配平：上代壳
  // 死于 mid-run 的未闭合 run 不回写，读侧（fold）合成 run-end(interrupted)
  // 投影）。pending inbox 重投——已落账未消费的信（排队/steer 落空/安全
  // 重启回队）经标准收信链续跑（此前 pending inbox 只阻止 idle-exit、
  // 无人消费 = 死信）。fire-and-forget：恢复 run 走正常事件面，不阻塞
  // boot 返回。
  const convSvc = ctx.get('conversation', false) as
    | { recoverPendingInbox?(): Promise<number>; reconcileUndelivered?(): Promise<number>; replayAnsweredInteractions?(): Promise<number>; receiveEnvelope?(env: unknown, ack: { fresh: boolean }): Promise<unknown> }
    | undefined;
  const inboxRecovery: Promise<void> = convSvc?.recoverPendingInbox !== undefined
    ? convSvc.recoverPendingInbox()
        .catch((err: unknown) => {
          process.stderr.write('[shell] inbox 恢复面失败：' + String(err) + '\n');
          return 0;
        })
        .then((n) => {
          if (n > 0) process.stderr.write('[shell] inbox 恢复补投：' + n + ' 封\n');
        })
    : Promise.resolve();
  // ④ 收尾一致性对账（cr-666，leftovers C2）：crash 窗口「只落账未执行」
  // 的入站信（无 run 轨迹、不在队列/收件箱）确定性补投——兜在 inbox 恢复
  // 之后（在途信先由既有恢复面消费，对账只收残余死信）。
  if (convSvc?.reconcileUndelivered !== undefined) {
    void inboxRecovery
      .then(() => convSvc.reconcileUndelivered!())
      .then((n) => { if (n > 0) process.stderr.write('[shell] 收尾对账补投：' + n + ' 封\n'); })
      .catch((err: unknown) => {
        process.stderr.write('[shell] 收尾对账补投失败：' + String(err) + '\n');
      });
  }
  // ③「已重启」续跑注入（cr-658）：restart_shell 自然收束兑现——本壳是
  // 换代结果且 marker 带会话键时，向该会话投「已重启」通知（sender = 桶
  // 对端，timer/goal 的 KV 前缀裁决同款），开续跑轮（续跑上下文 = 轨迹
  // 读面，模型按上一轮终稿继续）。兜在 inbox 恢复之后：排队信先消费，
  // 注入不插队。cr-1163：注入经 delivery 面（带 take 契约）——本代退出时
  // 未投键由退出路径取走并入 marker，跨代恰好一次。
  const restartedDelivery = typeof convSvc?.receiveEnvelope === 'function'
    ? restartedNoteDelivery(
        restartedConversations,
        inboxRecovery,
        (uuid) => convSvc.receiveEnvelope!(makeEnvelope({
          uuid,
          requestId: 'restarted-' + issueRequestId(),
          sender: restartNoteSender(uuid, args.agentId),
          to: args.agentId,
          kind: 'message',
          budget: 1,
          // cr-946：机制通知标记——壳自身合成的催办信不是会话发言：壳按机制行
          //（context+event）落账，webui 投为事件分隔符（同时是两轮 run 的边界）。
          payload: {
            text: '壳已重启完成（restart_shell 已兑现）：行集与运行时状态已重载。上一轮 run 已自然收束，其终稿与完整工具轨迹都在上下文中——直接按终稿中的下一步继续任务即可，勿重做已完成步骤、勿再次 restart_shell。',
            mechanism: true,
          },
        }), { fresh: true }),
        (msg) => process.stderr.write('[shell] ' + msg + '\n'),
      )
    : undefined;
  // cr-1129 批 4：重放计数走 stderr 诊断（stdout 信号面退役；纯域函数签名不变）
  replayAnsweredAfterInbox(convSvc, inboxRecovery, (s) => process.stderr.write('[shell] ' + s + '\n'));
  // run 节拍订阅（cr-740 运维面）：loop 事件 → stdout TSV（emit 注入面——纯域
  // 可测）。字段语义：
  //   run.started  <runId> <conversationId> <source> <model>
  //   run.settled  <runId> <conversationId> <finish> <steps> <totalTokens> <elapsedMs> [error]
  // 机制 run（meta.ARCHIVE_REVIEW_META——归档整理）照发：运维面关心活动量与
  // 失败率，来源经 source 字段可辨。宿主侧 onRunbeat 落 runbeat 日志。
  // cr-1127 批 3：runbeat 壳侧直写（宿主 sink 退役）——同一行数据本壳落
  // dataRoot/.runtime/logs/runbeat-<agentId>.log（滚动语义与宿主旧 sink 同源
  // appendRollingLine）；TSV emit 双写保留至批 4。
  const runbeatFile = path.join(path.resolve(args.dataRoot), '.runtime', 'logs', 'runbeat-' + args.agentId + '.log');
  const runbeat = (line: string): void => {
    appendRollingLine(runbeatFile, new Date().toISOString() + ' ' + line, 512 * 1024);
  };
  ctx.on('loop/run-started', (request: LoopRunRequest) => {
    runbeat(['run.started',
      request.runId ?? '', request.conversationId ?? '', request.source ?? '', request.model].join('\t'));
  });
  ctx.on('loop/after-run', (request: LoopRunRequest, result: LoopRunResult) => {
    const fields = [
      request.runId ?? '', request.conversationId ?? '', result.finish,
      String(result.usage.steps), String(result.usage.totalAccumulated ?? result.usage.prompt),
      result.usage.elapsedMs !== undefined ? String(result.usage.elapsedMs) : '',
      ...(result.error !== undefined ? [String(result.error).replaceAll('\t', ' ').replaceAll('\n', ' ').slice(0, 300)] : []),
    ];
    runbeat(['run.settled', ...fields].join('\t'));
  });
  return {
    lockInfo, rowset, rowsReady, ctx, transportHint, fingerprint, rowTools: rowToolFace(),
    emitStream: emitStreamFrame,
    control,
    restartedNoteTake: () => restartedDelivery?.take() ?? [],
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

/** restart_shell 退出前向宿主发「重拉本壳」请求（cr-648）：接管常态化
 *（cr-967——宿主恒有活壳句柄）后 warden 快路已接 exit 42，本请求是
 * 「句柄恰好缺席」边缘的保险面。宿主收信后在锁释放后按需 ensureAgent；
 * CLI 直连形态（无邮局）跳过。
 * cr-651：请求可能撞宿主换代窗口（restart_host 的 exit 42 与新壳拉起之间）而
 * 丢失——先落盘复活标记（dataRoot/.runtime/restart-shell/<agent>.json），新
 * 宿主 boot 扫标记兜底重拉；宿主收信成功则由钩子删除标记。 */
async function notifyHostRestartShell(args: ShellBootArgs, conversationIds: string[]): Promise<void> {
  if (args.postOffice === undefined) return;
  const marker = path.join(path.resolve(args.dataRoot), '.runtime', 'restart-shell', args.agentId + '.json');
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    // cr-658/cr-1159：发起方键集随 marker 落盘——新壳 boot 兑现标记后逐键
    // 注入「已重启」续跑通知（宿主扫描面只认文件名，零改动）。空集照写
    // （无发起方语义 = 旧空闲直发形态，新壳不注入仅换代）。
    fs.writeFileSync(marker, JSON.stringify({ agentId: args.agentId, at: new Date().toISOString(), conversationIds }), 'utf-8');
  } catch (err) {
    process.stderr.write('[shell] restart_shell 复活标记写入失败：' + String(err) + '\n');
  }
  try {
    const { IpcClient } = await import('ac-envelope-core');
    const client = new IpcClient();
    await client.connect(args.postOffice);
    await client.send(makeEnvelope({
      uuid: 'restart-shell-' + args.agentId,
      requestId: 'restart-shell-' + issueRequestId(),
      sender: args.agentId,
      to: 'host',
      kind: 'message',
      budget: 0,
      payload: { restartShell: true, agentId: args.agentId },
    }));
    client.close();
  } catch (err) {
    // 宿主换代窗口内连接失败：标记已落盘，由新宿主 boot 扫标记兜底
    process.stderr.write('[shell] restart_shell 宿主重拉请求发送失败（标记兜底）：' + String(err) + '\n');
  }
}

/** restartNoteSender（cr-658）：「已重启」注入信封的 sender = 桶对端
 * （主线 goalRoundSender 2026-09-03 KV 前缀裁决同款——对键取 ≠agent 一侧、
 * 自会话对角线取自身、非对键取 'user'），保证 system 渲染与 KV 前缀不翻转。 */
function restartNoteSender(conversationId: string, agentId: string): string {
  const parts = conversationId.split('~');
  if (parts.length === 2) {
    if (parts[0] === parts[1]) return agentId;
    return parts[0] === agentId ? parts[1]! : parts[0]!;
  }
  return 'user';
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
    let gracefulExit: (code: number) => void = () => {};
    // 退出意图优先级（cr-994）：42（restart_shell）一旦设立不可被 0 覆盖——
    // 接管宿主的 system/shutdown 帧（takeover 优雅收面）与 restart-ready 竞态
    // 时，0 先 resolve 会让 warden 判 done 不重拉，重启退化为等来件（实测
    // 31 分钟空窗）。首个意图生效（first-wins），restart 排程在 run 收束点
    // 同步设立，早于任何后续 shutdown 帧。
    let exitIntent: number | null = null;
    const decideExit = (code: number): void => {
      if (exitIntent !== null) return;
      exitIntent = code;
      gracefulExit(code);
    };
    const result = await bootShell(args, {
      onExit: (h) => process.on('exit', h),
      // system/shutdown 帧（换代接管）：与 stdin 'shutdown' 行同语义——延时
      // resolve 让 manage 回执先冲出 socket（宿主侧不依赖回执，丢亦无害）。
      onShutdown: () => { setTimeout(() => decideExit(0), 200); },
    });
    process.stderr.write('[shell] boot 完成：agent=' + args.agentId + ' rows=' + result.rowsReady + '\n');
    // cr-1097：开发者模式警示——env 进程级开关（AGENTCHAT_DEV_MODE=1），
    // 系统域双禁默认表不注入。boot 行显著提示，防误用态被当成守卫态。
    if (DEV_MODE) process.stderr.write('[shell] AGENTCHAT_DEV_MODE=1 开发者模式：系统域访问双禁已解除（凭据面恒禁不变）\n');
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
          // system 让路（cr-647 宽限 + cr-859 判定基础升级）：system 在场
          //（仓库根 .runtime 锁内 pid 活 ∧ 数据根心跳新鲜——双证据）时
          // supervisor 是快路（宿主退出码 42 → 1.5s 重拉），壳侧宽限 10s
          // 再兜底——否则 stdin EOF kick 抢跑，supervisor 重拉撞
          // EADDRINUSE 退出 78（监督栈永久消失，终端拓扑下连带全壳死）。
          // system 缺席（dev:fg 直跑 / bundle 前台直跑 / supervisor 死亡或
          // 挂起）= 恢复边降级到本壳（即时复活）。判定每拍现探——
          // AGENTCHAT_SUPERVISED env 继承链退役（第三方重拉壳后失真，§三.1）。
          // 锚定（cr-995 shellSelfRoot 三形态单源）：bundle 安装
          // （AGENTCHAT_HOME）/ dev bundle（dist 上级 = 仓库根）/ 源码
          // （apps/shell 上两级）。bundle 安装形态产品入口暂无 supervisor
          // （§七.3 开放裁决）——锁缺席 = 恒判缺席 = 恢复边即时，语义正确。
          // 裸 '../../' 锚在 dev bundle（cr-961）指向仓库外 → systemAlive
          // 恒假 → 复活抢跑 supervisor（2026-11-10 现场，cr-995）。
          systemLockFile: path.join(shellSelfRoot(), '.runtime'),
          // cr-1129 批 4：revive 观测信号走 stderr 诊断线（stdout 信号面退役）
          emit: (s) => process.stderr.write('[shell] ' + s + '\n'),
        })
      : null;
    // 安全重启退出码（cr-629）：conversation/restart-ready → 优雅退出 42
    //（宿主 warden 42 = 有意重启——立即 respawn、不计崩溃熔断）。
    // cr-648：退出前先向宿主发重拉请求兜底——换代接管（cr-967）后宿主
    // 恒有本壳句柄（exit 42 → warden 快路 respawn），此请求仅剩「句柄
    // 恰好缺席」边缘的保险面。
    const exitCode = await new Promise<number>((resolve) => {
      gracefulExit = resolve;
      result.ctx.on('conversation/restart-ready', (p: { conversationIds?: string[] }) => {
        // cr-1163：退出前同步 take 本代未投的「已重启」注入键——并入本次
        // 重启 marker（下代投递），通知跨代恰好一次；take 后注入面已空，
        // 关闭窗内不再有注入起跑点（不再产生 aborted 假红）。
        const merge = [...new Set([...(p.conversationIds ?? []), ...result.restartedNoteTake()])];
        void notifyHostRestartShell(args, merge).finally(() => decideExit(42));
      });
      // 锁路径同源 bootShell（影子形态 = children 域；main 作用域无 agentDir）
      const lockFile = path.join(
        args.parentId !== undefined
          ? path.join(path.resolve(args.dataRoot), 'agents', args.parentId, 'children', args.agentId)
          : path.join(path.resolve(args.dataRoot), 'agents', args.agentId),
        'activation.lock',
      );
      const heartbeat = setInterval(() => {
        // cr-1126 文件心跳（§2.4）：30s touch 锁 mtime——零协议喂活源 ①
        //（宿主读锁 stat 即得；touch 失败静默——判活另有 peek 双源兜底）。
        try { fs.utimesSync(lockFile, new Date(), new Date()); } catch { /* 锁已换代/缺席 */ }
      }, HEARTBEAT_MS);
      heartbeat.unref();
      const idleProbe = setInterval(() => {
        if (Date.now() - lastActiveAt < IDLE_EXIT_MS) return;
        if (shellIsIdle(result.ctx)) decideExit(0);
      }, IDLE_PROBE_MS);
      idleProbe.unref();
      // cr-1129 批 4：stdin 帧循环退役——控制帧/关停全量走 manage 通道
      //（cr-1128 批 3b 已切换）；stdin EOF 防孤儿自杀语义随之消亡（计划
      // §2.3——owner 失活判定改锁观察，孤儿收割兜底 = idle-exit 15min）。
      process.on('SIGTERM', () => decideExit(0));
    });
    revive?.stop();
    await result.close();
    return exitCode;
  } catch (err) {
    process.stderr.write('[shell] boot 失败：' + String(err) + '\n');
    return 1;
  }
}

// 直接运行时自举（import as module 时不执行）。路径等价门（cr-705）：
// 此前 endsWith('boot.ts') 在 bundle 形态（dist/shell.mjs）恒假——壳 bundle
// 零输出直退 0，spawn 链静默失败（e2e-bundle 抓到的实锤）。宿主 boot 同款
// resolve 等价比较，双形态通吃。
if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
