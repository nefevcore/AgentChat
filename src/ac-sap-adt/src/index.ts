// ============================================================
// ac-sap-adt —— SAP ABAP ADT 工具行（46 个 adt_* 工具）
//
// 引擎复用 @nefevcore/abap-adt-core 纯内核（与 DeepSeek Harness 适配层
// 同源——单一事实源，290 项内核测试在源仓库锁定行为）。本行只做宿主适配：
//
//   1. 工具注册：内核 DefinedTool → AgentChat ToolDefinition
//      （parameters 已是标准 JSON Schema 直传；execute 返回值归一
//       {ok, output} / {ok:false, error}，输出经 deepCompact 去
//       undefined——模型边界是 JSON 而非 JS）
//   2. 能力门禁：全部工具 requiredTags ['sap-adt']——只有 tags 里
//      显式加了 sap-adt 的 Agent 可见/可调（对齐 DSH 侧"默认不加载、
//      按需启用"的哲学；普通 Agent 的工具列表不被 46 个工具淹没）
//   3. 启停分层（对齐 mcp 语义——platform 标准词汇）：
//        · 行 config `enabled:false` = 进程级硬停（boot 不注册工具）
//        · `settings['sap-adt'].enabled` = 软停用（热生效）：
//          全局默认层（config.json，插件库弹窗）∪ Agent 差异层
//          （Agent 页弹窗，settingsOf 合成、差异层键优先）——
//          停用 Agent 的工具经 loop/before-run 从暴露面移除，
//          执行期再经 tool/before-execute 收口（含宿主直调）
//   4. 服务缝：fs → <数据根>/sap-adt/ 子树内的 node:fs 适配器
//      （快照/导出/本地检查）；credentials → ac-credentials 全局级
//      （密码引用 ADT_<NAME>_PASSWORD 加密落盘）；host → AgentChat
//      宿主档案（凭证词汇 + .ac-sap-adt 工作区目录）
//   5. 引擎配置分层：行 config < config.json 顶层 `sap-adt:` 段（引擎域：
//      destinations/configFile/policy）< 显式 configFile（相对路径锚定
//      数据根）——config/changed 热重载目的地表与策略，无需重启
//
// 会话工作区层（per-call 锚点按调用方作用域）：Agent 调用 →
// <数据根>/.ac-sap-adt/agents/<agentId>/destinations.yaml（per-Agent 隔离，
// 对话式 adt_create_destination 写这里）；宿主直调 → <数据根>/.ac-sap-adt/
// destinations.yaml。快照/导出的 fs 子树是独立的 <数据根>/sap-adt/。demo
// 目的地（进程内 mock ADT 服务器）默认开启——零 SAP 系统即可端到端体验。
// ============================================================
import * as fs from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-tools'; // ctx.tools 服务类型增强（type-only）
import z from '@agentchat/schemastery';
import {
  AdtRegistry,
  DebuggerManager,
  LockLedger,
  assembleAdtTools,
  composeLayers,
  credentialResolverOf,
  deepCompact,
  expandHomePath,
  loadExternalConfigFile,
  type AdtFileSystem,
  type EffectiveConfig,
  type HostProfile,
  type PluginConfig,
  type ToolExec,
  type ToolHost,
} from '@nefevcore/abap-adt-core';
import { SapAdtFs, credentialsServiceOf } from './engine.ts';

export const name = 'ac-sap-adt';

/** 能力标签：Agent 的 tags 须包含它才能看到/调用 adt_* 工具 */
export const CAPABILITY_TAG = 'sap-adt';

/**
 * AgentChat 宿主档案（内核 hostprofile 检测缝，core ≥ 0.7.1）：声明本宿主
 * 的凭证存储词汇与工作区 destinations 目录，内核据此把 adt_create_destination
 * 的工具描述/notes/hint 与 destinations.yaml 自文档注释全部换成 AgentChat
 * 语境（不再出现 .dsh-abap-adt / ~/.dsh 的 DSH 词汇）。两处接缝：
 * host 门面的 get('host')（措辞）与 AdtRegistry.create 的 hostProfile（存储
 * 权威——目录与文件注释以它为准）。
 */
const AGENTCHAT_HOST_PROFILE: HostProfile = {
  id: 'agentchat',
  label: 'AgentChat',
  credentialStore: { label: 'AgentChat encrypted credential store' },
  passwordResolution: 'AgentChat credential store > process env',
  globalConfigHint: 'overrides the `sap-adt:` section of the AgentChat config',
  // '.' = 锚点即配置目录（core ≥ 0.7.2）：锚点已按调用方作用域（per-Agent）
  // 切分，destinations.yaml 直接落锚点下，不再嵌一层常量目录
  workspaceConfigDir: '.',
};

/** 引擎配置形状（= 内核 PluginConfig；`sap-adt:` 顶层段键同形）。 */
export interface SapAdtRowOptions extends Partial<PluginConfig> {
  /**
   * 进程级硬停（缺省启用；false 时本行 boot 不注册任何工具）。
   * 热启停走 `settings['sap-adt'].enabled`（全局默认层 ∪ Agent 差异层，
   * 见行头注释第 3 条）——本键只是合成链之外的最后一道装配开关。
   */
  enabled?: boolean;
}

// 行配置 schema（loader 在 apply 前校验；destinations 条目形状由内核
// composeLayers/validateExternalConfig 把关——schema 层保持透传）
export const Config: z<SapAdtRowOptions> = z.object({
  enabled: z.boolean(),
  configFile: z.string(),
  demo: z.boolean(),
  demoPort: z.number(),
  defaultDestination: z.string(),
  enableTransports: z.boolean(),
  allowedTransports: z.string(),
  allowTransportableEdits: z.boolean(),
  allowedPackages: z.string(),
  allowExecution: z.boolean(),
  allowBatchWrites: z.boolean(),
  blockedTablesProfile: z.string(),
  blockedTables: z.array(z.string()),
  allowedTables: z.array(z.string()),
  allowDebugger: z.boolean(),
  allowDebugVariables: z.boolean(),
  destinations: z.array(z.any()),
}) as z<SapAdtRowOptions>;

// ── 扩展自述（注册制目录：ac-web-api 扫 cordis registry 读取） ──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'sap-adt',
  label: 'SAP ABAP ADT 工具行',
  description:
    '46 个 adt_* 工具直连 SAP ADT REST（搜索/读写/激活/单测/ATC/传输/调试器/$batch）；' +
    '需 sap-adt 能力标签；引擎配置走行 config 与 config.json `sap-adt:` 段（热生效）；' +
    'demo 目的地（进程内 mock）默认可用',
  fields: [
    {
      name: 'enabled',
      type: 'boolean',
      description:
        '行为门控（false = 本层生效范围停用 adt_* 工具：暴露面收敛 + 执行拒绝；' +
        '全局停用可被 Agent 差异层 true 覆盖——settingsOf 合成；config/changed 热生效）',
      default: true,
    },
  ],
  listeners: [
    {
      event: 'tool/before-execute',
      role: 'enforcer',
      description: 'settings[\'sap-adt\'].enabled 合成为 false 的调用方执行 adt_* 工具 → veto',
      respectsEnabled: true,
    },
    {
      event: 'loop/before-run',
      role: 'visibility',
      description: '停用 Agent 的 run 从 request.tools 移除 adt_* 暴露面（非 adt 工具不动）',
      respectsEnabled: true,
    },
  ],
};

export const inject = ['tools'];

/** config.json 顶层 `sap-adt:` 段（引擎配置域：destinations/policy/configFile）。 */
function globalSectionOf(ctx: Context): Partial<PluginConfig> | undefined {
  const config = ctx.get('config') as { get?(key: string): unknown } | undefined;
  const section = config?.get?.('sap-adt');
  if (!section || typeof section !== 'object' || Array.isArray(section)) return undefined;
  return section as Partial<PluginConfig>;
}

export async function apply(ctx: Context, options: SapAdtRowOptions = {}) {
  const logger = {
    info: (message: string) => ctx.logger.info(`[sap-adt] ${message}`),
    warn: (message: string) => ctx.logger.warn(`[sap-adt] ${message}`),
    error: (message: string) => ctx.logger.error(`[sap-adt] ${message}`),
  };

  // ---- 数据根与专用工作区（<数据根>/sap-adt/） ----
  const workspace = ctx.get('workspace') as { root?: string } | undefined;
  const dataRoot = resolve(workspace?.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
  const adtWorkspace = resolve(dataRoot, 'sap-adt');
  fs.mkdirSync(adtWorkspace, { recursive: true });

  // ---- 引擎宿主缝（fs / credentials / host / logger） ----
  const fsAdapter: AdtFileSystem = new SapAdtFs(adtWorkspace);
  const host: ToolHost = {
    get: (serviceName) => {
      if (serviceName === 'host') return AGENTCHAT_HOST_PROFILE;
      if (serviceName === 'fs') return fsAdapter;
      if (serviceName === 'credentials') return credentialsServiceOf(ctx);
      return undefined; // sandboxPolicy 等可选缝：本宿主不提供
    },
  };

  // ---- 启停分层 -----------------------------------------------------------
  // 行 config enabled:false = 进程级硬停（boot 不注册）；settings 域
  // enabled = 热启停（全局默认层 ∪ Agent 差异层，settingsOf 合成）。
  // 无 agents/config 服务 = 无 settings 面 → 恒放行（fail-open）。
  // ------------------------------------------------------------------------

  /** 合成后的 settings['sap-adt'].enabled 是否显式停用（true = 停用）。 */
  function settingsDisabledFor(agentId: string | undefined): boolean {
    const agents = ctx.get('agents') as
      | { settingsOf?(id: string, name: string): unknown }
      | undefined;
    let layer: unknown;
    if (agents?.settingsOf && agentId !== undefined) {
      layer = agents.settingsOf(agentId, 'sap-adt');
    } else {
      // 无身份（宿主直调）或无 agents 服务：读全局默认层
      const config = ctx.get('config') as { get?(key: string): unknown } | undefined;
      layer = config?.get?.('settings.sap-adt');
    }
    return layer !== null && typeof layer === 'object' && !Array.isArray(layer)
      ? (layer as { enabled?: unknown }).enabled === false
      : false;
  }

  // 进程级硬停：boot 期装配开关（改它需要重载行——文档已注明）
  const rowHardOff = options.enabled === false;

  // 执行期收口（含宿主直调——loop 暴露面收敛之外的防线）：
  // 合成停用的调用方执行 adt_* 工具 → veto（可读错误指明恢复方式）。
  ctx.on(
    'tool/before-execute',
    (execution, next) => {
      const call = execution.call as { name?: string; agentId?: string };
      if (typeof call.name === 'string' && call.name.startsWith('adt_') && settingsDisabledFor(call.agentId)) {
        return {
          ok: false as const,
          error:
            `sap-adt 工具行已对本调用方停用（settings['sap-adt'].enabled = false，` +
            'Agent 差异层/全局默认层合成后生效）。在 Agent 配置或全局设置里打开开关后立即恢复' +
            '（config/changed 热生效，无需重载）。',
        };
      }
      return next();
    },
    { description: "sap-adt：settings['sap-adt'].enabled 停用收口（adt_* 执行 veto）" },
  );

  // 暴露面收敛（对齐 ac-mcp scopeForAgent 形态）：停用 Agent 的 run 从
  // request.tools 移除 adt_*（非 adt 工具不动；request.tools 未声明时收
  // 敛为「全量 - adt_*」）。
  ctx.on(
    'loop/before-run',
    (call, next) => {
      const request = (call as { request?: { agent?: string; tools?: string[] } }).request;
      if (request && settingsDisabledFor(request.agent)) {
        const isAdt = (n: string) => n.startsWith('adt_');
        request.tools = request.tools === undefined ? undefined : request.tools.filter((n) => !isAdt(n));
        if (request.tools === undefined) {
          const universe = ctx.get('tools')?.list().map((t) => t.name) ?? [];
          request.tools = universe.filter((n) => !isAdt(n));
        }
      }
      return next();
    },
    { description: 'sap-adt：停用 Agent 的 adt_* 暴露面收敛（非 adt 工具不动）' },
  );

  // ---- 引擎配置分层与热重载 ----
  async function currentEffective(): Promise<{ config: EffectiveConfig; warnings: string[] }> {
    const warnings: string[] = [];
    const merged = composeLayers([options as Partial<PluginConfig>, globalSectionOf(ctx)]);
    if (merged.configFile) {
      // 团队共享配置文件：相对路径锚定数据根（内核缺省锚定 DSH home，
      // 在本宿主改为 AgentChat 数据根语义）
      const expanded = expandHomePath(merged.configFile);
      const file = isAbsolute(expanded) ? expanded : resolve(dataRoot, expanded);
      if (fs.existsSync(file)) {
        const layer = await loadExternalConfigFile(file);
        // EffectiveConfig ⊇ 配置层词汇（blockedTablesProfile 等在内核的
        // 运行时类型里是宽 string），此处按层词汇收窄回 PluginConfig
        return { config: composeLayers([merged as Partial<PluginConfig>, layer]), warnings };
      }
      warnings.push(`configFile not found, ignored: ${file}`);
    }
    return { config: merged, warnings };
  }

  // ---- 引擎状态（初始化失败不拖垮宿主：无工具 + 日志，配置修复热恢复） ----
  interface EngineState {
    registry: AdtRegistry;
    ledger: LockLedger;
    debugger: DebuggerManager;
  }
  let engine: EngineState | undefined;
  let disposed = false;
  let rebuildChain: Promise<void> = Promise.resolve();
  let lastSnapshot = '';

  function registerTools(state: EngineState): void {
    const deps = { registry: state.registry, ledger: state.ledger, debugger: state.debugger };
    const catalog = assembleAdtTools(deps, host);
    for (const tool of catalog) {
      // 执行上下文垫片：内核读 exec.signal（取消）与
      // exec.agent.session.header.cwd（per-call 工作区层锚点）。
      // 锚点按调用方作用域切分（Agent 隔离）：Agent 调用 →
      // <数据根>/.ac-sap-adt/agents/<agentId>/；宿主直调（无身份）→
      // <数据根>/.ac-sap-adt/。各 Agent 一份独立 destinations 表，互不可见。
      // agentId 只保留路径安全字符（防目录穿越），快照/导出仍锚定 fs
      // 适配器自己的 <数据根>/sap-adt/ 子树，与该锚点无关。
      const agentScopeDir = (agentId: string | undefined): string => {
        if (agentId === undefined || agentId === '') return resolve(dataRoot, '.ac-sap-adt');
        const slug = agentId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '_') || 'agent';
        return resolve(dataRoot, '.ac-sap-adt', 'agents', slug);
      };
      const execOf = (signal?: AbortSignal, agentId?: string): ToolExec => ({
        signal,
        agent: { session: { header: { cwd: agentScopeDir(agentId) } } },
      });
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
        requiredTags: [CAPABILITY_TAG],
        async execute(args, call) {
          try {
            const agentId = (call as { agentId?: string }).agentId;
            const value = await tool.execute((args ?? {}) as Record<string, unknown>, execOf(call.signal, agentId));
            return { ok: true, output: deepCompact(value) };
          } catch (err: unknown) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      });
    }
    logger.info(`${catalog.length} adt_* tools registered (capability tag: ${CAPABILITY_TAG})`);
  }

  async function init(): Promise<void> {
    if (engine || disposed || rowHardOff) return;
    const { config: effective, warnings } = await currentEffective();
    for (const warning of warnings) logger.warn(warning);
    // hostProfile = 存储权威：destinations 落盘 .agentchat/abap-adt/，
    // 文件注释按本宿主词汇渲染（与 host 门面声明同一份档案）
    const registry = await AdtRegistry.create(effective, {
      credentialResolver: credentialResolverOf(host),
      hostProfile: AGENTCHAT_HOST_PROFILE,
    });
    const state: EngineState = {
      registry,
      ledger: new LockLedger(),
      debugger: new DebuggerManager(registry),
    };
    engine = state;
    lastSnapshot = JSON.stringify(effective);
    registerTools(state);
    logger.info(
      `config applied: ${registry.destinations.size} destination(s): ` +
        `${[...registry.destinations.keys()].join(', ') || '(none)'}`,
    );
  }

  function rebuild(reason: string): void {
    rebuildChain = rebuildChain.then(async () => {
      if (disposed) return;
      try {
        if (!engine) {
          await init(); // 首次失败后的热恢复路径
          return;
        }
        const { config: effective, warnings } = await currentEffective();
        for (const warning of warnings) logger.warn(warning);
        const snapshot = JSON.stringify(effective);
        if (snapshot === lastSnapshot) return;
        await engine.registry.reload(effective);
        lastSnapshot = snapshot;
        logger.info(
          `config applied (${reason}): ${engine.registry.destinations.size} destination(s): ` +
            `${[...engine.registry.destinations.keys()].join(', ') || '(none)'}`,
        );
      } catch (err: unknown) {
        logger.error(`config reload failed, keeping last good state: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  try {
    await init();
  } catch (err: unknown) {
    logger.error(
      `engine init failed — no adt_* tools registered (fix config.json \`sap-adt:\` / row config; ` +
        `a config change retries): ${err instanceof Error ? err.message : String(err)}`,
    );
    // init 失败但行保持 ACTIVE：下方 config/changed 订阅承担热恢复。
  }
  if (rowHardOff) {
    logger.info('hard-disabled (row config enabled: false) — no tools registered (reload row to re-enable)');
  }

  // 全局配置热重载（ac-config config/changed；无 config 服务时静默）：
  // 引擎域（目的地/策略）重建。settings 域无需订阅——启停在执行期/
  // run 期实时合成（settingsDisabledFor 每次现读）。
  ctx.on('config/changed', () => rebuild('config/changed'), {
    description: 'sap-adt：引擎配置（目的地/策略）热重载',
  });

  // ---- 资源回收：引擎持有进程内 mock 服务器与调试器会话 ----
  ctx.effect(() => {
    disposed = true;
    return () => {
      void (async () => {
        await rebuildChain.catch(() => undefined);
        if (engine) {
          await engine.debugger.dispose().catch(() => undefined);
          await engine.registry.dispose().catch(() => undefined);
        }
      })();
    };
  });
}
