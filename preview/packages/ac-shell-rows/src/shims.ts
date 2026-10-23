// ============================================================
// shims.ts —— 数据根直读垫片行（M8.1 第一批 cr-519 + 第二批 cr-520 扩 credentials/workspace）
//
// 裁决簿〈注册表解体〉：活注册表退役，配置轴 = agents/<id>/ 文件文集，
// 壳 per-run 直读。沿用行（persona/datetime/goal/todo…）消费的
// ctx.agents / ctx.agentStore 服务面在本垫片以数据根直读实现——同一
// agents/ 树、与 ac-agent-store 同布局（ADR-5），主线行代码零改动。
// cutover 时垫片随主线行退役回收（8.9）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { readAgentConfig, settingsOf, deepMerge } from 'ac-agents-core';
import { readCredential, credentialKey, deriveKey, machineMaterial, GLOBAL_AGENT_ID } from 'ac-credentials-core';

/** ctx.agents 最小面（沿用行消费口：get / settingsOf / ids / list） */
class AgentsShim extends Service {
  private dataRoot: string;
  /** 行 id → 工具名投影（cr-593）：AgentConfig.tools 盘上词形是行 id，
   * 主线消费面（collab list_tools / read_agent_info 等按 config.tools
   * 过滤注册工具名）拿原词形 = 词形断裂（行 id 落空、恰同名者幸存）。
   * 垫片 = 盘上词汇 → 主线服务词汇的翻译边界（与 conversation 服务
   * toolFaceOf 同展开语义；缺席 = 无目录投影，原样透传）。 */
  private rowTools: Record<string, string[]> | undefined;
  constructor(ctx: Context, dataRoot: string, rowTools?: Record<string, string[]>) {
    super(ctx, 'agents');
    this.dataRoot = dataRoot;
    this.rowTools = rowTools;
  }

  /** 条目词形展开：行 id → 行工具名（保序去重；非行 id 原样） */
  private expandTokens(tokens: string[]): string[] {
    return [...new Set(tokens.flatMap((token) => this.rowTools?.[token] ?? [token]))];
  }

  get(id: string) {
    const config = readAgentConfig(this.dataRoot, id) ?? undefined;
    if (config === undefined || this.rowTools === undefined) return config;
    const tools = config.tools;
    if (Array.isArray(tools)) return { ...config, tools: this.expandTokens(tools) };
    if (typeof tools === 'object') {
      return {
        ...config,
        tools: {
          ...(tools.include !== undefined ? { include: this.expandTokens(tools.include) } : {}),
          ...(tools.exclude !== undefined ? { exclude: this.expandTokens(tools.exclude) } : {}),
        },
      };
    }
    return config;
  }

  settingsOf(id: string, name?: string) {
    const agent = this.get(id);
    if (name === undefined) {
      return deepMerge({}, agent?.settings ?? {});
    }
    return settingsOf(undefined, agent?.settings, name);
  }

  ids(): string[] {
    const dir = path.join(this.dataRoot, 'agents');
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  /** 主线 AgentsService.list 面（collab-tools list_agents 消费——全量配置数组） */
  list(): unknown[] {
    return this.ids().map((id) => this.get(id)).filter((c) => c !== undefined);
  }
}

/** ctx.agentStore 最小面（goal/todo entry 持久化 + persona 文档读口） */
class AgentStoreShim extends Service {
  private dataRoot: string;
  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'agentStore');
    this.dataRoot = dataRoot;
  }

  private agentDir(id: string): string {
    return path.join(this.dataRoot, 'agents', id);
  }

  // entries 布局单源（cr-540）：机制数据住 agents/<id>/entries/<key>.json，
  // 与宿主 agents 编辑面同路径——两写者不得分家（扁平原文件形态已退役）。
  readEntry<T>(id: string, key: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.entryFile(id, key), 'utf-8')) as T;
    } catch {
      return undefined;
    }
  }

  saveEntry(id: string, key: string, data: unknown): void {
    const file = this.entryFile(id, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, file);
  }

  private entryFile(id: string, key: string): string {
    return path.join(this.agentDir(id), 'entries', key + '.json');
  }

  /** persona file 语义的文档读口（AGENTS.md 优先、AGENT.md 回退——主线同款双名） */
  readDoc(id: string, name: string): string | undefined {
    try {
      return fs.readFileSync(path.join(this.agentDir(id), name), 'utf-8');
    } catch {
      return undefined;
    }
  }
}

/**
 * ctx.credentials 垫片（R-11 ③：凭据库数据根直读，物理单副本）。
 * 主线消费面（issue-tools / sap-adt / llm-pool 凭据注入链）以服务方法
 * 消费：resolve(agentId, provider) / getGlobal(provider)。本垫片按
 * ac-credentials-core 引用制实现——key 形 <agentId>_<provider>_API_KEY
 * / __global__ 前缀由 credentialKey 单源铸造（主线服务同源词汇）。
 * 每调用现读（每 run 前重读语义——不缓存；条目缺席 = ''）。
 */
class CredentialsShim extends Service {
  private dataRoot: string;
  private key: Buffer;

  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'credentials');
    this.dataRoot = dataRoot;
    this.key = deriveKey(machineMaterial());
  }
  getGlobal(provider: string): string {
    return this.read(credentialKey(GLOBAL_AGENT_ID, provider));
  }

  get(agentId: string, provider: string): string {
    return this.read(credentialKey(agentId, provider));
  }

  resolve(agentId: string, provider: string): string {
    return this.get(agentId, provider) || this.getGlobal(provider);
  }

  private read(name: string): string {
    try {
      return readCredential(this.dataRoot, this.key, name) ?? '';
    } catch {
      return '';
    }
  }
}

/**
 * ctx.workspace 垫片（数据根隔离红线收口）：沿用行里锚数据根的消费面
 *（sap-adt 工作区 / mcp 清单文件 / browser profile / fs 工具沙箱基准）
 * 都走 ctx.get('workspace')——主线由 ac-workspace 行提供，preview 壳暂无
 * 该行，垫片给最小面：root + sandboxWorkdir（Agent 专用空间语义，主线
 * files/<id> 同构）+ agentWorkdir。缺席时这些行会回落 ./data（cwd 相对）
 * ——preview 数据根隔离红线不可容。
 */
class WorkspaceShim extends Service {
  private dataRoot: string;
  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'workspace');
    this.dataRoot = dataRoot;
  }

  get root(): string {
    return this.dataRoot;
  }

  /** Agent 专用空间（主线 files/<agentId> 同构——fs 工具沙箱基准） */
  sandboxWorkdir(agentId?: string): string {
    if (agentId === undefined) return this.dataRoot;
    return path.join(this.dataRoot, 'files', agentId);
  }

  agentWorkdir(agentId?: string): string {
    return this.sandboxWorkdir(agentId);
  }
}

/**
 * ctx.convSettings 垫片（cr-565：会话级覆盖改树入宿主后的壳侧只读面）。
 *
 * 写面单源 = 宿主 conv-settings 行（web RPC：输入框模型菜单/设置面板），
 * 壳只读直取同一数据目录（<dataRoot>/conv-settings/<conversationId>.json
 * ——物理单副本，credentials 垫片同款 R-11 ③ 形态）。现读不缓存
 *（每 run 前重读语义）。
 *
 * 键注册面（registerKey/listKeys）住本垫片：主线「注册即归属」的扩展键
 *（如 harness-tools 的 harnessTier）由壳内扩展行自持，壳不写盘。
 * 回读不做枚举校验——写侧由宿主服务单源把关（同一数据目录，双校验无益）；
 * 已回收键的存量值因此仍可见，消费方按未知值回落即可。
 */
class ConvSettingsShim extends Service {
  private dataRoot: string;
  private keys = new Map<string, { key: string; enum?: string[]; description?: string }>();

  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'convSettings');
    this.dataRoot = dataRoot;
  }

  registerKey(def: { key: string; enum?: string[]; description?: string }): void {
    this.keys.set(def.key, def);
    // 注册即归属：扩展行卸载时键自动回收（主线 ConvSettingsService 同义）
    this.ctx.fiber.effect(() => () => this.keys.delete(def.key), 'convSettings.key:' + def.key);
  }

  listKeys(): Array<{ key: string; enum?: string[]; description?: string }> {
    return [...this.keys.values()];
  }

  get(conversationId: string): Record<string, string> {
    if (conversationId.includes('/') || conversationId.includes('\\') || conversationId.includes('..')) {
      throw new Error('conversationId "' + conversationId + '" 非法（禁路径分隔 / ..）');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(this.dataRoot, 'conv-settings', conversationId + '.json'), 'utf-8'));
    } catch {
      return {}; // 缺席/损坏 = 无覆盖
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
  }

  /** 壳侧无写权（D4 写者单源 = 宿主行）——静默吞掉会掩盖结构性越权，fail-loud */
  set(): never {
    throw new Error('convSettings 写面住宿主（conv-settings 行）——壳内不得写入会话覆盖');
  }
}

/**
 * 数据根直读垫片行工厂（cordis Plugin——boot 装配进壳树，提供 agents /
 * agentStore / credentials / workspace / convSettings 五服务）。不进行集
 * 目录（非能力行——接缝件，归 boot 编排）。
 */
export function makeShimsRow(dataRoot: string, rowTools?: Record<string, string[]>) {
  return {
    name: 'shell-data-root-shims',
    inject: [],
    apply(ctx: Context) {
      ctx.plugin(class extends AgentsShim {
        constructor(c: Context) { super(c, dataRoot, rowTools); }
      });
      ctx.plugin(class extends AgentStoreShim {
        constructor(c: Context) { super(c, dataRoot); }
      });
      ctx.plugin(class extends CredentialsShim {
        constructor(c: Context) { super(c, dataRoot); }
      });
      ctx.plugin(class extends WorkspaceShim {
        constructor(c: Context) { super(c, dataRoot); }
      });
      ctx.plugin(class extends ConvSettingsShim {
        constructor(c: Context) { super(c, dataRoot); }
      });
    },
  } satisfies Plugin;
}
