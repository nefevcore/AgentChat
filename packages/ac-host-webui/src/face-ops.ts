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
  workspacePathOf,
  workspaceTreeBase,
  resolveWorkspaceFile,
} from 'ac-host-rows';
import { validateTimerEntries } from 'ac-timer-core'; // cr-886 下沉单源（cr-1164 v3 换轨）
import { createPoolCredentials, maskSecrets } from './config-face.ts';
import type { ShellAdminPort } from './face-shell.ts';
import { readCatalogSnapshot } from './face-shell.ts';
import { SnapshotStore, SNAPSHOT_MAX_BYTES, looksLikeText } from 'ac-file-snapshots/src/store.ts';
import { runNativePickFolder } from 'ac-workspace/src/native-dialog.ts';
import { runNativeOpen } from 'ac-workspace/src/native-open.ts';
import { resolveOpenTargets, refreshTarget, runOpenWith, targetIconOf } from 'ac-workspace/src/open-targets.ts';
import { assocIconOfExt, folderIconOf } from 'ac-workspace/src/file-assoc-icons.ts';
import { readCatalog } from 'ac-rowset-core';
import { conversationDirs, foldDigestOf, foldSession, foldStepsOf, foldSummaryOf, projectUserReplay, readDomainFacts, readJournal, readLedger, rowShadowedBy, summaryTextOf } from 'ac-ledger';
import { readAgentConfig, settingsOf } from 'ac-agents-core';
import { estimateTokens } from 'ac-text-budget';
import { estimateReplayTokens } from 'ac-archive-core';

interface WebFace {
  registerRpc(method: string, handler: (params: unknown) => unknown): void;
}

export interface FaceOpsDeps {
  dataRoot: string;
  /** 仓库根（package.json / CHANGELOG.md 锚点；缺省 = AGENTCHAT_VERSION_JSON env
   * 优先〔bundle 形态：dist/version.json 随包走〕，仓库形态 = 本包向上四层） */
  repoRoot?: string;
  /** 行集目录（plugin/catalog 的 builtin 组数据源；缺省 = apps/catalog） */
  catalogFile?: string;
  /** 编排面惰性端口（runs/snapshot 活跃集——活壳 run-state 帧；缺席 = 无活跃面） */
  shellPort?: () => ShellAdminPort | null;
  /** 宿主壳状态镜像（cr-824 批二：poller 每拍 peek 的宿主内存镜像——
   *  在场时活跃集读它（零现探、无观测失败态——永阻塞不了）；缺席 = 退回
   *  collectRunning 现探（独立形态/旧接线兼容）。 */
  pollerSnapshot?: () => Map<string, { runs: Array<{ conversationId: string; runId: string | null; startedAt: number }> }> | null;
}

/** 仓库根解析：AGENTCHAT_VERSION_JSON（bundle 形态 env 注入）> 包相对缺省。
 * version.json 邻域即版本锚（readVersion 读 {name,version}——两形态同形）。 */
const VERSION_ANCHOR = () => process.env.AGENTCHAT_VERSION_JSON
  ?? fileURLToPath(new URL('../../../package.json', import.meta.url));
const DEFAULT_REPO_ROOT = () => path.dirname(VERSION_ANCHOR());

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
 * 观测态三值（cr-802 光环偶发消失根修）：port 缺席 = []（无编排面是稳定部署
 * 形态——确定无活跃面）；探测全部失败（有壳在场但一帧未答）= null（本拍无
 * 活跃面数据——观测失败≠没在跑；此前聚成空集会让 runs/snapshot digest 步进，
 * 前端把运行中条目清掉 = 光环消失，下一拍观测恢复才回来——「偶发」形态的
 * 宿主侧源头）。部分失败 = 精确集（成功壳照答，退出中壳本拍缺席）。 */
export type RunningProjection = Array<{ agentId: string; conversationId: string; runId: string | null; startedAt: number }> | null;

/** 活跃集读面单源（cr-824 批二）：poller 镜像在场 → 读它（宿主内存，零现探、
 *  无观测失败态——cr-802 的 null 两难随失败态一起消解：镜像不会 null）；
 *  缺席 → collectRunning 现探（独立形态/旧接线）。runs/snapshot、
 *  conversation/stats、session/history 三消费点共用本口。 */
export function runningOf(deps: FaceOpsDeps): Promise<RunningProjection> {
  if (deps.pollerSnapshot !== undefined) {
    const snap = deps.pollerSnapshot();
    if (snap !== null) {
      const running: Array<{ agentId: string; conversationId: string; runId: string | null; startedAt: number }> = [];
      for (const [agentId, s] of snap) {
        for (const r of s.runs) running.push({ agentId, ...r });
      }
      return Promise.resolve(running);
    }
  }
  return collectRunning(deps);
}

export async function collectRunning(deps: FaceOpsDeps): Promise<RunningProjection> {
  const running: Array<{ agentId: string; conversationId: string; runId: string | null; startedAt: number }> = [];
  const port = deps.shellPort?.() ?? null;
  if (port === null) return [];
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
  let probed = 0;
  for (const { agentId, control } of shells) {
    try {
      const st = await control({ ctrl: 'admin', agentId, op: 'run-state' }) as
        | { busy?: unknown; conversationId?: unknown; runId?: unknown; startedAt?: unknown; runs?: unknown }
        | null;
      probed += 1;
      // cr-746 per-门后壳可多 run：优先读 runs 数组（每会话一条）；
      // 旧壳单 run 形状（busy/conversationId 顶层字段）兼容回退。
      const list = Array.isArray(st?.runs)
        ? (st.runs as Array<{ conversationId?: unknown; runId?: unknown; startedAt?: unknown }>)
            .filter((r) => typeof r.conversationId === 'string' && r.conversationId !== '')
            .map((r) => ({
              conversationId: r.conversationId as string,
              runId: typeof r.runId === 'string' && r.runId !== '' ? r.runId : null,
              startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
            }))
        : st?.busy === true && typeof st.conversationId === 'string' && st.conversationId !== ''
          ? [{
            conversationId: st.conversationId,
            runId: typeof st.runId === 'string' && st.runId !== '' ? st.runId : null,
            startedAt: typeof st.startedAt === 'number' ? st.startedAt : 0,
          }]
          : [];
      for (const r of list) running.push({ agentId, ...r });
    } catch { /* 壳在退出/本拍不可观测——跳过（观测失败≠没在跑） */ }
  }
  // 有壳在场但一帧未答 = 本拍无活跃面数据（null）——调用方沿用上一拍投影
  if (shells.length > 0 && probed === 0) return null;
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

/** 身份目录面：预设清单（标签轴 cr-484 已退役、tags 目录随 cr-953 退役） */
function registerIdentity(web: WebFace): void {
  web.registerRpc('agents/presets', () => ({
    presets: listTemplates().map((t) => ({
      id: t.config.id,
      name: t.config.name ?? t.label,
      label: t.label,
      description: t.description ?? '',
      default: t.default === true,
    })),
  }));
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
    // 版本单源：AGENTCHAT_VERSION_JSON（bundle 形态 env 注入）> repoRoot 显式 > 包相对缺省
    const anchorFile = deps.repoRoot !== undefined ? path.join(deps.repoRoot, 'package.json') : VERSION_ANCHOR();
    try {
      const pkg = JSON.parse(fs.readFileSync(anchorFile, 'utf-8')) as {
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
    note: 'preview 轨道无自更新通道：更新 = git pull + 重启 pnpm dev（supervised）',
  }));
  web.registerRpc('system/version-changelog', () => {
    try {
      return { content: fs.readFileSync(path.join((deps.repoRoot ?? DEFAULT_REPO_ROOT()), 'CHANGELOG.md'), 'utf-8') };
    } catch {
      return { content: '' };
    }
  });
  web.registerRpc('system/version-update', () => {
    throw new Error('preview 轨道无自更新通道：更新 = git pull + 重启 pnpm dev（supervised）');
  });
}

/** 事件治理面（cr-826 目录数据化）：policy 写口 + 目录三面。
 *  目录数据源 = tool-catalog.json 快照（生成器真装配 dump——壳树注册面
 *  单源派生）∪ 宿主树活态（宿主自有行现算——两树并集，同名事件
 *  listeners 追加）。治理键 owner 原文两侧一致（fiber 名）。 */
function registerEvents(web: WebFace, ctx: Context, deps: FaceOpsDeps): void {
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

  /** 宿主树活态注册面（_hooks 私有读——与 ac-event-policy 同款立场；
   *  过滤 internal/* 与快照同口径） */
  const liveHostEvents = (): Array<{ name: string; listeners: Array<{ owner: string; prepend: boolean; global: boolean; description?: string }> }> => {
    const out: Array<{ name: string; listeners: Array<{ owner: string; prepend: boolean; global: boolean; description?: string }> }> = [];
    const hooksTable = ctx.events as unknown as { _hooks: Record<string, Array<{ ctx?: { fiber?: { name?: string } }; prepend?: unknown; global?: unknown; description?: unknown }>> };
    for (const [name, hooks] of Object.entries(hooksTable._hooks)) {
      if (name.startsWith('internal/')) continue;
      if (!Array.isArray(hooks) || hooks.length === 0) continue;
      out.push({
        name,
        listeners: hooks.map((h) => ({
          owner: h.ctx?.fiber?.name ?? '(anonymous)',
          prepend: h.prepend === true,
          global: h.global === true,
          ...(typeof h.description === 'string' && h.description !== '' ? { description: h.description } : {}),
        })),
      });
    }
    return out;
  };

  web.registerRpc('events/listeners', () => {
    const byName = new Map<string, { name: string; listeners: Array<Record<string, unknown>> }>();
    for (const e of readCatalogSnapshot(deps.catalogFile).events) {
      byName.set(e.name, { name: e.name, listeners: [...e.listeners] });
    }
    for (const e of liveHostEvents()) {
      const merged = byName.get(e.name);
      if (merged === undefined) byName.set(e.name, { name: e.name, listeners: [...e.listeners] });
      else merged.listeners.push(...e.listeners);
    }
    return { events: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
  });

  web.registerRpc('events/descriptions', () => {
    // 静态声明目录（builtin 源）∪ 动态插件（session 源——宿主侧无装载面，
    // 动态行卸载即失，快照不含；此处仅 builtin 面，与生成器口径一致）
    return { descriptions: readCatalogSnapshot(deps.catalogFile).eventDescs };
  });

  web.registerRpc('events/policy-list', () => {
    const policy = ctx.get('eventPolicy') as { disabledKeys(): Set<string> } | undefined;
    const disabled = policy !== undefined ? [...policy.disabledKeys()].sort() : [];
    const live = new Set<string>();
    for (const e of readCatalogSnapshot(deps.catalogFile).events) {
      for (const l of e.listeners) live.add(String(l.owner) + '::' + e.name);
    }
    for (const e of liveHostEvents()) {
      for (const l of e.listeners) live.add(l.owner + '::' + e.name);
    }
    return { disabled, live: [...live].sort() };
  });
}


/** 默认行集目录（apps/catalog/row-catalog.json） */
export const DEFAULT_CATALOG_FILE = fileURLToPath(new URL('../../../apps/catalog/row-catalog.json', import.meta.url));

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

  // 本地打开文件（系统默认程序）：定位与守卫同读面单源 resolveWorkspaceFile
  //（数据根快路径 → 会话挂载工作区/Agent 基准推导——与 /api/workspace/raw
  //  同源；前端文件编辑卡传的相对路径按挂载工作区解析，此前恒按数据根
  // 解析致挂载工作区文件打不开，cr-827）
  web.registerRpc('workspace/open-local', async (params) => {
    const p = obj(params);
    const raw = reqStr(p, 'path');
    const agentId = optStr(p.agentId);
    const conversationId = optStr(p.conversationId);
    let file: string;
    try {
      file = resolveWorkspaceFile(
        deps.dataRoot,
        raw,
        agentId !== undefined || conversationId !== undefined
          ? { ...(agentId !== undefined ? { agentId } : {}), ...(conversationId !== undefined ? { conversationId } : {}) }
          : undefined,
      );
    } catch {
      return { error: '文件不存在或不可读：' + raw };
    }
    return runNativeOpen(file, { select: false });
  });

  // 「打开方式」目标清单（cr-829）：解析 map 投影（每进程一次惰性解析，
  // 点击不重探测——纯模块行为面由 open-targets.test.ts 锁）；前端按 kind
  // 过滤（notepad 只能开文件、terminal 只能开目录）
  web.registerRpc('workspace/open-targets', async () => {
    const map = await resolveOpenTargets();
    const targets = await Promise.all([...map.values()].map(async (t) => ({
      id: t.id,
      label: t.label,
      kind: t.kind,
      // 真实应用图标（win exe 提取 dataURL；null = 无——前端回落线性图标）
      icon: await targetIconOf(t),
    })));
    return { targets };
  });

  // 文件关联图标批量查询（cr-833）：树内出现的扩展名清单 → 原生关联图标
  // dataURL（null = 无关联/非 win——前端回落静态表）。ext 白名单拒键注入；
  // 每扩展名一次注册表决议 + 提取，进程内缓存（树刷新零重复查询）。
  web.registerRpc('workspace/assoc-icons', async (params) => {
    const p = obj(params);
    const extsRaw = Array.isArray(p.exts) ? p.exts : [];
    const exts = [...new Set(extsRaw.filter((e): e is string => typeof e === 'string' && /^[a-z0-9]{1,16}$/i.test(e)))].slice(0, 64);
    const icons: Record<string, string | null> = {};
    const dirIcon = await folderIconOf().catch(() => null);
    await Promise.all(exts.map(async (ext) => {
      icons[ext.toLowerCase()] = await assocIconOfExt(ext.toLowerCase()).catch(() => null);
    }));
    return { icons, dirIcon };
  });

  // 指定应用打开（cr-829）：id = 目录表条目；路径定位同 open-local 单源
  // （文件 resolveWorkspaceFile / 目录 = 树基准推导——与 open-dir 同源）。
  // 启动遇 ENOENT 重解析该条目一次（自愈），证不出 → error。
  web.registerRpc('workspace/open-with', async (params) => {
    const p = obj(params);
    const id = reqStr(p, 'id');
    const agentId = optStr(p.agentId);
    const conversationId = optStr(p.conversationId);
    const context = agentId !== undefined || conversationId !== undefined
      ? { ...(agentId !== undefined ? { agentId } : {}), ...(conversationId !== undefined ? { conversationId } : {}) }
      : undefined;
    // 定位：dir:true = 目录目标（树基准推导，path 缺席合法——open-dir 同源）；
    // 否则按文件定位（resolveWorkspaceFile 单源）
    let absPath: string;
    if (p.dir === true) {
      absPath = workspaceTreeBase(deps.dataRoot, context).dir;
      try {
        if (!fs.statSync(absPath).isDirectory()) return { error: '目标不是文件夹：' + absPath };
      } catch {
        return { error: '文件夹不存在或不可访问：' + absPath };
      }
    } else {
      const raw = reqStr(p, 'path');
      try {
        absPath = resolveWorkspaceFile(deps.dataRoot, raw, context);
      } catch {
        return { error: '文件不存在或不可读：' + raw };
      }
    }
    const map = await resolveOpenTargets();
    const target = map.get(id);
    if (target === undefined) return { error: '应用不可用：' + id };
    if (p.dir === true && target.kind === 'file') return { error: target.label + ' 不能打开目录' };
    if (p.dir !== true && target.kind === 'dir') return { error: target.label + ' 不能打开文件' };
    const first = await runOpenWith(target, absPath, { isDir: p.dir === true });
    if (first.error !== undefined && /ENOENT/i.test(first.error)) {
      const fresh = await refreshTarget(id);
      if (fresh !== null) return runOpenWith(fresh, absPath, { isDir: p.dir === true });
      return { error: '应用已不可用（启动器失效）：' + target.label };
    }
    return first;
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
        ...(r.description !== undefined ? { description: r.description } : {}),
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
  /** 会话的承载 Agent（agent 域账本在场者——预算分母与回执归属解析）。
   *  journal-only 域也认（cr-714）：会话零终稿（崩溃孤儿 run 只有 journal
   *  步行）时 messages.jsonl 可能缺席——计量与 KV 走势仍在 journal。 */
  const owningAgentOf = (conversationId: string): string | undefined => {
    let agents: fs.Dirent[] = [];
    try { agents = fs.readdirSync(path.join(deps.dataRoot, 'agents'), { withFileTypes: true }); } catch { return undefined; }
    for (const a of agents) {
      if (a.isDirectory()
        && fs.existsSync(path.join(deps.dataRoot, 'agents', a.name, 'sessions', conversationId))) {
        return a.name;
      }
    }
    return undefined;
  };

  /** 回放口径会话估算（cr-714：主线 estimateReplayTokens 同源）：agent 域
   *  账本 = 完整事实源（入站 user 行 + 自著行含物化段行 steps 轨迹——与
   *  主线 records() 同形状），viewer = 承载 Agent（自著行按注入形状展开
   *  工具调用/结果/reasoning）；概要头计入（与归档阈值同口径，会话占用
   *  单一估算器）。agent 域无行 = 终稿层直估。 */
  const replayTokensOf = (conversationId: string, agentId: string | undefined): number => {
    let total = 0;
    let agentRows = 0;
    for (const dir of conversationDirs(deps.dataRoot, conversationId, { includeJournalOnly: true })) {
      const { rows } = readLedger(dir);
      agentRows += rows.length;
      // cr-974：v2 会话步级事实 = 事件行（无 role——估算器只见 role 行）→
      // 折叠出 steps 合成 v1 段行同形行，口径与物化时代恒等
      const domain = path.basename(path.dirname(path.dirname(dir)));
      const facts = readDomainFacts(dir, domain);
      // cr-1191 压缩边界过滤（回落路径与索引 activeContextTokens 口径对齐
      //——此前全量盘读含 shadowed 旧代，两路径读数分叉 650K↔149K 跳变）：
      // 与 ac-shell-rows archive.estimateOf activeOnly 同型——rowShadowedBy
      // 单源谓词，run 级按末事实 seq/ts 判。
      const boundaries = facts.compactions;
      const shadowed = (seq: number | undefined, ts: number | undefined): boolean =>
        boundaries.length > 0 && boundaries.some((b) => rowShadowedBy(
          { ...(seq !== undefined ? { seq } : {}), ...(ts !== undefined ? { ts } : {}) }, b,
        ));
      const rowTs = (r: { ts?: unknown; timestamp?: unknown }): number | undefined => {
        if (typeof r.ts === 'number' && Number.isFinite(r.ts)) return r.ts;
        if (typeof r.timestamp === 'string' && r.timestamp !== '') {
          const parsed = Date.parse(r.timestamp);
          if (Number.isFinite(parsed)) return parsed;
        }
        return undefined;
      };
      const rowSeq = (r: { seq?: unknown }): number | undefined =>
        typeof r.seq === 'number' && Number.isFinite(r.seq) ? r.seq : undefined;
      const picked = boundaries.length > 0 ? rows.filter((r) => !shadowed(rowSeq(r), rowTs(r))) : rows;
      const pseudo: Array<Record<string, unknown>> = [];
      if (facts.version >= 2) {
        for (const [run, rf] of facts.runs) {
          const steps = foldStepsOf(rf, facts.subcallArchive.filter((s) => s.run === run))?.steps ?? [];
          if (steps.length === 0) continue;
          if (boundaries.length > 0) {
            let runSeq: number | undefined;
            let runTs: number | undefined;
            for (const ev of rf.events) {
              if (ev.kind === 'tool-call-result') continue;
              if (ev.seq !== undefined && (runSeq === undefined || ev.seq > runSeq)) runSeq = ev.seq;
              if (ev.ts !== undefined && (runTs === undefined || ev.ts > runTs)) runTs = ev.ts;
            }
            for (const s of steps) {
              if (typeof s.ts === 'number' && (runTs === undefined || s.ts > runTs)) runTs = s.ts;
            }
            if (shadowed(runSeq, runTs)) continue; // 整 run 属压缩前代——不计
          }
          pseudo.push({ role: 'agent', content: '', agent_id: domain, run, steps, message_id: 'v2-' + run, timestamp: '' });
        }
      }
      // cr-1191 V3 摘要单源：digest 行在场时其正文已在 picked 内（行计一次），
      // 不再加 summary 头（防双计）；v2 存量代/v1 才作头。
      const fold = foldSession(deps.dataRoot, conversationId, [dir]);
      const digest = foldDigestOf(fold);
      const summary = digest !== null ? '' : (foldSummaryOf(fold)?.text ?? summaryTextOf(dir));
      total += estimateReplayTokens([...picked, ...pseudo] as never, agentId, summary !== '' ? { summary } : {});
    }
    if (agentRows > 0) return total;
    // 终稿层直估（cr-973 读时投影——agent 域无行 = 空会话，0）
    return projectUserReplay(deps.dataRoot, conversationId)
      .reduce((n: number, r: { content: string }) => n + estimateTokens(r.content), 0);
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

  // 会话 Token 仪表（cr-714 根修；cr-1160 三口径收敛）：contextTokens 优先
  // 索引活跃代合计（activeContextTokens——压缩边界已滤，与 LLM 注入同向）；
  // 行缺席/未入账回落 replayTokensOf 全量盘读（保守上界，行为等价降级）。
  // cache 面 = ctx.usage 聚合（事件信 reportMeter 入账，覆盖轨/累加轨）；
  // 缺失时回退 journal-settled 盘读（usage 行缺席的良定义降级）。
  // 载荷带压缩史（compactions——TokenGauge 弹层「压缩历史」区数据源）。
  web.registerRpc('session/tokens', (params) => {
    const p = obj(params);
    const conversationId = reqStr(p, 'conversationId');
    const agentId = optStr(p.agentId) ?? owningAgentOf(conversationId);
    let promptTokens: number | null = null;
    const idx = ctx.get('sessionIndex', false) as
      | { activeContextTokens(id: string, opts?: { refresh?: boolean }): number | null; pdeltaAnchorOf(id: string, opts?: { refresh?: boolean }): { anchorTs: number; estSince: number } | null; compactionFactsOf(id: string): Array<{ domain: string; generation: number; endTs: number; summaryLen: number | null; stats: { shadowedRows?: number; estimatedTokens?: number } | null }> }
      | undefined;
    let compactions: Array<{ domain: string; generation: number; endTs: number; summaryLen: number | null; stats: { shadowedRows?: number; estimatedTokens?: number } | null }> = [];
    if (idx !== undefined) {
      try {
        // 顺序敏感（cr-1160 实施期实证）：compactionFactsOf 内部 refreshConversation
        // （建索引行），activeContextTokens 走 refresh:false（高频面不建索引——
        // cr-1142 裁决）。先读活跃代再建索引 → 首次访问必返 null 回落全量盘读
        // （含 shadowed，即被根治的 C5 分叉形态）。故**先 compactionFactsOf 建面、
        // 后 activeContextTokens 读值**。
        compactions = idx.compactionFactsOf(conversationId);
        promptTokens = idx.activeContextTokens(conversationId, { refresh: false });
      } catch { /* 索引故障回落盘读 */ }
    }
    if (promptTokens === null) promptTokens = replayTokensOf(conversationId, agentId);
    let hit = 0;
    let miss = 0;
    let lastHit = 0;
    let lastMiss = 0;
    let lastRunPrompt = 0;
    const usage = ctx.get('usage') as
      | { byConversation(): Record<string, { cacheHit?: number; cacheMiss?: number; lastCacheHit?: number; lastCacheMiss?: number; lastContextPrompt?: number }> }
      | undefined;
    const bucket = usage?.byConversation()[conversationId];
    if (bucket !== undefined) {
      hit = bucket.cacheHit ?? 0;
      miss = bucket.cacheMiss ?? 0;
      lastHit = bucket.lastCacheHit ?? 0;
      lastMiss = bucket.lastCacheMiss ?? 0;
      lastRunPrompt = bucket.lastContextPrompt ?? 0;
    } else {
      for (const dir of conversationDirs(deps.dataRoot, conversationId, { includeJournalOnly: true })) {
        for (const line of readJournal(dir)) {
          if (line.type !== 'journal-settled' || line.usage === undefined) continue;
          hit += line.usage.cacheHit ?? 0;
          miss += line.usage.cacheMiss ?? 0;
          lastHit = line.usage.cacheHit ?? 0;
          lastMiss = line.usage.cacheMiss ?? 0;
          lastRunPrompt = line.usage.prompt;
        }
      }
    }
    // P+delta 外推面（cr-1194）：P = usage 桶 lastContextPrompt（usage.prompt
    // 覆盖轨 = 末步 prompt，天然含 system/工具定义/模板/本 run 轨迹全部真实
    // 开销）；锚/delta 由索引锚面给（跨代守卫在彼——锚早于末代 compaction
    // 即 null）。P 无效（0/无计量）或锚面缺席 = pdelta 不出场，前端回落
    // 净估算（cr-1193 降级路径）。
    let pdelta: { prompt: number; estSince: number } | undefined;
    if (lastRunPrompt > 0) {
      try {
        const anchor = idx !== undefined ? idx.pdeltaAnchorOf(conversationId, { refresh: false }) : undefined;
        if (anchor != null) pdelta = { prompt: lastRunPrompt, estSince: anchor.estSince };
      } catch { /* 索引故障回落净估算 */ }
    }
    const maxContextTokens = archiveBudgetOf(agentId);
    const messageCount = projectUserReplay(deps.dataRoot, conversationId).length;
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
      ...(pdelta !== undefined ? { pdelta } : {}),
      // cr-1160 §2.8 展示面：压缩史（每代时刻/摘要长/stats）
      ...(compactions.length > 0 ? { compactions } : {}),
    };
  });

  // KV 缓存率走势（cr-714 去 stub）：ac-usage timeline 留存的透传面——每点
  // = 一次有计量的 LLM 调用（步），运行中 run 拼接 pending 尾段（步收束即
  // 可见，cr-251）；重启由审计流水回放重建。记账户号桶键 = 会话键本身
  //（usage 自报信 conversationId 原样）。usage 行缺席 = 空序列（前端空态）。
  // 点带 prompt（cr-761）= 本步请求真实上下文 token——上下文占用的实时
  // 驱动信号（TokenGauge 运行中以最新步 prompt 展示）。
  web.registerRpc('session/kv-timeline', (params) => {
    const conversationId = reqStr(obj(params), 'conversationId');
    const usage = ctx.get('usage') as
      | { conversationTimeline(id: string): Array<{ ts: number; hit: number; miss: number; prompt?: number }> }
      | undefined;
    return {
      conversationId,
      points: usage?.conversationTimeline(conversationId) ?? [],
    };
  });

  // 运行矩阵快照（主线 runs/snapshot 同构）：指纹阶段只 stat（零文件读）；
  // 活跃集 = 活壳 run-state 帧（busy 壳才成条——闲壳在跑不等于有 run）。
  // digest 短路：请求带上一轮 digest 且当前一致 → unchanged 轻载荷。
  // cr-980 性能收口（perf-followups 2026-11-10 #1-#3）：
  //   · single-flight——冷启动期并发调用共享同一趟扫描（曾 5 路并发各 ~8s
  //     全量展开在单线程宿主上串行叠加，把 singles/list 与首批轻 RPC 拖住）；
  //   · boot 即预热一趟——首屏 RPC 到达时 memo / 索引账面已热；
  //   · 指纹源优先 sessionIndex 行账面（零盘 IO）：变更面（running 集 ∪
  //     近期 running 余温 ∪ 未入账新会话）定向 stat 入账；行缺席回落全量
  //     stat 扫；周期空闲对账兜底外部写（crash 壳收束尾部 / 绕过通知的写）。

  let lastRunsDigest: string | null = null;
  /** 近期活跃会话余温集（cid → 最近在 running 集的时刻）：run 收束发生在
   *  两次快照之间时，终稿尾部追加在上次定向刷新之后——余温窗口内的会话
   *  仍每拍入账，收束尾不丢指纹步进。 */
  const recentHot = new Map<string, number>();

  const computeSnapshot = async (): Promise<
    | { unchanged: true; digest: string; generatedAt: number }
    | {
      digest: string; generatedAt: number;
      conversations: Array<{ conversationId: string; messageCount: number; size: number; updatedAt: number }>;
      running: Array<{ agentId: string; conversationId: string; handle: string; startedAt: number }>;
      groups: Array<{ groupId: string; name: string; memberCount: number; members: string[] }>;
      usageTotals?: unknown;
    }
  > => {
    // 会话目录单趟枚举（readdir only——指纹 / stat 面共用；目录缺席容错）
    const dirsByConv = scanConversationDirs(deps.dataRoot);
    // 群面（cr-579）：groups/<gid>/group.json 扫描（主线 ctx.group.list 同源形状）
    const groups = listGroupConfigs(deps.dataRoot);
    // 活跃 run 集（cr-598 共享件；cr-824 批二改 runningOf——poller 镜像
    // 优先，现探仅退路）。观测失败（null，cr-802——仅现探退路可达）= 本拍
    // 无活跃面数据：跳过 digest 步进、响应沿用上次 running 投影——观测抖动
    // 不得表现成「运行中条目清空再回来」的光环闪烁。
    const runningRaw = await runningOf(deps);
    if (runningRaw === null) {
      return { unchanged: true, digest: lastRunsDigest ?? '', generatedAt: Date.now() };
    }
    const running: Array<{ agentId: string; conversationId: string; handle: string; startedAt: number }> = runningRaw.map((r) => ({
      ...r,
      handle: r.conversationId === r.agentId ? r.agentId : r.conversationId + '~' + r.agentId,
    }));

    // ---- 会话清单与指纹源（cr-973 viewer 停写）：agent 域账本是事实源 ----
    // sessionIndex 行在场 → files 表账面聚合（零盘 IO）+ 变更面定向 stat
    // 入账；行缺席（摘行/独立形态）→ 全量 stat 扫回落（时间片让出，慢但
    // 同构——插槽-插头验收：摘行读面降级不空转）。
    const index = ctx.get('sessionIndex') as SessionIndexStatsFace | undefined;
    const convsMeta: Array<{ cid: string; size: number; mtimeMs: number }> = [];
    if (index !== undefined) {
      // 已消失会话清账（目录被删——catalog 账面与指针行一并回收）
      const known = new Map(index.catalog().map((r) => [r.conv, r]));
      for (const conv of known.keys()) {
        if (!dirsByConv.has(conv)) index.drop(conv);
      }
      // 变更面定向 stat 入账：running ∪ 余温（30s 内有 run）∪ 未入账新会话
      const now = Date.now();
      const hot = new Set<string>();
      for (const r of running) {
        hot.add(r.conversationId);
        recentHot.set(r.conversationId, now);
      }
      for (const [cid, at] of recentHot) {
        if (now - at > 30_000) recentHot.delete(cid);
        else hot.add(cid);
      }
      for (const cid of dirsByConv.keys()) {
        if (hot.has(cid) || !known.has(cid)) index.refreshStats(cid);
      }
      const fresh = new Map(index.catalog().map((r) => [r.conv, r]));
      for (const cid of [...dirsByConv.keys()].sort()) {
        const row = fresh.get(cid);
        if (row !== undefined) convsMeta.push({ cid, size: row.size, mtimeMs: row.mtimeMs });
      }
    } else {
      let sliceAt = Date.now();
      for (const cid of [...dirsByConv.keys()].sort()) {
        let size = -1;
        let mtimeMs = 0;
        for (const dir of dirsByConv.get(cid) ?? []) {
          for (const file of ['messages.jsonl', path.join('journal', 'partials.jsonl'), 'subcalls.jsonl']) {
            try {
              const st = fs.statSync(path.join(dir, file));
              size = size < 0 ? st.size : size + st.size;
              mtimeMs = Math.max(mtimeMs, st.mtimeMs);
            } catch { /* 缺席文件不参与 */ }
          }
        }
        if (size >= 0) convsMeta.push({ cid, size, mtimeMs });
        if (Date.now() - sliceAt > SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          sliceAt = Date.now();
        }
      }
    }

    const fingerprint = [
      convsMeta.map((c) => c.cid + ':' + c.size + ':' + c.mtimeMs).sort().join('|'),
      running.map((r) => r.agentId + '@' + r.conversationId + '#' + r.startedAt).sort().join('|'),
      groups.map((g) => g.id + ':' + g.members.length + ':' + g.name).sort().join('|'),
    ].join('::');
    const digest = hashFingerprint(fingerprint);
    lastRunsDigest = digest;
    // 展开阶段（cr-1185 批3：SQL 单源零盘读）：messageCount = roster 小表
    // speech 列；尾部摘要 last 已随名册脱离退役（消费方 = session/roster 的
    // lastText——发言口径 + 断连不漂移）。cr-978 指纹 memo 与 cr-1142
    // sessionMeta 内嵌读取一并退役（展开不再读账本——memo 无存在必要）；
    // 单会话行缺席（未入账）= messageCount 0 诚实值（轮询/帧驱动/warm-up
    // 三通道分钟内补齐，冷首拍短暂）。时间片让出保留（cr-980 #2）。
    const rosterOf = new Map((index !== undefined ? index.rosterSnapshot() : []).map((r) => [r.key, r]));
    const conversations = [] as Array<{ conversationId: string; messageCount: number; size: number; updatedAt: number }>;
    let sliceAt = Date.now();
    for (let i = 0; i < convsMeta.length; i++) {
      const c = convsMeta[i]!;
      conversations.push({ conversationId: c.cid, messageCount: rosterOf.get(c.cid)?.messageCount ?? 0, size: c.size, updatedAt: c.mtimeMs });
      if (Date.now() - sliceAt > SLICE_MS) {
        await new Promise<void>((r) => setImmediate(r));
        sliceAt = Date.now();
      }
    }
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
  };

  // single-flight（cr-980 #1）：在途 Promise 共享——并发调用等同一趟；航班
  // 落定即释放（下一拍重算指纹——digest 的新鲜度按拍维持，不缓存载荷）。
  let snapFlight: Promise<Awaited<ReturnType<typeof computeSnapshot>>> | null = null;
  const snapshotOnce = (): Promise<Awaited<ReturnType<typeof computeSnapshot>>> => {
    if (snapFlight !== null) return snapFlight;
    snapFlight = computeSnapshot().finally(() => { snapFlight = null; });
    return snapFlight;
  };

  web.registerRpc('runs/snapshot', async (params) => {
    const result = await snapshotOnce();
    // digest 短路（逐调用方判——共享航班的结果对各端各自的上一轮 digest
    // 对账；指纹相等即读面输入未变，unchanged 轻载荷）
    const reqDigest = obj(params).digest;
    if (typeof reqDigest === 'string' && reqDigest === result.digest && !('unchanged' in result)) {
      return { unchanged: true, digest: reqDigest, generatedAt: Date.now() };
    }
    return result;
  });

  // boot 预热（cr-980 #1）：注册即发一趟——首屏 RPC 到达前完成 memo / 索引
  // 账面的冷填充（首调用直接 join 本航班）。不 await：boot 继续走，扫描
  // 时间片让出不挡装配；预热无观测面，失败静默。
  // cr-1185：预热航班收尾接名册 warm-up（首屏 session/roster 通常已暖）。
  // 尾链自带兜底（桩 ctx 无 get 的测试面不产 unhandled——预热本就静默）。
  void snapshotOnce()
    .catch(() => undefined)
    .then(() => {
      const index = ctx.get('sessionIndex') as SessionIndexStatsFace | undefined;
      if (index !== undefined) void warmRoster(index).catch(() => undefined);
    })
    .catch(() => undefined);

  // 周期空闲对账（cr-980 #3 外部写兜底）：全量 stat 入账一轮——crash 壳
  // 收束尾部 / 绕过通知的外部写（digest 新鲜度上限 = 对账周期 + 一拍）。
  // unref：纯后台兜底不续命进程（测试 / 独立形态）。
  const reconcile = async (): Promise<void> => {
    const index = ctx.get('sessionIndex') as SessionIndexStatsFace | undefined;
    if (index === undefined) return;
    try {
      const dirs = scanConversationDirs(deps.dataRoot);
      let sliceAt = Date.now();
      for (const cid of dirs.keys()) {
        index.refreshStats(cid);
        if (Date.now() - sliceAt > SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          sliceAt = Date.now();
        }
      }
      // 目录已消失的会话清账（删除检测有界——不依赖 runs/snapshot 被轮询）
      for (const row of index.catalog()) {
        if (!dirs.has(row.conv)) index.drop(row.conv);
      }
      // cr-1185 名册罗盘缺口填充：stat 对账后跑一趟（boot 预热之外的常规
      // 兜底——外部写绕过帧驱动的会话由此在分钟级补齐）。增量语义：无
      // 缺口时零成本；缺口面通常只在冷启动后首轮出现。
      await warmRoster(index);
    } catch { /* 数据根暂不可访问（测试清理竞态）——下轮再试 */ }
  };
  // cr-1185 名册 warm-up（性能修复后形态）：**全量对账逐会话分片**——
  // 全量版 rosterGaps 曾是秒级同步段（千级会话全量 stat 扫），在 RPC 路径
  // 冻结宿主 ~6s。循环体：枚举（零 stat）→ 逐会话 rosterGapOf（单会话
  // stat，微秒级）→ 缺口 refreshConversation；12ms 时间片让出（SLICE_MS
  // 同款纪律）。孤儿行（目录已消失）随 drop 清。有填充才广播
  // session/roster-warmed——冷态拉过 session/roster 的前端借此帧重拉。
  // boot 预热航班收尾与周期 reconcile 都走这里（幂等：无缺口 = 零 stat
  // 读差异、零 refresh）。同拍并发调用由 warmRosterInFlight 串行化
  //（boot 预热 + 首轮 reconcile 可能同拍）。
  let warmRosterInFlight: Promise<void> | null = null;
  const warmRoster = (index: SessionIndexStatsFace): Promise<void> => {
    if (warmRosterInFlight !== null) return warmRosterInFlight;
    warmRosterInFlight = (async (): Promise<void> => {
      let filled = 0;
      let sliceAt = Date.now();
      for (const cid of index.allConversationIds()) {
        try {
          if (index.rosterGapOf(cid)) { index.refresh(cid); filled += 1; }
        } catch { /* 单会话失败继续——下轮 reconcile 再试 */ }
        if (Date.now() - sliceAt > SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          sliceAt = Date.now();
        }
      }
      if (filled > 0) {
        (ctx.webServer as unknown as { broadcast(type: string, data?: unknown): void })
          .broadcast('session/roster-warmed', { args: [{ filled }] });
      }
    })().finally(() => { warmRosterInFlight = null; });
    return warmRosterInFlight;
  };
  const reconcileTimer = setInterval(() => { void reconcile(); }, 60_000);
  (reconcileTimer as { unref?: () => void }).unref?.();
}

/** 一批注册（web-api 行装配时调用） */
export function registerOpsFace(web: WebFace, ctx: Context, deps: FaceOpsDeps): void {
  registerTimers(web, ctx);
  registerIdentity(web);
  registerSkills(web, deps);
  registerSnapshots(web, ctx, deps);
  registerUsage(web, ctx);
  registerSystem(web, deps);
  registerEvents(web, ctx, deps);
  registerWorkspace(web, deps);
  registerPlugin(web, ctx, deps);
  registerLlm(web, ctx, deps);
  registerRunsFace(web, ctx, deps);
}

// ---- runs/snapshot 支撑件（cr-980）----

/** 时间片让出阈值（~12ms——批粒度计数让出的替代：冷扫描按墙钟切片，
 *  不独占宿主事件循环，首批轻 RPC 不再排队秒级） */
const SLICE_MS = 12;

/** 会话目录单趟枚举（conv → 源目录集，readdir only 零 stat）：
 *  agents 各域 sessions（cr-998 viewer 兼容窗退役——消息流单源 agent 域）。 */
function scanConversationDirs(dataRoot: string): Map<string, string[]> {
  const dirsByConv = new Map<string, string[]>();
  const agentsRoot = path.join(dataRoot, 'agents');
  try {
    for (const a of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!a.isDirectory()) continue;
      const sRoot = path.join(agentsRoot, a.name, 'sessions');
      let sds: fs.Dirent[] = [];
      try { sds = fs.readdirSync(sRoot, { withFileTypes: true }); } catch { continue; }
      for (const s of sds) {
        if (!s.isDirectory()) continue;
        const list = dirsByConv.get(s.name) ?? [];
        list.push(path.join(sRoot, s.name));
        dirsByConv.set(s.name, list);
      }
    }
  } catch { /* 无 agents 域 */ }
  return dirsByConv;
}

/** 指纹面窄接口（ctx.sessionIndex 结构子集——ac-session-index 行提供；
 *  可选依赖（use-time 软取）：行摘除时 runs/snapshot 回落全量 stat 扫） */
interface SessionIndexStatsFace {
  /** 会话源文件 stat 面入账（不读内容——指纹只吃 stat） */
  refreshStats(convId: string): void;
  /** files 表按 conv 聚合（零盘 IO——账面新鲜度由 refreshStats 维护） */
  catalog(): Array<{ conv: string; size: number; mtimeMs: number }>;
  /** 会话索引行全清（目录已消失） */
  drop(convId: string): void;
  /** 会话元数据聚合（cr-1142 roster 预览权威化——发言口径末行身份/时标）。
   *  只读模式：本面是高频聚合（60s 轮询 + 事件驱动），绝不隐式建索引
   *  （cr-1138 裁决：全量预热是显式动作）——未入账会话返回 null 走回落。 */
  /** 会话指针行增量入账（含 roster 同源重算——cr-1185 名册通道） */
  refresh(convId: string): unknown;
  /** 名册缺口判定（单会话原子——全量对账由 warmRoster 分片，cr-1185） */
  rosterGapOf(convId: string): boolean;
  /** 全部会话键枚举（零 stat——分片全量对账数据源） */
  allConversationIds(): string[];
  /** 名册小表快照（零盘读——cr-1185） */
  rosterSnapshot(): Array<{
    key: string; kind: 'pair' | 'single' | 'group' | 'other';
    lastSpeechAt: string | null; lastAgent: string | null; lastRole: string | null; lastText: string | null;
    lastAt: string | null; speech: number; total: number; messageCount: number;
  }>;
}
