// ============================================================
// agents-row.ts —— 宿主 agents 行（cr-540；行集清单 R1「身份编辑面」
// 改造落地：config / entries / 文档唯一写口 + 模板目录）
//
// 裁决簿〈注册表解体〉：活注册表退役——配置轴 = agents/<id>/ 文件文集
//（文件即注册），在场轴 = guardian 可达表（监护编排件，非本行）。本行 =
// 该文件文集的唯一写口，吸收主线 agent-store 写引擎 + agents-dir 布局 +
// agent-presets 目录三件事；读面单源 = ac-agents-core（tree.ts/config.ts）。
//
// agents/<id>/ 布局（D4.1 + 授权草稿 A 节）：
//   config.json          AgentConfig（身份全量）
//   auth.json            per-agent 授权层（auth-registry 行写者面——本行不碰）
//   entries/<key>.json   机制数据（timer / timer-archive / goal …）
//   <NAME>.md            文档实体（AGENT.md 等）
//   avatar.<ext>         头像
//   sessions/<uuid>/…    账本（壳写）；children/<cid>/…  子树（subagent 物化）
//                        —— 后两者不在本行写权内
//
// 写入原子性：临时文件 + rename（继承主线 agent-store 口径）。读面零归一：
// 开发期零兼容（R-10）——旧键（hooks/conductor 等）不在此翻译，归 cutover
// 导入脚本（8.7 B 段）一次处理。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import {
  agentDir,
  assertAgentId,
  listAgentIds,
  readAgentConfig,
  writeAgentConfig,
  type AgentConfig,
} from 'ac-agents-core';
import { listTemplates, readTemplate, type AgentTemplate } from './preset-builtin.ts';

/** 行配置 */
export interface AgentsHostRowOptions {
  dataRoot: string;
  /** 内置模板目录（preset-builtin 行在集时由宿主 boot 注入；缺席 = 模板面不可用） */
  templatesDir?: string;
}

/** entries 键词法（机制数据 param-case——禁路径分隔/遍历） */
const ENTRY_KEY = /^[a-z][a-z0-9-]*$/;
/** 文档名词法（单词 .md 文件名——禁路径分隔/遍历） */
const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/i;
/** 头像扩展名（写入口径与探测口径同源） */
const AVATAR_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'] as const;

/** 头像内容类型（扩展名闭集——saveAvatar 归一后只有这五种） */
const AVATAR_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** 头像路径（纯函数——web 名册 hasAvatar/avatarVersion 与 avatar HTTP 静态面共用） */
export function avatarPathOf(dataRoot: string, id: string): string | undefined {
  const dir = agentDir(dataRoot, id);
  for (const ext of AVATAR_EXTS) {
    const file = path.join(dir, `avatar${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/** 头像内容类型猜测（扩展名闭集专用——ac-workspace guessContentType 的头像子集） */
export function avatarContentType(file: string): string {
  return AVATAR_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 原子写文本（临时文件 + rename——同主线 agent-store 口径） */
function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);
}

/** 原子写 JSON（2 空格缩进 + 尾换行） */
function writeJsonAtomic(file: string, data: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * 宿主 agents 行服务：身份编辑面唯一写口（服务键 'agents'——壳侧同名垫片
 * 是只读面，两者分属不同进程；cutover 后由本行接管主线注册表键）。
 */
export class AgentsEditService extends Service {
  private readonly dataRoot: string;
  private readonly templatesDir: string | undefined;

  constructor(ctx: Context, options: AgentsHostRowOptions) {
    super(ctx, 'agents');
    this.dataRoot = path.resolve(options.dataRoot);
    this.templatesDir = options.templatesDir;
  }

  /** 某 Agent 的数据目录（agents-core 路径 + 词法防线单源） */
  agentDirOf(id: string): string {
    return agentDir(this.dataRoot, id);
  }

  // ---- 配置轴（文件即注册） ----

  /** 读身份（缺席/损坏 = undefined；树内 id 不一致视同损坏） */
  getAgent(id: string): AgentConfig | undefined {
    return readAgentConfig(this.dataRoot, id) ?? undefined;
  }

  /** 身份在场判定（主线 ctx.agents.has 契约面——usage 等沿用行按它区分
   *  Agent/端点；cr-567 补：缺此方法 ac-usage 的 byAgent/byPair 直接抛 TypeError） */
  has(id: string): boolean {
    return readAgentConfig(this.dataRoot, id) !== null;
  }

  /** 全部身份配置（目录扫描；config 损坏的 id 不入清单，见 agentIds） */
  listAgents(): AgentConfig[] {
    return this.agentIds().map((id) => this.getAgent(id)).filter((c): c is AgentConfig => c !== undefined);
  }

  /** 全部身份 id（有目录即算——config 损坏也列出供诊断） */
  agentIds(): string[] {
    return listAgentIds(this.dataRoot);
  }

  /** 写身份（全量；原子写 config.json） */
  saveAgent(config: AgentConfig): void {
    writeAgentConfig(this.dataRoot, config);
  }

  /**
   * 删身份 = 删整棵 agents/<id>/ 树（含 entries / 文档 / 头像 / 账本 /
   * children——父删除级联杀子是 agents 树自含语义的既定面）。false = 无此身份。
   */
  removeAgent(id: string): boolean {
    const dir = this.agentDirOf(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // ---- 机制数据 entries（<agentDir>/entries/<key>.json） ----

  saveEntry(id: string, key: string, data: unknown): void {
    assertEntryKey(key);
    writeJsonAtomic(this.entryFile(id, key), data);
  }

  readEntry<T>(id: string, key: string): T | undefined {
    assertEntryKey(key);
    try {
      return JSON.parse(fs.readFileSync(this.entryFile(id, key), 'utf-8')) as T;
    } catch {
      return undefined;
    }
  }

  removeEntry(id: string, key: string): boolean {
    assertEntryKey(key);
    const file = this.entryFile(id, key);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  /** 某身份的 entry 键清单（目录扫描；缺席 = 空表） */
  entryKeys(id: string): string[] {
    const dir = this.entriesDir(id);
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name.slice(0, -'.json'.length))
        .sort();
    } catch {
      return [];
    }
  }

  // ---- 文档（AGENT.md 等 Markdown 实体——唯一写口） ----

  /** 写文档（内容尾换行归一；frontmatter 剥离等语义归消费方） */
  saveDoc(id: string, name: string, content: string): void {
    assertDocName(name);
    writeTextAtomic(path.join(this.agentDirOf(id), name), content.endsWith('\n') ? content : `${content}\n`);
  }

  /** 读文档（原样含 frontmatter；缺席 = undefined） */
  readDoc(id: string, name: string): string | undefined {
    assertDocName(name);
    try {
      return fs.readFileSync(path.join(this.agentDirOf(id), name), 'utf-8');
    } catch {
      return undefined;
    }
  }

  /** 删文档；false = 无此文档 */
  removeDoc(id: string, name: string): boolean {
    assertDocName(name);
    const file = path.join(this.agentDirOf(id), name);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  // ---- 头像（数据目录内二进制） ----

  /** 存头像（<agentDir>/avatar<ext>；写新前清理旧扩展名残留——大小写不敏感） */
  saveAvatar(id: string, data: Buffer, ext: string): string {
    const safe = /\.(png|jpe?g|gif|webp|svg)$/i.exec(ext)?.[0].toLowerCase() ?? '.png';
    const dir = this.agentDirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const old of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (/^avatar\.(png|jpe?g|gif|webp|svg)$/i.test(old) && old.toLowerCase() !== `avatar${safe}`) {
        fs.rmSync(path.join(dir, old));
      }
    }
    const file = path.join(dir, `avatar${safe}`);
    fs.writeFileSync(file, data);
    return file;
  }

  /** 头像路径（不存在 = undefined） */
  avatarPath(id: string): string | undefined {
    return avatarPathOf(this.dataRoot, id);
  }

  /** 删头像；false = 无头像 */
  removeAvatar(id: string): boolean {
    const file = this.avatarPath(id);
    if (file === undefined) return false;
    fs.rmSync(file);
    return true;
  }

  // ---- 模板面（preset-builtin 行在集时可用——直读静态配置集） ----

  /** 内置模板清单（行不在集 = 空表——良定义降级） */
  templates(): AgentTemplate[] {
    return this.templatesDir === undefined ? [] : listTemplates(this.templatesDir);
  }

  /**
   * 从模板创建身份（create-from-template）：一步写全 config 文集。
   * skip-if-present（用户数据优先的文件版语义）：已存在 config.json 不覆盖，
   * 原样返回现值——重入幂等，不吞掉用户编辑。
   */
  createFromTemplate(templateId: string, id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
    const existing = this.getAgent(id);
    if (existing !== undefined) return existing;
    const config = this.templateConfigOf(templateId, id, overrides);
    this.saveAgent(config);
    return config;
  }

  /**
   * transient boot 合成：宿主从模板合成身份（argv 传临时壳，账本住
   * sessions/<uuid> 不落 agents/ 树）——纯合成不落盘。
   */
  transientConfigOf(templateId: string, id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
    return this.templateConfigOf(templateId, id, overrides);
  }

  // ---- 内部 ----

  /** 模板 → 身份：剥 preset 标志与模板自身 id（创建物是真实身份，非预设名册条目） */
  private templateConfigOf(templateId: string, id: string, overrides: Partial<AgentConfig>): AgentConfig {
    if (this.templatesDir === undefined) {
      throw new Error('模板面不可用：行集无 preset-builtin 行');
    }
    assertAgentId(id);
    const template = readTemplate(templateId, this.templatesDir);
    if (template === undefined) throw new Error(`模板不存在：${templateId}`);
    const { preset: _preset, id: _templateId, ...body } = template.config;
    return { ...body, ...overrides, id };
  }

  private entriesDir(id: string): string {
    return path.join(this.agentDirOf(id), 'entries');
  }

  private entryFile(id: string, key: string): string {
    return path.join(this.entriesDir(id), `${key}.json`);
  }
}

/** entries 键词法闸（fail-loud：非法键=写错域，不静默兜底） */
function assertEntryKey(key: string): void {
  if (!ENTRY_KEY.test(key)) {
    throw new Error(`entry key "${key}" 非法（须 param-case，如 'timer'）`);
  }
}

/** 文档名词法闸（fail-loud） */
function assertDocName(name: string): void {
  if (!DOC_NAME.test(name)) {
    throw new Error(`文档名 "${name}" 非法（须单词 .md 文件名，如 'AGENT.md'）`);
  }
}

/**
 * 宿主 agents 行工厂（服务实例经构造器捕获——同 fiber 自注册场景不依赖
 * ctx.agents getter）。capture = 装配方取实例引用面（timers 行 entries
 * 单写者注入——cr-551；可选，缺省无副作用）。
 */
export function makeAgentsHostRow(
  options: AgentsHostRowOptions,
  capture?: (svc: AgentsEditService) => void,
): Plugin {
  return {
    name: 'host-agents-row',
    inject: [],
    apply(ctx: Context) {
      ctx.plugin(class extends AgentsEditService {
        constructor(c: Context) { super(c, options); capture?.(this); }
      });
    },
  };
}
