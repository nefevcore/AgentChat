// ============================================================
// WorkspacesService —— 用户工作区管理（会话树分组的文件夹白名单）
//
// 用户工作区 ≠ 数据目录（AGENTCHAT_WORKSPACE / workspace/default）：
// 它是用户登记的一个本机文件夹，作为会话列表树的根节点分组；
// 挂在其下的独立会话运行时把该文件夹并入沙箱路径白名单
// （security.allowedPaths，见 agents/config.ts extraAllowedPaths）。
//
// 存储：<wsRoot>/workspaces/<id>/workspace.json
//   · path 必须是存在的外部目录（绝对路径，resolve 归一）
//   · 同一路径只允许登记一次（重复 → 拒绝）
//   · 删除工作区不动会话（会话 workspaceId 悬空 → 列表归入未分组）
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@agentchat/util';
import type { WorkspaceInfo } from '@agentchat/protocol';

const log = createLogger('[server:workspaces]');

/** workspace.json 持久形态 */
export interface WorkspaceRecord {
  id: string;
  name: string;
  /** 文件夹绝对路径（白名单根） */
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspacesServiceOptions {
  /** 数据工作区根（workspaces/ 所在） */
  wsRoot: string;
}

export class WorkspacesService {
  private readonly wsRoot: string;

  constructor(options: WorkspacesServiceOptions) {
    this.wsRoot = options.wsRoot;
  }

  /** 元数据目录：<ws>/workspaces/<id>/ */
  private dirOf(id: string): string {
    return path.join(this.wsRoot, 'workspaces', id);
  }

  private fileOf(id: string): string {
    return path.join(this.dirOf(id), 'workspace.json');
  }

  private readRecord(id: string): WorkspaceRecord | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileOf(id), 'utf8'));
      if (typeof raw?.id !== 'string' || typeof raw?.path !== 'string') return null;
      return raw as WorkspaceRecord;
    } catch {
      return null; // 不存在/损坏
    }
  }

  /** 读单个（不存在 → null） */
  get(id: string): WorkspaceInfo | null {
    const record = this.readRecord(id);
    return record ? this.toInfo(record) : null;
  }

  /** 全部工作区（按名称排序：数字感知 localeCompare） */
  list(): WorkspaceInfo[] {
    const root = path.join(this.wsRoot, 'workspaces');
    if (!fs.existsSync(root)) return [];
    const out: WorkspaceInfo[] = [];
    for (const name of fs.readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const record = this.readRecord(name.name);
      if (record) out.push(this.toInfo(record));
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return out;
  }

  /** 校验路径形态：绝对、存在、是目录；返回归一化绝对路径 */
  private validateDir(input: string): string {
    if (typeof input !== 'string' || !input.trim()) {
      throw new Error('工作区路径不能为空');
    }
    const p = path.resolve(input.trim());
    if (!path.isAbsolute(p)) throw new Error(`工作区路径必须是绝对路径：${input}`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      throw new Error(`路径不存在：${p}`);
    }
    if (!stat.isDirectory()) throw new Error(`路径不是文件夹：${p}`);
    return p;
  }

  /** 同一路径重复登记 → 拒绝 */
  private assertPathUnused(dir: string, exceptId?: string): void {
    const dup = this.list().find(w => w.path === dir && w.id !== exceptId);
    if (dup) throw new Error(`该文件夹已是工作区「${dup.name}」`);
  }

  /** 创建：name 缺省 = 文件夹名 */
  create(input: { name?: string; path: string }): WorkspaceInfo {
    const dir = this.validateDir(input.path);
    this.assertPathUnused(dir);
    const name = (input.name ?? '').trim() || path.basename(dir) || dir;
    const now = new Date().toISOString();
    const record: WorkspaceRecord = { id: randomUUID(), name, path: dir, createdAt: now, updatedAt: now };
    fs.mkdirSync(this.dirOf(record.id), { recursive: true });
    fs.writeFileSync(this.fileOf(record.id), JSON.stringify(record, null, 2), 'utf8');
    log.info(`已创建用户工作区 ${record.id.slice(0, 8)}…「${name}」→ ${dir}`);
    return this.toInfo(record);
  }

  /** 更新（改名 / 换文件夹） */
  update(id: string, input: { name?: string; path?: string }): WorkspaceInfo {
    const record = this.readRecord(id);
    if (!record) throw new Error(`工作区 "${id}" 不存在`);
    if (input.path !== undefined) {
      const dir = this.validateDir(input.path);
      this.assertPathUnused(dir, id);
      record.path = dir;
    }
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error('工作区名称不能为空');
      record.name = name;
    }
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.fileOf(id), JSON.stringify(record, null, 2), 'utf8');
    return this.toInfo(record);
  }

  /** 删除：只删工作区登记，不动会话（悬空 workspaceId → 未分组） */
  delete(id: string): void {
    const record = this.readRecord(id);
    if (!record) throw new Error(`工作区 "${id}" 不存在`);
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
    log.info(`已删除用户工作区 ${id}（会话保留，归入未分组）`);
  }

  private toInfo(record: WorkspaceRecord): WorkspaceInfo {
    return {
      id: record.id,
      name: record.name,
      path: record.path,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
