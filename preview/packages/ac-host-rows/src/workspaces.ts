// ============================================================
// workspaces.ts —— 工作区登记表（cr-583）
//
// 数据 = <dataRoot>/workspaces.json（主线 ac-workspace 行同布局：顶层
// 数组，条目 {id,name,path,createdAt,updatedAt}——切换前旧根即此形态，
// 文件可直接平移）。CRUD 语义照搬主线 WorkspaceService 四方法
//（listWorkspaces/registerWorkspace/updateWorkspace/removeWorkspace）——
// 函数直读直写形态（listGroupConfigs 同款先例），REST 编排住 web-api 行。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceRegistration {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

function fileOf(dataRoot: string): string {
  return path.join(dataRoot, 'workspaces.json');
}

function read(dataRoot: string): WorkspaceRegistration[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(fileOf(dataRoot), 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is WorkspaceRegistration =>
      e !== null && typeof e === 'object'
      && typeof (e as WorkspaceRegistration).id === 'string'
      && typeof (e as WorkspaceRegistration).name === 'string'
      && typeof (e as WorkspaceRegistration).path === 'string');
  } catch {
    return []; // 缺席/损坏 = 空登记（会话全部落「未分组」）
  }
}

function write(dataRoot: string, docs: WorkspaceRegistration[]): void {
  const file = fileOf(dataRoot);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(docs, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

export function listWorkspaces(dataRoot: string): WorkspaceRegistration[] {
  return read(dataRoot);
}

export function registerWorkspace(dataRoot: string, wsPath: string, name?: string): WorkspaceRegistration {
  const docs = read(dataRoot);
  const id = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
