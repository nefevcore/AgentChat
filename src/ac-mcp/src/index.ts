// ============================================================
// ac-mcp —— MCP 服务行（ctx.mcp，M14）
//
// src 轨道映射（agent-mcp，地图 §3.2 形态重构）：
//   · 全局注册 + 懒建连（对齐 ac-llm 范式）：registerServer 只存
//     定义，首次消费（loop/before-run 触发的 sync）才建连发现；
//     连接缓存跨 run 复用
//   · 发现的工具注册进 ctx.tools（注册即归属：随 mcp 行卸载/服务器
//     移除自动回收）；撞名命名空间前缀（裸名 → `${server}__${name}`
//     回退——ac-mcp-core pickToolName）
//   · per-Agent 暴露走 AgentConfig.tools 白名单（loop 原生支持——
//     白名单不含 MCP 工具名即不暴露；include 不可绕过 requires 门禁）
//   · servers 放行清单分层（运行时动态加载，settingsOf 语义）：行
//     Config（cordis.yml/bootTree 基线）→ settings.mcp 全局默认层
//     （config.json，插件库弹窗）→ Agent 差异层（Agent 页弹窗；配置
//     即覆盖全局）。清单载体 = JSON 文件（`file` 字段，缺省数据根
//     mcp.json——文件存在即整体替换基线；弹窗配路径，复用 file 类型
//     的文件选取器）；差异层可指向自己的清单文件（可含池外服务器，
//     run 时懒注册懒建连）；暴露面按合成后的生效清单收敛（before-run
//     改写 request.tools：非 MCP 工具不动）
//   · clientFactory 注入口：测试假连接零网络零子进程
//
// 单服务器失败不炸行（warn + 跳过；下一 run 重试）。协议实现住
// ac-mcp-core 纯库（官方 SDK 包装）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import z from '@agentchat/schemastery';
import type { ToolDefinition } from 'ac-tools';
import {
  createSdkConnection,
  pickToolName,
  type McpConnectionFactory,
  type McpConnection,
  type McpServerConfig,
  type McpToolDef,
} from 'ac-mcp-core';

/** 缺省服务器清单文件名（相对路径锚定数据根；存在即整体替换行基线） */
const DEFAULT_SERVERS_FILE = 'mcp.json';

/** 服务器注册定义（Config.servers 单位；clientFactory 为测试注入面） */
export interface McpServerDef extends McpServerConfig {
  /** 连接工厂（缺省官方 SDK 包装；测试注入假实现） */
  clientFactory?: McpConnectionFactory;
}

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface McpRowOptions {
  /** 放行基线（settings.mcp 全局层 servers 未配置时的回落池） */
  servers?: McpServerDef[];
}

/** 服务器运行态 */
interface ServerEntry {
  def: McpServerDef;
  connection: McpConnection | null;
  /** 本服务器注册的工具 disposer（移除服务器/重发现时回收） */
  disposers: Array<() => void>;
  /** 本服务器注册的工具最终名（暴露面收敛判定 + teardown 定向回收） */
  toolNames: string[];
  synced: boolean;
}

export class McpService extends Service {
  private servers = new Map<string, ServerEntry>();
  /** 行 options（放行基线——全局层未配置 servers 时的回落值） */
  private options: McpRowOptions;
  /** 全局池定义（基线 ∪ settings.mcp 全局层；enabled 软停用不清定义——
   *  Agent 差异层 enabled:true 可复活重挂） */
  private poolDefs = new Map<string, McpServerDef>();
  /** 池内已注册的服务器名（对账撤/挂只动这些；Agent 差异层懒注册的服务器
   *  与程序化 registerServer 不在被回收面——池想要时可收编进 managed） */
  private managed = new Set<string>();
  /** 已注册 MCP 工具名 → 服务器名（per-Agent 暴露面收敛判定） */
  private toolServers = new Map<string, string>();

  constructor(ctx: Context, options: McpRowOptions = {}) {
    super(ctx, 'mcp');
    this.options = options;
    for (const def of options.servers ?? []) {
      this.registerServer(def); // 基线层非法/重名 = 装配错误，fail-loud（行 FAILED）
      this.managed.add(def.name);
      this.poolDefs.set(def.name, def);
    }

    // 懒建连 + per-Agent 暴露面收敛（首个 run 前完成发现与注册，此后复用）；
    // sync 前先对账（boot 期吸收 settings.mcp 现值——config/changed 错过更早写入）
    this.ctx.on('loop/before-run', (call, next) => this.prepareRun(call.request).then(() => next(), () => next()), { description: 'MCP 懒建连 + 工具发现注册 + per-Agent 暴露面收敛' });
    // 配置热更：settings.mcp 变更 → 对账（撤/挂/热替换；config/set 热通路）
    this.ctx.on('config/changed', () => this.reconcile(), { description: 'MCP 服务器清单热更对账（settings.mcp 全局层）' });
    this.reconcile();
  }

  /**
   * 注册服务器（fiber 归属：调用方行卸载时自动回收连接与已注册工具；
   * 重名抛错）。注册不建连——首次 sync 才连接（懒建连）。
   */
  registerServer(def: McpServerDef) {
    if (!def.name) throw new Error('MCP 服务器注册缺少 name');
    if (this.servers.has(def.name)) throw new Error(`MCP 服务器 "${def.name}" 已注册`);
    const entry: ServerEntry = { def, connection: null, disposers: [], toolNames: [], synced: false };
    return this.ctx.fiber.effect(() => {
      this.servers.set(def.name, entry);
      return () => {
        this.teardown(entry);
        this.servers.delete(def.name);
      };
    }, `mcp.registerServer(${def.name})`);
  }

  /** 手动移除服务器（关闭连接 + 回收已注册工具） */
  removeServer(name: string): boolean {
    const entry = this.servers.get(name);
    if (!entry) return false;
    this.teardown(entry);
    this.servers.delete(name);
    return true;
  }

  /** 重读清单文件并对账（不建连——管理面/测试入口；run 路径自动走 sync 前对账） */
  reload(): void {
    this.reconcile();
  }

  /** 服务器清单概览（诊断/管理面） */
  listServers(): Array<{ name: string; enabled: boolean; connected: boolean; toolCount: number }> {
    return [...this.servers.values()].map((e) => ({
      name: e.def.name,
      enabled: e.def.enabled !== false,
      connected: e.connection?.connected === true,
      toolCount: e.disposers.length,
    }));
  }

  /**
   * 发现并注册全部 enabled 服务器的工具（幂等：已 synced 跳过；
   * force = 断开重连重发现）。单服务器失败 warn 不炸。
   */
  async sync(options: { force?: boolean } = {}): Promise<void> {
    this.reconcile(); // 配置层对账（settings.mcp——便宜：内存读 + 名集 diff）
    for (const entry of this.servers.values()) {
      if (entry.def.enabled === false) continue;
      if (entry.synced && !options.force) continue;
      if (options.force) this.teardown(entry);
      try {
        await this.syncServer(entry);
      } catch (err: unknown) {
        this.ctx.logger.warn(`[mcp] 服务器 "${entry.def.name}" 同步失败: ${String(err)}`);
        this.teardown(entry); // 失败回收半注册状态（下一 run 重试）
      }
    }
  }

  private async syncServer(entry: ServerEntry): Promise<void> {
    if (!entry.connection) {
      const factory = entry.def.clientFactory ?? createSdkConnection;
      entry.connection = factory(entry.def);
    }
    const connection = entry.connection;
    if (!connection.connected) await connection.connect();

    const tools = await connection.listTools();
    // 撞名判定基准：当前已注册工具名 + 服务器内置去重
    const toolsService = this.ctx.get('tools');
    if (!toolsService) return;
    const taken = new Set(toolsService.list().map((t) => t.name));

    for (const tool of tools) {
      const finalName = pickToolName(entry.def.name, tool.name, taken);
      if (finalName === null) {
        this.ctx.logger.warn(`[mcp] 工具名冲突跳过: ${entry.def.name}/${tool.name}`);
        continue;
      }
      taken.add(finalName);
      // 注册即归属：随当前 tracer fiber（mcp 行/调用方）回收；
      // disposer 同时记入服务器条目（手动移除/重发现时定向回收）
      const disposer = toolsService.register(this.buildToolDef(entry, connection, tool, finalName));
      entry.disposers.push(() => disposer?.());
      entry.toolNames.push(finalName);
      this.toolServers.set(finalName, entry.def.name);
    }
    entry.synced = true;
    this.ctx.logger.info(
      `[mcp] 服务器 "${entry.def.name}" 同步完成（${tools.length} 工具）`,
    );
  }

  private buildToolDef(
    entry: ServerEntry,
    connection: McpConnection,
    tool: McpToolDef,
    finalName: string,
  ): ToolDefinition {
    return {
      name: finalName,
      description: `[MCP:${entry.def.name}] ${tool.description ?? 'MCP 工具'}`,
      parameters: {
        type: 'object',
        properties: tool.inputSchema.properties ?? {},
        ...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}),
      },
      async execute(args) {
        // 工具体抛错由 ac-tools 统一收敛为 { ok:false, error }——只转换协议级错误
        const result = await connection.callTool(tool.name, args);
        // 协议级错误（isError）以工具失败形态回填——模型可读、可重试
        return result.isError
          ? { ok: false, error: result.text || `MCP 工具 "${tool.name}" 报错（无输出）` }
          : { ok: true, output: result.text };
      },
    };
  }

  /** 回收服务器资源：关闭连接 + 注销已注册工具 */
  private teardown(entry: ServerEntry): void {
    for (const dispose of entry.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 回收尽力而为 */
      }
    }
    for (const toolName of entry.toolNames.splice(0)) this.toolServers.delete(toolName);
    entry.connection?.close();
    entry.connection = null;
    entry.synced = false;
  }

  // ── 配置层（settings.mcp：全局默认层 + Agent 差异层，settingsOf 语义）──
  // 全局层对账进「池」（poolDefs/managed）；Agent 差异层在 run 时合成——
  // 配置了 per-Agent 即覆盖全局（数组整体替换），差异层定义的服务器懒注册
  // 懒建连（运行时动态加载）。组合无 config/agents 行时各自 no-op。

  /** 注册配置层服务器（settings 层来源——运行期输入 fail-soft：warn 跳过） */
  private addManaged(def: McpServerDef): void {
    try {
      this.registerServer(def);
      this.managed.add(def.name);
    } catch (err: unknown) {
      this.ctx.logger.warn(`[mcp] 配置层服务器 "${def.name}" 注册失败: ${String(err)}`);
    }
  }

  private removeManaged(name: string): void {
    if (this.removeServer(name)) this.managed.delete(name);
  }

  /**
   * 全局层对账（构造时 + config/changed + 每次 sync 前）：
   *   · 池定义纯派生 = 清单文件（`file`，缺省 mcp.json；文件存在即整体
   *     替换基线，缺失/非法回落基线）——文件每次现读，改动下一 run 生效；
   *   · `enabled === false` → 全局软停用：撤挂池内服务器（poolDefs 保留
   *     定义——Agent 差异层 enabled:true 的 run 会复活重挂）；
   *   · 同名定义变更 → 热替换（teardown 重注册，下次 sync 懒建连）；
   *   · 池想要的既有注册（差异层懒注册的/程序化的）收编进 managed。
   */
  private reconcile(): void {
    const config = this.ctx.get('config', false) as
      | { get<T>(key: string): T | undefined }
      | undefined;
    if (!config) return;
    const layer = config.get<Record<string, unknown>>('settings.mcp');
    if (layer !== undefined && (!layer || typeof layer !== 'object' || Array.isArray(layer))) {
      this.ctx.logger.warn('[mcp] settings.mcp 形状非法（保持现状）');
      return;
    }
    // 池定义纯派生：清单文件（`file`，缺省 mcp.json）——缺失回落基线、
    // 非法保持现状（不动 poolDefs）、正常即整体替换基线
    const file = this.readServersFile(layer?.file);
    if (file.status === 'invalid') return;
    const defs = file.status === 'ok' ? file.defs : undefined;
    this.poolDefs = new Map((defs ?? this.options.servers ?? []).map((d) => [d.name, d] as const));
    const next = layer?.enabled === false ? [] : [...this.poolDefs.values()];
    const want = new Map(next.map((d) => [d.name, d] as const));
    // 撤：不在期望集，或定义变更（撤了在下面重挂——懒建连重连新定义）
    for (const name of [...this.managed]) {
      const def = want.get(name);
      if (!def || !this.servers.get(name)) {
        this.removeManaged(name);
      } else if (JSON.stringify(this.servers.get(name)?.def) !== JSON.stringify(def)) {
        this.removeManaged(name);
      }
    }
    // 挂：期望集中未注册的；已注册但非管辖的收编（池想要即认领）
    for (const [name, def] of want) {
      if (this.servers.has(name)) {
        this.managed.add(name);
        continue;
      }
      this.addManaged(def);
    }
  }

  /**
   * 服务器清单文件读取（每次对账/收敛现读——文件是事实源，改动下一
   * run 生效，与 persona file 同款热语义）：
   *   · 内容 = `{ "servers": [...] }` 或裸数组；经行 Config schema 校验；
   *   · 相对路径锚定数据根（workspace.root——与文件选择器「数据根」
   *     快捷根一致），绝对路径原样；
   *   · 三态：ok（defs）/ missing（缺省名静默、显式名 warn——调用方回落
   *     基线）/ invalid（warn——调用方保持现状）。
   */
  private readServersFile(rawFile: unknown):
    | { status: 'ok'; defs: McpServerDef[] }
    | { status: 'missing' }
    | { status: 'invalid' } {
    const file =
      typeof rawFile === 'string' && rawFile.trim() !== ''
        ? rawFile.trim()
        : DEFAULT_SERVERS_FILE;
    const workspace = this.ctx.get('workspace', false) as { root?: string } | undefined;
    const anchor = workspace?.root ?? path.resolve(process.env.AGENTCHAT_DATA_ROOT ?? './data');
    const full = path.isAbsolute(file) ? file : path.resolve(anchor, file);
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf-8');
    } catch {
      if (file !== DEFAULT_SERVERS_FILE) {
        this.ctx.logger.warn(`[mcp] 服务器清单文件不可读（回落）: ${full}`);
      }
      return { status: 'missing' };
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      const servers = Array.isArray(parsed) ? parsed : (parsed as { servers?: unknown }).servers;
      if (!Array.isArray(servers)) throw new Error('内容须为 { "servers": [...] } 或裸数组');
      return { status: 'ok', defs: Config({ servers: servers as McpServerDef[] }).servers ?? [] };
    } catch (err: unknown) {
      this.ctx.logger.warn(`[mcp] 服务器清单文件非法（保持现状） ${full}: ${String(err)}`);
      return { status: 'invalid' };
    }
  }

  /**
   * run 前置（loop/before-run）：全局池懒建连 + per-Agent 暴露面收敛。
   * 收敛 = 改写 request.tools：非 MCP 工具不动；MCP 工具仅「本 Agent 生效
   * 服务器清单」内的可见（缺省 = 全局池；差异层 servers 覆盖）。
   */
  private async prepareRun(request: { agent?: string; tools?: string[] }): Promise<void> {
    await this.sync();
    await this.scopeForAgent(request);
  }

  /** 确保清单内服务器已注册并建连发现（差异层懒注册 / 池复活重挂） */
  private async ensureServers(defs: McpServerDef[]): Promise<void> {
    let added = false;
    for (const def of defs) {
      if (this.servers.has(def.name)) continue;
      try {
        this.registerServer(def); // 差异层来源——不进 managed（非池管辖）
      } catch (err: unknown) {
        this.ctx.logger.warn(`[mcp] Agent 差异层服务器 "${def.name}" 注册失败: ${String(err)}`);
      }
      added = true;
    }
    if (added) await this.sync();
  }

  /**
   * per-Agent 生效清单（settingsOf(agent, 'mcp') 合成：全局默认层 ∪ 差异层，
   * 差异层键优先）→ 收敛本 run 的 MCP 工具暴露面。
   *   · 差异层 `file` = 覆盖（本 Agent 只用那份清单文件，可含池外服务器）；
   *   · `enabled === false`（合成后）= 本 Agent 停用 MCP 暴露；
   *   · 清单文件缺失/非法 → warn 回落全局池；
   *   · 生效清单已覆盖全部已注册 MCP 服务器 → 不动 request.tools（零足迹）。
   */
  private async scopeForAgent(request: { agent?: string; tools?: string[] }): Promise<void> {
    if (!request.agent) return; // 无身份 run（直答/测试）不收敛：见全部已注册工具
    const agents = this.ctx.get('agents', false) as
      | { settingsOf?(id: string, name?: string): unknown }
      | undefined;
    if (!agents?.settingsOf) return;
    const cfg = agents.settingsOf(request.agent, 'mcp') as
      | { file?: unknown; enabled?: unknown }
      | undefined;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
    const disabled = cfg.enabled === false;
    // 缺省回落 mcp.json（= 池文件）；missing/invalid 回落全局池（warn 已记）
    const file = disabled ? { status: 'missing' as const } : this.readServersFile(cfg.file);
    const defs = file.status === 'ok' ? file.defs : undefined;
    const effective = disabled ? [] : (defs ?? [...this.poolDefs.values()]);
    if (effective.length > 0) await this.ensureServers(effective); // 懒注册 + 建连（缺的）
    if (this.toolServers.size === 0) return; // 无已注册 MCP 工具 → 无可收敛
    const allowed = new Set(effective.map((d) => d.name));
    if ([...this.toolServers.values()].every((srv) => allowed.has(srv))) return; // 全可见 → 零足迹
    const universe = this.ctx
      .get('tools')
      ?.list()
      .map((t) => t.name) ?? [];
    const visible = new Set(
      universe.filter((n) => {
        const srv = this.toolServers.get(n);
        return srv === undefined || allowed.has(srv); // 非 MCP 工具不动
      }),
    );
    request.tools =
      request.tools === undefined ? [...visible] : request.tools.filter((n) => visible.has(n));
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** MCP 服务（ac-mcp 提供）：服务器注册（懒建连）+ 工具发现注册 */
    mcp: McpService;
  }
}

export const name = 'ac-mcp';

/**
 * 行配置 schema（yml/bootTree 基线面——loader 在 apply 前校验并填默认值：
 * `servers` 缺省 `[]`；非法条目 = 行 FAILED、boot 拒绝）。settings 层的
 * 清单载体是文件（`file` 字段 → mcp.json，内容复用本 schema 的 servers
 * 校验），不在此表达。`clientFactory` 是程序注入面（函数——yml 无法
 * 表达），schema 不声明、非严格合并原样透传（测试假连接不受影响）。
 */
export const Config: z<McpRowOptions> = z.object({
  servers: z.array(z.object({
    name: z.string().required().description('服务器名（注册中心键；工具撞名前缀词）'),
    url: z.string().description('HTTP[StreamableHTTP] 端点；与 command 二选一'),
    headers: z.dict(z.string()).description('HTTP 自定义头（鉴权等）'),
    command: z.string().description('stdio 命令；传输缺省按 url/command 推断'),
    args: z.array(z.string()).description('stdio 命令参数'),
    env: z.dict(z.string()).description('stdio 环境变量（值支持 ${VAR} 展开）'),
    enabled: z.boolean().description('false = 清单内软停用（sync 跳过该服务器）'),
    connectTimeoutMs: z.number().min(0).description('建连超时（ms）'),
    insecure: z.boolean().description('自签名证书放行（per-server dispatcher，不动全局）'),
    transport: z.union([z.const('stdio'), z.const('http')]).description('显式传输选择（缺省推断）'),
  })).description('放行基线（cordis.yml mcp 行 config；运行时清单缺省读数据根 mcp.json——文件存在即整体替换本基线）'),
}) as z<McpRowOptions>;

// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
import type {} from 'ac-config'; // config/changed 事件目录类型增强（监听 owning 包）
export const extension: ExtensionMeta = {
  name: 'mcp',
  label: 'MCP 工具发现',
  description: '首 run 懒建连 + tools/list 发现注册；服务器清单 = 清单文件（settings.mcp.file，缺省数据根 mcp.json）分层合成——Agent 差异层指向自己的清单即覆盖；暴露面按生效清单收敛（非 MCP 工具不动）',
  automatic: true,
  fields: [
    { name: 'file', type: 'file', default: 'mcp.json', description: 'MCP 服务器清单文件（JSON：{ "servers": [...] } 或裸数组；条目 name 必填，url 或 command+args 二选一，可选 headers/env/enabled/connectTimeoutMs/insecure/transport）。相对路径锚定数据根；文件存在即整体替换行基线，改动下一 run 热生效；Agent 差异层指向自己的清单文件即覆盖（可含池外服务器，run 时动态加载建连）' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（false = 本层生效范围收敛 MCP 工具暴露为空；全局停用可被 Agent 差异层 true 覆盖——settingsOf 合成）' },
  ],
  listeners: [{ event: 'loop/before-run', role: 'MCP 懒建连 + 暴露面收敛', description: '首 run 前完成服务器建连与工具发现注册；按 per-Agent 生效清单收敛 MCP 工具暴露', respectsEnabled: true }],
};


export const inject = ['tools'];

export function apply(ctx: Context, options: McpRowOptions = {}) {
  ctx.plugin(McpService, options);
}
