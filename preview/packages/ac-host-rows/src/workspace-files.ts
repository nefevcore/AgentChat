// ============================================================
// workspace-files.ts —— 工作区文件面（cr-676）
//
// 主线 owning = ac-workspace 服务（tree/readFile/resolveFile/
// saveUpload），该服务 inject 主线 agents/agentStore/session 三服务，
// preview 宿主树无此服务面、不可零改动导入（cr-583 交接列明的缺口）。
// 本模块按 workspaces.ts 同款形态裁出纯函数面（零 cordis 依赖），语义
// 照搬主线方法：
//   · 树基准三级优先序：会话挂载工作区 > Agent 级基准（显式
//     settings['security'].workdir > 专用空间 files/<id>）> 数据根；
//   · 读面定位两段：数据根快路径（无 context 时即原行为）→ 工作区基准
//     推导（Agent 在工作区里作业时回复写的 `src/app.ts` 相对引用可预览）；
//   · raw 直链与上传桶（内容寻址 sha1-12 + 原扩展名，同内容幂等）。
// HTTP 编排住 ac-host-webui/web-api.ts（与 cr-583 登记面同款分工）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRootsContainment } from 'ac-sandbox-core';
import { readAgentConfig, settingsOf } from 'ac-agents-core';
import { listWorkspaces, workspacePathOf } from './workspaces.ts';

/** 读面上下文（主线 readContext 同形：agentId/conversationId 可选透传） */
export interface WorkspaceContext {
  agentId?: string;
  conversationId?: string;
}

export interface WorkspaceNode {
  name: string;
  type: 'dir' | 'file';
}

export interface WorkspaceTreeResult {
  path: string;
  children: WorkspaceNode[];
  /** 树基准回显（label = 前端标题：登记名 / Agent/<id> / 空串 = 数据根） */
  root: { dir: string; label: string };
}

export interface WorkspaceFileResult {
  path: string;
  content: string;
  base64: boolean;
  contentType: string;
  size: number;
}

export interface WorkspaceUploadResult {
  hash: string;
  storedName: string;
  originalName: string;
  size: number;
  /** 数据根相对引用形（树/raw 直链传统形） */
  path: string;
  /** 落点绝对路径（Agent read 工具跨锚点可达——主线 cr-22 同语义） */
  absPath: string;
}

/** 预览上限（主线 ac-workspace.readFile 缺省同值） */
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

/** 内容类型猜测表（预览/直链用——主线 ac-workspace CONTENT_TYPES 同表） */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

/** 简易内容类型猜测（预览/直链用） */
export function guessContentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 会话 id 词形闸（拼路径面：非空、无分隔符、无回溯） */
function usableConversationId(id: string): boolean {
  return id !== '' && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

/** 会话元数据（viewer/sessions/<sid>/session.json——宿主 singles 行单写；缺席/损坏 = 空对象） */
function sessionMetaOf(
  dataRoot: string,
  conversationId: string | undefined,
): { agentId?: string; workspaceId?: string } {
  if (conversationId === undefined || !usableConversationId(conversationId)) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(
      path.join(dataRoot, 'viewer', 'sessions', conversationId, 'session.json'), 'utf-8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const m = raw as { agentId?: unknown; workspaceId?: unknown };
    return {
      ...(typeof m.agentId === 'string' && m.agentId !== '' ? { agentId: m.agentId } : {}),
      ...(typeof m.workspaceId === 'string' && m.workspaceId !== '' ? { workspaceId: m.workspaceId } : {}),
    };
  } catch {
    return {};
  }
}

/** 会话挂载工作区根（workspaceId → 登记路径；未挂载/未登记 = null） */
export function conversationWorkspaceRoot(dataRoot: string, conversationId: string | undefined): string | null {
  const wsId = sessionMetaOf(dataRoot, conversationId).workspaceId;
  return wsId === undefined ? null : workspacePathOf(dataRoot, wsId);
}

/** 会话承载 Agent（上传桶推导用——agentId 缺席时经会话推导；缺席 = undefined） */
export function conversationAgentId(dataRoot: string, conversationId: string | undefined): string | undefined {
  return sessionMetaOf(dataRoot, conversationId).agentId;
}

/** 全局默认设置层（<dataRoot>/config.json 的 agents.settings——主线 settingsOf 第一层） */
function globalAgentSettings(dataRoot: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf-8'));
    const s = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { agents?: { settings?: unknown } }).agents?.settings
      : undefined;
    return s !== null && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Agent 级基准（主线 sandboxWorkdir 单参形态）：显式 settings['security'].workdir
 * > 专用空间 files/<id>；预设/虚拟/未注册 = undefined（数据根兜底——主线
 * treeBase 的 !preset && !virtual 门）。
 */
export function agentWorkdirOf(dataRoot: string, agentId: string): string | undefined {
  const agent = readAgentConfig(dataRoot, agentId);
  if (agent === null || agent.preset === true || agent.virtual === true) return undefined;
  const security = settingsOf(globalAgentSettings(dataRoot), agent.settings, 'security');
  const explicit = security !== null && typeof security === 'object'
    ? (security as { workdir?: unknown }).workdir
    : undefined;
  if (typeof explicit === 'string' && explicit !== '') return path.resolve(explicit);
  return path.resolve(dataRoot, 'files', agentId);
}

/**
 * 树基准（workspaceTree 单源）：会话挂载工作区 > Agent 级基准 > 数据根。
 * label = 基准名（前端标题展示）；数据根 = 空串。
 */
export function workspaceTreeBase(dataRoot: string, context?: WorkspaceContext): { dir: string; label: string } {
  const root = path.resolve(dataRoot);
  if (context !== undefined && (context.agentId !== undefined || context.conversationId !== undefined)) {
    const convRoot = conversationWorkspaceRoot(dataRoot, context.conversationId);
    if (convRoot !== null) {
      const name = listWorkspaces(dataRoot).find((w) => w.path === convRoot)?.name ?? path.basename(convRoot);
      return { dir: path.resolve(convRoot), label: name };
    }
    if (context.agentId !== undefined) {
      const dir = agentWorkdirOf(dataRoot, context.agentId);
      if (dir !== undefined && dir !== root) return { dir, label: 'Agent/' + context.agentId };
    }
  }
  return { dir: root, label: '' };
}

/** 基准内解析（词法 + 身份包含判定——../ 越界照拦） */
function resolveIn(root: string, relPath: string): string {
  const full = path.resolve(root, relPath || '.');
  if (!createRootsContainment([root])(full)) throw new Error('路径越界（仅限工作区目录内）');
  return full;
}

/**
 * 目录树（懒加载；path 相对树基准，空 = 基准根）。dotfile 过滤仅作用于
 * 数据根基准（控制面噪音）；外挂工作区/Agent 专用空间如实列出（.dsh/
 * .git 等项目目录是用户真实内容）。读不到 = 空层（前端懒加载照常）。
 */
export function workspaceTree(
  dataRoot: string,
  relPath = '',
  context?: WorkspaceContext,
): WorkspaceTreeResult {
  const base = workspaceTreeBase(dataRoot, context);
  const dir = resolveIn(base.dir, relPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { path: relPath, children: [], root: base };
  }
  const filterDots = base.dir === path.resolve(dataRoot);
  const children: WorkspaceNode[] = [];
  for (const e of entries) {
    if (filterDots && e.name.startsWith('.')) continue;
    if (e.isDirectory()) children.push({ name: e.name, type: 'dir' });
    else if (e.isFile()) children.push({ name: e.name, type: 'file' });
  }
  children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: relPath, children, root: base };
}

/** 读面工作区基准清单（locateReadable ②：会话挂载工作区 > Agent 级基准；数据根已被①覆盖） */
function readBases(dataRoot: string, context?: WorkspaceContext): string[] {
  if (context === undefined || (context.agentId === undefined && context.conversationId === undefined)) return [];
  const bases: string[] = [];
  const conv = conversationWorkspaceRoot(dataRoot, context.conversationId);
  if (conv !== null) bases.push(conv);
  if (context.agentId !== undefined) {
    const agent = agentWorkdirOf(dataRoot, context.agentId);
    if (agent !== undefined && agent !== path.resolve(dataRoot)) bases.push(agent);
  }
  return [...new Set(bases.map((b) => path.resolve(b)))];
}

/**
 * 读面定位（readFile/resolveFile 单源）：
 *   ① 数据根快路径（无 context 时即原行为）：根内词法解析，文件存在即中；
 *      不存在不抛，继续工作区基准（相对引用常根内不存在）。无 context 时
 *      保持原语义：不存在/越界照抛。
 *   ② 工作区基准（仅 context 在场）：候选 resolve(base, p)，包含判定须落在
 *      base 内（../ 逃逸照拒）；存在且为文件 → 命中（displayPath = 绝对路径）。
 * 全部未命中 → 抛「文件不存在或不可读」（调用方转 404）。
 */
function locateReadable(
  dataRoot: string,
  p: string,
  context?: WorkspaceContext,
): { file: string; displayPath: string } {
  const hasCtx = context !== undefined && (context.agentId !== undefined || context.conversationId !== undefined);
  const root = path.resolve(dataRoot);
  let dataCandidate: string | undefined;
  try {
    dataCandidate = resolveIn(root, p);
  } catch (err) {
    if (!hasCtx) throw err;
    dataCandidate = undefined;
  }
  if (dataCandidate !== undefined) {
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dataCandidate);
    } catch (err) {
      if (!hasCtx) throw err;
      st = undefined;
    }
    if (st?.isFile()) return { file: dataCandidate, displayPath: p };
  }
  for (const base of readBases(dataRoot, context)) {
    const cand = path.resolve(base, p);
    if (!createRootsContainment([base])(cand)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(cand);
    } catch {
      continue;
    }
    if (st.isFile()) return { file: cand, displayPath: cand };
  }
  throw new Error('文件不存在或不可读');
}

/**
 * 读文件内容（相对数据根；文本直读，二进制 base64）。大小上限（缺省 4 MiB）
 * 超限抛错。`files/<bucket>/...`（上传返回形）天然直通——files 是数据根子目录。
 */
export function readWorkspaceFile(
  dataRoot: string,
  relPath: string,
  context?: WorkspaceContext,
  maxBytes = MAX_PREVIEW_BYTES,
): WorkspaceFileResult {
  const { file, displayPath } = locateReadable(dataRoot, relPath, context);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('目标不是文件');
  if (stat.size > maxBytes) throw new Error(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 预览上限`);
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf-8');
  const binary = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text.slice(0, 8192));
  return {
    path: displayPath,
    content: binary ? buf.toString('base64') : text,
    base64: binary,
    contentType: guessContentType(file),
    size: stat.size,
  };
}

/** 解析文件绝对路径（raw 直链面；定位与守卫同 readFile）。不存在/目录 → 抛错（调用方转 404） */
export function resolveWorkspaceFile(
  dataRoot: string,
  relPath: string,
  context?: WorkspaceContext,
): string {
  const { file } = locateReadable(dataRoot, relPath, context);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('目标不是文件');
  return file;
}

/**
 * 上传落盘：<root>/files/<bucket>/_tmp/<hash><ext>（bucket = 承载 Agent，
 * 缺省 shared）。内容寻址：同内容同名、已存在即跳过写入（重复粘贴/跨刷新/
 * 多标签页天然幂等）。conversationId 在场且 agentId 缺席时经会话推导承载
 * Agent（独立会话上传此前恒落 shared 的根因）。
 */
export function saveWorkspaceUpload(
  dataRoot: string,
  agentId: string | undefined,
  originalName: string,
  data: Buffer,
  conversationId?: string,
): WorkspaceUploadResult {
  const owner = agentId !== undefined && agentId !== ''
    ? agentId
    : conversationAgentId(dataRoot, conversationId);
  const bucket = owner ?? 'shared';
  const dir = path.resolve(dataRoot, 'files', bucket, '_tmp');
  fs.mkdirSync(dir, { recursive: true });
  const hash = createHash('sha1').update(data).digest('hex').slice(0, 12);
  const ext = path.extname(originalName).slice(0, 16).replace(/[^.\w-]/g, '');
  const storedName = `${hash}${ext}`;
  const file = path.join(dir, storedName);
  if (!fs.existsSync(file)) fs.writeFileSync(file, data);
  return {
    hash,
    storedName,
    originalName,
    size: data.length,
    path: `files/${bucket}/_tmp/${storedName}`,
    absPath: file,
  };
}
