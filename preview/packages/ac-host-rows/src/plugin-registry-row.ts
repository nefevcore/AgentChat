// ============================================================
// plugin-registry-row.ts —— 宿主插件治理行（cr-543；行集清单 R1「插件治理」
// 改造落地：装载裁决 + 熔断闸门 + 行集偏好急救 RPC + client manifest 注入）
//
// 与主线 ac-plugin-registry 的形态差（改造的实质，不是缩水）：
//   主线：装载 = 把第三方代码 dynamic import 进**宿主进程**（ctx.plugin），
//         行因此住宿主，熔断/健康记录围绕宿主内装载。
//   本行：装载 = 授权动作（A7/A10）——批准安装后插件行集条目物化为
//         <dataRoot>/plugin-rows.json，装载发生在**壳进程**（壳 boot 读目录
//         + 插件行合并 → 行集派生 → 动态装配）。第三方代码零宿主驻留
//         （R0a 判据 1）——宿主进程不 import 任何插件代码。
//
// 行内四件事：
//   ① 安装态与 staging 人审（哈希 / 只读代理 / 权限快照 / 来源锚定）——
//      算法全复用 ac-plugin-core 纯库（主线原样 import，零改动）；
//   ② 装载裁决与熔断闸门：壳侧装载失败经 plugin/load-failure 回报 →
//      阈值熔断 → 该插件行集条目从 plugin-rows.json 剔除（fail-closed）；
//   ③ 行集偏好急救 RPC（rows/*）：写 <dataRoot>/host-rows.json，恒冷
//      生效（restartRequired——〈patch 机制退役〉：无热通道无 patch 文件）；
//   ④ client manifest 注入：安装目录即 boot graph 源
//      （<dataRoot>/plugins/<name>/manifest.json —— webui 行 pluginsDir
//      扫描单源，R7-9 唯一通道），安装/卸载后广播 plugin/updated 事件帧。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import {
  DEFAULT_GRANTED_PERMISSIONS,
  EXECUTION_EXPLICIT_REQUIRED,
  HIGH_RISK_UI_SLOTS,
  HOST_CONTRACTS_VERSION,
  KNOWN_PERMISSIONS,
  REVIEW_EXPLICIT_REQUIRED,
  UI_SLOT_IDS,
  appendAudit,
  approveStaging,
  clearLoadHealth,
  findReservedConflict,
  hashPluginDir,
  isLoadDisabled,
  listInstalled,
  listStaging,
  listStagingFiles,
  loadManifestFromDir,
  pluginsRoot,
  readLoadHealth,
  readStagingFile,
  recordLoadFailure,
  rejectStaging,
  reservedConflictError,
  stagePlugin,
  uninstallPlugin,
  type ApproveResult,
  type InstalledPluginRecord,
  type PluginAuditEntry,
  type PluginPermission,
  type PluginSource,
  type PluginStagingRecord,
  type StagingFileContent,
  type StagingFileInfo,
} from 'ac-plugin-core';
import type { Envelope } from 'ac-envelope-core';
import {
  isPluginRequest,
  makePluginReceiptEnvelope,
  validatePluginRequestPayload,
  type PluginReceiptPayload,
} from 'ac-envelope-core';
import type { HostInbox } from './host-inbox.ts';
import {
  deriveHostRowset,
  hostPreferenceFile,
  mergeRowsetCatalog,
  pluginRowsOf,
  readCatalog,
  readHostPreferences,
  writeHostPreferences,
  writePluginRows,
  type HostRowPreference,
  type RowDescriptor,
} from 'ac-rowset-core';

/** 行配置（宿主 boot 组装——数据根显式注入，隔离红线） */
export interface PluginRegistryHostRowOptions {
  dataRoot: string;
  /** 行集目录（宿主偏好视图 + 插件行撞名对账；缺省 <dataRoot>/row-catalog.json） */
  catalogFile?: string;
  /** host 端点收信扇出面（cr-553 装卸请求信受理；缺席 = 信封面下线，RPC/装载裁决照常） */
  inbox?: HostInbox;
  /** 邮局（回执 + 续跑信投递——受理编排件注入，测试可替身） */
  postOffice?: { dispatch(env: Envelope): Promise<unknown> };
}

/** 插件行集现算结果（安装态 → 壳行集条目） */
export interface PluginRowsView {
  rows: RowDescriptor[];
  warnings: string[];
}

/** 宿主行集急救视图（目录 + 偏好合成） */
export interface HostRowsView {
  rows: Array<{ id: string; disabled: boolean; role?: string }>;
  file: string;
  warnings: string[];
}

/** 批量返回（安装/卸载后行集随之刷新——调用方人审回执直接可见） */
export interface InstalledView {
  installed: InstalledPluginRecord[];
  rows: RowDescriptor[];
  warnings: string[];
}

/** 安装目录内 manifest 原样（行集声明 rows 不在校验后的 PluginManifest 里） */
function readRawManifest(dir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * 宿主插件治理服务（服务键 'pluginRegistry'——消费方：plugin-market 行的
 * stage 面 / webui RPC）。零第三方代码装载：本进程只做文件域与裁决。
 */
export class PluginRegistryHostService extends Service {
  private readonly dataRoot: string;
  private readonly catalogFile: string;

  constructor(ctx: Context, options: PluginRegistryHostRowOptions) {
    super(ctx, 'pluginRegistry');
    this.dataRoot = path.resolve(options.dataRoot);
    this.catalogFile = options.catalogFile !== undefined
      ? path.resolve(options.catalogFile)
      : path.join(this.dataRoot, 'row-catalog.json');
  }

  /** 插件库根（安装态 / 暂存 / 熔断记录同源） */
  root(): string {
    return pluginsRoot(this.dataRoot);
  }

  // ---- ① 安装态与 staging 人审（ac-plugin-core 纯库沿用） ----

  listInstalled(): InstalledPluginRecord[] {
    return listInstalled(this.dataRoot);
  }

  stagingRecords(): PluginStagingRecord[] {
    return listStaging(this.dataRoot);
  }

  stagingFiles(id: string): StagingFileInfo[] {
    return listStagingFiles(this.dataRoot, id);
  }

  stagingFile(id: string, rel: string): StagingFileContent {
    return readStagingFile(this.dataRoot, id, rel);
  }

  /** 暂存（人审入口；plugin-market 行的下载解包后落点） */
  stage(dir: string, owner: string, source?: PluginSource): Promise<PluginStagingRecord> {
    return stagePlugin(this.dataRoot, path.resolve(dir), owner, source);
  }

  /** 人审批准：安装落盘 → 清熔断记录 → 刷新插件行集 → 审计入账 */
  async approve(id: string, grants?: unknown): Promise<{ approved: ApproveResult; rows: RowDescriptor[]; warnings: string[] }> {
    const approved = await approveStaging(this.dataRoot, id, grants);
    const installedDir = path.join(this.root(), approved.manifest.name);
    const rows = this.refreshRows();
    await this.audit({
      event: 'install',
      name: approved.manifest.name,
      version: approved.manifest.version,
      owner: 'host',
      sourceDir: installedDir,
      hash: approved.hash,
      grants: approved.permissions,
      outcome: approved.replaced !== undefined ? 'installed+replaced' : 'installed',
    });
    return { approved, rows: rows.rows, warnings: rows.warnings };
  }

  /** 人审拒绝（暂存副本删除；来源目录保真不动） */
  async reject(id: string): Promise<{ id: string; removedDir?: string }> {
    const result = await rejectStaging(this.dataRoot, id);
    await this.audit({ event: 'reject', name: id, owner: 'host', ...(result.removedDir !== undefined ? { sourceDir: result.removedDir } : {}) });
    return result;
  }

  /**
   * 免审定型安装（cr-553——装卸请求信的文件域半边；主线 installFromDir
   * 语义的宿主形态：stage → 自动批准〔免审快照 = manifest permissions
   * 全集〕→ 刷新行集 + 审计。装载归壳 boot（重启/下轮 boot 即装载）——
   * 宿主不装载代码（R0a 判据 1）。三态：rejected / idempotent / installed。
   */
  async installFromDir(sourceDir: string, owner: string): Promise<
    | { status: 'rejected'; name?: string; error: string }
    | {
      status: 'installed';
      name: string;
      version: string;
      installedDir: string;
      hash: string;
      idempotent: boolean;
      backupDir?: string;
      warnings: string[];
    }
  > {
    const resolved = path.resolve(sourceDir);
    let manifest: { name: string; version: string; permissions?: PluginPermission[] };
    try {
      manifest = loadManifestFromDir(resolved);
    } catch (err: unknown) {
      return { status: 'rejected', error: err instanceof Error ? err.message : String(err) };
    }
    const conflict = findReservedConflict(manifest as Parameters<typeof findReservedConflict>[0]);
    if (conflict) {
      return { status: 'rejected', name: manifest.name, error: reservedConflictError(conflict, manifest.name) };
    }
    // 同 name+version 幂等（主线 G8 语义）：内容一致 → 已装状态；不一致 → 教 bump version
    const hash = hashPluginDir(resolved);
    const installed = listInstalled(this.dataRoot).find((record) => record.manifest.name === manifest.name);
    if (installed !== undefined && installed.manifest.version === manifest.version) {
      if (installed.hash === hash) {
        return {
          status: 'installed', name: manifest.name, version: manifest.version,
          installedDir: path.join(this.root(), installed.dir), hash, idempotent: true, warnings: [],
        };
      }
      return {
        status: 'rejected', name: manifest.name,
        error: '插件 "' + manifest.name + '@' + manifest.version + '" 已安装且内容哈希不一致——同版本改动必须先在 manifest.json bump version 再重装',
      };
    }
    // stage → 自动批准（免审快照 = manifest permissions 全集——主线 F14/L5）
    let stagingId: string;
    try {
      stagingId = (await this.stage(resolved, owner)).id;
    } catch (err: unknown) {
      return { status: 'rejected', name: manifest.name, error: '暂存失败：' + (err instanceof Error ? err.message : String(err)) };
    }
    let approved: ApproveResult;
    try {
      approved = await approveStaging(this.dataRoot, stagingId, manifest.permissions ?? []);
    } catch (err: unknown) {
      await this.reject(stagingId).catch(() => undefined);
      return { status: 'rejected', name: manifest.name, error: err instanceof Error ? err.message : String(err) };
    }
    const rows = this.refreshRows();
    await this.audit({
      event: 'install', name: approved.manifest.name, version: approved.manifest.version, owner,
      sourceDir: path.join(this.root(), approved.manifest.name), hash: approved.hash,
      grants: approved.permissions,
      outcome: approved.replaced !== undefined ? 'installed+replaced' : 'installed',
    });
    return {
      status: 'installed', name: approved.manifest.name, version: approved.manifest.version,
      installedDir: approved.installedDir, hash: approved.hash, idempotent: false, warnings: rows.warnings,
      ...(approved.replaced !== undefined ? { backupDir: approved.replaced.backupDir } : {}),
    };
  }

  /** 永久卸载：移出安装态 + 旧版本进 .backup + 刷新插件行集 */
  async uninstall(name: string): Promise<{ name: string; backupDir?: string; rows: RowDescriptor[]; warnings: string[] }> {
    const result = await uninstallPlugin(this.dataRoot, name);
    const rows = this.refreshRows();
    await this.audit({
      event: 'uninstall',
      name,
      owner: 'host',
      outcome: 'uninstalled',
      ...(result.backupDir !== undefined ? { backupDir: result.backupDir } : {}),
    });
    return { ...result, rows: rows.rows, warnings: rows.warnings };
  }

  /** 权限词汇表（前端 grants 勾选源——形状与主线 plugin/permissions 恒等） */
  permissions(): {
    contractsVersion: string;
    permissions: readonly PluginPermission[];
    defaultGrants: readonly PluginPermission[];
    executionExplicitRequired: readonly PluginPermission[];
    reviewExplicitRequired: readonly PluginPermission[];
    uiSlots: readonly string[];
    highRiskUiSlots: readonly string[];
  } {
    return {
      contractsVersion: HOST_CONTRACTS_VERSION,
      permissions: KNOWN_PERMISSIONS,
      defaultGrants: DEFAULT_GRANTED_PERMISSIONS,
      executionExplicitRequired: EXECUTION_EXPLICIT_REQUIRED,
      reviewExplicitRequired: REVIEW_EXPLICIT_REQUIRED,
      uiSlots: UI_SLOT_IDS,
      highRiskUiSlots: HIGH_RISK_UI_SLOTS,
    };
  }

  // ---- ② 装载裁决（install = 授权动作 → 壳行集） ----

  /**
   * 插件行集现算：已安装插件的 manifest.rows → 壳行集条目。
   * 熔断（.load-health disabled）与撞名（保留字护栏）在此剔除；
   * 产物落 plugin-rows.json（壳 boot 合并单源）。
   */
  pluginRows(): PluginRowsView {
    const warnings: string[] = [];
    const rows: RowDescriptor[] = [];
    const taken = new Set<string>();
    for (const record of listInstalled(this.dataRoot)) {
      const name = record.manifest.name;
      if (isLoadDisabled(this.dataRoot, name)) {
        warnings.push('插件 ' + name + ' 已熔断（装载失败阈值）——行集条目剔除');
        continue;
      }
      const dir = path.join(this.root(), record.dir);
      const parsed = pluginRowsOf(name, dir, readRawManifest(dir));
      warnings.push(...parsed.warnings);
      for (const row of parsed.rows) {
        if (taken.has(row.id)) {
          warnings.push('插件行 id 重复，已丢弃：' + row.id);
          continue;
        }
        taken.add(row.id);
        rows.push(row);
      }
    }
    // 出厂行撞名对账（保留字护栏——动态行不许覆盖出厂行）
    const base = readCatalog(this.catalogFile);
    const merged = mergeRowsetCatalog(base, rows);
    if (merged.warnings.length > 0) warnings.push(...merged.warnings);
    return { rows: merged.catalog.rows.slice(base.rows.length), warnings };
  }

  /** 刷新 plugin-rows.json（安装/卸载/熔断变更后调用；返回现算结果） */
  refreshRows(): PluginRowsView {
    const view = this.pluginRows();
    writePluginRows(this.dataRoot, view.rows);
    return view;
  }

  /** 装载裁决（壳侧装载前询问；熔断/未安装 = false——fail-closed） */
  canLoad(name: string): boolean {
    if (isLoadDisabled(this.dataRoot, name)) return false;
    return listInstalled(this.dataRoot).some((record) => record.manifest.name === name);
  }

  /** 壳侧装载失败回报（阈值熔断 → 行集条目剔除 + 审计入账） */
  async reportLoadFailure(name: string, error: string): Promise<{ disabled: boolean; count: number }> {
    const state = await recordLoadFailure(this.dataRoot, name, error);
    const disabled = isLoadDisabled(this.dataRoot, name);
    if (disabled) this.refreshRows();
    await this.audit({
      event: 'load',
      name,
      outcome: disabled ? 'disabled' : 'failed',
      error,
    });
    return { disabled, count: state.count };
  }

  /** 清熔断记录（修复后重装 / 人工急救） */
  async clearLoadHealthFor(name: string): Promise<void> {
    await clearLoadHealth(this.dataRoot, name);
    this.refreshRows();
  }

  /** 熔断档案视图（webui 徽章数据源） */
  loadHealth(): ReturnType<typeof readLoadHealth> {
    return readLoadHealth(this.dataRoot);
  }

  // ---- ③ 行集偏好急救（A9：偏好文件恒冷生效） ----

  rowPreferences(): HostRowPreference[] {
    return readHostPreferences(this.dataRoot);
  }

  /**
   * 宿主行集视图：目录 host 行全集 × 偏好（disabled 标记合成）。
   * 全列出（含被停用行）——急救面要能把停用行重新打开，派生清单
   * （deriveHostRowset）只承担装配语义与告警面。
   */
  hostRows(): HostRowsView {
    const prefs = readHostPreferences(this.dataRoot);
    const catalog = readCatalog(this.catalogFile);
    const derived = deriveHostRowset(prefs, catalog);
    const disabled = new Set(prefs.filter((p) => p.disabled).map((p) => p.id));
    const rows = catalog.rows
      .filter((row) => row.tree === 'host')
      .map((row) => ({
        id: row.id,
        disabled: disabled.has(row.id),
        ...(row.role !== undefined ? { role: row.role } : {}),
      }));
    return { rows, file: hostPreferenceFile(this.dataRoot), warnings: derived.warnings };
  }

  /**
   * 写一条行偏好（恒冷生效：restartRequired 恒 true——新架构无热通道）。
   * disabled=false = 删条目（偏好文件只记差异）。
   */
  setRowPreference(id: string, disabled: boolean): HostRowsView {
    const prefs = readHostPreferences(this.dataRoot).filter((p) => p.id !== id);
    if (disabled) prefs.push({ id, disabled: true });
    writeHostPreferences(this.dataRoot, prefs);
    return this.hostRows();
  }

  /** 清空偏好文件（恢复出厂全装） */
  resetRowPreferences(): HostRowsView {
    writeHostPreferences(this.dataRoot, []);
    return this.hostRows();
  }

  // ---- 审计（install/uninstall/reject/load 四类，ac-plugin-core 流水） ----

  private audit(entry: Omit<PluginAuditEntry, 'ts'>): Promise<void> {
    return appendAudit(this.dataRoot, { ts: new Date().toISOString(), ...entry });
  }
}

// ---- 参数窄化（主线 agent-admin 行同款薄行自持） ----

function obj(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') throw new Error('参数 ' + key + ' 缺失或非非空字符串');
  return value;
}

/**
 * 装卸请求受理编排（cr-553）：install → svc.installFromDir（免审三态）；
 * uninstall → svc.uninstall（永久卸载）。回执 payload + 续跑文案一体
 * 返回（回执进经验流 / 续跑驱动下一轮——主线 receiptAndRetrigger 同义）。
 * 相对目录按发起方沙箱（files/<agentId>/）基准解析——主线 resolveDir
 * 同语义；结构非法 = 拒收回执（不 throw——handler 抛错 = 投递失败滞留
 * 重试，语义应为一次性拒收）。
 */
async function applyPluginRequest(
  svc: PluginRegistryHostService,
  env: Envelope,
): Promise<{ payload: PluginReceiptPayload; nextPrompt: string | null }> {
  const agent = env.sender;
  const issues = validatePluginRequestPayload(env.payload);
  if (issues.length > 0) {
    return {
      payload: { subject: 'plugin-rejected', agent, ok: false, reason: '结构非法：' + issues.join('；') },
      nextPrompt: '[plugin] 你请求的插件装卸信结构非法：' + issues.join('；') + '。请修正参数后重试。',
    };
  }
  const p = env.payload as { action: 'install' | 'uninstall'; dir?: string; name?: string; conversationId: string };
  const base = path.join(svc.root() === '' ? '' : path.dirname(svc.root()), 'files', agent);
  if (p.action === 'install') {
    const dir = path.isAbsolute(p.dir!) ? path.resolve(p.dir!) : path.resolve(base, p.dir!);
    const result = await svc.installFromDir(dir, agent);
    if (result.status === 'rejected') {
      return {
        payload: { subject: 'plugin-rejected', agent, ok: false, name: result.name, reason: result.error },
        nextPrompt: '[plugin] 你请求的安装未完成：' + result.error + '。请修复后重新 install_plugin（同版本改动必须先 bump manifest version）。',
      };
    }
    if (result.idempotent) {
      return {
        payload: {
          subject: 'plugin-installed', agent, ok: true, name: result.name, version: result.version,
          installedDir: result.installedDir, idempotent: true, warnings: result.warnings,
        },
        nextPrompt: '[plugin] install_plugin 幂等返回：' + result.name + '@' + result.version + ' 内容与已装版本一致，未重复装载。如需更新代码，请 bump manifest version 后重装。',
      };
    }
    return {
      payload: {
        subject: 'plugin-installed', agent, ok: true, name: result.name, version: result.version,
        installedDir: result.installedDir, idempotent: false, warnings: result.warnings,
        ...(result.backupDir !== undefined ? { backupDir: result.backupDir } : {}),
      },
      nextPrompt: '[plugin] 你安装的 ' + result.name + '@' + result.version + ' 已写入安装态（宿主零代码装载——plugin-rows.json 已刷新，本壳重启或新壳 boot 时装载）。要立即测试请用 register_plugin（会话级装载）。',
    };
  }
  const result = await svc.uninstall(p.name!);
  return {
    payload: {
      subject: 'plugin-uninstalled', agent, ok: true, name: result.name,
      ...(result.backupDir !== undefined ? { backupDir: result.backupDir } : {}),
      warnings: result.warnings,
    },
    nextPrompt: '[plugin] 你卸载的 ' + result.name + ' 已完成（代码回滚进 .backup，行集条目已剔除）。请继续后续工作。',
  };
}

/**
 * 插件治理行（inject ['webServer']——RPC 面挂宿主 web 传输；webServer 缺席
 * 则本行 PENDING，装配终检 fail-loud）。
 */
export function makePluginRegistryRow(options: PluginRegistryHostRowOptions): Plugin {
  return {
    name: 'ac-host-rows/plugin-registry',
    inject: ['webServer'],
    apply(ctx: Context) {
      // 直构（行 apply 闭包要访问本行自身提供的 pluginRegistry 服务——
      // 自依赖 inject 禁止；主线 ac-plugin-registry 同款形态）
      const svc = new PluginRegistryHostService(ctx, options);
      const web = ctx.webServer;
      /** 行集/安装态变更帧（前端重拉 diff——安装/卸载语义） */
      const notify = (name: string): void => {
        web.broadcast('plugin/updated', { name });
      };

      // —— ④ 装卸请求信受理（cr-553；creator 模板工具面的宿主半边）——
      // 壳 install_plugin / unregister_plugin（永久档）的落点：信封 →
      // installFromDir / uninstall（免审——admin 边界在壳侧工具面把守）→
      // 回执信（receipt → ledger-only 落原会话）+ 续跑信（message → 驱动
      // 下一轮——主线 receiptAndRetrigger 语义：成败都回投，失败文案可
      // 独立驱动 bump version / 修复重装）。源目录相对路径按发起方沙箱
      //（files/<agentId>/）基准解析。inbox/postOffice 缺席 = 信封面下线，
      // RPC 与装载裁决照常（良定义降级）。
      if (options.inbox !== undefined && options.postOffice !== undefined) {
        const dispatch = options.postOffice.dispatch.bind(options.postOffice);
        options.inbox.on(async (env: Envelope) => {
          if (!isPluginRequest(env) || env.to !== 'host') return;
          const receipt = await applyPluginRequest(svc, env);
          await dispatch(makePluginReceiptEnvelope({
            uuid: env.uuid, requestId: env.requestId, to: env.sender, payload: receipt.payload,
          }));
          if (receipt.nextPrompt !== null) {
            await dispatch({
              uuid: env.uuid,
              requestId: 'retrigger-' + env.requestId,
              sender: 'host',
              to: env.sender,
              kind: 'message',
              budget: 1,
              payload: { text: receipt.nextPrompt },
            });
          }
        });
      }

      // —— ① 安装态与 staging 人审 ——
      web.registerRpc('plugin/installed', () => {
        const rows = svc.refreshRows();
        return { installed: svc.listInstalled(), rows: rows.rows, warnings: rows.warnings };
      });

      web.registerRpc('plugin/staging-list', () => ({ staging: svc.stagingRecords() }));

      web.registerRpc('plugin/stage', async (params) => {
        const p = obj(params);
        const dir = reqStr(p, 'dir');
        const owner = typeof p.owner === 'string' && p.owner !== '' ? p.owner : 'user';
        const staging = await svc.stage(dir, owner);
        notify(staging.manifest.name);
        return { staging };
      });

      web.registerRpc('plugin/approve', async (params) => {
        const p = obj(params);
        const result = await svc.approve(reqStr(p, 'id'), p.grants);
        notify(result.approved.manifest.name);
        return {
          installed: result.approved,
          ...(result.approved.replaced !== undefined ? { backupDir: result.approved.replaced.backupDir } : {}),
          rows: result.rows,
          warnings: result.warnings,
        };
      });

      web.registerRpc('plugin/reject', async (params) => {
        const result = await svc.reject(reqStr(obj(params), 'id'));
        notify(result.id);
        return result;
      });

      web.registerRpc('plugin/uninstall', async (params) => {
        const result = await svc.uninstall(reqStr(obj(params), 'name'));
        notify(result.name);
        return {
          uninstalled: {
            name: result.name,
            ...(result.backupDir !== undefined ? { backupDir: result.backupDir } : {}),
          },
          rows: result.rows,
          warnings: result.warnings,
        };
      });

      web.registerRpc('plugin/staging-files', (params) => ({
        files: svc.stagingFiles(reqStr(obj(params), 'id')),
      }));

      web.registerRpc('plugin/staging-file', (params) => {
        const p = obj(params);
        return { content: svc.stagingFile(reqStr(p, 'id'), reqStr(p, 'path')).content };
      });

      web.registerRpc('plugin/permissions', () => svc.permissions());

      // —— ② 装载裁决 / 熔断闸门 ——
      web.registerRpc('plugin/rows', () => svc.pluginRows());

      web.registerRpc('plugin/load-health', () => svc.loadHealth());

      web.registerRpc('plugin/load-failure', async (params) => {
        const p = obj(params);
        const name = reqStr(p, 'name');
        const error = typeof p.error === 'string' ? p.error : '';
        const state = await svc.reportLoadFailure(name, error);
        if (state.disabled) notify(name);
        return state;
      });

      web.registerRpc('plugin/load-health-clear', async (params) => {
        const name = reqStr(obj(params), 'name');
        await svc.clearLoadHealthFor(name);
        notify(name);
        return { cleared: true };
      });

      // —— ③ 行集偏好急救（恒冷生效——restartRequired 恒 true） ——
      web.registerRpc('rows/list', () => svc.hostRows());

      web.registerRpc('rows/set', (params) => {
        const p = obj(params);
        const view = svc.setRowPreference(reqStr(p, 'id'), p.disabled === true);
        return { state: 'written', restartRequired: true, ...view };
      });

      web.registerRpc('rows/reset', () => {
        const view = svc.resetRowPreferences();
        return { state: 'reset', restartRequired: true, ...view };
      });
    },
  };
}
