// ============================================================
// SinglesService —— 独立会话（single session）管理（P3）
//
// 会话 = 引用 + 覆盖，不是拷贝：
//   workspace/singles/<sid>/session.json   元数据（agentId 引用 + 模型覆盖 + 状态）
//   sessions/single~<sid>/messages.jsonl   消息（标准会话链，格式与 pair 完全一致）
//
//   · 不动 Agent 的 config.json——presets/工具集/钩子跟随 Agent 原定义
//   · 只有模型是会话级覆盖（池引用字符串 / 内嵌 / $ref+覆盖三形态，
//     运行时经 router llmOverride → assembly.createLLM → resolveLLMPool 解析）
//   · 隔离分级（诚实声明）：历史/上下文隔离（独立会话键 + 独立记忆对象），
//     不含插件实例隔离（单平面架构下行是宿主全局的；见 docs/architecture.md）
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@agentchat/util';
import { singleDialogKey } from '@agentchat/agents';
import type { SingleSessionInfo } from '@agentchat/protocol';

const log = createLogger('[server:singles]');

/** session.json 持久形态 */
export interface SingleSessionRecord {
  id: string;
  agentId: string;
  /** 模型覆盖：池引用字符串 / 内嵌 LLMConfig / $ref+覆盖（undefined = 用 Agent 原配置） */
  model?: string | Record<string, unknown>;
  title?: string;
  /** 所属用户工作区（workspaceId 引用；缺省/空 = 未分组） */
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'archived';
}

/** registry 最小面（避免依赖 @agents 具体类型） */
export interface SinglesRegistryLike {
  get(agentId: string): { agent_id: string; virtual?: boolean } | undefined;
  listIds(): string[];
}

/** workspaces 最小面（避免依赖 server/workspaces 具体类型；测试可桩） */
export interface SinglesWorkspacesLike {
  get(id: string): { id: string } | null;
}

export interface SinglesServiceOptions {
  /** 工作区根（singles/ 与 sessions/ 所在） */
  wsRoot: string;
  registry: SinglesRegistryLike;
  /** 模型池目录（校验池引用存在；缺省不校验字符串引用） */
  llmPools?: () => Record<string, unknown>;
  /** 用户工作区目录（校验 workspaceId 存在；缺省不校验） */
  workspaces?: SinglesWorkspacesLike;
}

export class SinglesService {
  private readonly wsRoot: string;
  private readonly registry: SinglesRegistryLike;
  private readonly llmPools?: () => Record<string, unknown>;
  private readonly workspaces?: SinglesWorkspacesLike;

  constructor(options: SinglesServiceOptions) {
    this.wsRoot = options.wsRoot;
    this.registry = options.registry;
    this.llmPools = options.llmPools;
    this.workspaces = options.workspaces;
  }

  /** 元数据目录：<ws>/singles/<sid>/ */
  private dirOf(sessionId: string): string {
    return path.join(this.wsRoot, 'singles', sessionId);
  }

  private fileOf(sessionId: string): string {
    return path.join(this.dirOf(sessionId), 'session.json');
  }

  /** 消息文件（标准会话链，HistoryService/归档同路径） */
  messagesFileOf(sessionId: string): string {
    return path.join(this.wsRoot, 'sessions', singleDialogKey(sessionId), 'messages.jsonl');
  }

  /** 校验模型覆盖形态（字符串 = 池引用须存在；对象 = 原样接受；未提供池目录 = 不校验，运行时兜底） */
  private validateModel(model: SingleSessionRecord['model']): void {
    if (model === undefined) return;
    if (typeof model === 'object' && model !== null) return; // 内嵌 / $ref+覆盖
    if (typeof model === 'string') {
      const pools = this.llmPools?.();
      if (pools === undefined) return; // 池目录未提供（如测试桩）：放行，resolveLLMPool 运行时兜底
      if (!(model in pools)) {
        throw new Error(`模型池引用 "${model}" 不存在（可用：${Object.keys(pools).join(', ') || '（无）'}）`);
      }
      return;
    }
    throw new Error('model 必须是池引用字符串或配置对象');
  }

  /**
   * 创建独立会话（P4 快速创建：允许空 Agent——空会话先建，Agent 在输入栏选择后
   * 经 update 补齐；空 Agent 会话不能发消息，WS 层拦截）。
   * 非空 agentId 时校验：存在且非虚拟；模型引用可解析 → 写 session.json。
   * workspaceId（用户工作区）非空时校验存在；目录名即 id（uuid v4，对齐 groups 现状）。
   */
  create(input: { agentId?: string; model?: SingleSessionRecord['model']; title?: string; workspaceId?: string }): SingleSessionInfo {
    const agentId = (input.agentId ?? '').trim();
    if (agentId) {
      const agent = this.registry.get(agentId);
      if (!agent) {
        throw new Error(`Agent "${agentId}" 不存在（可用：${this.registry.listIds().join(', ')}）`);
      }
      if (agent.virtual) {
        throw new Error(`Agent "${agentId}" 是虚拟 Agent，不支持独立会话`);
      }
    }
    this.validateModel(input.model);
    const workspaceId = (input.workspaceId ?? '').trim();
    if (workspaceId) this.validateWorkspace(workspaceId);

    // 空白会话全局唯一：创建新的空会话前先清掉遗留空会话（未选 Agent 且无消息）
    // ——不限定 workspaceId（空白会话不属于任何分组），保证任一时刻最多一个
    this.purgeEmptySessions();

    const now = new Date().toISOString();
    const record: SingleSessionRecord = {
      id: randomUUID(),
      agentId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };
    fs.mkdirSync(this.dirOf(record.id), { recursive: true });
    fs.writeFileSync(this.fileOf(record.id), JSON.stringify(record, null, 2), 'utf8');
    log.info(`已创建独立会话 ${record.id}（agent=${agentId || '（空，待选择）'}${workspaceId ? ', workspace 挂载' : ''}${record.model ? ', model 覆盖' : ''}）`);
    return this.toInfo(record);
  }

  private readRecord(sessionId: string): SingleSessionRecord | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileOf(sessionId), 'utf8'));
      if (typeof raw?.id !== 'string' || typeof raw?.agentId !== 'string') return null;
      return raw as SingleSessionRecord;
    } catch {
      return null; // 不存在/损坏
    }
  }

  /** 读单会话（不存在 → null） */
  get(sessionId: string): SingleSessionInfo | null {
    const record = this.readRecord(sessionId);
    return record ? this.toInfo(record) : null;
  }

  /** 原始记录读取（WSHandler 投递用：需要 model 覆盖原样透传 router） */
  getRecord(sessionId: string): SingleSessionRecord | null {
    return this.readRecord(sessionId);
  }

  /** 全部会话（含 archived；lastActivity 来自消息文件 mtime，供列表页排序） */
  list(): SingleSessionInfo[] {
    const root = path.join(this.wsRoot, 'singles');
    if (!fs.existsSync(root)) return [];
    const out: SingleSessionInfo[] = [];
    for (const name of fs.readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const record = this.readRecord(name.name);
      if (record) out.push(this.toInfo(record));
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /** 归档（软删）：状态置 archived，消息文件保留 */
  archive(sessionId: string): SingleSessionInfo {
    const record = this.readRecord(sessionId);
    if (!record) throw new Error(`独立会话 "${sessionId}" 不存在`);
    record.status = 'archived';
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.fileOf(sessionId), JSON.stringify(record, null, 2), 'utf8');
    log.info(`已归档独立会话 ${sessionId}`);
    return this.toInfo(record);
  }

  /**
   * 删除（硬删）：移除元数据目录 + 会话消息目录（sessions/single~<id>/）。
   * 与归档不同：数据不可恢复，供列表显式删除入口使用。
   */
  delete(sessionId: string): void {
    const record = this.readRecord(sessionId);
    if (!record) throw new Error(`独立会话 "${sessionId}" 不存在`);
    fs.rmSync(this.dirOf(sessionId), { recursive: true, force: true });
    const msgDir = path.dirname(this.messagesFileOf(sessionId));
    fs.rmSync(msgDir, { recursive: true, force: true });
    log.info(`已删除独立会话 ${sessionId}（含消息记录）`);
  }

  /** 是否已有消息（消息文件存在且非空）——锁定预设/Agent 变更的判据 */
  hasMessages(sessionId: string): boolean {
    try {
      const stat = fs.statSync(this.messagesFileOf(sessionId));
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * 是否空会话：未选 Agent 且无消息文件（P4 复用判定——新建时若已存在
   * 空会话则复用，避免反复 + 堆积空白条目）。
   */
  isEmpty(sessionId: string): boolean {
    const record = this.readRecord(sessionId);
    if (!record || record.status !== 'active') return false;
    if (record.agentId) return false;
    try {
      fs.accessSync(this.messagesFileOf(sessionId));
      return false; // 已有消息 = 不是空会话
    } catch {
      return true;
    }
  }

  /**
   * 清掉全部遗留空白会话（未选 Agent 且无消息；硬删——无数据可失）。
   * 保证「空白会话全局唯一」不变量：create 空会话前调用。
   */
  private purgeEmptySessions(): number {
    let purged = 0;
    for (const info of this.list()) {
      if (this.isEmpty(info.id)) {
        this.delete(info.id);
        purged++;
      }
    }
    if (purged > 0) log.info(`已清理 ${purged} 个遗留空白会话（空白会话全局唯一）`);
    return purged;
  }

  /** 更新标题 */
  rename(sessionId: string, title: string): SingleSessionInfo {
    const record = this.readRecord(sessionId);
    if (!record) throw new Error(`独立会话 "${sessionId}" 不存在`);
    record.title = title;
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.fileOf(sessionId), JSON.stringify(record, null, 2), 'utf8');
    return this.toInfo(record);
  }

  /** 校验用户工作区引用存在（目录未提供时放行） */
  private validateWorkspace(workspaceId: string): void {
    if (!this.workspaces) return;
    if (!this.workspaces.get(workspaceId)) throw new Error(`工作区 "${workspaceId}" 不存在`);
  }

  /**
   * 更新会话设置（输入栏内联调整：换 Agent / 换模型覆盖 / 挂工作区）。
   * model 语义：undefined = 不变；null = 清除覆盖（回落 Agent 原配置）。
   * agentId 语义：undefined = 不变；'' = 清空（空会话，发消息前必须补齐）。
   *   **已有消息的会话禁止变更 agentId**：历史消息的归属身份与投递目标
   *   绑定在所选 Agent/预设上，中途更换会导致消息身份错乱（规则 1）。
   * workspaceId 语义：undefined = 不变；'' = 移入未分组。
   */
  update(sessionId: string, input: { agentId?: string; model?: SingleSessionRecord['model'] | null; title?: string; workspaceId?: string }): SingleSessionInfo {
    const record = this.readRecord(sessionId);
    if (!record) throw new Error(`独立会话 "${sessionId}" 不存在`);
    const nextAgent = input.agentId?.trim();
    if (nextAgent !== undefined && nextAgent !== record.agentId) {
      if (this.hasMessages(sessionId)) {
        throw new Error('已存在消息的会话不能更换预设/Agent（历史消息身份与 Agent 绑定）');
      }
      if (nextAgent) {
        const agent = this.registry.get(nextAgent);
        if (!agent) throw new Error(`Agent "${nextAgent}" 不存在（可用：${this.registry.listIds().join(', ')}）`);
        if (agent.virtual) throw new Error(`Agent "${nextAgent}" 是虚拟 Agent，不支持独立会话`);
      }
      record.agentId = nextAgent;
    }
    if (input.model !== undefined) {
      if (input.model === null) delete record.model;
      else {
        this.validateModel(input.model);
        record.model = input.model;
      }
    }
    if (input.workspaceId !== undefined) {
      const nextWs = input.workspaceId.trim();
      if (nextWs) this.validateWorkspace(nextWs);
      if (nextWs) record.workspaceId = nextWs;
      else delete record.workspaceId;
    }
    if (input.title !== undefined && input.title.trim()) record.title = input.title.trim();
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.fileOf(sessionId), JSON.stringify(record, null, 2), 'utf8');
    log.info(`已更新独立会话 ${sessionId}${input.agentId !== undefined ? `（agent=${record.agentId}）` : ''}${input.model !== undefined ? `（model ${record.model ? '覆盖' : '清除'}）` : ''}${input.workspaceId !== undefined ? `（workspace=${record.workspaceId || '未分组'}）` : ''}`);
    return this.toInfo(record);
  }

  /** 记录 → 前端 DTO（附 lastActivity 供列表） */
  private toInfo(record: SingleSessionRecord): SingleSessionInfo {
    let lastActivity: string | undefined;
    try {
      const stat = fs.statSync(this.messagesFileOf(record.id));
      if (stat.mtimeMs > 0) lastActivity = stat.mtime.toISOString();
    } catch { /* 无消息文件 = 从未对话 */
    }
    return {
      id: record.id,
      agentId: record.agentId,
      model: record.model,
      title: record.title,
      workspaceId: record.workspaceId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActivity,
    };
  }
}
