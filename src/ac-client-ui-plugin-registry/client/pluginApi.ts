// ============================================================
// ac-client-ui-plugin-registry/client/pluginApi.ts —— 插件域数据面
//（M29 P1-3a 自 settings/api.ts 归域迁入——T3「数据面跟域走」兑现：
// 视图已随行（M28 P2），数据面随视图归位）
//
// 形态：rpc 必传（RpcClientFace 契约面——消费组件经
// useClientContext()?.rpc 取用 + 早退守卫，M27.2 先例形态；不再复制
// settings 的 defaultRpc 缺省包装层）。
// 类型词汇（PluginCatalog/StagingRecord 等）仍 type-import 自
// settings/types.ts（弱依赖——契约词汇型面，运行时零依赖）。
// 留守 settings 的域外函数：get/setEventPolicy（全局治理配置——
// M29 开工裁决定留守）、get/setGlobalSetting（全局默认层 = config 域）。
// ============================================================
import type {
  PluginCatalog,
  PluginLibrary,
  PluginInfo,
  StagingRecord,
  StagingFileInfo,
  StagingFileContent,
  EventChainEntry,
  EventDescriptionEntry,
  PluginPatchEntry,
} from 'ac-client-ui-settings/client/types.ts';
import { highRiskOf } from 'ac-client-ui-settings/client/slotCatalog.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

// ── 插件/工具目录（plugin/rows + extension-catalog + loaded + installed
//    + tools/list 五源合成；M22 P2：扩展目录归后端）。行组合制：内置能力
//    全是 cordis.yml 装配行（不经 pluginRegistry）。按名去重：
//    · 同名 loaded + installed → 合并为一条 source 'installed'（installed 信息优先）
//    · rows 与动态插件撞名 → 动态插件信息优先，rows 只补缺 ──
export async function getCatalog(rpc: Rpc): Promise<PluginCatalog> {
  const [loadedR, installedR, rowsR, toolsR, extR] = await Promise.all([
    rpc.call<{
      loaded?: Array<Record<string, any>>;
      failed?: Array<{ name: string; error: string }>;
      /** 熔断跳过（M23 G9 第四态徽章） */
      skipped?: Array<{ name: string; reason: string; count: number }>;
      /** 安全模式（M23 L8 横幅） */
      safeMode?: boolean;
    }>('plugin/loaded'),
    rpc.call<{ installed?: Array<Record<string, any>> }>('plugin/installed'),
    // 装配行清单（旧后端无此面 → 容忍为空，退回旧两源合成）
    rpc.call<{ rows?: Array<Record<string, any>> }>('plugin/rows').catch(() => ({ rows: [] })),
    rpc.call<{ tools?: Array<{ name: string; description?: string; requiredTags?: string[]; owner?: string; parameters?: Record<string, unknown> }> }>('tools/list'),
    // 扩展目录（M22 D4①；旧后端无此面 → 容忍为空）
    rpc.call<{ extensions?: Array<Record<string, any>> }>('plugin/extension-catalog').catch(() => ({ extensions: [] })),
  ]);
  const byName = new Map<string, PluginInfo>();
  // ① cordis 装配行（内置基线；后续动态源同名覆盖）。描述取行包
  //  package.json（后端 plugin/rows 解析）；origin==='internal' 的进程
  //  内部行（loader/include/内联回调）不是可辨识能力，过滤不进目录。
  //  origin==='dynamic'（M23 F11）在这里不进目录——动态行在「Agent 开发行」
  //  区单独呈现，plugins 合成由下方 loaded/installed 源覆盖。
  for (const r of rowsR.rows ?? []) {
    const name = String(r?.name ?? '');
    if (!name || name === '(anonymous)') continue;
    if (r?.origin === 'internal' || r?.origin === 'dynamic') continue;
    const description = typeof r.description === 'string' && r.description
      ? r.description
      : 'cordis.yml 装配行（行组合制内置能力）';
    byName.set(name, {
      name,
      label: name,
      description,
      source: 'builtin',
      ...(typeof r.version === 'string' && r.version ? { version: r.version } : {}),
    });
  }
  // ② 动态装载行（manifest 映射；sessionOnly → session 源）
  for (const l of loadedR.loaded ?? []) {
    const m = (l.manifest ?? {}) as Record<string, any>;
    const name = String(l.name ?? m.name ?? '');
    if (!name) continue;
    byName.set(name, {
      name, label: name,
      source: l.sessionOnly === true ? 'session' : 'builtin',
      ...(m.description ?? l.description ? { description: String(m.description ?? l.description) } : {}),
      ...(m.version ? { version: String(m.version) } : {}),
      ...(Array.isArray(m.permissions) ? { permissions: m.permissions as PluginInfo['permissions'] } : {}),
      ...(Array.isArray(l.allowedPermissions) ? { grantedPermissions: l.allowedPermissions as PluginInfo['grantedPermissions'] } : {}),
      ...(l.dir ? { dir: String(l.dir) } : {}),
      // 供给面透传（M23 G4 修复的一半：manifest.provides → PluginInfo）
      ...(m.provides && typeof m.provides === 'object' ? { provides: m.provides as PluginInfo['provides'] } : {}),
      // 非隔离 UI 透传（M23 F7/F8：manifest.ui.isolated === false → 徽章）
      ...(m.ui?.isolated === false ? { uiNonIsolated: true } : {}),
      // 高危 UI 席位透传（M27 D13：⚠ 名单——安装确认面明示）
      ...(highRiskOf(m.ui?.slots).length > 0 ? { uiHighRiskSlots: highRiskOf(m.ui?.slots) } : {}),
    });
  }
  // ③ 已安装（manifest 映射；与 loaded 撞名 → 合并为一条 source 'installed'）
  for (const l of installedR.installed ?? []) {
    const m = (l.manifest ?? {}) as Record<string, any>;
    const name = String(m.name ?? l.name ?? '');
    if (!name) continue;
    const prev = byName.get(name);
    byName.set(name, {
      ...(prev ?? { name, label: name }),
      name, label: name, source: 'installed',
      ...(m.description ?? l.description ? { description: String(m.description ?? l.description) } : {}),
      ...(m.version ?? l.version ? { version: String(m.version ?? l.version) } : {}),
      ...(Array.isArray(l.permissions) ? { permissions: l.permissions as PluginInfo['permissions'] } : {}),
      ...(l.owner ? { owner: String(l.owner) } : {}),
      ...(l.installedAt ? { installedAt: String(l.installedAt) } : {}),
      // 供给面透传（M23 G4 修复的一半：manifest.provides → PluginInfo）
      ...(m.provides && typeof m.provides === 'object' ? { provides: m.provides as PluginInfo['provides'] } : {}),
      // 非隔离 UI 透传（M23 F7/F8：installed 的 manifest 同样可能带 ui）
      ...(m.ui?.isolated === false ? { uiNonIsolated: true } : {}),
      // 高危 UI 席位透传（M27 D13：同 loaded 组）
      ...(highRiskOf(m.ui?.slots).length > 0 ? { uiHighRiskSlots: highRiskOf(m.ui?.slots) } : {}),
    });
  }
  return {
    plugins: [...byName.values()],
    rows: (rowsR.rows ?? []).map((r) => ({
      name: String(r?.name ?? ''),
      fibers: Number(r?.fibers ?? 0),
      active: r?.active === true,
      // origin 三值直传（M23 F11：'dynamic' = Agent 开发行；缺省/未知 → package）
      origin: (r?.origin === 'internal' || r?.origin === 'dynamic' ? r.origin : 'package') as PluginCatalog['rows'][number]['origin'],
      ...(typeof r?.description === 'string' && r.description ? { description: r.description } : {}),
      ...(typeof r?.version === 'string' && r.version ? { version: r.version } : {}),
      ...(typeof r?.owner === 'string' && r.owner ? { owner: r.owner } : {}),
      // yml/include 树行 id（M24 P4：行偏好层开关锚点）
      ...(typeof r?.entryId === 'string' && r.entryId ? { entryId: r.entryId } : {}),
    })),
    extensions: (extR.extensions ?? []) as PluginCatalog['extensions'],
    tools: (toolsR.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      requiredTags: t.requiredTags ?? [],
      // 注册方行名（注册即归属；工具目录按来源行分组折叠的锚点）
      ...(t.owner ? { owner: t.owner } : {}),
      ...(t as any).parameters ? { parameters: (t as any).parameters } : {},
    })),
    // 装载状态（安装卡片三态徽章——M22 D6；G9 起扩第四态 + 安全模式）
    loaded: (loadedR.loaded ?? []).map((l) => String(l.name ?? '')),
    failed: loadedR.failed ?? [],
    skipped: loadedR.skipped ?? [],
    safeMode: loadedR.safeMode === true,
  };
}

/** ③ 插件库：已安装 + 待审暂存 + 开发扫描（M22 D7：dev = plugin/dev-scan） */
export async function getLibrary(rpc: Rpc): Promise<PluginLibrary> {
  const [installedR, stagingR, devR] = await Promise.all([
    rpc.call<{ installed?: Array<Record<string, any>> }>('plugin/installed'),
    rpc.call<{ staging?: Array<Record<string, any>> }>('plugin/staging-list'),
    // dev 扫描 + 数据根（旧后端无此面 → 容忍为空）
    rpc.call<{ root?: string; dev?: Array<Record<string, any>> }>('plugin/dev-scan').catch(() => ({}) as { root?: string; dev?: Array<Record<string, any>> }),
  ]);
  return {
    installed: (installedR.installed ?? []).map((l) => {
      const m = (l.manifest ?? {}) as Record<string, any>;
      const name = String(m.name ?? l.name ?? '');
      return {
        name,
        label: name,
        source: 'installed' as const,
        ...(m.version ?? l.version ? { version: String(m.version ?? l.version) } : {}),
        ...(m.description ?? l.description ? { description: String(m.description ?? l.description) } : {}),
        ...(Array.isArray(l.permissions) ? { permissions: l.permissions as PluginInfo['permissions'] } : {}),
        ...(l.owner ? { owner: String(l.owner) } : {}),
        ...(l.dir ? { dir: String(l.dir) } : {}),
        ...(l.installedAt ? { installedAt: String(l.installedAt) } : {}),
        // 供给面透传（M23 G4：已安装卡片"提供 N 工具/M provider/K 事件"行）
        ...(m.provides && typeof m.provides === 'object' ? { provides: m.provides as PluginInfo['provides'] } : {}),
        // 非隔离 UI 透传（M23 F7/F8：已安装卡片徽章数据源 = 本映射）
        ...(m.ui?.isolated === false ? { uiNonIsolated: true } : {}),
        // 高危 UI 席位透传（M27 D13：已安装卡片徽章）
        ...(highRiskOf(m.ui?.slots).length > 0 ? { uiHighRiskSlots: highRiskOf(m.ui?.slots) } : {}),
      };
    }),
    staging: (stagingR.staging ?? []) as unknown as StagingRecord[],
    dev: (devR.dev ?? []) as PluginLibrary['dev'],
    ...(devR.root ? { root: devR.root } : {}),
  };
}

// ── ③b 目录信息架构（M24 P3/P4：plugin/catalog 两分组 + 待审并入） ──

/** 内置组行（包源清单；装配状态与 cordis registry 交叉） */
export interface CatalogBuiltinRow {
  name: string;
  version?: string;
  description?: string;
  assembled: boolean;
  fibers: number;
  /** yml 裸行 id（含未装配/强制停用行——插件库「插件目录」页签停用开关的锚点） */
  entryId?: string;
}

/** 本地组行（registry ∪ devScan ∪ 会话装载；state 含待审外的六态） */
export interface CatalogLocalRow {
  name: string;
  version?: string;
  description?: string;
  owner?: string;
  dir?: string;
  state: 'loaded' | 'installed' | 'failed' | 'skipped' | 'dev' | 'pending';
  error?: string;
  reason?: string;
  sessionOnly?: boolean;
  uiNonIsolated?: boolean;
  /** 高危 UI 席位（M27 D13 ⚠ 名单：perspective 整面板替换——确认面明示） */
  uiHighRiskSlots?: string[];
  provides?: Record<string, unknown>;
  permissions?: string[];
}

/** 待审暂存（并入本地组徽章态） */
export interface CatalogPendingRow {
  pendingId: string;
  name: string;
  version: string;
  owner: string;
  requiredGrants: string[];
  createdAt: string;
}

/** 目录（M24 P3：plugin/catalog RPC 直连）。
 *  不再吞错（2026-08-30 事故：旧后端容忍 .catch(()=>({})) 把「RPC 面下线」
 *  也吞成空清单——降级态必须上抛，宿主记 pluginCatalogError、UI 呈现
 *  错误横幅 + 急救区，而非误导性"内置目录为空"） */
export async function getPluginCatalog(rpc: Rpc): Promise<{
  builtin: CatalogBuiltinRow[];
  note?: string;
  local: CatalogLocalRow[];
  pending: CatalogPendingRow[];
}> {
  const r = await rpc.call<{ builtin?: any[]; note?: string; local?: any[]; pending?: any[] }>('plugin/catalog');
  return {
    builtin: (r.builtin ?? []) as CatalogBuiltinRow[],
    ...(r.note ? { note: r.note } : {}),
    local: (r.local ?? []) as CatalogLocalRow[],
    pending: (r.pending ?? []) as CatalogPendingRow[],
  };
}

// ── ③c 插件市场（M24 P5：market/search + market/stage） ──

/** 市场搜索结果条目 */
export interface MarketResult {
  source: 'npm' | 'github';
  name: string;
  version?: string;
  description?: string;
  downloads?: number;
  stars?: number;
  url?: string;
  spec: string;
}

export async function marketSearch(query: string, rpc: Rpc): Promise<{ results: MarketResult[] }> {
  const r = await rpc.call<{ results?: MarketResult[] }>('market/search', { query });
  return { results: r.results ?? [] };
}

/** 市场安装 → 暂存待人审（来源锚定随行返回） */
export async function marketStage(
  spec: string,
  owner: string,
  rpc: Rpc,
): Promise<{ staging: StagingRecord; source: Record<string, unknown> }> {
  const r = await rpc.call<{ staging?: Record<string, any>; source?: Record<string, unknown> }>('market/stage', { spec, owner });
  return { staging: r.staging as unknown as StagingRecord, source: r.source ?? {} };
}

/** ③ 发布第一阶段：暂存待审 */
export async function stagePlugin(dir: string, owner: string, rpc: Rpc): Promise<{ staging: StagingRecord }> {
  const r = await rpc.call<{ staging?: Record<string, any> }>('plugin/stage', { dir, owner });
  return { staging: r.staging as unknown as StagingRecord };
}

/** ③ 人审通过后安装（grants 为 UI 勾选结果） */
export async function approvePlugin(id: string, grants: string[], rpc: Rpc): Promise<{ installed: PluginInfo }> {
  const r = await rpc.call<{ installed?: Record<string, any> }>('plugin/approve', { id, grants });
  return { installed: { name: String(r.installed?.name ?? ''), label: String(r.installed?.name ?? ''), source: 'installed' } };
}

/** ③ 拒绝暂存 */
export async function rejectPlugin(id: string, rpc: Rpc): Promise<{ success: true }> {
  await rpc.call('plugin/reject', { id });
  return { success: true };
}

/** ③ 卸载已安装插件 */
export async function uninstallPlugin(name: string, rpc: Rpc): Promise<{ success: true; backupDir?: string }> {
  const r = await rpc.call<{ uninstalled?: { backupDir?: string } }>('plugin/uninstall', { name });
  return { success: true, ...(r.uninstalled?.backupDir ? { backupDir: r.uninstalled.backupDir } : {}) };
}

// ── ④ 会话级插件（preview plugin/load sessionOnly + reload/unload） ──

export async function getSessionPlugins(rpc: Rpc): Promise<{ plugins: PluginInfo[] }> {
  const r = await rpc.call<{ loaded?: Array<Record<string, any>> }>('plugin/loaded');
  return {
    // 只取会话级装载（sessionOnly===true）——已安装插件的 boot 装载不是
    // "会话插件"（B3：混入会让 dev 卡片的 loaded 徽章与卸载语义错位）
    plugins: (r.loaded ?? [])
      .filter((l) => l.sessionOnly === true)
      .map((l) => ({
        name: String(l.name ?? l.id ?? ''),
        label: String(l.name ?? ''),
        source: 'session' as const,
        ...(l.dir ? { dir: String(l.dir) } : {}),
        ...(l.agentId ? { owner: String(l.agentId) } : {}),
      })),
  };
}

export async function registerSessionPlugin(
  dir: string,
  agentId: string | undefined,
  grants: string[] | undefined,
  rpc: Rpc,
): Promise<{ status: 'loaded' | 'replaced'; plugin: PluginInfo }> {
  // 后端 plugin/load 读 agentId（会话装载归属 Agent；B2：此前发 owner 字段名错配）
  const r = await rpc.call<{ status?: string; name?: string }>('plugin/load', { dir, sessionOnly: true, ...(agentId ? { agentId } : {}), ...(grants ? { grants } : {}), watch: true });
  return { status: r.status === 'replaced' ? 'replaced' : 'loaded', plugin: { name: String(r.name ?? ''), label: String(r.name ?? ''), source: 'session' } };
}

export async function unloadSessionPlugin(name: string, rpc: Rpc): Promise<{ success: true }> {
  await rpc.call('plugin/unload', { name });
  return { success: true };
}

/** ⑤ 权限词汇表（plugin/permissions → PluginPermissionsView） */
export async function getPermissions(rpc: Rpc): Promise<import('ac-client-ui-settings/client/types.ts').PluginPermissionsView> {
  const r = await rpc.call<{
    permissions?: string[];
    defaultGrants?: string[];
    executionExplicitRequired?: string[];
    reviewExplicitRequired?: string[];
  }>('plugin/permissions');
  return {
    vocabulary: (r.permissions ?? []) as import('ac-client-ui-settings/client/types.ts').PluginPermissionsView['vocabulary'],
    defaultGranted: (r.defaultGrants ?? []) as import('ac-client-ui-settings/client/types.ts').PluginPermissionsView['defaultGranted'],
    explicitRequired: [...(r.executionExplicitRequired ?? []), ...(r.reviewExplicitRequired ?? [])] as import('ac-client-ui-settings/client/types.ts').PluginPermissionsView['explicitRequired'],
  };
}

/** ⑥ 暂存目录文件树（人审） */
export async function getStagingTree(id: string, rpc: Rpc): Promise<{ files: StagingFileInfo[] }> {
  const r = await rpc.call<{ files?: Array<Record<string, any>> }>('plugin/staging-files', { id });
  return { files: (r.files ?? []) as unknown as StagingFileInfo[] };
}

/** ⑥ 暂存文件内容（人审只读） */
export async function getStagingFile(id: string, path: string, rpc: Rpc): Promise<StagingFileContent> {
  const r = await rpc.call<{ content?: string }>('plugin/staging-file', { id, path });
  return { path, content: String(r?.content ?? '') };
}

// ── ⑩ 反依赖图（M25 P3：停用承重行级联警告 + 保护行标记） ──

/** 反依赖图行节点（plugin/dep-graph；旧后端无此面 → 容忍为空） */
export async function getDepGraph(
  rpc: Rpc,
): Promise<{
  rows: Array<{ name: string; deps: string[]; rowDeps: string[]; dependents: string[]; protected: boolean }>;
  note?: string;
}> {
  const r = await rpc
    .call<{ rows?: Array<{ name: string; deps: string[]; rowDeps: string[]; dependents: string[]; protected: boolean }>; note?: string }>('plugin/dep-graph')
    .catch(() => ({}) as { rows?: never[]; note?: string });
  return { rows: r?.rows ?? [], ...(r?.note ? { note: r.note } : {}) };
}

// ── ⑦ 行偏好层 cordis.patch.yml（M23 P3-lite：plugin/patch-list / patch-set） ──

/** 行偏好清单（只读；fail-soft warnings 透出给前端呈现） */
export async function getPatchList(rpc: Rpc): Promise<{ patches: PluginPatchEntry[]; file: string; warnings: string[] }> {
  const r = await rpc.call<{ patches?: PluginPatchEntry[]; file?: string; warnings?: string[] }>('plugin/patch-list');
  return {
    patches: Array.isArray(r?.patches) ? r.patches : [],
    file: typeof r?.file === 'string' ? r.file : '',
    warnings: Array.isArray(r?.warnings) ? r.warnings : [],
  };
}

/**
 * 写一条行偏好 {id, disabled}（upsert；原子写）。
 * 三态返回（F12/M5）：'written'（带 restartRequired: true，重启生效）/
 * 'no-include-row'（偏好文件已写但进程无 include 行，无消费者）；
 * 'hot' 为保留字（include 热通道后置 P7，首期恒不返回）。
 */
export async function setPluginPatch(
  id: string,
  disabled: boolean,
  rpc: Rpc,
): Promise<{ state: 'hot' | 'written' | 'no-include-row'; restartRequired?: boolean; patches: PluginPatchEntry[] }> {
  const r = await rpc.call<{ state?: string; restartRequired?: boolean; patches?: PluginPatchEntry[] }>('plugin/patch-set', { id, disabled });
  const state = r?.state === 'hot' || r?.state === 'no-include-row' ? r.state : 'written';
  return {
    state,
    ...(r?.restartRequired === true ? { restartRequired: true } : {}),
    patches: Array.isArray(r?.patches) ? r.patches : [],
  };
}

/**
 * 还原行偏好层（批量，2026-08-30）：
 *   · 'factory' —— 清空全部停用条目 → 出厂 cordis.yml 全量装配；
 *   · 'minimal' —— 最小核心集（会话链 + RPC 面 + 急救 + 安全行）以外的
 *     在册行全部停用 → 安全模式基线。
 */
export async function resetPluginPatches(
  mode: 'factory' | 'minimal',
  rpc: Rpc,
): Promise<{ state: 'hot' | 'written' | 'no-include-row'; restartRequired?: boolean; patches: PluginPatchEntry[] }> {
  const r = await rpc.call<{ state?: string; restartRequired?: boolean; patches?: PluginPatchEntry[] }>('plugin/patch-reset', { mode });
  const state = r?.state === 'hot' || r?.state === 'no-include-row' ? r.state : 'written';
  return {
    state,
    ...(r?.restartRequired === true ? { restartRequired: true } : {}),
    patches: Array.isArray(r?.patches) ? r.patches : [],
  };
}

// ── ⑧ 事件执行链（M23 P4：events/listeners 静态读出） ──

/** 事件执行链（按事件名排序；listeners 数组序 = waterfall 执行序；owner = 裸 fiber 名） */
export async function getEventListeners(rpc: Rpc): Promise<{ events: EventChainEntry[] }> {
  const r = await rpc.call<{ events?: EventChainEntry[] }>('events/listeners');
  return { events: Array.isArray(r?.events) ? r.events : [] };
}

// ── ⑨ 事件描述声明（M25 P2） ──

/** 事件描述声明 × 执行链交叉（events/descriptions；旧后端无此面 → 容忍为空） */
export async function getEventDescriptions(
  rpc: Rpc,
): Promise<{ descriptions: EventDescriptionEntry[]; chains: Record<string, EventChainEntry['listeners']> }> {
  const r = await rpc
    .call<{ descriptions?: EventDescriptionEntry[]; chains?: Record<string, EventChainEntry['listeners']> }>('events/descriptions')
    .catch(() => ({}) as { descriptions?: EventDescriptionEntry[]; chains?: Record<string, EventChainEntry['listeners']> });
  return {
    descriptions: Array.isArray(r?.descriptions) ? r.descriptions : [],
    chains: r?.chains ?? {},
  };
}
