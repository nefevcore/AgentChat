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
//   · servers 放行清单走行 Config（进程级授权：能连哪些服务器由
//     行组合决定，Agent 不能自行开新连接）
//   · clientFactory 注入口：测试假连接零网络零子进程
//
// 单服务器失败不炸行（warn + 跳过；下一 run 重试）。协议实现住
// ac-mcp-core 纯库（官方 SDK 包装）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { ToolDefinition } from 'ac-tools';
import {
  createSdkConnection,
  pickToolName,
  type McpConnectionFactory,
  type McpConnection,
  type McpServerConfig,
  type McpToolDef,
} from 'ac-mcp-core';

/** 服务器注册定义（Config.servers 单位；clientFactory 为测试注入面） */
export interface McpServerDef extends McpServerConfig {
  /** 连接工厂（缺省官方 SDK 包装；测试注入假实现） */
  clientFactory?: McpConnectionFactory;
}

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface McpRowOptions {
  /** 放行的服务器清单（进程级授权；enabled !== false 者生效） */
  servers?: McpServerDef[];
}

/** 服务器运行态 */
interface ServerEntry {
  def: McpServerDef;
  connection: McpConnection | null;
  /** 本服务器注册的工具 disposer（移除服务器/重发现时回收） */
  disposers: Array<() => void>;
  synced: boolean;
}

export class McpService extends Service {
  private servers = new Map<string, ServerEntry>();

  constructor(ctx: Context, options: McpRowOptions = {}) {
    super(ctx, 'mcp');
    for (const def of options.servers ?? []) {
      this.registerServer(def);
    }

    // 懒建连触发面：首个 run 前完成发现与工具注册（此后复用）
    this.ctx.on('loop/before-run', (call, next) => this.sync().then(() => next(), () => next()), { description: 'MCP 懒建连 + 工具发现注册' });
  }

  /**
   * 注册服务器（fiber 归属：调用方行卸载时自动回收连接与已注册工具；
   * 重名抛错）。注册不建连——首次 sync 才连接（懒建连）。
   */
  registerServer(def: McpServerDef) {
    if (!def.name) throw new Error('MCP 服务器注册缺少 name');
    if (this.servers.has(def.name)) throw new Error(`MCP 服务器 "${def.name}" 已注册`);
    const entry: ServerEntry = { def, connection: null, disposers: [], synced: false };
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
    entry.connection?.close();
    entry.connection = null;
    entry.synced = false;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** MCP 服务（ac-mcp 提供）：服务器注册（懒建连）+ 工具发现注册 */
    mcp: McpService;
  }
}

export const name = 'ac-mcp';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'mcp',
  label: 'MCP 工具发现',
  description: '首 run 懒建连 + tools/list 发现注册（per-Agent 暴露走工具清单的 include/exclude）',
  automatic: true,
  listeners: [{ event: 'loop/before-run', role: 'MCP 工具懒建连', description: '首 run 前完成服务器建连与工具发现注册' }],
};


export const inject = ['tools'];

export function apply(ctx: Context, options: McpRowOptions = {}) {
  ctx.plugin(McpService, options);
}
