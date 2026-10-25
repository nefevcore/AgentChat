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
export class AgentsShim extends Service {
  private dataRoot: string;
  /** 行 id → 工具名投影（cr-593）：AgentConfig.rows 盘上词形是行 id，
   * 主线消费面（collab list_tools / read_agent_info 等按 config.rows
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
    const rows = config.rows;
    if (Array.isArray(rows)) return { ...config, rows: this.expandTokens(rows) };
    if (typeof rows === 'object') {
      return {
        ...config,
        rows: {
          ...(rows.include !== undefined ? { include: this.expandTokens(rows.include) } : {}),
          ...(rows.exclude !== undefined ? { exclude: this.expandTokens(rows.exclude) } : {}),
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
export class WorkspaceShim extends Service {
  private dataRoot: string;
  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'workspace');
    this.dataRoot = dataRoot;
  }

  get root(): string {
    return this.dataRoot;
  }

  /** Agent 专用空间（主线 files/<agentId> 同构——fs 工具沙箱基准） */
  sandboxWorkdir(agentId?: string, conversationId?: string): string {
    // 会话挂载工作区最优先（主线 ac-workspace 同语义：挂载即基准——
    // bash cwd / 相对路径锚随会话指向工作区根，cr-614）
    const wsRoot = this.conversationWorkspaceRoot(conversationId);
    if (wsRoot !== null) return wsRoot;
    if (agentId === undefined) return this.dataRoot;
    return path.join(this.dataRoot, 'files', agentId);
  }

  agentWorkdir(agentId?: string): string {
    return this.sandboxWorkdir(agentId);
  }

  /**
   * 沙箱允许根并出面（主线 ac-workspace.sandboxAllowedPaths 同语义，
   * cr-614）：settings['security'].allowedPaths ∪ 会话挂载工作区根。
   * 此前缺席 = 工具行 createAgentSandboxCache 拿不到任何授予——
   * 「连工作区所在位置都越界」的根因（登记了工作区、会话挂了
   * workspaceId，沙箱消费面断链）。
   */
  sandboxAllowedPaths(agentId: string | undefined, conversationId?: string): string[] {
    const out: string[] = [];
    if (agentId !== undefined) {
      const agents = this.ctx.get('agents', false) as
        | { settingsOf(id: string, name?: string): unknown }
        | undefined;
      const security = agents?.settingsOf(agentId, 'security');
      const v = security !== undefined && security !== null && typeof security === 'object'
        ? (security as { allowedPaths?: unknown }).allowedPaths
        : undefined;
      if (Array.isArray(v)) out.push(...v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0));
    }
    const wsRoot = this.conversationWorkspaceRoot(conversationId);
    if (wsRoot !== null) out.push(wsRoot);
    return [...new Set(out)];
  }

  /**
   * 会话挂载工作区根（主线 ac-workspace 同链路）：viewer/sessions/
   * <id>/session.json 的 workspaceId → workspaces.json 路径。两处盘上
   * 布局 = 宿主侧 owning 写者（ac-host-rows workspaces.ts / singles-row）
   * ——主线 ac-workspace 同布局，冻结词形。
   */
  conversationWorkspaceRoot(conversationId: string | undefined): string | null {
    if (conversationId === undefined || conversationId === '') return null;
    if (conversationId.includes('/') || conversationId.includes('\\') || conversationId.includes('..')) return null;
    let wsId: string | undefined;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(
        path.join(this.dataRoot, 'viewer', 'sessions', conversationId, 'session.json'), 'utf-8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const v = (raw as { workspaceId?: unknown }).workspaceId;
        if (typeof v === 'string' && v !== '') wsId = v;
      }
    } catch { /* 缺席/损坏 = 未挂载 */ }
    if (wsId === undefined) return null;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(this.dataRoot, 'workspaces.json'), 'utf-8'));
      // cr-627：盘上形态 = 宿主 owning 写者（ac-host-rows workspaces.ts——顶层
      // 数组）；旧测试数据的 {workspaces:[...]} 包装形态一并兼容（读面宽进）。
      const list = Array.isArray(raw)
        ? raw
        : raw !== null && typeof raw === 'object'
          ? (raw as { workspaces?: unknown }).workspaces
          : undefined;
      if (Array.isArray(list)) {
        for (const w of list) {
          if (w !== null && typeof w === 'object' && !Array.isArray(w)
            && (w as { id?: unknown }).id === wsId
            && typeof (w as { path?: unknown }).path === 'string') {
            return (w as { path: string }).path;
          }
        }
      }
    } catch { /* 缺席/损坏 = 未挂载 */ }
    return null;
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

/** ctx.session 最小面（主线消费口 = session.recordContext：ask-questions
 * 作答注入〔已收到用户回答〕/ 未响应通知等 context 材料落账 + 事件）。
 * 垫片 = 主线服务词汇 → 壳侧 conversation 服务 recordContext 的转发边界
 *（cr-625；落账/发射 owning = ConversationService——机器知 currentRun）。 */
export class SessionShim extends Service {
  constructor(ctx: Context) {
    super(ctx, 'session');
  }

  recordContext(
    conversationId: string,
    _agentId: string,
    content: string,
    extra: { source: string; label?: string },
  ): void {
    const conversation = this.ctx.get('conversation', false) as
      { recordContext(conversationId: string, content: string, extra: { source: string; label?: string; injectionId?: string }): Promise<void> } | undefined;
    if (conversation === undefined) return; // 会话行未装——降级不阻断（主线同语义）
    void conversation.recordContext(conversationId, content, extra).catch(() => {
      // 落账失败不阻断注入链（run 内消息已就位）——事件面仍发（直播行不丢）
    });
  }
}

/**
 * 数据根直读垫片行工厂（cordis Plugin——boot 装配进壳树，提供 agents /
 * agentStore / credentials / workspace / convSettings / session 六服务）。
 * 不进行集目录（非能力行——接缝件，归 boot 编排）。
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
      ctx.plugin(class extends SessionShim {
        constructor(c: Context) { super(c); }
      });
    },
  } satisfies Plugin;
}
