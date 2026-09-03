// ============================================================
// settings/api.ts —— 类型化 API 层（阶段二第二梯：Port B 直连）
//
// 全部端点已迁 preview 词汇（rpc/call 方法名直转）。M22 P2 后插件域
// 直消费 preview 形状（agents/assembly、plugin/extension-catalog、
// plugin/dev-scan），src AssemblyView/HookKind 适配层已退场；
// 市场为 preview 无面（M22 D8 摘除）；原生文件对话框显式降级。
// ============================================================

import type {
  AgentConfigViews,
  FieldMeta,
  PoolData,
  TimerEntry,
  AssemblyData,
  AssemblyPatch,
  AssemblyRowInfo,
  PluginCatalog,
  PluginLibrary,
  PluginInfo,
  PluginPermissionsView,
  StagingRecord,
  StagingFileInfo,
  StagingFileContent,
  EventChainEntry,
  EventDescriptionEntry,
  PluginPatchEntry,
} from './types';
import { wireRpc } from '../api/wire';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

// ── 全局配置 ──

export function getGlobalConfig(rpc: Rpc = wireRpc): Promise<{ config: Record<string, any> }> {
  return rpc.call('config/get');
}

export function saveGlobalConfig(config: Record<string, any>, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  return rpc.call('config/save', { config });
}

export function getPools(rpc: Rpc = wireRpc): Promise<PoolData> {
  // preview 无专用池端点：config/get 白名单域（llmProviders/searchProviders 键）
  return rpc.call<{ config: Record<string, any> }>('config/get').then((r) => ({
    llmProviders: (r.config?.llmProviders ?? r.config?.llm ?? {}) as PoolData['llmProviders'],
    searchProviders: (r.config?.searchProviders ?? {}) as PoolData['searchProviders'],
  }));
}

/** 池域定向保存（PoolManager 即时落盘——不再等底部「保存配置」全量保存；
 *  api_key 侧信道语义在服务端 config/set：掩码=不动 / ''=删 / 新值=存） */
export async function savePoolDomain(
  domain: 'llmProviders' | 'searchProviders',
  pools: Record<string, any>,
  rpc: Rpc = wireRpc,
): Promise<void> {
  await rpc.call('config/set', { key: domain, value: pools });
}

/** 删除 Provider 连接凭据（pool:<name>）——删除连接条目时必须同步调用，
 *  否则内置种子名的 /models 发现回写会凭残留凭据"复活"已删条目 */
export async function deleteLlmPoolCredential(name: string, rpc: Rpc = wireRpc): Promise<void> {
  await rpc.call('llm/pool-credential', { name, value: '' });
}

/** 免注册连接探测（新建弹窗"填 Key 即读清单"）：base_url + api_key 直调
 *  /models（后端本地代理，不经注册面——保存前可用；不写缓存） */
export async function probeLlmModels(
  baseUrl: string,
  apiKey: string,
  rpc: Rpc = wireRpc,
): Promise<{ models: string[] }> {
  const r = await rpc.call<{ models?: string[] }>('llm/probe-models', {
    base_url: baseUrl,
    api_key: apiKey,
  });
  return { models: r.models ?? [] };
}

/**
 * 视觉能力探测（模型能力元数据）：逐模型 1×1 图最小请求三态判定
 * （true/false/null=未知）。免注册路径（base_url+api_key，保存前可用）
 * 与注册路径（provider 名——后端附加 pool:<名> 凭据）双形态。
 */
export async function probeLlmVision(
  input: { baseUrl?: string; apiKey?: string; provider?: string; models: string[] },
  rpc: Rpc = wireRpc,
): Promise<{ results: Record<string, boolean | null> }> {
  const r = await rpc.call<{ results?: Record<string, boolean | null> }>('llm/probe-vision', {
    models: input.models,
    ...(input.baseUrl ? { base_url: input.baseUrl, ...(input.apiKey ? { api_key: input.apiKey } : {}) } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
  });
  return { results: r.results ?? {} };
}

// ── Schema（LLM/search 内置字段表合成；namespace 仍空表 = FieldMeta 归一化容忍） ──

/** llmParams 透传键全集（与 ac-agents LLM_SAMPLING_KEYS 白名单逐键一致） */
const LLM_SAMPLING_KEYS = [
  'temperature', 'max_tokens', 'top_p', 'response_format', 'stop',
  'reasoning_effort', 'thinking', 'logprobs', 'top_logprobs', 'tool_choice',
] as const;

/**
 * LLM provider 内置字段表（AgentPane 模型页签表单数据源）。
 * llm-provider-model-plan P5：连接字段（api_key/base_url）收敛进 Provider
 * 连接定义（设置 → 模型管理 / PoolManager）——Agent 面只选 provider+model
 * 与采样参数（logprobs/top_logprobs/tool_choice 由 AgentPane 的
 * HIDDEN_LLM_KEYS 过滤不展示）。
 * · model 字段：AgentPane 以 key === 'model' 特判渲染为纯下拉——
 *   「默认」+ 所选连接的模型清单（进页签/换连接自动读取 /models 发现，
 *   不再有手输与「读取」按钮）。
 * · reasoning_effort：下拉档位（与会话输入框同词汇：默认/无/low/high/max）——
 *   「默认」= 不覆盖（不发送推理参数，跟随服务商缺省）；「无」('none')
 *   由后端 filterLlmParams 翻译为 thinking disabled（显式关闭思考输出，
 *   替代原「思考输出」勾选）。
 */
/** 推理力度档位（与会话输入框同词汇）。'' = 默认：不发送推理参数、
 *  跟随服务商缺省（DeepSeek/GLM 默认开启思考）；'none' = 显式关闭思考 */
const EFFORT_FIELD_OPTIONS = [
  { label: '默认（跟随服务商）', value: '' },
  { label: '无', value: 'none' },
  { label: 'low', value: 'low' },
  { label: 'high', value: 'high' },
  { label: 'max', value: 'max' },
];

const BUILTIN_LLM_SCHEMA: FieldMeta[] = [
  { key: 'model', label: '模型 ID', description: '「默认」= 按全局设置的默认模型处理；清单来自所选连接的模型发现', type: 'text' },
  { key: 'reasoning_effort', label: '推理力度', description: '默认 = 不发送推理参数（跟随服务商，DeepSeek/GLM 默认开启思考）；无 = 关闭思考输出；low / high / max = 强度档位', type: 'select', options: EFFORT_FIELD_OPTIONS },
  { key: 'temperature', label: '温度', description: '采样发散度（0-2）', type: 'number', min: 0, max: 2, step: 0.1 },
  { key: 'top_p', label: 'top_p', description: '核采样阈值（0-1）', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'max_tokens', label: '最大输出 Token', type: 'number' },
  { key: 'stop', label: '停止词', description: '生成命中该词即终止（单个停止词）', type: 'text' },
  { key: 'response_format', label: '输出格式', description: '如 json_object', type: 'text' },
  { key: 'logprobs', label: 'logprobs', type: 'checkbox' },
  { key: 'top_logprobs', label: 'top_logprobs', type: 'number' },
  { key: 'tool_choice', label: 'tool_choice', type: 'text' },
];

/** Provider 连接模板（PoolManager「+ 添加」预设——模板出默认 base_url/
 *  defaultModel，用户只需起名 + 填 API Key；名称与模板解耦：同名即该
 *  provider 的引用名，多账号可另起名（如 ds-work / ds-personal）） */
export interface LlmProviderTemplate {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel?: string;
}

export const LLM_PROVIDER_TEMPLATES: LlmProviderTemplate[] = [
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/', defaultModel: 'deepseek-v4-flash' },
  { id: 'openai', label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { id: 'glm', label: '智谱 GLM 开放平台', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.3' },
  // GLM Coding Plan（编程套餐独立端点）——套餐模型集与开放平台不同，
  // 不设 defaultModel：填 Key 读取清单后自动取第一个
  { id: 'glm-coding-plan', label: '智谱 GLM Coding Plan（编程套餐）', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
];

/** 模板 → 字段默认值（getLlmSchemas 的 model 默认同源） */
const LLM_PROVIDER_DEFAULTS: Record<string, Record<string, unknown>> = Object.fromEntries(
  LLM_PROVIDER_TEMPLATES.map((t) => [t.id, { base_url: t.baseUrl, ...(t.defaultModel ? { model: t.defaultModel } : {}) }]),
);

/** 字段表按 provider 默认值表打 default（浅拷贝不改基表；避开 Vue 宏同名） */
function applyFieldDefaults(base: FieldMeta[], defaults: Record<string, unknown>): FieldMeta[] {
  return base.map((f) => (f.key in defaults ? { ...f, default: defaults[f.key] } : f));
}

export async function getLlmSchemas(): Promise<Record<string, any[]>> {
  const table: Record<string, any[]> = {};
  for (const [provider, defaults] of Object.entries(LLM_PROVIDER_DEFAULTS)) {
    table[provider] = applyFieldDefaults(BUILTIN_LLM_SCHEMA, defaults);
  }
  return table;
}

// ── 搜索 provider 内置字段表（2026-10 收敛：仅 tavily/deepseek——与
// ac-web-search-core PROVIDER_REGISTRY 同口径；未实测的三家不保证能用，
// 注册表与池页下拉一并摘除）──
// 此前 getSearchSchemas 恒返回空表：PoolManager 的 providerOptions 为空、
// 字段集为空——「+ 添加」弹窗只有一个空下拉和零字段，搜索引擎根本无法
// 新增。deepseek 配置项只保留 api_key——端点（anthropic/v1 端点）/模型
// （deepseek-v4-flash）/搜索次数（5）由 ac-web-search-core 内置缺省接管，
// 调优字段（深度/主题）deepseek 不消费，均不再暴露（存量 config 键运行时
// 兼容读取）；tavily 只读 api_key + 调优字段（默认值与 ac-web-tools 缺省
// 一致：5 条 / advanced / general / 截断 2000）。池 default 条目 =
// web_search 的缺省源（行侧 defaultSearchPool 接线）。

/** 搜索调优公共字段（键 = 搜索池条目 / settings['web-tools'] 词汇） */
const SEARCH_TUNING_FIELDS: FieldMeta[] = [
  { key: 'defaultResults', label: '默认结果数', type: 'number', default: 5 },
  { key: 'defaultDepth', label: '默认深度', type: 'select', options: [{ label: 'basic', value: 'basic' }, { label: 'advanced', value: 'advanced' }], default: 'advanced' },
  { key: 'defaultTopic', label: '默认主题', type: 'select', options: [{ label: 'general', value: 'general' }, { label: 'news', value: 'news' }, { label: 'finance', value: 'finance' }], default: 'general' },
  { key: 'rawContentMaxLen', label: '原文截断长度', description: 'raw_content 超长截断（字符）', type: 'number', default: 2000 },
];

const BUILTIN_SEARCH_SCHEMAS: Record<string, FieldMeta[]> = {
  tavily: [
    { key: 'api_key', label: 'API Key', description: 'Tavily 密钥；可前往 app.tavily.com 免费获取（每月 1000 次）。加密存于凭据库，不入 config.json', type: 'password', sensitive: true },
    ...SEARCH_TUNING_FIELDS,
  ],
  deepseek: [
    { key: 'api_key', label: 'API Key', description: '与 DeepSeek 模型共用同一 Key（platform.deepseek.com）。加密存于凭据库，不入 config.json；端点/模型/搜索次数等参数走内置默认', type: 'password', sensitive: true },
  ],
};

export async function getSearchSchemas(): Promise<Record<string, any[]>> {
  return BUILTIN_SEARCH_SCHEMAS;
}

export async function getNamespaceSchemas(): Promise<{ namespaces: Record<string, any[]>; extensions?: any; tools?: any }> {
  return { namespaces: {} };
}

// ── 插件域 ──

/** ① Agent 装配视图（agents/assembly 直连；M22 P2 起无适配层，仅容忍缺省；
 *  M24 X1：hooks → settings 线格式同批原子切换） */
export async function getAssembly(agentId: string, rpc: Rpc = wireRpc): Promise<{ assembly: AssemblyData }> {
  const r = await rpc.call<{ assembly?: Record<string, unknown> }>('agents/assembly', { agentId });
  const a = (r.assembly ?? {}) as Partial<AssemblyData>;
  return {
    assembly: {
      agentId: a.agentId ?? agentId,
      settings: {
        enabled: a.settings?.enabled ?? [],
        configs: a.settings?.configs ?? {},
      },
      tools: {
        include: a.tools?.include ?? [],
        exclude: a.tools?.exclude ?? [],
        enabled: a.tools?.enabled ?? [],
        catalog: a.tools?.catalog ?? [],
      },
    },
  };
}

/** ① 保存装配（agents/assembly/update：settings per-name 浅合并 / null 删除——
 *  合并语义在服务端（M22 D5），前端不再 read-modify-write（B8 竞态消除）） */
export async function saveAssembly(agentId: string, patch: AssemblyPatch, rpc: Rpc = wireRpc): Promise<{ assembly: AssemblyData }> {
  await rpc.call('agents/assembly/update', { agentId, patch: patch as unknown as Record<string, unknown> });
  return getAssembly(agentId, rpc);
}

/** ② 插件/工具目录（plugin/rows + plugin/extension-catalog + plugin/loaded
 *  + plugin/installed + tools/list 五源合成；M22 P2：扩展目录归后端）。
 *  行组合制：内置能力全是 cordis.yml 装配行（不经 pluginRegistry）。按名去重：
 *  · 同名 loaded + installed → 合并为一条 source 'installed'（installed 信息优先）
 *  · rows 与动态插件撞名 → 动态插件信息优先，rows 只补缺 */
export async function getCatalog(rpc: Rpc = wireRpc): Promise<PluginCatalog> {
  const [loadedR, installedR, rowsR, toolsR, extR] = await Promise.all([
    rpc.call<{
      loaded?: Array<Record<string, any>>;
      failed?: Array<{ name: string; error: string }>;
      /** 熔断跳过（M23 G9 第四态徽章） */
      skipped?: Array<{ name: string; reason: string; count: number }>;
      /** 安全模式（M23 L8 横幅） */
      safeMode?: boolean;
    }>('plugin/loaded'),
    rpc.call<{ installed?: Array<Record<string, any>> }>('plugin/installed'),
    // 装配行清单（旧后端无此面 → 容忍为空，退回旧两源合成）
    rpc.call<{ rows?: Array<Record<string, any>> }>('plugin/rows').catch(() => ({ rows: [] })),
    rpc.call<{ tools?: Array<{ name: string; description?: string; requiredTags?: string[] }> }>('tools/list'),
    // 扩展目录（M22 D4①；旧后端无此面 → 容忍为空）
    rpc.call<{ extensions?: Array<Record<string, any>> }>('plugin/extension-catalog').catch(() => ({ extensions: [] })),
  ]);
  const byName = new Map<string, PluginInfo>();
  // ① cordis 装配行（内置基线；后续动态源同名覆盖）。描述取行包
  //  package.json（后端 plugin/rows 解析）；origin==='internal' 的进程
  //  内部行（loader/include/内联回调）不是可辨识能力，过滤不进目录。
  //  origin==='dynamic'（M23 F11）在这里不进目录——动态行在「Agent 开发行」
  //  区单独呈现，plugins 合成由下方 loaded/installed 源覆盖。
  for (const r of rowsR.rows ?? []) {
    const name = String(r?.name ?? '');
    if (!name || name === '(anonymous)') continue;
    if (r?.origin === 'internal' || r?.origin === 'dynamic') continue;
    const description = typeof r.description === 'string' && r.description
      ? r.description
      : 'cordis.yml 装配行（行组合制内置能力）';
    byName.set(name, {
      name,
      label: name,
      description,
      source: 'builtin',
      ...(typeof r.version === 'string' && r.version ? { version: r.version } : {}),
    });
  }
  // ② 动态装载行（manifest 映射；sessionOnly → session 源）
  for (const l of loadedR.loaded ?? []) {
    const m = (l.manifest ?? {}) as Record<string, any>;
    const name = String(l.name ?? m.name ?? '');
    if (!name) continue;
    byName.set(name, {
      name, label: name,
      source: l.sessionOnly === true ? 'session' : 'builtin',
      ...(m.description ?? l.description ? { description: String(m.description ?? l.description) } : {}),
      ...(m.version ? { version: String(m.version) } : {}),
      ...(Array.isArray(m.permissions) ? { permissions: m.permissions as PluginInfo['permissions'] } : {}),
      ...(Array.isArray(l.allowedPermissions) ? { grantedPermissions: l.allowedPermissions as PluginInfo['grantedPermissions'] } : {}),
      ...(l.dir ? { dir: String(l.dir) } : {}),
      // 供给面透传（M23 G4 修复的一半：manifest.provides → PluginInfo）
      ...(m.provides && typeof m.provides === 'object' ? { provides: m.provides as PluginInfo['provides'] } : {}),
      // 非隔离 UI 透传（M23 F7/F8：manifest.ui.isolated === false → 徽章）
      ...(m.ui?.isolated === false ? { uiNonIsolated: true } : {}),
    });
  }
  // ③ 已安装（manifest 映射；与 loaded 撞名 → 合并为一条 source 'installed'）
  for (const l of installedR.installed ?? []) {
    const m = (l.manifest ?? {}) as Record<string, any>;
    const name = String(m.name ?? l.name ?? '');
    if (!name) continue;
    const prev = byName.get(name);
    byName.set(name, {
      ...(prev ?? { name, label: name }),
      name, label: name, source: 'installed',
      ...(m.description ?? l.description ? { description: String(m.description ?? l.description) } : {}),
      ...(m.version ?? l.version ? { version: String(m.version ?? l.version) } : {}),
      ...(Array.isArray(l.permissions) ? { permissions: l.permissions as PluginInfo['permissions'] } : {}),
      ...(l.owner ? { owner: String(l.owner) } : {}),
      ...(l.installedAt ? { installedAt: String(l.installedAt) } : {}),
      // 供给面透传（M23 G4 修复的一半：manifest.provides → PluginInfo）
      ...(m.provides && typeof m.provides === 'object' ? { provides: m.provides as PluginInfo['provides'] } : {}),
      // 非隔离 UI 透传（M23 F7/F8：installed 的 manifest 同样可能带 ui）
      ...(m.ui?.isolated === false ? { uiNonIsolated: true } : {}),
    });
  }
  return {
    plugins: [...byName.values()],
    rows: (rowsR.rows ?? []).map((r) => ({
      name: String(r?.name ?? ''),
      fibers: Number(r?.fibers ?? 0),
      active: r?.active === true,
      // origin 三值直传（M23 F11：'dynamic' = Agent 开发行；缺省/未知 → package）
      origin: (r?.origin === 'internal' || r?.origin === 'dynamic' ? r.origin : 'package') as AssemblyRowInfo['origin'],
      ...(typeof r?.description === 'string' && r.description ? { description: r.description } : {}),
      ...(typeof r?.version === 'string' && r.version ? { version: r.version } : {}),
      ...(typeof r?.owner === 'string' && r.owner ? { owner: r.owner } : {}),
      // yml/include 树行 id（M24 P4：行偏好层开关锚点）
      ...(typeof r?.entryId === 'string' && r.entryId ? { entryId: r.entryId } : {}),
    })),
    extensions: (extR.extensions ?? []) as PluginCatalog['extensions'],
    tools: (toolsR.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', requiredTags: t.requiredTags ?? [], ...(t as any).parameters ? { parameters: (t as any).parameters } : {} })),
    // 装载状态（安装卡片三态徽章——M22 D6；G9 起扩第四态 + 安全模式）
    loaded: (loadedR.loaded ?? []).map((l) => String(l.name ?? '')),
    failed: loadedR.failed ?? [],
    skipped: loadedR.skipped ?? [],
    safeMode: loadedR.safeMode === true,
  };
}

/** ③ 插件库：已安装 + 待审暂存 + 开发扫描（M22 D7：dev = plugin/dev-scan） */
export async function getLibrary(rpc: Rpc = wireRpc): Promise<PluginLibrary> {
  const [installedR, stagingR, devR] = await Promise.all([
    rpc.call<{ installed?: Array<Record<string, any>> }>('plugin/installed'),
    rpc.call<{ staging?: Array<Record<string, any>> }>('plugin/staging-list'),
    // dev 扫描 + 数据根（旧后端无此面 → 容忍为空）
    rpc.call<{ root?: string; dev?: Array<Record<string, any>> }>('plugin/dev-scan').catch(() => ({}) as { root?: string; dev?: Array<Record<string, any>> }),
  ]);
  return {
    installed: (installedR.installed ?? []).map((l) => {
      const m = (l.manifest ?? {}) as Record<string, any>;
      const name = String(m.name ?? l.name ?? '');
      return {
        name,
        label: name,
        source: 'installed' as const,
        ...(m.version ?? l.version ? { version: String(m.version ?? l.version) } : {}),
        ...(m.description ?? l.description ? { description: String(m.description ?? l.description) } : {}),
        ...(Array.isArray(l.permissions) ? { permissions: l.permissions as PluginInfo['permissions'] } : {}),
        ...(l.owner ? { owner: String(l.owner) } : {}),
        ...(l.dir ? { dir: String(l.dir) } : {}),
        ...(l.installedAt ? { installedAt: String(l.installedAt) } : {}),
        // 供给面透传（M23 G4：已安装卡片"提供 N 工具/M provider/K 事件"行）
        ...(m.provides && typeof m.provides === 'object' ? { provides: m.provides as PluginInfo['provides'] } : {}),
        // 非隔离 UI 透传（M23 F7/F8：已安装卡片徽章数据源 = 本映射）
        ...(m.ui?.isolated === false ? { uiNonIsolated: true } : {}),
      };
    }),
    staging: (stagingR.staging ?? []) as unknown as StagingRecord[],
    dev: (devR.dev ?? []) as PluginLibrary['dev'],
    ...(devR.root ? { root: devR.root } : {}),
  };
}

// ── ③b 目录信息架构（M24 P3/P4：plugin/catalog 两分组 + 待审并入） ──

/** 内置组行（包源清单；装配状态与 cordis registry 交叉） */
export interface CatalogBuiltinRow {
  name: string;
  version?: string;
  description?: string;
  assembled: boolean;
  fibers: number;
  /** yml 裸行 id（含未装配/强制停用行——插件库「插件目录」页签停用开关的锚点） */
  entryId?: string;
}

/** 本地组行（registry ∪ devScan ∪ 会话装载；state 含待审外的六态） */
export interface CatalogLocalRow {
  name: string;
  version?: string;
  description?: string;
  owner?: string;
  dir?: string;
  state: 'loaded' | 'installed' | 'failed' | 'skipped' | 'dev' | 'pending';
  error?: string;
  reason?: string;
  sessionOnly?: boolean;
  uiNonIsolated?: boolean;
  provides?: Record<string, unknown>;
  permissions?: string[];
}

/** 待审暂存（并入本地组徽章态） */
export interface CatalogPendingRow {
  pendingId: string;
  name: string;
  version: string;
  owner: string;
  requiredGrants: string[];
  createdAt: string;
}

interface PluginCatalogData {
  builtin: CatalogBuiltinRow[];
  note?: string;
  local: CatalogLocalRow[];
  pending: CatalogPendingRow[];
}

/** 目录（M24 P3：plugin/catalog RPC 直连）。
 *  不再吞错（2026-08-30 事故：旧后端容忍 .catch(()=>({})) 把「RPC 面下线」
 *  也吞成空清单——降级态必须上抛，useSettings 记 pluginCatalogError、
 *  UI 呈现错误横幅 + 急救区，而非误导性"内置目录为空"） */
export async function getPluginCatalog(rpc: Rpc = wireRpc): Promise<PluginCatalogData> {
  const r = await rpc.call<{ builtin?: any[]; note?: string; local?: any[]; pending?: any[] }>('plugin/catalog');
  return {
    builtin: (r.builtin ?? []) as CatalogBuiltinRow[],
    ...(r.note ? { note: r.note } : {}),
    local: (r.local ?? []) as CatalogLocalRow[],
    pending: (r.pending ?? []) as CatalogPendingRow[],
  };
}

// ── ③c 插件市场（M24 P5：market/search + market/stage） ──

/** 市场搜索结果条目 */
export interface MarketResult {
  source: 'npm' | 'github';
  name: string;
  version?: string;
  description?: string;
  downloads?: number;
  stars?: number;
  url?: string;
  spec: string;
}

export async function marketSearch(query: string, rpc: Rpc = wireRpc): Promise<{ results: MarketResult[] }> {
  const r = await rpc.call<{ results?: MarketResult[] }>('market/search', { query });
  return { results: r.results ?? [] };
}

/** 市场安装 → 暂存待人审（来源锚定随行返回） */
export async function marketStage(
  spec: string,
  owner = 'user',
  rpc: Rpc = wireRpc,
): Promise<{ staging: StagingRecord; source: Record<string, unknown> }> {
  const r = await rpc.call<{ staging?: Record<string, any>; source?: Record<string, unknown> }>('market/stage', { spec, owner });
  return { staging: r.staging as unknown as StagingRecord, source: r.source ?? {} };
}

// ── ③d 全局默认层（M24 A1：config settings 域单键读写） ──

/** 读全局默认层全量（config.get → settings） */
export async function getGlobalSettings(rpc: Rpc = wireRpc): Promise<Record<string, any>> {
  const r = await rpc.call<{ config?: Record<string, any> }>('config/get');
  return (r.config?.settings ?? {}) as Record<string, any>;
}

/** 写一个插件的全局默认层（config/set → settings.<configNs>；value null = 删除） */
export async function setGlobalSetting(
  configNs: string,
  value: Record<string, unknown> | null,
  rpc: Rpc = wireRpc,
): Promise<void> {
  if (value === null) {
    await rpc.call('config/delete', { key: `settings.${configNs}` });
    return;
  }
  await rpc.call('config/set', { key: `settings.${configNs}`, value });
}

/** ③ 发布第一阶段：暂存待审 */
export async function stagePlugin(dir: string, owner: string, rpc: Rpc = wireRpc): Promise<{ staging: StagingRecord }> {
  const r = await rpc.call<{ staging?: Record<string, any> }>('plugin/stage', { dir, owner });
  return { staging: r.staging as unknown as StagingRecord };
}

/** ③ 人审通过后安装（grants 为 UI 勾选结果） */
export async function approvePlugin(id: string, grants: string[], rpc: Rpc = wireRpc): Promise<{ installed: PluginInfo }> {
  const r = await rpc.call<{ installed?: Record<string, any> }>('plugin/approve', { id, grants });
  return { installed: { name: String(r.installed?.name ?? ''), label: String(r.installed?.name ?? ''), source: 'installed' } };
}

/** ③ 拒绝暂存 */
export async function rejectPlugin(id: string, rpc: Rpc = wireRpc): Promise<{ success: true }> {
  await rpc.call('plugin/reject', { id });
  return { success: true };
}

/** ③ 卸载已安装插件 */
export async function uninstallPlugin(name: string, rpc: Rpc = wireRpc): Promise<{ success: true; backupDir?: string }> {
  const r = await rpc.call<{ uninstalled?: { backupDir?: string } }>('plugin/uninstall', { name });
  return { success: true, ...(r.uninstalled?.backupDir ? { backupDir: r.uninstalled.backupDir } : {}) };
}

// ── ④ 会话级插件（preview plugin/load sessionOnly + reload/unload） ──
// （市场面已摘除：preview 无插件市场，ac-plugin-market 落地后再恢复——M22 D8）

export async function getSessionPlugins(rpc: Rpc = wireRpc): Promise<{ plugins: PluginInfo[] }> {
  const r = await rpc.call<{ loaded?: Array<Record<string, any>> }>('plugin/loaded');
  return {
    // 只取会话级装载（sessionOnly===true）——已安装插件的 boot 装载不是
    // "会话插件"（B3：混入会让 dev 卡片的 loaded 徽章与卸载语义错位）
    plugins: (r.loaded ?? [])
      .filter((l) => l.sessionOnly === true)
      .map((l) => ({
        name: String(l.name ?? l.id ?? ''),
        label: String(l.name ?? ''),
        source: 'session' as const,
        ...(l.dir ? { dir: String(l.dir) } : {}),
        ...(l.agentId ? { owner: String(l.agentId) } : {}),
      })),
  };
}

export async function registerSessionPlugin(
  dir: string,
  agentId?: string,
  grants?: string[],
  rpc: Rpc = wireRpc,
): Promise<{ status: 'loaded' | 'replaced'; plugin: PluginInfo }> {
  // 后端 plugin/load 读 agentId（会话装载归属 Agent；B2：此前发 owner 字段名错配）
  const r = await rpc.call<{ status?: string; name?: string }>('plugin/load', { dir, sessionOnly: true, ...(agentId ? { agentId } : {}), ...(grants ? { grants } : {}), watch: true });
  return { status: r.status === 'replaced' ? 'replaced' : 'loaded', plugin: { name: String(r.name ?? ''), label: String(r.name ?? ''), source: 'session' } };
}

export async function unloadSessionPlugin(name: string, rpc: Rpc = wireRpc): Promise<{ success: true }> {
  await rpc.call('plugin/unload', { name });
  return { success: true };
}

/** ⑤ 权限词汇表（plugin/permissions → PluginPermissionsView） */
export async function getPermissions(rpc: Rpc = wireRpc): Promise<PluginPermissionsView> {
  const r = await rpc.call<{
    permissions?: string[];
    defaultGrants?: string[];
    executionExplicitRequired?: string[];
    reviewExplicitRequired?: string[];
  }>('plugin/permissions');
  return {
    vocabulary: (r.permissions ?? []) as PluginPermissionsView['vocabulary'],
    defaultGranted: (r.defaultGrants ?? []) as PluginPermissionsView['defaultGranted'],
    explicitRequired: [...(r.executionExplicitRequired ?? []), ...(r.reviewExplicitRequired ?? [])] as PluginPermissionsView['explicitRequired'],
  };
}

/** ⑥ 暂存目录文件树（人审） */
export async function getStagingTree(id: string, rpc: Rpc = wireRpc): Promise<{ files: StagingFileInfo[] }> {
  const r = await rpc.call<{ files?: Array<Record<string, any>> }>('plugin/staging-files', { id });
  return { files: (r.files ?? []) as unknown as StagingFileInfo[] };
}

/** ⑥ 暂存文件内容（人审只读） */
export async function getStagingFile(id: string, path: string, rpc: Rpc = wireRpc): Promise<StagingFileContent> {
  const r = await rpc.call<{ content?: string }>('plugin/staging-file', { id, path });
  return { path, content: String(r?.content ?? '') };
}

// ── ⑩ 反依赖图（M25 P3：停用承重行级联警告 + 保护行标记） ──

/** 反依赖图行节点（plugin/dep-graph；旧后端无此面 → 容忍为空） */
export async function getDepGraph(
  rpc: Rpc = wireRpc,
): Promise<{
  rows: Array<{ name: string; deps: string[]; rowDeps: string[]; dependents: string[]; protected: boolean }>;
  note?: string;
}> {
  const r = await rpc
    .call<{ rows?: Array<{ name: string; deps: string[]; rowDeps: string[]; dependents: string[]; protected: boolean }>; note?: string }>('plugin/dep-graph')
    .catch(() => ({}) as { rows?: never[]; note?: string });
  return { rows: r?.rows ?? [], ...(r?.note ? { note: r.note } : {}) };
}

// ── ⑦ 行偏好层 cordis.patch.yml（M23 P3-lite：plugin/patch-list / patch-set） ──

/** 行偏好清单（只读；fail-soft warnings 透出给前端呈现） */
export async function getPatchList(rpc: Rpc = wireRpc): Promise<{ patches: PluginPatchEntry[]; file: string; warnings: string[] }> {
  const r = await rpc.call<{ patches?: PluginPatchEntry[]; file?: string; warnings?: string[] }>('plugin/patch-list');
  return {
    patches: Array.isArray(r?.patches) ? r.patches : [],
    file: typeof r?.file === 'string' ? r.file : '',
    warnings: Array.isArray(r?.warnings) ? r.warnings : [],
  };
}

/**
 * 写一条行偏好 {id, disabled}（upsert；原子写）。
 * 三态返回（F12/M5）：'written'（带 restartRequired: true，重启生效）/
 * 'no-include-row'（偏好文件已写但进程无 include 行，无消费者）；
 * 'hot' 为保留字（include 热通道后置 P7，首期恒不返回）。
 */
export async function setPluginPatch(
  id: string,
  disabled: boolean,
  rpc: Rpc = wireRpc,
): Promise<{ state: 'hot' | 'written' | 'no-include-row'; restartRequired?: boolean; patches: PluginPatchEntry[] }> {
  const r = await rpc.call<{ state?: string; restartRequired?: boolean; patches?: PluginPatchEntry[] }>('plugin/patch-set', { id, disabled });
  const state = r?.state === 'hot' || r?.state === 'no-include-row' ? r.state : 'written';
  return {
    state,
    ...(r?.restartRequired === true ? { restartRequired: true } : {}),
    patches: Array.isArray(r?.patches) ? r.patches : [],
  };
}

/**
 * 还原行偏好层（批量，2026-08-30）：
 *   · 'factory' —— 清空全部停用条目 → 出厂 cordis.yml 全量装配；
 *   · 'minimal' —— 最小核心集（会话链 + RPC 面 + 急救 + 安全行）以外的
 *     在册行全部停用 → 安全模式基线。
 */
export async function resetPluginPatches(
  mode: 'factory' | 'minimal',
  rpc: Rpc = wireRpc,
): Promise<{ state: 'hot' | 'written' | 'no-include-row'; restartRequired?: boolean; patches: PluginPatchEntry[] }> {
  const r = await rpc.call<{ state?: string; restartRequired?: boolean; patches?: PluginPatchEntry[] }>('plugin/patch-reset', { mode });
  const state = r?.state === 'hot' || r?.state === 'no-include-row' ? r.state : 'written';
  return {
    state,
    ...(r?.restartRequired === true ? { restartRequired: true } : {}),
    patches: Array.isArray(r?.patches) ? r.patches : [],
  };
}

// ── ⑧ 事件执行链（M23 P4：events/listeners 静态读出） ──

/** 事件执行链（按事件名排序；listeners 数组序 = waterfall 执行序；owner = 裸 fiber 名） */
export async function getEventListeners(rpc: Rpc = wireRpc): Promise<{ events: EventChainEntry[] }> {
  const r = await rpc.call<{ events?: EventChainEntry[] }>('events/listeners');
  return { events: Array.isArray(r?.events) ? r.events : [] };
}

// ── ⑨ 事件描述声明 + 治理面（M25 P2） ──

/** 事件描述声明 × 执行链交叉（events/descriptions；旧后端无此面 → 容忍为空） */
export async function getEventDescriptions(
  rpc: Rpc = wireRpc,
): Promise<{ descriptions: EventDescriptionEntry[]; chains: Record<string, EventChainEntry['listeners']> }> {
  const r = await rpc
    .call<{ descriptions?: EventDescriptionEntry[]; chains?: Record<string, EventChainEntry['listeners']> }>('events/descriptions')
    .catch(() => ({}) as { descriptions?: EventDescriptionEntry[]; chains?: Record<string, EventChainEntry['listeners']> });
  return {
    descriptions: Array.isArray(r?.descriptions) ? r.descriptions : [],
    chains: r?.chains ?? {},
  };
}

/** 治理停用集（events/policy-list；行未装载 → 空呈现） */
export async function getEventPolicy(rpc: Rpc = wireRpc): Promise<{ disabled: string[]; live: string[] }> {
  const r = await rpc
    .call<{ disabled?: string[]; live?: string[] }>('events/policy-list')
    .catch(() => ({}) as { disabled?: string[]; live?: string[] });
  return { disabled: r?.disabled ?? [], live: r?.live ?? [] };
}

/** 写一条治理键（events/policy-set；返回更新后的停用集与影响提示） */
export async function setEventPolicy(
  key: string,
  disabled: boolean,
  rpc: Rpc = wireRpc,
): Promise<{ disabledList: string[]; note?: string }> {
  const r = await rpc.call<{ disabledList?: string[]; note?: string }>('events/policy-set', { key, disabled });
  return { disabledList: r?.disabledList ?? [], ...(r?.note ? { note: r.note } : {}) };
}

// ── Agent 配置（写侧 RPC：ac-agent-admin 面） ──

/** 创建新 Agent（id 留空则自动生成；src 形状 → preview AgentConfig 白名单） */
export async function createAgent(
  payload: { id?: string; name?: string; provider?: string; llm?: Record<string, any> },
  rpc: Rpc = wireRpc,
): Promise<{ success?: boolean; agentId?: string; error?: string }> {
  const config: Record<string, unknown> = {};
  if (payload.id) config.id = payload.id;
  if (payload.name) config.description = payload.name;
  if (payload.provider) config.provider = payload.provider;
  const model = payload.llm?.model;
  if (typeof model === 'string' && model) config.model = model;
  const r = await rpc.call<{ config?: { id?: string } }>('agents/create', { config });
  return { success: true, agentId: r.config?.id ?? payload.id };
}

export async function deleteAgent(agentId: string, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  await rpc.call('agents/delete', { agentId });
  return { success: true };
}

/** 模型池反查（P5 口径：池条目名 = provider 名——双字段引用无别名形态，
 *  ref 回显只按 provider 名匹配；无匹配 → undefined） */
function llmPoolRefOf(pools: Record<string, any>, provider: unknown): string | undefined {
  if (typeof provider !== 'string' || !provider) return undefined;
  const entry = pools?.[provider];
  return entry && typeof entry === 'object' ? provider : undefined;
}

/** Agent 配置双视图（get-config + SYSTEM/AGENT.md 双 read-doc 并取 + 池名回显） */
export async function getAgentConfig(agentId: string, rpc: Rpc = wireRpc): Promise<AgentConfigViews> {
  const [cfgR, sysR, agentR, poolsR] = await Promise.all([
    rpc.call<{ config?: Record<string, any> }>('agents/get-config', { agentId }),
    rpc.call<{ content?: string }>('agents/read-doc', { agentId, name: 'SYSTEM.md' }).catch(() => ({ content: undefined })),
    rpc.call<{ content?: string }>('agents/read-doc', { agentId, name: 'AGENT.md' }).catch(() => ({ content: undefined })),
    // 池反查（快照语义）：后端 AgentConfig 不存池引用——保存时引用被拆为
    // provider/model 双字段，读回按 provider 名（= 连接条目名）回显 $ref
    // （仅展示定位；池内容后续变更不追踪）。config/get 失败容忍 → 不设 $ref。
    getPools(rpc).catch(() => ({ llmProviders: {} as Record<string, any>, searchProviders: {} as Record<string, any> })),
  ]);
  const c = cfgR.config ?? {};
  const ref = llmPoolRefOf(poolsR.llmProviders, c.provider);
  const view = {
    agent_id: String(c.id ?? agentId),
    name: c.description ?? c.id ?? agentId,
    virtual: c.virtual,
    ...(Array.isArray(c.tags) ? { tags: c.tags } : {}),
    llm: {
      provider: c.provider ?? '',
      ...(c.model ? { model: c.model } : {}),
      ...(typeof c.llmParams === 'object' && c.llmParams ? c.llmParams : {}),
      ...(ref ? { $ref: ref } : {}),
    },
    ...(c.maxSteps !== undefined ? { max_steps: c.maxSteps } : {}),
    // settings.security.allowedPaths 不在此物化（原「安全」页签已移除）：
    // 唯一读写面 = 插件配置页 security 扩展卡片（assembly 契约，raw.settings）
  };
  return {
    agent_id: view.agent_id,
    raw: view,
    effective: view,
    sysContent: sysR.content ?? '',
    agentContent: agentR.content ?? '',
  };
}

/** 保存 Agent 配置（patch 映射 + 文档双写）。
 *  连接凭据已退役（P4/D3）：llm.api_key 不再上送——apiKey 归 Provider
 *  连接定义（设置 → 模型管理），Agent 面不可覆盖。 */
export async function saveAgentConfig(
  agentId: string,
  payload: { config: Record<string, any>; sysContent?: string; agentContent?: string },
  rpc: Rpc = wireRpc,
): Promise<{ success?: boolean; error?: string }> {
  const bodyCfg = payload.config ?? {};
  const llm = (bodyCfg.llm ?? {}) as Record<string, any>;
  const patch: Record<string, unknown> = {};
  if (bodyCfg.name !== undefined) patch.description = bodyCfg.name;
  if (llm.provider !== undefined) patch.provider = llm.provider || undefined;
  // model ''/null = 显式清除（「默认」= 按全局设置的默认模型处理）——
  // 服务端 deepMerge 以 null 覆盖落存，投递侧回落默认池连接
  if (llm.model !== undefined) patch.model = llm.model || null;
  const lp: Record<string, unknown> = {};
  for (const k of LLM_SAMPLING_KEYS) {
    if (llm[k] !== undefined) lp[k] = llm[k];
  }
  if (Object.keys(lp).length) patch.llmParams = lp;
  if (bodyCfg.max_steps !== undefined) patch.maxSteps = bodyCfg.max_steps;
  // 能力标签（P6）：AgentPane 徽章编辑写 raw.tags → AgentConfig.tags
  if (bodyCfg.tags !== undefined) patch.tags = bodyCfg.tags;
  // 路径穿透白名单（settings.security.allowedPaths）不在此映射（原「安全」
  // 页签已移除）：唯一写口 = 插件配置页 security 扩展卡片，走 assembly 契约
  await rpc.call('agents/update-config', { agentId, patch });
  // 文档双写：空串=删（sysEnabled off 语义）
  if (typeof payload.sysContent === 'string') {
    await rpc.call('agents/save-doc', { agentId, name: 'SYSTEM.md', content: payload.sysContent }).catch(() => undefined);
  }
  if (typeof payload.agentContent === 'string') {
    await rpc.call('agents/save-doc', { agentId, name: 'AGENT.md', content: payload.agentContent }).catch(() => undefined);
  }
  return { success: true };
}

export async function getAgentTimers(agentId: string, rpc: Rpc = wireRpc): Promise<{ entries: TimerEntry[] }> {
  const r = await rpc.call<{ entries?: TimerEntry[] }>('timer/entries', { agentId });
  return { entries: r.entries ?? [] };
}

export async function saveAgentTimers(agentId: string, entries: TimerEntry[], rpc: Rpc = wireRpc): Promise<{ entries: TimerEntry[] }> {
  await rpc.call('timer/save', { agentId, entries });
  return { entries }; // 回显保存值
}

// ── 杀手锏兜底（preview 无原生文件对话框：显式失败，SettingField 走手输路径） ──

export async function browseFile(_accept?: string, _title?: string): Promise<{ success: boolean; path?: string }> {
  return { success: false };
}
