// ============================================================
// singles-row.ts —— 宿主独立会话行（cr-566）
//
// owns：meta/sessions/<sid>.json（元数据：agentId / title / workspaceId /
// status / 时间戳——数据分层第二层，自 viewer 投影目录迁出；cr-998 起
// 单源——viewer 旧位置读窗退役，数据根已一次性迁移归零）
// + meta/sessions/.singles-registry.json
//（清单注册表，cr-869：整表视图驻留内存，写点同步维护，list 零读——
// cr-845 摘要索引的延伸；cr-973 自 viewer 树迁出——viewer 整树可删）。
// 消息流 = agent 域账本（cr-973 viewer 停写——终稿层经 ac-ledger
// projectUserReplay 读时投影，本行不再触碰 viewer 消息文件；模型覆盖
// 归 conv-settings（D12 单源，不落 session.json）。
//
// RPC 面与主线 ac-web-api 同形（前端零改动）：
//   singles/list | create | update | fork | archive | delete
// 事件：singles/updated —— 帧 args = [session, 'created'|'updated'|'archived'|'removed']
//（前端 singleBoard 增量合并的单源；断连重连走 list 兜底）。
//
// 导入存量兼容：旧根导入的 827 个会话只有 messages.jsonl 无 session.json——
// 视图按账本派生（agentId = 首条对端行、title = 首条**用户**行截断、时间 =
// 目录 mtime），首次 update 时才落 session.json（纯增量，不迁移）。
//
// 标题生成面（cr-672）：LLM 概括只住壳（llm 行在壳树）而 session.json 写权
// 在本行——壳侧 auto-title 行经信封（title-request）上报标题，本行
// write-if-absent 落盘 + singles/updated 广播。派生面仍是兜底：存量会话、
// 非用户会话（agent↔agent / 机制触发）与生成失败线都走它。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin, Context } from '@agentchat/cordis';
import { issueConversationId, validateTitleRequestPayload, type TitleRequestPayload } from 'ac-envelope-core';
import { conversationDirs, forkConversation, isSingleSessionId, metaSessionsDir, projectUserReplay, sessionDir, userMetaFile } from 'ac-ledger';
import { readAgentConfig } from 'ac-agents-core';
import { SnapshotStore } from 'ac-file-snapshots/src/store.ts';
import { DATE_SNAPSHOT_PREFIX, TITLE_MAX_LEN, clearUnread, fallbackTitle } from 'ac-core-utils';
import type { HostServiceDesk } from './service-desk.ts';

export interface SinglesHostRowOptions {
  dataRoot: string;
  /** 宿主服务台（壳侧命名行 title.set 受理——cr-672；cr-1175 批 2 起迁服务帧；缺省 = 只走派生标题） */
  desk?: HostServiceDesk;
}

/** 会话元数据（session.json 形态——模型覆盖不在此，见 conv-settings） */
export interface SingleMeta {
  id: string;
  agentId?: string;
  title?: string;
  workspaceId?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

/** 对外视图（前端 SingleSession 形状） */
export interface SingleView {
  id: string;
  agentId: string;
  model?: string;
  title?: string;
  workspaceId?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastActivity?: string;
}

/** 会话设置窄接口（ctx.convSettings——D12 宿主行提供；行缺席 = 无覆盖语义） */
interface ConvSettingsFace {
  get(conversationId: string): Record<string, string>;
  set(conversationId: string, patch: Record<string, string | null | undefined>): Record<string, string>;
}

/** 索引行窄接口（ctx.sessionIndex 结构子集——ac-session-index 行提供；
 *  可选依赖（use-time 软取）：行摘除时 list 回落逐条目 stat 复验，慢但同构） */
interface SessionIndexFace {
  /** messages.jsonl 账面（与 ledgerFingerprint 同公式——零盘 IO） */
  messagesCatalog(): Array<{ conv: string; size: number; mtimeMs: number }>;
}

interface WebFace {
  registerRpc(method: string, handler: (params: unknown) => unknown): void;
  broadcast(type: string, data?: unknown): void;
}




// singles 键词法锁（cr-1120）判词已并源 ac-ledger/user.ts isSingleSessionId
//（cr-1179——壳侧 auto-title 行同源共用法）。
function assertSingleId(id: string): void {
  if (!isSingleSessionId(id)) {
    throw new Error('会话 id "' + id + '" 非法（须 uuid 形独立会话键）');
  }
}

function readMeta(dataRoot: string, id: string): SingleMeta | null {
  let m: Partial<SingleMeta> | null = null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(userMetaFile(dataRoot, id), 'utf-8'));
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) m = raw as Partial<SingleMeta>;
  } catch { /* 缺席/损坏 = null */ }
  if (m === null) return null;
  return {
    id,
    ...(typeof m.agentId === 'string' ? { agentId: m.agentId } : {}),
    ...(typeof m.title === 'string' ? { title: m.title } : {}),
    ...(typeof m.workspaceId === 'string' ? { workspaceId: m.workspaceId } : {}),
    status: m.status === 'archived' ? 'archived' : 'active',
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(0).toISOString(),
    updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : new Date(0).toISOString(),
  };
}

function writeMeta(dataRoot: string, meta: SingleMeta): void {
  // cr-973 viewer 停写：会话身份不再物化 viewer 目录（清单身份源 =
  // meta/sessions，消息流在 agent 域）——元数据本体落第二层 meta/sessions/。
  const file = userMetaFile(dataRoot, meta.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/** 账本摘要派生值（无 session.json 的存量会话按行派生——agentId / title / 末行时刻 / 行数） */
interface LedgerSummary {
  agentId?: string; title?: string; lastActivity?: string; count: number;
}

// 清单注册表（cr-682 进程内缓存 → cr-845 落盘摘要索引 → cr-869 全视图清单 →
// cr-870 事件失效）：list 载荷整表驻留内存——装载时盘对账重建一次（唯一
// 全量读），此后 list 热路径 = 直吐 + 每条目 1 次 stat 指纹复验（失配/stale
// 条目才读账本重算）。全部写点同步
// 维护条目 + 落盘；账本追加经 ledger/viewer-appended 事件标记条目 stale
//（写者通知面 = UserStub send/receive + web-api 读前派生/账本管理面——宿主
// 单进程全覆盖），装载对账保留为跨进程写兜底。
// 防线（承 cr-845）：正确性永不依赖注册表内容——条目形状逐项窄化校验，
// 损坏/漂移即整表重建覆写；写点维护恒先写 session.json 真值、再同步注册表
//（读路径探测差异亦回源重算——缓存自愈，无双源漂移窗口）。


function registryFileOf(dataRoot: string): string {
  // cr-973 自 viewer/sessions 迁 meta/sessions（注册表是派生缓存——迁址
  // 即一次性冷对账重建，旧文件留投影树不动）
  return path.join(metaSessionsDir(dataRoot), '.singles-registry.json');
}

interface RegistryEntry {
  /** messages.jsonl 指纹（装载对账/写点维护——事件通知后按 stale 惰性重算取新值） */
  size: number;
  mtimeMs: number;
  /** session.json 指纹（装载复验——手工改元数据/外部写后该条目回源重算） */
  metaMtimeMs: number;
  /** 账本有追加事件未重算（cr-870：ledger/viewer-appended 标记，list 时该条目回源） */
  stale?: boolean;
  /** count>0 时的账本摘要（派生 title/agentId/lastActivity——session.json 缺席时兜底） */
  summary: LedgerSummary;
  /** 装载对账时的完整视图（写点维护后的现状——list 直吐） */
  view: SingleView | null;
}
interface RegistryFile { version: 2; entries: Record<string, RegistryEntry> }

// 条目窄化（shape 损坏条目整表丢弃重建——正确性不依赖缓存内容）
function validEntry(e: unknown): e is RegistryEntry {
  if (typeof e !== 'object' || e === null) return false;
  const { size, mtimeMs, metaMtimeMs, summary } = e as Record<string, unknown>;
  return typeof size === 'number' && typeof mtimeMs === 'number' && typeof metaMtimeMs === 'number'
    && typeof summary === 'object' && summary !== null && typeof (summary as { count?: unknown }).count === 'number'
    && ('view' in e);
}

function writeRegistry(dataRoot: string, entries: Map<string, RegistryEntry>): void {
  fs.mkdirSync(metaSessionsDir(dataRoot), { recursive: true });
  const file = registryFileOf(dataRoot);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, entries: Object.fromEntries(entries) } satisfies RegistryFile), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 元数据指纹（装载复验）：meta 文件 mtime——外部手改都会被看见。 */
function metaMtimeOf(dataRoot: string, id: string): number {
  try { return fs.statSync(userMetaFile(dataRoot, id)).mtimeMs; } catch { return 0; }
}

/** 单会话条目回源重建（盘真值 → 视图 + 摘要指纹；null = 盘上已无此会话） */
function buildEntry(dataRoot: string, id: string, conv: ConvSettingsFace | undefined): RegistryEntry | null {
  const ledgerSt = ledgerFingerprint(dataRoot, id);
  const summary = ledgerSt === null ? { count: 0 } : computeLedgerSummary(dataRoot, id);
  const view = viewOf(dataRoot, id, conv, summary);
  if (view === null) return null; // meta 与账本双空 = 不是会话
  return { size: ledgerSt?.size ?? 0, mtimeMs: ledgerSt?.mtimeMs ?? 0, metaMtimeMs: metaMtimeOf(dataRoot, id), summary, view };
}

/** 冷对账：目录 id 集 × 注册表条目集 → 差异逐 id 回源重建（装载期唯一全量读） */
function reconcile(dataRoot: string, conv: () => ConvSettingsFace | undefined, diskIds: string[], entries: Map<string, RegistryEntry>): void {
  for (const id of diskIds) {
    if (entries.has(id)) continue;
    const e = buildEntry(dataRoot, id, conv());
    if (e !== null) entries.set(id, e);
  }
  for (const id of [...entries.keys()]) {
    if (!diskIds.includes(id)) entries.delete(id);
  }
}

/** 注册表装载：盘上文件读入（损坏 = 空表）→ 留存条目 meta 指纹复验（session.json
 *  被外部改 → 该条目回源重算）→ 与目录对账（新目录补建/已删目录摘除）→ 落盘一次。
 *  conv-settings 文件级外部改不在此复验——运行期写点已由 conv-settings/updated
 *  订阅维护，装载信任条目（成本折衷：每条目省一次 conv.get 的文件读）。 */
function loadRegistry(dataRoot: string, conv: () => ConvSettingsFace | undefined): Map<string, RegistryEntry> {
  let entries = new Map<string, RegistryEntry>();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(registryFileOf(dataRoot), 'utf-8'));
    if (typeof raw === 'object' && raw !== null) {
      const { version, entries: fileEntries } = raw as Record<string, unknown>;
      if (version === 2 && typeof fileEntries === 'object' && fileEntries !== null) {
        for (const [id, e] of Object.entries(fileEntries)) {
          if (validEntry(e)) entries.set(id, e);
        }
      }
    }
  } catch { /* 缺席/损坏 = 空表重建 */ }
  const diskIds = listIds(dataRoot);
  // 留存条目 meta 指纹复验：session.json 手工改/外部写（mtime 变）→ 回源重算
  for (const id of [...entries.keys()]) {
    if (entries.get(id)!.metaMtimeMs !== metaMtimeOf(dataRoot, id)) {
      const rebuilt = buildEntry(dataRoot, id, conv());
      if (rebuilt === null) entries.delete(id);
      else entries.set(id, rebuilt);
    }
  }
  reconcile(dataRoot, conv, diskIds, entries);
  writeRegistry(dataRoot, entries);
  return entries;
}

/** 账本指纹（cr-973：agent 域 messages.jsonl 聚合——size 求和、mtime 取
 *  最大）。null = 无账本。 */
function ledgerFingerprint(dataRoot: string, id: string): { size: number; mtimeMs: number } | null {
  let size = 0;
  let mtimeMs = 0;
  let any = false;
  try {
    for (const dir of conversationDirs(dataRoot, id, { includeJournalOnly: true })) {
      try {
        const st = fs.statSync(path.join(dir, 'messages.jsonl'));
        size += st.size;
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
        any = true;
      } catch { /* 该域无 messages 文件 */ }
    }
  } catch {
    return null; // 非法 id 等
  }
  return any ? { size, mtimeMs } : null;
}

function computeLedgerSummary(dataRoot: string, id: string): LedgerSummary {
  // cr-973：终稿层读时投影（agent 域账本——viewer 不再物化）
  const rows = projectUserReplay(dataRoot, id);
  let agentId: string | undefined;
  // 标题候选两档：用户自己的首条发言（正解）> 任意首条有内容行（旧会话
  // 兜底）。旧实现取「首条非空内容行」，对端台词/定时触发词/DSML 残片都会
  // 变成标题；且按换行符切分不剥 CR 尾（CRLF 会话标题带脏尾，cr-672）。
  let userTitle: string | undefined;
  let anyTitle: string | undefined;
  for (const r of rows) {
    if (r.role === 'peer' && r.agentId !== '' && agentId === undefined) agentId = r.agentId;
    const content = typeof r.content === 'string' ? r.content : '';
    // 日期快照行（ac-datetime 前缀）不是用户发言；材料行筛选（跳过附件路径 /
    // @ 引用 / URL 行）、归一与上限走 ac-core-utils 单源（与生成面同口径——
    // 旧派生面 40 字与其 24 字走散，且路径开头的消息让整列标题同形）
    if (content.trim() === '' || content.startsWith(DATE_SNAPSHOT_PREFIX)) continue;
    const candidate = fallbackTitle(content);
    if (candidate === '') continue;
    anyTitle ??= candidate;
    if (userTitle === undefined && r.role === 'user') userTitle = candidate;
  }
  const title = userTitle ?? anyTitle;
  const lastActivity = rows.at(-1)?.timestamp;
  return {
    ...(agentId !== undefined ? { agentId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(lastActivity !== undefined ? { lastActivity } : {}),
    count: rows.length,
  };
}

/** 视图组装（回执/单点路径：直读盘真值——注册表条目由 buildEntry/写点维护） */
function viewOf(dataRoot: string, id: string, conv: ConvSettingsFace | undefined, summary?: LedgerSummary): SingleView | null {
  const meta = readMeta(dataRoot, id);
  const sum = summary ?? (ledgerFingerprint(dataRoot, id) === null ? { count: 0 } : computeLedgerSummary(dataRoot, id));
  if (meta === null && sum.count === 0) return null;
  let iso = meta?.updatedAt ?? new Date(0).toISOString();
  try { iso = fs.statSync(path.dirname(userMetaFile(dataRoot, id))).mtime.toISOString(); } catch { /* 元数据目录缺席：用元数据时刻 */ }
  const model = conv?.get(id).model;
  const title = meta?.title ?? sum.title;
  const agentId = meta?.agentId ?? sum.agentId;
  return {
    id,
    agentId: agentId ?? '',
    ...(model !== undefined ? { model } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(meta?.workspaceId !== undefined ? { workspaceId: meta.workspaceId } : {}),
    status: meta?.status ?? 'active',
    createdAt: meta?.createdAt ?? iso,
    updatedAt: meta?.updatedAt ?? iso,
    // lastActivity 仅在有消息时携带（主线 ac-singles 同义：无消息空会话
    // 不带该键——前端 isSingleFresh 据此呈现新会话开场居中态，创建时刻
    // 兜底会把空会话钉成「非开场」形态，cr-601）
    ...(sum.lastActivity !== undefined ? { lastActivity: sum.lastActivity } : {}),
  };
}

/** 旧落点前缀快照搬空（cr-1100 分居迁移：meta/sessions/*.prefix-snapshot.json
 *  → meta/prefix-snapshots/<sid>.json；新位在场优先，同名残留即清）。
 *
 *  装载期调用一次，幂等归零——旧位清空后退化为一次目录枚举直通。
 *  逐文件独立容错：迁移期活壳仍可能按旧路径写（Windows 文件锁挡
 *  rename/rm），单文件失败不得中断整批——失败者留待下次装载重试；
 *  其残留对 listIds 已无害（词汇锁排除含点文件名）。
 *
 *  fsApi 参数只为单测注入失败面（生产恒用 node:fs）。
 *  返回 moved = 实际搬迁/清理成功的文件数。 */
export function migrateLegacyPrefixSnapshots(
  dataRoot: string,
  fsApi: Pick<typeof fs, 'readdirSync' | 'mkdirSync' | 'existsSync' | 'renameSync' | 'rmSync'> = fs,
): { moved: number } {
  let names: string[] = [];
  try { names = fsApi.readdirSync(metaSessionsDir(dataRoot)) as string[]; } catch { return { moved: 0 }; }
  const legacy = names.filter((n) => n.endsWith('.prefix-snapshot.json'));
  if (legacy.length === 0) return { moved: 0 };
  const toDir = path.join(dataRoot, 'meta', 'prefix-snapshots');
  try { fsApi.mkdirSync(toDir, { recursive: true }); } catch { return { moved: 0 }; }
  let moved = 0;
  for (const name of legacy) {
    const sid = name.slice(0, -'.prefix-snapshot.json'.length);
    const from = path.join(metaSessionsDir(dataRoot), name);
    const to = path.join(toDir, sid + '.json');
    try {
      if (fsApi.existsSync(to)) fsApi.rmSync(from, { force: true });
      else fsApi.renameSync(from, to);
      moved += 1;
    } catch { /* 单文件占用（活壳在写）——留待下次装载重试 */ }
  }
  return { moved };
}

/** 全部会话 id：meta/sessions（singles 身份源）∪ agent 域会话目录
 *  （消息先行、meta 未落的会话兜底——buildEntry 对无 meta 会话按账本
 *  派生标题/agentId；cr-998 viewer 存量目录并集窗退役，身份事实源
 *  改指 agent 域）。
 *  词汇锁（cr-1100）：meta/sessions/ 只收裸 <sid>.json 会话元数据——
 *  文件名含点即非会话 id；新的会话级产物勿再入本目录，独占目录或入
 *  meta/ 平级子域。
 *  词汇锁（cr-1120）：id 必须 uuid 形（isSingleSessionId）——agents 域
 *  sessions/ 还住对桶键 'a~b'（agent⇄agent / 群成员流 gid~member）与
 *  子 Agent 键 'sub_*'，meta 层也有 title-request 历史误写残留；无差别
 *  并集会把它们收进用户会话清单（未分组幻影行 + 帧路由串台）。 */
function listIds(dataRoot: string): string[] {
  const ids = new Set<string>();
  try {
    for (const e of fs.readdirSync(metaSessionsDir(dataRoot), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.') && !e.name.slice(0, -5).includes('.') && isSingleSessionId(e.name.slice(0, -5))) ids.add(e.name.slice(0, -5));
    }
  } catch { /* 无元数据域 */ }
  try {
    for (const a of fs.readdirSync(path.join(dataRoot, 'agents'), { withFileTypes: true })) {
      if (!a.isDirectory()) continue;
      try {
        for (const e of fs.readdirSync(path.join(dataRoot, 'agents', a.name, 'sessions'), { withFileTypes: true })) {
          if (e.isDirectory() && isSingleSessionId(e.name)) ids.add(e.name);
        }
      } catch { /* 该 agent 无 sessions */ }
    }
  } catch { /* 无 agents 域 */ }
  return [...ids].sort();
}

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

/**
 * 宿主独立会话行。写者单源 = 宿主（UserStub 写同类目录的 messages.jsonl；
 * 本行写 session.json——同目录不同文件，各自 owning）。
 */
export function makeSinglesHostRow(options: SinglesHostRowOptions): Plugin {
  return {
    name: 'ac-host-rows/singles',
    inject: ['webServer'],
    apply(ctx: Context) {
      const dataRoot = options.dataRoot;
      const web = ctx.webServer as unknown as WebFace;
      const conv = (): ConvSettingsFace | undefined => ctx.get('convSettings') as ConvSettingsFace | undefined;
      // 会话快照纯库实例（cr-1208 级联：删除 RPC 同数据根直清——与
      // ac-host-webui face-ops 读面同一 owning 实现，无服务依赖）
      const snapshots = new SnapshotStore({ root: path.join(dataRoot, 'file-snapshots') });
      const emit = (view: SingleView, kind: 'created' | 'updated' | 'archived' | 'removed'): void => {
        web.broadcast('singles/updated', { args: [view, kind] });
      };
      // 旧落点快照搬空（cr-1100 分居一次性迁移，幂等归零）
      migrateLegacyPrefixSnapshots(dataRoot);
      // 清单注册表（cr-869）：装载对账一次驻留，写点 upsert + 落盘；list 直吐
      const registry = loadRegistry(dataRoot, conv);
      /** 写点收口：emit 后同步注册表条目（真值已落盘，条目 = 回执视图 + 现指纹；
       *  账本指纹未变复用旧摘要——写点改的是 session.json/conv，不碰消息流）+ 落盘 */
      const upsertEntry = (id: string, view: SingleView | null): void => {
        const st = ledgerFingerprint(dataRoot, id);
        const prev = registry.get(id);
        const summary = st === null ? { count: 0 }
          : (prev !== undefined && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.summary : computeLedgerSummary(dataRoot, id));
        if (view === null && summary.count === 0) { registry.delete(id); }
        else registry.set(id, { size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0, metaMtimeMs: metaMtimeOf(dataRoot, id), summary, view });
        writeRegistry(dataRoot, registry);
      };
      // conv-settings 外部写点对账（web-api conv-settings/set RPC——model 字段
      // 第二写者）：本行 RPC 之外的设置变更 → 该会话条目视图回源刷新。
      // 纯观察（emit 事件），无 veto/改写语义。
      ctx.on('conv-settings/updated', (conversationId: string) => {
        if (!registry.has(conversationId)) return; // 非独立会话（对桶/群）不在册
        const e = registry.get(conversationId)!;
        registry.set(conversationId, { ...e, view: viewOf(dataRoot, conversationId, conv(), e.summary) });
        writeRegistry(dataRoot, registry);
      });
      // 账本追加通知（cr-870）：条目标记 stale——list 时该条目回源重算（摘要在
      // 追加后重取新 lastActivity/count；重算面收口在 list 而非事件内，通知零
      // 读盘开销）。不在册 id 忽略：追加可先于会话物化（首条消息触发 create）。
      ctx.on('ledger/viewer-appended', (conversationId: string) => {
        const e = registry.get(conversationId);
        if (e === undefined) return;
        registry.set(conversationId, { ...e, stale: true });
      });

      // ---- 标题落盘受理（cr-672；cr-1175 批 2 起迁 title.set 服务帧——request 档）----
      // 写权归本行（session.json 单写者）；write-if-absent——用户手改标题 /
      // fork 继承标题 / 换代壳重复上报一律不覆盖。已有标题 = 幂等成功
      //（{ applied: true } 回执）。落盘即 emit singles/updated 广播——D7
      // 前端 live 通知（发一次即忘，前端刷新 = 重读盘面兜底）。
      if (options.desk !== undefined) {
        options.desk.register('title.set', async (payloadRaw: unknown) => {
          const payload = payloadRaw as Partial<TitleRequestPayload>;
          const issues = validateTitleRequestPayload(payload);
          if (issues.length > 0) throw new Error('标题请求非法：' + issues.join('；'));
          const id = String(payload.conversationId);
          // cr-1120：受理前按词汇锁拒绝非 singles 会话键（对桶/子Agent 键
          // 的 auto-title 上报不落 meta/sessions——历史误写即本次未分组
          // 幻影行的来源之一）；非法键 fail-loud（协议错误，回执面可见）。
          assertSingleId(id);
          const title = String(payload.title).trim().slice(0, TITLE_MAX_LEN);
          if (title === '') return { applied: false };
          const before = viewOf(dataRoot, id, conv());
          if (before === null || before.status !== 'active') return { applied: false };
          // 判「已存标题」只看 session.json（readMeta）——viewOf 的 title 含
          // 账本派生兜底值，拿它判会让生成标题永无写入机会
          if (readMeta(dataRoot, id)?.title !== undefined) return { applied: false };
          writeMeta(dataRoot, {
            id,
            ...(before.agentId !== '' ? { agentId: before.agentId } : {}),
            title,
            ...(before.workspaceId !== undefined ? { workspaceId: before.workspaceId } : {}),
            status: 'active',
            createdAt: before.createdAt,
            updatedAt: new Date().toISOString(),
          });
          const view = viewOf(dataRoot, id, conv());
          if (view !== null) { emit(view, 'updated'); upsertEntry(id, view); }
          return { applied: true };
        });
      }

      // list（cr-869/870）：驻留快照直吐。每条目 1 次账本指纹复验（cr-973
      // 起指纹 = agent 域 messages.jsonl 聚合 stat）
      //（兜底事件丢失——绕过通知的外部写/删除仍被看见），失配或 stale（追加
      // 事件标记）才读账本重算（cr-870 前是全条目三重 stat + meta 读）。
      // 让出按 ~12ms 时间片（cr-980 perf #4：批计数 32 → 墙钟切片——千级
      // 条目的指纹复验 stat 段不再成块独占事件循环）。
      web.registerRpc('singles/list', async () => {
        const out: SingleView[] = [];
        let dirty = false;
        let sliceAt = Date.now();
        // 指纹复验源（cr-981）：sessionIndex 在场 → messages 账面一次读
        //（零盘 IO——逐条目 stat×agents 复验是 list 最后的大头，实测千级
        // 条目 ~1.1s/次；账面 ~2ms）。账面新鲜度由 runs/snapshot 变更面
        // 定向入账 + 60s 周期对账维护（running 会话拍内新鲜，其余 ≤ 对账
        // 周期）；行缺席 → 逐条目 stat 复验回落（同构降级）。
        const index = ctx.get('sessionIndex') as SessionIndexFace | undefined;
        const cat = index !== undefined
          ? new Map(index.messagesCatalog().map((r) => [r.conv, r]))
          : null;
        const ids = [...registry.keys()];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!;
          const e = registry.get(id)!;
          const st = cat !== null ? (cat.get(id) ?? null) : ledgerFingerprint(dataRoot, id);
          const gone = st === null && e.size !== 0; // 账本曾存在、现已消失
          if (e.stale === true || gone || (st !== null && (st.size !== e.size || st.mtimeMs !== e.mtimeMs))) {
            const rebuilt = buildEntry(dataRoot, id, conv());
            if (rebuilt === null) registry.delete(id);
            else registry.set(id, rebuilt);
            dirty = true;
          }
          const cur = registry.get(id);
          if (cur?.view != null && cur.view.status === 'active') out.push(cur.view);
          if (Date.now() - sliceAt > 12) {
            await new Promise<void>((r) => setImmediate(r));
            sliceAt = Date.now();
          }
        }
        if (dirty) writeRegistry(dataRoot, registry);
        return { singles: out };
      });

      web.registerRpc('singles/create', (params) => {
        const p = obj(params);
        const agentId = optStr(p.agentId);
        if (agentId !== undefined && readAgentConfig(dataRoot, agentId) === null) {
          throw new Error('Agent 不存在：' + agentId);
        }
        // reuse：复用同 Agent 的空会话（列表「新增」不刷屏——主线同义）
        if (p.reuse === true) {
          for (const [id, e] of registry) {
            if (e.view === null || e.view.status !== 'active') continue;
            if (agentId !== undefined && e.view.agentId !== agentId) continue;
            if (e.summary.count === 0) return { single: e.view, reused: true };
          }
        }
        // 指定 id 物化（延迟落盘链路——前端幻影会话首条消息发送时带本地
        // 签发的 id 创建，消息流与 session.json 落同一目录）：已有目录
        //（meta 或账本任一在场）= 幂等返回现状视图，不重复落盘。
        const requested = optStr(p.id);
        if (requested !== undefined) assertSingleId(requested);
        const id = requested ?? issueConversationId();
        if (requested !== undefined) {
          const existing = viewOf(dataRoot, id, conv());
          if (existing !== null) return { single: existing };
        }
        const now = new Date().toISOString();
        const meta: SingleMeta = {
          id,
          ...(agentId !== undefined ? { agentId } : {}),
          ...(optStr(p.title) !== undefined ? { title: optStr(p.title)!.slice(0, TITLE_MAX_LEN) } : {}),
          ...(optStr(p.workspaceId) !== undefined ? { workspaceId: optStr(p.workspaceId)! } : {}),
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        writeMeta(dataRoot, meta);
        const model = optStr(p.model);
        if (model !== undefined) conv()?.set(id, { model });
        const view = viewOf(dataRoot, id, conv());
        if (view === null) throw new Error('会话创建失败：' + id);
        emit(view, 'created');
        upsertEntry(id, view);
        return { single: view };
      });

      web.registerRpc('singles/update', (params) => {
        const p = obj(params);
        const id = reqStr(p, 'id');
        assertSingleId(id);
        const before = viewOf(dataRoot, id, conv());
        if (before === null) throw new Error('会话不存在：' + id);
        const now = new Date().toISOString();
        const meta: SingleMeta = {
          id,
          ...(before.agentId !== '' ? { agentId: before.agentId } : {}),
          ...(before.title !== undefined ? { title: before.title } : {}),
          ...(before.workspaceId !== undefined ? { workspaceId: before.workspaceId } : {}),
          status: before.status,
          createdAt: before.createdAt,
          updatedAt: now,
        };
        // agentId：'' = 清空待选；已有消息时拒绝（换 Agent = 换上下文——主线 409 语义）
        if (p.agentId !== undefined) {
          const next = String(p.agentId);
          if (next === '') {
            const known = registry.get(id)?.summary.count;
            const count = known !== undefined ? known : (ledgerFingerprint(dataRoot, id) === null ? 0 : computeLedgerSummary(dataRoot, id).count);
            if (count > 0) throw new Error('会话已有消息，不能清空 Agent');
            delete meta.agentId;
          } else {
            if (readAgentConfig(dataRoot, next) === null) throw new Error('Agent 不存在：' + next);
            meta.agentId = next;
          }
        }
        if (p.title !== undefined) {
          const title = String(p.title).trim();
          if (title === '') delete meta.title;
          else meta.title = title.slice(0, TITLE_MAX_LEN);
        }
        if (p.workspaceId !== undefined) {
          const ws = String(p.workspaceId).trim();
          if (ws === '') delete meta.workspaceId;
          else meta.workspaceId = ws;
        }
        writeMeta(dataRoot, meta);
        // 模型覆盖：undefined = 不变 / null = 清除 / 字符串 = 设（D12 单源）
        if (p.model !== undefined) {
          const service = conv();
          if (service === undefined) throw new Error('convSettings 服务未装配——模型覆盖不可用');
          service.set(id, { model: p.model === null ? null : String(p.model) });
        }
        const view = viewOf(dataRoot, id, conv());
        if (view === null) throw new Error('会话读取失败：' + id);
        emit(view, 'updated');
        upsertEntry(id, view);
        return { single: view };
      });

      web.registerRpc('singles/fork', (params) => {
        const p = obj(params);
        const id = reqStr(p, 'id');
        assertSingleId(id);
        const from = viewOf(dataRoot, id, conv());
        if (from === null) throw new Error('会话不存在：' + id);
        const nextId = issueConversationId();
        const anchor = optStr(p.anchorMessageId);
        // cr-973：消息流在 agent 域——逐域分支拷贝（新会话只有 agent 域 + meta）
        let forked = false;
        for (const dir of conversationDirs(dataRoot, id)) {
          const domain = path.basename(path.dirname(path.dirname(dir)));
          const to = sessionDir(dataRoot, domain, nextId);
          try {
            const n = forkConversation(dir, to, anchor);
            forked = forked || n > 0;
          } catch {
            // 该域无 messages 文件（journal-only）——跳过
          }
        }
        const now = new Date().toISOString();
        const meta: SingleMeta = {
          id: nextId,
          ...(from.agentId !== '' ? { agentId: from.agentId } : {}),
          ...(from.title !== undefined ? { title: from.title } : {}),
          ...(from.workspaceId !== undefined ? { workspaceId: from.workspaceId } : {}),
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        writeMeta(dataRoot, meta);
        if (from.model !== undefined) conv()?.set(nextId, { model: from.model });
        const view = viewOf(dataRoot, nextId, conv());
        if (view === null) throw new Error('会话分支创建失败：' + nextId);
        const created = { ...view, lastActivity: now };
        emit(created, 'created');
        upsertEntry(nextId, created);
        return { single: view };
      });

      web.registerRpc('singles/archive', (params) => {
        const id = reqStr(obj(params), 'id');
        assertSingleId(id);
        const before = viewOf(dataRoot, id, conv());
        if (before === null) throw new Error('会话不存在：' + id);
        const meta: SingleMeta = {
          id,
          ...(before.agentId !== '' ? { agentId: before.agentId } : {}),
          ...(before.title !== undefined ? { title: before.title } : {}),
          ...(before.workspaceId !== undefined ? { workspaceId: before.workspaceId } : {}),
          status: 'archived',
          createdAt: before.createdAt,
          updatedAt: new Date().toISOString(),
        };
        writeMeta(dataRoot, meta);
        const view = viewOf(dataRoot, id, conv());
        if (view === null) throw new Error('会话读取失败：' + id);
        emit(view, 'archived');
        upsertEntry(id, view);
        return { single: view };
      });

      // 硬删：会话账本（user 投影 + 各 agent 域）+ 元数据 + 模型覆盖 + 快照，一并清
      web.registerRpc('singles/delete', (params) => {
        const id = reqStr(obj(params), 'id');
        assertSingleId(id);
        const before = viewOf(dataRoot, id, conv());
        for (const dir of conversationDirs(dataRoot, id)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        // 元数据在第二层（meta/sessions/）——连带摘除
        fs.rmSync(userMetaFile(dataRoot, id), { force: true });
        conv()?.set(id, { model: null });
        // 未读计数连带清（cr-1184）：会话已不存在，滞留计数 = 永不可消的僵尸徽章
        clearUnread(dataRoot, id);
        // 会话快照连带清（cr-1208）：级联口归位删除 RPC 本身——壳内事件
        // 订阅跨进程不可达（宿主只 web.broadcast 不 emit 总线），cr-376
        // 事件接线在生产从未触发过，本行与快照根同进程直清。
        snapshots.dropConversation(id);
        emit(before ?? { id, agentId: '', status: 'archived', createdAt: '', updatedAt: '' }, 'removed');
        upsertEntry(id, null);
        return { deleted: true };
      });

    },
  };
}
