// ============================================================
// ac-agent-store/src/service.ts —— Agent 数据目录 owning 服务
//
// ADR-5：Agent 数据目录（<root>/agents/<id>/）的一切写入归本服务——
// 消灭 src 的跨域越权写（教训：timer 直写 config.json、read_agent_info
// 直读 memory 文件）。其他域（M12 ac-timer 的条目、M14 ac-skill 清单）
// 一律经 saveEntry/readEntry 走本服务，不触碰文件。
//
// 目录布局（ADR-5：会话键统一 conversationId 思想的同款推广——
// 目录名即 Agent id，无排序/前缀魔法）：
//   <root>/agents/<id>/config.json   AgentConfig 全量
//   <root>/agents/<id>/<key>.json    机制数据 entry（timer/skills/...）
//   <root>/agents/<id>/AGENT.md 等   文档实体（M14 唯一写口：persona 等）
//
// 写入原子性：临时文件 + rename（继承 timer 状态文件模式）。
// 本服务零运行时依赖（AgentConfig 仅 type-import 自 ac-agents）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import type { AgentConfig } from 'ac-agents';

/** 原子写 JSON：临时文件 + rename（各 owning service 自持写法——不跨域引实现） */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
}

/** 行配置 */
export interface AgentStoreRowOptions {
  /** 数据根目录（缺省 './data'，相对 cwd；Agent 目录 = <root>/agents） */
  root?: string;
}

/** entry key 校验：param-case 词，禁路径分隔/遍历 */
function assertEntryKey(key: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(key)) {
    throw new Error(`entry key "${key}" 非法（须 param-case，如 'timer'）`);
  }
}

/** Agent id 校验：禁路径分隔/遍历 */
function assertAgentId(id: string): void {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('~')) {
    throw new Error(`agent id "${id}" 非法（禁路径分隔/遍历字符）`);
  }
}

/** 文档名校验：单词 .md 文件名（AGENT.md/SYSTEM.md 等），禁路径分隔/遍历 */
function assertDocName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/i.test(name)) {
    throw new Error(`文档名 "${name}" 非法（须单词 .md 文件名，如 'AGENT.md'）`);
  }
}

export class AgentStoreService extends Service {
  private agentsDir: string;

  constructor(ctx: Context, options: AgentStoreRowOptions = {}) {
    super(ctx, 'agentStore');
    this.agentsDir = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'agents');
  }

  /** Agent 数据目录根（诊断用） */
  get root(): string {
    return this.agentsDir;
  }

  /** 某 Agent 的数据目录 */
  agentDir(id: string): string {
    assertAgentId(id);
    return path.join(this.agentsDir, id);
  }

  // ---- AgentConfig ----

  /** 保存 Agent 配置（全量；原子写 config.json） */
  saveAgent(config: AgentConfig): void {
    assertAgentId(config.id);
    writeJsonAtomic(this.configFile(config.id), config);
  }

  /**
   * 读 Agent 配置（缺失/损坏 → undefined）。
   * M24 X1 双读归一边界（唯一落点——agents-dir/管理面/预设 skip-if-present
   * 全部经本方法读盘）：旧 `hooks` 键读取时归一为 `settings`（类型层之下；
   * 两者同给时新键优先），其余一切读取点由编译器暴露。写侧（saveAgent）
   * 只写新键——回写后旧键自然消失。
   */
  getAgent(id: string): AgentConfig | undefined {
    const raw = this.readJsonFile<AgentConfig & { hooks?: Record<string, unknown> }>(this.configFile(id));
    if (raw === undefined) return undefined;
    if (raw.hooks !== undefined) {
      const { hooks, ...rest } = raw;
      return { ...rest, settings: rest.settings ?? hooks } as AgentConfig;
    }
    return raw;
  }

  /** 全部已物化的 Agent 配置（目录扫描） */
  listAgents(): AgentConfig[] {
    return this.agentIds()
      .map((id) => this.getAgent(id))
      .filter((c): c is AgentConfig => c !== undefined);
  }

  /** 全部 Agent id（有目录即算，config 损坏的 id 也列出供诊断） */
  agentIds(): string[] {
    try {
      return fs
        .readdirSync(this.agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return []; // 目录不存在
    }
  }

  /**
   * 删除 Agent 数据目录（含 entries；会话文件归 ac-session，不在此列）。
   * @returns false = 无此 Agent
   */
  removeAgent(id: string): boolean {
    const dir = this.agentDir(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // ---- 机制数据 entries（timer/skills 等；本服务是唯一写口）----

  /** 保存 entry（<agentDir>/<key>.json，原子写） */
  saveEntry<T>(agentId: string, key: string, data: T): void {
    assertEntryKey(key);
    writeJsonAtomic(this.entryFile(agentId, key), data);
  }

  /** 读 entry（缺失/损坏 → undefined） */
  readEntry<T>(agentId: string, key: string): T | undefined {
    assertEntryKey(key);
    return this.readJsonFile<T>(this.entryFile(agentId, key));
  }

  /** 删除 entry */
  removeEntry(agentId: string, key: string): boolean {
    assertEntryKey(key);
    const file = this.entryFile(agentId, key);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  /** 某 Agent 的全部 entry key 名 */
  entryKeys(agentId: string): string[] {
    const dir = this.agentDir(agentId);
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== 'config.json')
        .map((e) => e.name.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  // ---- 文档（AGENT.md/SYSTEM.md 等 Markdown 实体；M14 唯一写口） ----

  /**
   * 保存文档（<agentDir>/<name>，原子写）。内容原样保存——frontmatter
   * 剥离等消费侧语义归消费方（ac-persona 等），本服务只管字节。
   */
  saveDoc(agentId: string, name: string, content: string): void {
    assertDocName(name);
    const file = path.join(this.agentDir(agentId), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    fs.renameSync(tmp, file);
  }

  /** 读文档（缺失 → undefined；内容原样含 frontmatter） */
  readDoc(agentId: string, name: string): string | undefined {
    assertDocName(name);
    try {
      const file = path.join(this.agentDir(agentId), name);
      if (!fs.existsSync(file)) return undefined;
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return undefined;
    }
  }

  /** 删除文档；false = 无此文档 */
  removeDoc(agentId: string, name: string): boolean {
    assertDocName(name);
    const file = path.join(this.agentDir(agentId), name);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  // ---- 头像（M17-E：Agent 数据目录内二进制；本服务 owning） ----

  /** 存头像（<agentDir>/avatar<ext>；写新前清理旧扩展名残留） */
  saveAvatar(agentId: string, data: Buffer, ext: string): string {
    const safe = /^\.(png|jpe?g|gif|webp|svg)$/i.exec(ext)?.[0] ?? '.png';
    const dir = this.agentDir(agentId);
    fs.mkdirSync(dir, { recursive: true });
    for (const old of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']) {
      const f = path.join(dir, `avatar${old}`);
      if (old !== safe && fs.existsSync(f)) fs.rmSync(f);
    }
    const file = path.join(dir, `avatar${safe}`);
    fs.writeFileSync(file, data);
    return file;
  }

  /** 头像文件路径（不存在 → undefined） */
  avatarPath(agentId: string): string | undefined {
    const dir = this.agentDir(agentId);
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']) {
      const f = path.join(dir, `avatar${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }

  /** 删头像；false = 无头像 */
  removeAvatar(agentId: string): boolean {
    const file = this.avatarPath(agentId);
    if (!file) return false;
    fs.rmSync(file);
    return true;
  }

  // ---- 内部 ----

  private configFile(id: string): string {
    return path.join(this.agentDir(id), 'config.json');
  }

  private entryFile(id: string, key: string): string {
    return path.join(this.agentDir(id), `${key}.json`);
  }

  private readJsonFile<T>(file: string): T | undefined {
    try {
      if (!fs.existsSync(file)) return undefined;
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
    } catch {
      return undefined;
    }
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** Agent 数据目录 owning 服务（ac-agent-store 提供）：config + 机制 entries 唯一写口 */
    agentStore: AgentStoreService;
  }
}
