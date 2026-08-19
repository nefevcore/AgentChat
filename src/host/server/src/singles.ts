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
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'archived';
}

/** registry 最小面（避免依赖 @agents 具体类型） */
export interface SinglesRegistryLike {
  get(agentId: string): { agent_id: string; virtual?: boolean } | undefined;
  listIds(): string[];
}

export interface SinglesServiceOptions {
  /** 工作区根（singles/ 与 sessions/ 所在） */
  wsRoot: string;
  registry: SinglesRegistryLike;
  /** 模型池目录（校验池引用存在；缺省不校验字符串引用） */
  llmPools?: () => Record<string, unknown>;
}

export class SinglesService {
  private readonly wsRoot: string;
  private readonly registry: SinglesRegistryLike;
  private readonly llmPools?: () => Record<string, unknown>;

  constructor(options: SinglesServiceOptions) {
    this.wsRoot = options.wsRoot;
    this.registry = options.registry;
    this.llmPools = options.llmPools;
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
   * 创建独立会话：校验 Agent 存在且非虚拟、模型引用可解析 → 写 session.json。
   * 目录名即 id（uuid v4，对齐 groups 现状）。
   */
  create(input: { agentId: string; model?: SingleSessionRecord['model']; title?: string }): SingleSessionInfo {
    const agent = this.registry.get(input.agentId);
    if (!agent) {
      throw new Error(`Agent "${input.agentId}" 不存在（可用：${this.registry.listIds().join(', ')}）`);
    }
    if (agent.virtual) {
      throw new Error(`Agent "${input.agentId}" 是虚拟 Agent，不支持独立会话`);
    }
    this.validateModel(input.model);

    const now = new Date().toISOString();
    const record: SingleSessionRecord = {
      id: randomUUID(),
      agentId: input.agentId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.title ? { title: input.title } : {}),
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };
    fs.mkdirSync(this.dirOf(record.id), { recursive: true });
    fs.writeFileSync(this.fileOf(record.id), JSON.stringify(record, null, 2), 'utf8');
    log.info(`已创建独立会话 ${record.id}（agent=${record.agentId}${record.model ? ', model 覆盖' : ''}）`);
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

  /** 更新标题 */
  rename(sessionId: string, title: string): SingleSessionInfo {
    const record = this.readRecord(sessionId);
    if (!record) throw new Error(`独立会话 "${sessionId}" 不存在`);
    record.title = title;
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.fileOf(sessionId), JSON.stringify(record, null, 2), 'utf8');
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
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActivity,
    };
  }
}
