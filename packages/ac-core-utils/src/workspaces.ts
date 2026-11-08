// ============================================================
// workspaces.ts —— 工作区登记表读写面（cr-583 立；数据分层第二批
// meta/ 迁居后自 ac-host-rows/workspaces 下沉单源）
//
// 收录判据（index 头同款）：workspaces.json 登记表词汇现由两处消费——
// 宿主 web-api/face-ops（经 ac-host-rows 直读直写）与主线 WorkspaceService
// 四方法（ctx.workspace——ac-skill 工作区挂载解析等读方）。两处各写一份
// 「读旧写新」兼容窗必走散（web-api 写 meta/、服务读根级旧位 → 新登记
// 在服务面失踪），故下沉纯库单源（readGroupConfig 先例）。
//
// 落点：meta/workspaces.json（数据分层第二层——docs/design/data-root-layers.md
// §二）；读侧兼容窗回落旧位置根级 workspaces.json（寄居期文件不迁移）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renameWithRetry } from 'ac-plugin-core';

export interface WorkspaceRegistration {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

/** 登记表落点（数据分层第二层）：meta/workspaces.json——写侧恒新位置 */
function fileOf(dataRoot: string): string {
  return path.join(dataRoot, 'meta', 'workspaces.json');
}

/** 兼容窗旧位置（根级 workspaces.json——只读不写，不物理迁移） */
function legacyFileOf(dataRoot: string): string {
  return path.join(dataRoot, 'workspaces.json');
}

/** 损坏留档（防后续写口以空表覆写唯一副本——凭据域 B2 同款防线） */
function archiveCorrupt(file: string): void {
  try { fs.renameSync(file, file + '.corrupt'); } catch { /* 留档失败不阻塞 */ }
}

function read(dataRoot: string): WorkspaceRegistration[] {
  // 新位置缺席 → 兼容窗回落旧位置（读旧写新，不迁移）
  const file = fs.existsSync(fileOf(dataRoot)) ? fileOf(dataRoot) : legacyFileOf(dataRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    // 缺席 = 首启合法空态；损坏 = 留档后空登记（会话全部落「未分组」）
    if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) archiveCorrupt(file);
    return [];
  }
  if (!Array.isArray(raw)) {
    archiveCorrupt(file);
    return [];
  }
  return raw.filter((e): e is WorkspaceRegistration =>
    e !== null && typeof e === 'object'
    && typeof (e as WorkspaceRegistration).id === 'string'
    && typeof (e as WorkspaceRegistration).name === 'string'
    && typeof (e as WorkspaceRegistration).path === 'string');
}

function write(dataRoot: string, docs: WorkspaceRegistration[]): void {
  const file = fileOf(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true }); // meta/ 首写物化
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(docs, null, 2) + '\n', 'utf-8');
  // Windows 瞬时占用（杀软/并发读）会让 rename 抛 EPERM：仓库既有原语退避重试
  //（ac-plugin-core/fsx —— 全仓 rename 的单一收敛点，cr-676 全量跑出 flake 后并源）
  renameWithRetry(tmp, file);
}

export function listWorkspaces(dataRoot: string): WorkspaceRegistration[] {
  return read(dataRoot);
}

export function registerWorkspace(dataRoot: string, wsPath: string, name?: string): WorkspaceRegistration {
  const docs = read(dataRoot);
  const id = 'ws-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const item: WorkspaceRegistration = {
    id,
    name: name?.trim() || path.basename(wsPath) || wsPath,
    path: wsPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  docs.push(item);
  write(dataRoot, docs);
  return item;
}

export function updateWorkspace(
  dataRoot: string,
  id: string,
  patch: { name?: string; path?: string },
): WorkspaceRegistration | undefined {
  const docs = read(dataRoot);
  const item = docs.find((w) => w.id === id);
  if (item === undefined) return undefined;
  if (patch.name !== undefined) item.name = patch.name;
  if (patch.path !== undefined) item.path = patch.path;
  item.updatedAt = new Date().toISOString();
  write(dataRoot, docs);
  return item;
}

export function removeWorkspace(dataRoot: string, id: string): boolean {
  const docs = read(dataRoot);
  const next = docs.filter((w) => w.id !== id);
  if (next.length === docs.length) return false;
  write(dataRoot, next);
  return true;
}

/** 会话挂载工作区 → 登记路径（树基准解析面——未登记 = null） */
export function workspacePathOf(dataRoot: string, wsId: string): string | null {
  return listWorkspaces(dataRoot).find((w) => w.id === wsId)?.path ?? null;
}
