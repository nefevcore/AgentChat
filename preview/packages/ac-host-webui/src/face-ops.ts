// ============================================================
// face-ops.ts —— 宿主 RPC 补全面（cr-567）：宿主可直读的一批能力域
//
// 原则：能直通 owning 实现就不写第二份——
//   timer/*        → ctx.timers（HostTimersService，宿主行）
//   usage/tokens   → ctx.usage（ac-usage 行零改动导入）
//   events/policy  → ctx.eventPolicy（ac-event-policy 行）
//   fileSnapshots  → ac-file-snapshots 的 SnapshotStore（纯库，同一 owning 实现）
//   agents/presets → 宿主模板目录（preset-builtin）
//   skills/list    → 数据根技能目录直读（ac-skill 同布局：<root>/skills、files/<agent>/skills）
//   system/version → 仓库 package.json + CHANGELOG.md
// 只做参数窄化 + 转发 + 形状对齐，零业务逻辑。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@agentchat/cordis';
import type { TimerEntry } from 'ac-timer-core';
import {
  GLOBAL_TIMER_OWNER,
  conversationWorkspaceRoot,
  listGroupConfigs,
  listTemplates,
  listWorkspaces,
  validateTimerEntries,
  workspacePathOf,
  workspaceTreeBase,
} from 'ac-host-rows';
import { createPoolCredentials, maskSecrets } from './config-face.ts';
import type { ShellAdminPort } from './face-shell.ts';
import { SnapshotStore, SNAPSHOT_MAX_BYTES, looksLikeText } from 'ac-file-snapshots/src/store.ts';
import { runNativePickFolder } from 'ac-workspace/src/native-dialog.ts';
import { runNativeOpen } from 'ac-workspace/src/native-open.ts';
import { readCatalog } from 'ac-rowset-core';
import { UserLedger, conversationDirs, readJournal, readLedger } from 'ac-ledger';
import { readAgentConfig, settingsOf } from 'ac-agents-core';
import { estimateTokens } from 'ac-text-budget';

interface WebFace {
  registerRpc(method: string, handler: (params: unknown) => unknown): void;
}

export interface FaceOpsDeps {
  dataRoot: string;
  /** 仓库根（package.json / CHANGELOG.md 锚点；缺省 = 本包向上四层） */
  repoRoot?: string;
  /** 行集目录（plugin/catalog 的 builtin 组数据源；缺省 = preview/apps/catalog） */
  catalogFile?: string;
  /** 编排面惰性端口（runs/snapshot 活跃集——活壳 run-state 帧；缺席 = 无活跃面） */
  shellPort?: () => ShellAdminPort | null;
}

/** 默认仓库根（preview/packages/ac-host-webui/src → 仓库根） */
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function obj(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v === '') throw new Error('参数 ' + key + ' 缺失或非非空字符串');
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 活跃 run 聚集（活壳逐个 run-state 帧——busy 壳才成条，闲壳在跑不算）。
 * cr-598 提为共享件：runs/snapshot 与 conversation/stats / session/history
 * 活投影同源（stats 曾硬编码空壳——前端 resume 与流式静默探针两链全断）。
 * port 缺席 / 壳退出 / 熔断在途 → 该壳视无 run。 */
export async function collectRunning(deps: FaceOpsDeps): Promise<Array<{ agentId: string; conversationId: string; runId: string | null; startedAt: number }>> {
  const running: Array<{ agentId: string; conversationId: string; runId: string | null; startedAt: number }> = [];
  const port = deps.shellPort?.() ?? null;
  if (port === null) return running;
  // 活壳清单 + 控制通道（cr-675）：优先编排面统一入口（盘上活锁壳——宿主换代
  // 后的孤壳仍在跑 run，活跃面不能因换代而空）；无统一入口时退回句柄池枚举。
  const unified = port.control;
  const shells: Array<{ agentId: string; control(frame: Record<string, unknown>): Promise<unknown> }> = [];
  if (unified !== undefined && port.liveShellIds !== undefined) {
    for (const agentId of [...port.liveShellIds()].sort()) {
      shells.push({ agentId, control: (frame) => unified(agentId, frame) });
    }
  } else if (port.handles !== undefined) {
    for (const [agentId, handle] of [...port.handles().entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      shells.push({ agentId, control: (frame) => handle.control(frame) });
    }
  }
  for (const { agentId, control } of shells) {
    try {
      const st = await control({ ctrl: 'admin', agentId, op: 'run-state' }) as
        | { busy?: unknown; conversationId?: unknown; runId?: unknown; startedAt?: unknown }
        | null;
      if (st?.busy !== true || typeof st.conversationId !== 'string' || st.conversationId === '') continue;
      running.push({
        agentId,
        conversationId: st.conversationId,
        runId: typeof st.runId === 'string' && st.runId !== '' ? st.runId : null,
        startedAt: typeof st.startedAt === 'number' ? st.startedAt : 0,
      });
    } catch { /* 壳在退出——跳过 */ }
  }
  return running;
}

/** 定时任务面（ctx.timers = 宿主 timers 行；行缺席 = fail-loud） */
function registerTimers(web: WebFace, ctx: Context): void {
  const timers = (): {
    list(): Array<{ owner: string; entries: TimerEntry[] }>;
    entries(owner: string): TimerEntry[];
    save(owner: string, entries: TimerEntry[]): void;
    triggerNow(owner: string, entryId: string): boolean;
  } => {
    const service = ctx.get('timers') as ReturnType<typeof timers> | undefined;
    if (service === undefined) throw new Error('timers 服务未装配（timers 行不在宿主行集）——定时任务面不可用');
    return service;
  };
  const ownerOf = (source: Record<string, unknown>): string => optStr(source.agentId) ?? GLOBAL_TIMER_OWNER;

  web.registerRpc('timer/list', () => ({ entries: timers().list() }));
  web.registerRpc('timer/entries', (params) => {
    const owner = ownerOf(obj(params));
    return { owner, entries: timers().entries(owner) };
  });
  web.registerRpc('timer/save', (params) => {
    const p = obj(params);
    const owner = ownerOf(p);
    timers().save(owner, validateTimerEntries(p.entries));
    return { saved: true, owner };
  });
  web.registerRpc('timer/trigger', (params) => {
    const p = obj(params);
    return { triggered: timers().triggerNow(ownerOf(p), reqStr(p, 'entryId')) };
  });
}

/** 身份目录面：预设清单 + 能力标签目录（标签轴 cr-484 已退役 → 空目录是终态） */
function registerIdentity(web: WebFace): void {
  web.registerRpc('agents/presets', () => ({
    presets: listTemplates().map((t) => ({
      id: t.config.id,
      name: t.config.name ?? t.label,
      label: t.label,
      description: t.description ?? '',
      default: t.default === true,
      ...(Array.isArray(t.config.tags) ? { tags: t.config.tags } : {}),
    })),
  }));
  web.registerRpc('tags/catalog', () => ({ tags: [] }));
}

/** SKILL.md 前置元数据（name / description 两行；缺省回落目录名） */
function readSkillManifest(dir: string, dirName: string): { name: string; description: string; dirName: string } {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'); } catch { /* 目录里没有 SKILL.md */ }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const field = (name: string): string | undefined => {
    const m = new RegExp('^' + name + '\\s*:\\s*(.+)$', 'm').exec(front);
    return m?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  };
  return { name: field('name') ?? dirName, description: field('description') ?? '', dirName };
}

/** 技能目录：全局 <root>/skills 与 Agent 专属 <root>/files/<agentId>/skills（ac-skill 同布局） */
function scanSkills(root: string): Array<{ name: string; description: string; dirName: string }> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => readSkillManifest(path.join(root, e.name), e.name));
}


/**
 * 工作区技能组（主线 ac-skill-core WORKSPACE_SKILL_DIRS 同清单——
 * .claude/skills / .github/skills / skills / .agents/skills / .dsh/skills，
 * 先命中先得）：线形拍平随条目附 dir/location（主线 web-api skills/list
 * 同形——前端来源徽章数据面）。
 */
const WORKSPACE_SKILL_DIRS = ['.claude/skills', '.github/skills', 'skills', '.agents/skills', '.dsh/skills'];

function scanWorkspaceSkills(wsRoot: string): Array<{ name: string; description: string; dirName: string; dir: string; location: string }> {
  const out: Array<{ name: string; description: string; dirName: string; dir: string; location: string }> = [];
  const seen = new Set<string>();
  const locationPrefix = wsRoot.replace(/\\/g, '/');
  for (const rel of WORKSPACE_SKILL_DIRS) {
    for (const s of scanSkills(path.join(wsRoot, ...rel.split('/')))) {
      if (seen.has(s.name)) continue; // 跨组同名：先命中先得（主线同语义）
      seen.add(s.name);
      out.push({ ...s, dir: rel, location: locationPrefix + '/' + rel });
    }
  }
  return out;
}

function registerSkills(web: WebFace, deps: FaceOpsDeps): void {
  web.registerRpc('skills/list', (params) => {
    const p = obj(params);
    const agentId = optStr(p.agentId);
    // 会话挂载工作区根（cr-627 语义，单源 = ac-host-rows workspace-files.ts）
    const wsRoot = conversationWorkspaceRoot(deps.dataRoot, optStr(p.conversationId));
    return {
      skills: {
        global: scanSkills(path.join(deps.dataRoot, 'skills')),
        own: agentId !== undefined ? scanSkills(path.join(deps.dataRoot, 'files', agentId, 'skills')) : [],
        // 会话挂载工作区的约定目录技能（主线 web-api skills/list 线形同形）
        workspace: wsRoot !== null ? scanWorkspaceSkills(wsRoot) : [],
      },
    };
  });
}

/** 文件快照读面（同一 owning 实现：<root>/file-snapshots 的 SnapshotStore） */
function registerSnapshots(web: WebFace, ctx: Context, deps: FaceOpsDeps): void {
  const store = new SnapshotStore({ root: path.join(deps.dataRoot, 'file-snapshots') });
  // 磁盘终版读取（无快照存量文件的重建数据源）：准入闸与 owning 行同源——
  // 上限取 settings.fileSnapshots.maxBytes（缺省 SNAPSHOT_MAX_BYTES）+ 文本嗅探
  const limitOf = (): number => {
    const config = ctx.get('config') as { get<T>(key: string): T | undefined } | undefined;
    const layer = config?.get<Record<string, unknown>>('settings.fileSnapshots');
    const v = layer?.maxBytes;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : SNAPSHOT_MAX_BYTES;
  };
  const readCurrent = (absPath: string): string | null => {
    try {
      const resolved = path.resolve(absPath);
      const st = fs.statSync(resolved);
      if (!st.isFile()) return null;
      const limit = limitOf();
      if (limit > 0 && st.size > limit) return null;
      const text = fs.readFileSync(resolved, 'utf-8');
      return looksLikeText(text) ? text : null;
    } catch {
      return null;
    }
  };
  web.registerRpc('fileSnapshots/list', (params) => ({
    snapshots: store.list(reqStr(obj(params), 'conversationId')),
  }));
  web.registerRpc('fileSnapshots/read-current', (params) => {
    const p = obj(params);
    const paths = Array.isArray(p.paths) ? (p.paths as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const contents: Record<string, string | null> = {};
    for (const abs of paths.slice(0, 200)) contents[abs] = readCurrent(abs);
    return { contents };
  });
}

/** 用量汇总（ctx.usage = ac-usage 行零改动导入；形状与主线 web-api 逐字段一致） */
function registerUsage(web: WebFace, ctx: Context): void {
  web.registerRpc('usage/tokens', () => {
    const usage = ctx.get('usage') as
      | {
          byAgent(): unknown; byModel(): unknown; byDay(): unknown; byDayModel(): unknown;
          byDayPair(): unknown; byConversation(): unknown; byPair(): unknown;
          bySelfSession(): unknown; totals(): unknown;
        }
      | undefined;
    if (usage === undefined) throw new Error('usage 服务未装配（usage 行不在宿主行集）——用量面不可用');
    return {
      byAgent: usage.byAgent(),
      byModel: usage.byModel(),
      byDay: usage.byDay(),
      byDayModel: usage.byDayModel(),
      byDayPair: usage.byDayPair(),
      byConversation: usage.byConversation(),
      byPair: usage.byPair(),
      bySelfSession: usage.bySelfSession(),
      totals: usage.totals(),
    };
  });
}

/** 版本面：仓库 package.json + CHANGELOG.md（自更新通道 preview 轨道没有 → 显式报告） */
function registerSystem(web: WebFace, deps: FaceOpsDeps): void {
  const readVersion = (): { current: string; name: string } => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join((deps.repoRoot ?? DEFAULT_REPO_ROOT), 'package.json'), 'utf-8')) as {
        version?: string; name?: string;
      };
      return { current: typeof pkg.version === 'string' ? pkg.version : '0.0.0', name: typeof pkg.name === 'string' ? pkg.name : 'agentchat' };
    } catch {
      return { current: '0.0.0', name: 'agentchat' };
    }
  };
  web.registerRpc('system/version', () => readVersion());
  // 更新检查：preview 轨道无「发布清单」通道（更新 = git pull + supervisor 重启），
  // checkFailed 显式上报而不是垫一个假的「已是最新」
  web.registerRpc('system/version-check', () => ({
    ...readVersion(),
    latest: null,
    hasUpdate: false,
    latestUrl: null,
    checkFailed: true,
    note: 'preview 轨道无自更新通道：更新 = git pull + 重启 dev:supervised',
  }));
  web.registerRpc('system/version-changelog', () => {
    try {
      return { content: fs.readFileSync(path.join((deps.repoRoot ?? DEFAULT_REPO_ROOT), 'CHANGELOG.md'), 'utf-8') };
    } catch {
      return { content: '' };
    }
  });
  web.registerRpc('system/version-update', () => {
    throw new Error('preview 轨道无自更新通道：更新 = git pull + 重启 dev:supervised');
  });
}

/** 事件治理面（events/policy-set = ctx.eventPolicy 写口；目录面见下） */
function registerEvents(web: WebFace, ctx: Context): void {
  web.registerRpc('events/policy-set', async (params) => {
    const p = obj(params);
    const policy = ctx.get('eventPolicy') as { setPolicy(key: string, disabled: boolean): Promise<string[]> } | undefined;
    if (policy === undefined) throw new Error('eventPolicy 服务未装配（事件治理面不可用）');
    const key = reqStr(p, 'key');
    const disabled = p.disabled !== false;
    const next = await policy.setPolicy(key, disabled);
    return {
      set: true, key, disabled, disabledList: next,
      note: disabled
        ? '停用已写入 config events.disabled：后续注册即被吞；boot 期已注册条目需重启进程生效。'
        : '启用已写入——重启进程后恢复注册。',
    };
  });
  // 目录面：宿主侧不做行包自述聚合（那是装饰/治理视图）——返回空清单让前端渲染空态，
  // 待「事件目录数据化」批接入（不在本批范围，避免半真数据）
  web.registerRpc('events/listeners', () => ({ events: [] }));
  web.registerRpc('events/descriptions', () => ({ descriptions: [] }));
}


/** 默认行集目录（preview/apps/catalog/row-catalog.json） */
const DEFAULT_CATALOG_FILE = fileURLToPath(new URL('../../../apps/catalog/row-catalog.json', import.meta.url));

/**
 * 工作区域（cr-568）：本机目录浏览 / 原生文件夹选择 / 系统打开。
 * 原生编排复用 ac-workspace 的纯模块（native-dialog / native-open——同一实现，
 * 不写第二份平台分支）；preview 无 workspace 行 → 树基准 = 数据根 / Agent 空间。
 */
function registerWorkspace(web: WebFace, deps: FaceOpsDeps): void {
  /** 快捷根：Windows 盘符 + 用户主目录（浏览弹窗空 path 的入口） */
  const roots = (): Array<{ name: string; path: string }> => {
    const out: Array<{ name: string; path: string }> = [];
    if (process.platform === 'win32') {
      for (let c = 65; c <= 90; c += 1) {
        const drive = String.fromCharCode(c) + ':\\';
        if (fs.existsSync(drive)) out.push({ name: drive.slice(0, 2), path: drive });
      }
    } else {
      out.push({ name: '/', path: '/' });
    }
    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (home !== undefined && fs.existsSync(home)) out.push({ name: '主目录', path: home });
    // 已登记工作区（cr-583：主线 browseRoots 同义——登记表缺席 = 空集不追加）
    for (const w of listWorkspaces(deps.dataRoot)) out.push({ name: '工作区：' + w.name, path: w.path });
    return out;
  };

  web.registerRpc('workspace/browse-dirs', (params) => {
    const p = obj(params);
    const want = typeof p.path === 'string' ? p.path : '';
    if (want === '') return { path: '', roots: roots(), dirs: [] };
    if (!path.isAbsolute(want)) return { path: want, dirs: [], error: '须为绝对路径' };
    const target = path.resolve(want);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (err: unknown) {
      return { path: target, parent: path.dirname(target), dirs: [], error: err instanceof Error ? err.message : String(err) };
    }
    const dirs: Array<{ name: string; path: string }> = [];
    const files: Array<{ name: string; path: string }> = [];
    for (const e of entries) {
      if (e.isDirectory()) dirs.push({ name: e.name, path: path.join(target, e.name) });
      else if (p.files === true && e.isFile()) files.push({ name: e.name, path: path.join(target, e.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    return {
      path: target,
      ...(parent !== target ? { parent } : {}),
      dirs,
      ...(p.files === true ? { files } : {}),
    };
  });

  // 原生文件夹选择（系统对话框；结果三态 path / cancelled / error——与主线同形）
  web.registerRpc('workspace/pick-folder', async (params) => runNativePickFolder({ title: optStr(obj(params).title) }));

  // 本地打开文件（系统默认程序）：绝对路径直用，相对路径按数据根解析
  web.registerRpc('workspace/open-local', async (params) => {
    const p = obj(params);
    const raw = reqStr(p, 'path');
    const file = path.isAbsolute(raw) ? raw : path.resolve(deps.dataRoot, raw);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return { error: '目标不是文件：' + file };
    } catch {
      return { error: '文件不存在：' + file };
    }
    return runNativeOpen(file, { select: false });
  });

  // 本地资源管理器（workspace/open-dir）：workspaceId = 登记工作区；缺席按
  // 树基准推导（会话挂载工作区 > Agent 空间 > 数据根——与树面板同源，
  // cr-676；此前恒开 Agent 空间/数据根，登记工作区点了开错文件夹）
  web.registerRpc('workspace/open-dir', async (params) => {
    const p = obj(params);
    const workspaceId = optStr(p.workspaceId);
    const registered = workspaceId !== undefined ? workspacePathOf(deps.dataRoot, workspaceId) : null;
    if (workspaceId !== undefined && registered === null) return { error: '工作区不存在：' + workspaceId };
    const agentId = optStr(p.agentId);
    const conversationId = optStr(p.conversationId);
    const dir = registered ?? workspaceTreeBase(deps.dataRoot, {
      ...(agentId !== undefined ? { agentId } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
    }).dir;
    try {
      if (!fs.statSync(dir).isDirectory()) return { error: '目标不是文件夹：' + dir };
    } catch {
      return { error: '文件夹不存在或不可访问：' + dir };
    }
    return runNativeOpen(dir, { select: false });
  });
}

/**
 * 插件目录面（cr-568）：preview 形态的语义裁定——
 *   插件 = **行集条目**（宿主行 + 壳行），第三方代码零宿主驻留（R0a）；
 *   builtin 组 = 行集目录（assembled = 该行在宿主树），local 组 = 安装态 +
 *   待审暂存；plugin/load|unload 在宿主无意义（装载发生在壳 boot），patch-*
 *   机制已整体退役（cr-485）——两条都以可读原因 fail-loud，不空转。
 */
function registerPlugin(web: WebFace, ctx: Context, deps: FaceOpsDeps): void {
  const registry = (): {
    listInstalled(): Array<Record<string, unknown>>;
    stagingRecords(): Array<Record<string, unknown>>;
  } => {
    const service = ctx.get('pluginRegistry') as ReturnType<typeof registry> | undefined;
    if (service === undefined) throw new Error('pluginRegistry 服务未装配（plugin-registry 行不在宿主行集）——插件面不可用');
    return service;
  };

  web.registerRpc('plugin/catalog', () => {
    const catalog = readCatalog((deps.catalogFile ?? DEFAULT_CATALOG_FILE));
    const builtin = catalog.rows
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => ({
        name: r.id,
        ...(r.role !== undefined ? { description: r.role } : {}),
        assembled: r.tree === 'host',
        fibers: 0,
        entryId: r.id,
      }));
    const local = registry().listInstalled().map((rec) => ({
      name: String(rec.name ?? ''),
      ...(typeof rec.version === 'string' ? { version: rec.version } : {}),
      ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
      ...(typeof rec.owner === 'string' ? { owner: rec.owner } : {}),
      ...(typeof rec.dir === 'string' ? { dir: rec.dir } : {}),
      state: 'installed' as const,
    }));
    const pending = registry().stagingRecords().map((rec) => ({
      pendingId: String(rec.id ?? ''),
      name: String((rec.manifest as { name?: unknown } | undefined)?.name ?? rec.name ?? ''),
      version: String((rec.manifest as { version?: unknown } | undefined)?.version ?? ''),
      owner: String(rec.owner ?? ''),
      requiredGrants: Array.isArray(rec.requiredGrants) ? rec.requiredGrants : [],
      createdAt: String(rec.createdAt ?? ''),
    }));
    return {
      builtin,
      local,
      pending,
      note: 'preview 形态：插件 = 行集条目（宿主行 + 壳行），第三方代码不驻留宿主（装载发生在壳 boot）；安装走上架人审（plugin/stage → plugin/approve）。',
    };
  });

  web.registerRpc('plugin/load', () => {
    throw new Error('宿主不装载第三方代码（R0a）：preview 的插件装载发生在壳 boot（安装态 → 行集条目 → 壳内动态 import）。请用 plugin/stage → plugin/approve 安装。');
  });
  web.registerRpc('plugin/unload', () => {
    throw new Error('宿主不驻留第三方代码，无「卸载已装载实例」语义：永久卸载用 plugin/uninstall；会话级装卸由壳内 plugin-dev 行的工具面完成。');
  });
  for (const method of ['plugin/patch-list', 'plugin/patch-set', 'plugin/patch-reset']) {
    web.registerRpc(method, () => {
      throw new Error('patch 机制已整体退役（cr-485）：行集偏好改用 rows/list|rows/set|rows/reset（恒冷生效）。');
    });
  }
}

/** 模型清单探测（OpenAI-compat GET <base_url>/models——与主线 pool/probe 同协议族） */
async function fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const res = await fetch(url, {
    headers: apiKey !== '' ? { authorization: 'Bearer ' + apiKey } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('清单端点返回 ' + res.status + '：' + url);
  const body = await res.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ name?: unknown } | string> };
  const out: string[] = [];
  for (const m of body.data ?? []) if (typeof m.id === 'string') out.push(m.id);
  for (const m of body.models ?? []) {
    if (typeof m === 'string') out.push(m);
    else if (typeof m.name === 'string') out.push(m.name);
  }
  return [...new Set(out)].sort();
}

/** 模型连接面：宿主无 ctx.llm（池在壳内）——按 config.llmProviders 投影给前端；
 *  发现面（llm/models|probe-models）按池 base_url + 凭据探测并回写发现缓存 */
function registerLlm(web: WebFace, ctx: Context, deps: FaceOpsDeps): void {
  web.registerRpc('llm/providers', () => {
    let pool: Record<string, unknown> = {};
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(deps.dataRoot, 'config.json'), 'utf-8')) as Record<string, unknown>;
      const raw = cfg.llmProviders;
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) pool = raw as Record<string, unknown>;
    } catch { /* 无 config = 空池 */ }
    const names = Object.keys(pool).filter((n) => !n.startsWith('$'));
    const stats = names.map((name) => {
      const entry = pool[name];
      const e = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      const modelsRaw = Array.isArray(e.models) ? e.models : [];
      const models: string[] = [];
      const modelMeta: Record<string, { vision?: boolean; hidden?: boolean }> = {};
      for (const m of modelsRaw) {
        if (typeof m === 'string') { models.push(m); continue; }
        if (m !== null && typeof m === 'object') {
          const item = m as Record<string, unknown>;
          if (typeof item.model !== 'string') continue;
          models.push(item.model);
          const meta: { vision?: boolean; hidden?: boolean } = {};
          if (typeof item.vision === 'boolean') meta.vision = item.vision;
          if (typeof item.hidden === 'boolean') meta.hidden = item.hidden;
          if (Object.keys(meta).length > 0) modelMeta[item.model] = meta;
        }
      }
      return {
        name,
        models,
        // 本进程无 provider 实例（池在壳内）——如实上报，前端以配置为清单源
        instantiated: false,
        ...(typeof e.base_url === 'string' ? { baseUrl: e.base_url } : {}),
        ...(typeof e.protocol === 'string' ? { protocol: e.protocol } : {}),
        ...(Object.keys(modelMeta).length > 0 ? { modelMeta } : {}),
      };
    });
    return { providers: names, stats };
  });

  // 免注册探测（新建弹窗「填 Key 即读清单」）：base_url + api_key 直调，不落缓存
  web.registerRpc('llm/probe-models', async (params) => {
    const p = obj(params);
    const baseUrl = reqStr(p, 'base_url');
    const apiKey = optStr(p.api_key) ?? '';
    return { models: await fetchModels(baseUrl, apiKey) };
  });

  // 池条目发现（ChatInput 打开模型菜单时对无发现缓存的连接补拉一次）：
  // api_key 取凭据侧信道（POOL:<NAME>），清单回写 config.llmProviders[name].models
  web.registerRpc('llm/models', async (params) => {
    const name = reqStr(obj(params), 'name');
    const config = ctx.get('config') as
      | { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
      | undefined;
    if (config === undefined) throw new Error('config 服务未装配——发现缓存不可用');
    const pool = config.get<Record<string, unknown>>('llmProviders') ?? {};
    const entry = pool[name];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('连接不存在：' + name);
    const e = entry as Record<string, unknown>;
    if (typeof e.base_url !== 'string' || e.base_url === '') throw new Error('连接缺 base_url：' + name);
    const apiKey = createPoolCredentials(deps.dataRoot).get('POOL:' + name);
    const models = await fetchModels(e.base_url, apiKey);
    if (models.length === 0) throw new Error('清单端点未返回模型：' + name);
    config.set('llmProviders', { ...pool, [name]: { ...e, models } });
    return { models };
  });
}

// ============================================================
// 会话计量 + 运行矩阵（cr-574）：宿主聚合面——对齐主线 ac-web-api
// sessionTokensPayload 与 runs/snapshot 口径，数据源换 preview 拓扑：
//   session/tokens → user 投影账本回放估算（contextTokens）+
//                    agent 域 journal 的 journal-settled usage 计量（cache 面）
//   runs/snapshot  → user 会话目录扫描（stat 指纹 + 展开读）+
//                    活壳 run-state 控制帧（活跃 run 集）+ digest 短路
// ============================================================

/** runs/snapshot 数据指纹 → digest（主线 web-api 同款 FNV-1a 短哈希） */
function hashFingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function registerRunsFace(web: WebFace, ctx: Context, deps: FaceOpsDeps): void {
  /** 会话的承载 Agent（agent 域账本在场者——预算分母与回执归属解析） */
  const owningAgentOf = (conversationId: string): string | undefined => {
    let agents: fs.Dirent[] = [];
    try { agents = fs.readdirSync(path.join(deps.dataRoot, 'agents'), { withFileTypes: true }); } catch { return undefined; }
    for (const a of agents) {
      if (a.isDirectory()
        && fs.existsSync(path.join(deps.dataRoot, 'agents', a.name, 'sessions', conversationId, 'messages.jsonl'))) {
        return a.name;
      }
    }
    return undefined;
  };

  /** 归档预算分母（全局 settings ∪ agent 差异层——主线 archive budgetsFor 同口径；缺省 1M） */
  const archiveBudgetOf = (agentId: string | undefined): number => {
    let globalSettings: Record<string, unknown> | undefined;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(deps.dataRoot, 'config.json'), 'utf-8')) as Record<string, unknown>;
      if (cfg.settings !== null && typeof cfg.settings === 'object' && !Array.isArray(cfg.settings)) globalSettings = cfg.settings as Record<string, unknown>;
    } catch { /* 无全局 config = 无全局层 */ }
    const agentSettings = agentId !== undefined ? readAgentConfig(deps.dataRoot, agentId)?.settings : undefined;
    const archive = settingsOf(globalSettings, agentSettings, 'archive') as { maxContextTokens?: unknown } | undefined;
    return typeof archive?.maxContextTokens === 'number' && archive.maxContextTokens > 0 ? archive.maxContextTokens : 1_000_000;
  };

  // 会话 Token 仪表（主线 sessionTokensPayload 同形）：contextTokens = user
  // 投影账本逐消息直估（终稿层——agent 域 steps 不入 UI 仪表口径）；cache 面 =
  // 各 agent 域 journal-settled 的 run 级计量聚合（UsageAggregate 覆盖/累加轨同义）
  web.registerRpc('session/tokens', (params) => {
    const p = obj(params);
    const conversationId = reqStr(p, 'conversationId');
    const rows = new UserLedger(deps.dataRoot, conversationId, ['user']).replay();
    const promptTokens = rows.reduce((n, r) => n + estimateTokens(r.content), 0);
    let hit = 0;
    let miss = 0;
    let lastHit = 0;
    let lastMiss = 0;
    let lastRunPrompt = 0;
    for (const dir of conversationDirs(deps.dataRoot, conversationId)) {
      for (const line of readJournal(dir)) {
        if (line.type !== 'journal-settled' || line.usage === undefined) continue;
        hit += line.usage.cacheHit ?? 0;
        miss += line.usage.cacheMiss ?? 0;
        lastHit = line.usage.cacheHit ?? 0;
        lastMiss = line.usage.cacheMiss ?? 0;
        lastRunPrompt = line.usage.prompt;
      }
    }
    const agentId = optStr(p.agentId) ?? owningAgentOf(conversationId);
    const maxContextTokens = archiveBudgetOf(agentId);
    const messageCount = rows.length;
    const avgTokensPerMsg = messageCount > 0 ? promptTokens / messageCount : 0;
    const usagePercent = Math.min(100, (promptTokens / maxContextTokens) * 100);
    return {
      conversationId,
      messageCount,
      contextTokens: promptTokens,
      maxContextTokens,
      avgTokensPerMsg: Math.round(avgTokensPerMsg),
      usagePercent,
      estimatedMsgsRemaining:
        avgTokensPerMsg > 0 ? Math.max(0, Math.floor((maxContextTokens - promptTokens) / avgTokensPerMsg)) : 0,
      status: usagePercent < 75 ? 'normal' : usagePercent < 90 ? 'high' : 'critical',
      ...(agentId !== undefined ? { agentId } : {}),
      cache: { lastHit, lastMiss, hit, miss, lastRunPrompt },
    };
  });

  // 运行矩阵快照（主线 runs/snapshot 同构）：指纹阶段只 stat（零文件读）；
  // 活跃集 = 活壳 run-state 帧（busy 壳才成条——闲壳在跑不等于有 run）。
  // digest 短路：请求带上一轮 digest 且当前一致 → unchanged 轻载荷。
  let lastRunsDigest: string | null = null;
  web.registerRpc('runs/snapshot', async (params) => {
    const sessionsRoot = path.join(deps.dataRoot, 'viewer', 'sessions');
    let sessionDirs: fs.Dirent[] = [];
    try { sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { /* 无 user 会话域 */ }
    const convsMeta = sessionDirs
      .filter((e) => e.isDirectory())
      .map((e) => {
        let size = -1;
        let mtimeMs = 0;
        try { const st = fs.statSync(path.join(sessionsRoot, e.name, 'messages.jsonl')); size = st.size; mtimeMs = st.mtimeMs; } catch { /* 无账本文件 */ }
        return { cid: e.name, size, mtimeMs };
      });
    // 群面（cr-579）：groups/<gid>/group.json 扫描（主线 ctx.group.list 同源形状）
    const groups = listGroupConfigs(deps.dataRoot);
    // 活跃 run 集（cr-598 提为共享件 collectRunning——stats/history 活投影同源）
    const running: Array<{ agentId: string; conversationId: string; handle: string; startedAt: number }> = (await collectRunning(deps)).map((r) => ({
      ...r,
      handle: r.conversationId === r.agentId ? r.agentId : r.conversationId + '~' + r.agentId,
    }));
    const fingerprint = [
      convsMeta.map((c) => c.cid + ':' + c.size + ':' + c.mtimeMs).sort().join('|'),
      running.map((r) => r.agentId + '@' + r.conversationId + '#' + r.startedAt).sort().join('|'),
      groups.map((g) => g.id + ':' + g.members.length + ':' + g.name).sort().join('|'),
    ].join('::');
    const digest = hashFingerprint(fingerprint);
    const reqDigest = obj(params).digest;
    if (typeof reqDigest === 'string' && reqDigest === digest && lastRunsDigest === digest) {
      return { unchanged: true, digest, generatedAt: Date.now() };
    }
    lastRunsDigest = digest;
    // 展开阶段（digest 变化或首轮）：此刻才读账本（messageCount + 尾部摘要）
    const conversations = convsMeta
      .filter((c) => c.size >= 0)
      .map((c) => {
        const { rows } = readLedger(path.join(sessionsRoot, c.cid));
        const last = rows.at(-1);
        return {
          conversationId: c.cid,
          messageCount: rows.length,
          size: c.size,
          updatedAt: c.mtimeMs,
          ...(last !== undefined
            ? {
              last: {
                role: last.agent_id === 'user' ? 'user' : 'assistant',
                text: last.content.slice(0, 120),
                ts: last.timestamp,
                ...(last.agent_id !== 'user' ? { agent_id: last.agent_id } : {}),
              },
            }
            : {}),
        };
      });
    const usage = ctx.get('usage') as { totals(): unknown } | undefined;
    return {
      digest,
      generatedAt: Date.now(),
      conversations,
      running,
      // 群面（cr-579）：主线 runs/snapshot groups 同形（矩阵视图成员轴 + 名册合成）
      groups: groups.map((g) => ({
        groupId: g.id,
        name: g.name,
        memberCount: g.members.length,
        members: g.members,
      })),
      ...(usage !== undefined ? { usageTotals: usage.totals() } : {}),
    };
  });
}

/** 一批注册（web-api 行装配时调用） */
export function registerOpsFace(web: WebFace, ctx: Context, deps: FaceOpsDeps): void {
  registerTimers(web, ctx);
  registerIdentity(web);
  registerSkills(web, deps);
  registerSnapshots(web, ctx, deps);
  registerUsage(web, ctx);
  registerSystem(web, deps);
  registerEvents(web, ctx);
  // 前缀快照时间线（主线 singles 的 M21 能力）：preview 会话面无快照机制——
  // 空时间线是终态而非缺失（前端 KV 面板据此渲染空态）
  web.registerRpc('session/kv-timeline', () => ({ entries: [] }));
  registerWorkspace(web, deps);
  registerPlugin(web, ctx, deps);
  registerLlm(web, ctx, deps);
  registerRunsFace(web, ctx, deps);
}
