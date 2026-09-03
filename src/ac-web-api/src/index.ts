// ============================================================
// ac-web-api —— WS RPC 业务方法注册行（薄编排层，M7 §二A）
//
// 职责唯一：把 preview 各域服务面经 ctx.webServer.registerRpc 显式注册
// （注册即归属：摘本行 = RPC 面整体下线，各域服务与传输层互不影响）。
//
//   · 命名：preview 目录风格 domain/action（rpc 方法名与事件名是两个
//     命名空间，不冲突）；方法面按消费域显式注册，弃 src 反射全量
//   · 边界铁律（M7 决策 #4）：纯编排——inject 已有服务、参数窄化、
//     转发调用、outcome→ack 映射；零业务逻辑（业务住各域服务）
//   · ack 映射：deliver outcome steered/queued → ws/ack busy；
//     placement='next-run' 且会话忙 → 预发 ws/ack parked（等闲停靠的
//     中间态上报）；timeout → rpc error（消息未投递）
//
// 方法面（src WS 协议对照，preview 命名）：
//   conversation/deliver      ≡ chat.send（+ack busy/parked/deduped）
//   conversation/interrupt    ≡ chat.interrupt
//   conversation/stats        （运行快照；UI 忙闲指示）
//   interaction/list|reply    ≡ chat.interact.respond（+待答清单）
//   session/history           ≡ history.request
//   session/delete-message    ≡ chat.delete_message
//   agents/list               ≡ agent.list
//   agents/tool-defs          ≡ agent.tool_defs（生效集）
//   group/list|create|delete|join|leave|send|history ≡ group.*
//   usage/tokens              ≡ usage.tokens
//   timer/list|entries|save|trigger   （M17-A：定时任务管理面）
//   backup/run                （M17-A：数据备份面。backup/list·jobs/* 四法·
//                              plugin/reload 系同批防御性垫面，无产品调用方
//                              已删[2026-08-31 审计遗留#1]——服务面保留：
//                              jobs 由 ac-shell-tools/subagent 进程内消费、
//                              备份列表内嵌 run 载荷、插件重载走 watch 自动）
//   config/get|set|delete     （M17-A：全局配置面，白名单键 + sanitize）
//   llm/providers             （M17-A：模型池查看面）
//   plugin/*                  （M17-A：插件库全流程 + 权限词汇表；
//                              M18 增 plugin/rows = cordis 装配行清单，
//                              2026-08-28 附 package.json 元数据；
//                              M22 增 extension-catalog 扩展目录 /
//                              dev-scan 开发目录扫描 / loaded 附 failed[]）
//   system/version|restart    （M17-A：版本面 + 重启触发面）
//   workspace/browse-dirs     （M18：本机目录浏览——路径穿透白名单的
//                              文件夹选择弹窗数据源，只列目录名）
//   session/tokens            （M18：补 maxContextTokens/usagePercent/
//                              avgTokensPerMsg/estimatedMsgsRemaining——
//                              会话头 Token 仪表的分母与派生值）
//   （agent.config 归 ac-agent-admin 行注册——写侧能力随其行走；
//    file.upload 低优延后，见 docs/m7-webui-plan.md）
// ============================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@agentchat/cordis';
import { capabilitySetOf, resolveToolNames, toolAllowedFor } from 'ac-agents';
import { pairKey } from 'ac-agent-loop';
import { OpenAICompletions } from 'ac-openai-completions';
import { normalizePoolModels, type PoolModelEntry } from 'ac-llm-pool';
import type { LlmAttachment, LlmMessage } from 'ac-llm';
import {
  DEFAULT_GRANTED_PERMISSIONS,
  EXECUTION_EXPLICIT_REQUIRED,
  HOST_CONTRACTS_VERSION,
  KNOWN_PERMISSIONS,
  REVIEW_EXPLICIT_REQUIRED,
  type PluginPermission,
} from 'ac-plugin-core';
import { GLOBAL_TIMER_OWNER, type TimerEntry } from 'ac-timer';
import { requestSystemRestart } from 'ac-restart';
import { guessContentType } from 'ac-workspace';
import { computeRowAggregates } from 'ac-event-policy';
import type { ExtensionMeta, ExtensionFieldMeta, ExtensionListenerMeta } from 'ac-extension-core';
import type { MultipartBody } from 'ac-web-server';

// 类型层认识各域（运行时按服务 key 解耦；type-only 零依赖）
import type {} from 'ac-conversation';
import type {} from 'ac-session';
import type {} from 'ac-agents';
import type {} from 'ac-group';
import type {} from 'ac-usage';
import type {} from 'ac-durable-interaction';
import type {} from 'ac-tools';
import type {} from 'ac-llm';
import type {} from 'ac-archive';
import type {} from 'ac-backup';
import type {} from 'ac-config';
import type {} from 'ac-plugin-registry';
import type {} from 'ac-workspace';
import type {} from 'ac-agent-store';
import type {} from 'ac-singles';

export const name = 'ac-web-api';

export const inject = [
  'webServer',
  'conversation',
  'session',
  'agents',
  'group',
  'usage',
  'durableInteraction',
  'tools',
  'timers',
  'backup',
  'config',
  'credentials',
  'llm',
  'pluginRegistry',
  'workspace',
  'agentStore',
];

// ---- 参数窄化（薄行自持；缺参/类型不符 → rpc error） ----

function obj(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v === '') throw new Error(`参数 ${key} 缺失或非非空字符串`);
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 分页参数：非负整数（越界/非法 → undefined，按缺省处理） */
function optPageNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

// ---- M17-A 配置面：白名单键 + 掩码 sanitize ----

/**
 * 全局配置可写键白名单（设置面板词汇）：settings 域只写这些键，
 * 其余（app 内部键）由各域服务自行拥有。点路径首段命中即放行。
 */
const CONFIG_KEY_PREFIXES = new Set(['llm', 'llmProviders', 'searchProviders', 'timer', 'tool', 'ui', 'session', 'settings']);

/** 掩码值（与 src settings/schema.ts sanitizeGlobalConfig 同款） */
const API_KEY_MASK = '••••••••';

/** 白名单校验：点路径首段须在可写集合内（未知键 fail-closed） */
function assertConfigKey(key: string): void {
  const first = key.split('.')[0];
  if (!first || !CONFIG_KEY_PREFIXES.has(first)) {
    throw new Error(`config 键 "${key}" 不在可写白名单（${[...CONFIG_KEY_PREFIXES].join('/')}）`);
  }
}

/**
 * 保存前 sanitize（src sanitizeGlobalConfig 的收编）：递归剥离值等于
 * 掩码的字段（api_key/tavily 等打码凭据绝不回写盘）。
 */
function sanitizeConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitizeConfigValue(v));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === API_KEY_MASK) continue;
    out[k] = sanitizeConfigValue(v);
  }
  return out;
}

// ---- 池凭据侧信道（src /api/config 的提取/回填语义收编）----
// 池条目的 api_key 不落 config.json：保存时提取进 ctx.credentials
// （全局级，credId 'pool:<名>'/'searchpool:<名>'）；读取时回填掩码
// 指示"已设置"。掩码值 = 保持不变；空串 = 删除凭据。

/** 池域 → 凭据 id 前缀 */
const POOL_CRED_PREFIX: Record<string, string> = {
  llmProviders: 'pool:',
  searchProviders: 'searchpool:',
};

/**
 * 提取池条目 api_key 进凭据库并从 payload 剥离（就地变异深拷贝值）。
 * 返回剥离后的同形状值（可直接进 config.set）。
 */
function extractPoolCredentials(
  ctx: Context,
  key: string,
  value: unknown,
): unknown {
  const prefix = POOL_CRED_PREFIX[key];
  if (!prefix || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
      name.startsWith('$')
    ) {
      out[name] = entry;
      continue;
    }
    const e = { ...(entry as Record<string, unknown>) };
    const apiKey = e.api_key;
    if (typeof apiKey === 'string' && apiKey !== API_KEY_MASK) {
      // 非掩码 = 新值或空串（空串 = 删除）；掩码 = 保持不变（不触凭据库）
      ctx.credentials.setGlobal(`${prefix}${name}`, apiKey);
    }
    delete e.api_key;
    out[name] = e;
  }
  return out;
}

/** config/get 深拷贝上回填池条目 api_key 掩码（'' = 未设置） */
function backfillPoolMasks(ctx: Context, config: Record<string, unknown>): void {
  for (const [key, prefix] of Object.entries(POOL_CRED_PREFIX)) {
    const pool = config[key];
    if (pool === null || typeof pool !== 'object' || Array.isArray(pool)) continue;
    for (const [name, entry] of Object.entries(pool as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      (entry as Record<string, unknown>).api_key = ctx.credentials.getGlobal(`${prefix}${name}`)
        ? API_KEY_MASK
        : '';
    }
  }
}

/** 定时条目形状校验（设置面板 timer/save 入站；非法抛错——防脏配置落盘） */
function validateTimerEntries(raw: unknown): TimerEntry[] {
  if (!Array.isArray(raw)) throw new Error('参数 entries 须为 TimerEntry 数组');
  return raw.map((item, i) => {
    if (item === null || typeof item !== 'object') throw new Error(`entries[${i}] 非对象`);
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '') throw new Error(`entries[${i}].id 缺失`);
    if (e.mode !== 'time' && e.mode !== 'delay' && e.mode !== 'random' && e.mode !== 'workday' && e.mode !== 'holiday') {
      throw new Error(`entries[${i}].mode 非法（${String(e.mode)}）`);
    }
    if (typeof e.hint !== 'string') throw new Error(`entries[${i}].hint 须为字符串`);
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') throw new Error(`entries[${i}].enabled 须为 boolean`);
    return e as unknown as TimerEntry;
  });
}

/** 读根包版本（import.meta.url 相对定位；兜底 cwd 向上走查 package.json） */
function readRootPackage(): { name: string; version: string } | undefined {
  const candidates: string[] = [];
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'));
  } catch {
    /* import.meta.url 不可用（打包态）→ 走 cwd 兜底 */
  }
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    candidates.push(join(dir, 'package.json'));
    dir = join(dir, '..');
  }
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf-8')) as { name?: unknown; version?: unknown };
      if (typeof pkg.version === 'string') {
        return { name: typeof pkg.name === 'string' ? pkg.name : 'agentchat', version: pkg.version };
      }
    } catch {
      /* 该候选不存在/不可读 → 下一个 */
    }
  }
  return undefined;
}

/** deliver 的入站消息：字符串或 {role, content} 形 LlmMessage（role 白名单校验）。
 *  多模态：可选 attachments（媒体引用旁挂）白名单校验透传——kind ∈
 *  image/video/file、ref 必填字符串、mime/filename/detail 选填字符串、
 *  单条 ≤50 个、ref ≤2048 字符。 */
function messageOf(v: unknown): string | LlmMessage {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'object' && v !== null) {
    const m = v as { role?: unknown; content?: unknown; name?: unknown; attachments?: unknown };
    const role = m.role;
    if (
      (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') &&
      typeof m.content === 'string'
    ) {
      return {
        role,
        content: m.content,
        ...(typeof m.name === 'string' ? { name: m.name } : {}),
        ...(attachmentsOf(m.attachments) !== undefined ? { attachments: attachmentsOf(m.attachments) } : {}),
      };
    }
  }
  throw new Error('参数 message 缺失（须为非空字符串或 {role, content}）');
}

/** attachments 入参白名单校验（非法/为空 → undefined = 不携带） */
function attachmentsOf(v: unknown): LlmAttachment[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length === 0) return undefined;
  if (v.length > 50) throw new Error('参数 attachments 超限（单条消息最多 50 个附件）');
  const out: LlmAttachment[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (
      !((a.kind === 'image' || a.kind === 'video' || a.kind === 'file') && typeof a.ref === 'string' && a.ref)
    ) {
      continue;
    }
    if (a.ref.length > 2048) continue;
    out.push({
      kind: a.kind,
      ref: a.ref,
      ...(typeof a.mime === 'string' ? { mime: a.mime } : {}),
      ...(typeof a.filename === 'string' ? { filename: a.filename } : {}),
      ...(a.detail === 'low' || a.detail === 'high' || a.detail === 'original' || a.detail === 'auto'
        ? { detail: a.detail }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

// ============================================================
// plugin/rows 行元数据（扩展面板描述数据源，2026-08-28 前端反馈 #2）
// cordis registry 的 Runtime 只有 name/fibers——描述回归各包 package.json
// （单一事实源，57 个 ac-* 行零改动）。解析失败（loader/include 内部行、
// ctx.inject 内联回调等非包行）→ origin 'internal'，前端过滤不进插件目录。
// ============================================================

/** 行元数据解析结果（按行名缓存；RPC 只读面，进程内稳定） */
interface RowMeta {
  /** package = 可解析到同名 package.json 的装配/供应商行；internal = 进程内部行 */
  origin: 'package' | 'internal';
  description?: string;
  version?: string;
}

const rowMetaCache = new Map<string, RowMeta>();
/** Node 解析器（import.meta.url 锚定：workspace 裸包名经根 node_modules 链接可解析） */
const nodeRequire = createRequire(import.meta.url);

/**
 * 行名 → 包元数据：
 *   · 先试 `${name}/package.json`（显式导出 package.json 的包，如 @agentchat/cordis）
 *   · 回退解析包入口 `${name}` → 入口目录上一级 package.json（ac-* 包
 *     exports 只开放 "."/"./src/*"，入口 dirname 的父目录即包根）
 *   · 仅当解析到的 package.json `name` 与行名一致才采信（防入口旁的
 *     无关 package.json 误标 description/origin）
 */
function rowMetaOf(name: string | undefined): RowMeta {
  const key = name && name !== '(anonymous)' ? name : '(anonymous)';
  const cached = rowMetaCache.get(key);
  if (cached) return cached;
  const meta: RowMeta = { origin: 'internal' };
  if (key !== '(anonymous)') {
    for (const spec of [`${key}/package.json`, key]) {
      try {
        const resolved = nodeRequire.resolve(spec);
        const pkgPath = spec.endsWith('package.json')
          ? resolved
          : join(dirname(resolved), '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
          name?: unknown;
          description?: unknown;
          version?: unknown;
        };
        if (pkg.name !== key) break; // 名不符 → 不采信（内联行等）
        meta.origin = 'package';
        if (typeof pkg.description === 'string' && pkg.description !== '') meta.description = pkg.description;
        if (typeof pkg.version === 'string' && pkg.version !== '') meta.version = pkg.version;
        break;
      } catch {
        /* 该解析形态不可行 → 试下一个 */
      }
    }
  }
  rowMetaCache.set(key, meta);
  return meta;
}

// ============================================================
// 内置组包源缓存（M24 X2 优化）：plugin/catalog 每次 RPC 原先全量重读
// 73 个 package.json——mtime 失效缓存后仅首次/变更后读盘（rowMetaCache
// 同款思路，加失效判据）。
// ============================================================

/** 内置组扫描采信的 package.json 形状 */
interface BuiltinPkgJson {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  /** 声明命名空间：`{ plugin: true }` = 本包是 AgentChat 插件（可装配单元） */
  agentchat?: { plugin?: unknown } | undefined;
}

const builtinPkgCache = new Map<string, { mtimeMs: number; pkg: BuiltinPkgJson | null }>();

/** 读单个包的 package.json（缺失/损坏 → null；mtime 未变走缓存） */
function readBuiltinPkg(file: string): BuiltinPkgJson | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = builtinPkgCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.pkg;
  let pkg: BuiltinPkgJson | null = null;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf-8')) as BuiltinPkgJson;
  } catch {
    pkg = null;
  }
  builtinPkgCache.set(file, { mtimeMs, pkg });
  return pkg;
}

// ============================================================
// 扩展目录（M22 D4① 静态起步 → 2026-08-30 A1 注册制落地）：UI「扩展」
// 单元 = 消费事件的扩展行。条目 = 行包**入口模块自述**
// `export const extension: ExtensionMeta`（契约住 ac-extension-core 纯库），
// 本行扫描 cordis registry 聚合（collectExtensionCatalog）——行装载即
// 条目在、卸载即条目失，覆盖面随行声明自动生长（静态表退役；M25
// ctx.on description 监听器自述的同款"声明即注册"模式）。
// ============================================================

/** 扩展目录条目（plugin/extension-catalog 载荷元素；包内构造——wire 面为 JSON） */
interface ExtensionCatalogEntry {
  /** AgentConfig.settings 键（persona/memory/…；动态插件 = manifest.name） */
  name: string;
  /** 装配行包名；可见性 = row ∈ plugin/rows */
  row: string;
  label: string;
  description: string;
  /** 事件落点（listeners[].event 去重派生；空 = 纯能力供给行，如 web-tools 工具行） */
  targets: string[];
  /** 基础设施行：装载即生效，per-Agent 不可关 */
  automatic?: boolean;
  /** 全局默认参数命名空间（M24 P4 弹窗数据源：插件库·配置弹窗写 config/set → settings.<configNs>） */
  configNs?: string;
  /**
   * per-Agent 参数面字段（settings[name].*；形状由 owning 行实现声明）。
   * 2026-08-30 演进：string → string | {name, description?}——配置弹窗
   * 渲染字段级描述（不然用户不清楚每个配置的作用）；裸 string 兼容保留。
   * 其后追加 type/enum 形状提示（控件渲染依据——原样透传，见
   * ExtensionFieldMeta）。
   */
  fields?: Array<string | ExtensionFieldMeta>;
  /** 监听器级声明（M25 P2：事件描述 + 角色 + facet + respectsEnabled；形状 = ExtensionListenerMeta） */
  listeners?: ExtensionListenerMeta[];
}

/**
 * 扩展目录收集（A1 注册制）：扫描 cordis registry 读取行包入口模块的
 * 自述 `export const extension: ExtensionMeta`。派生：row = runtime 名；
 * targets = listeners[].event 去重；configNs = name（仅 fields 非空时
 * 透出 = ⚙ 可配置判据）。name 去重（首见为准）、name 序稳定输出；
 * 非自述行 / 形状不符如实跳过（fail-soft，不炸 RPC 面）。
 */
function collectExtensionCatalog(ctx: Context): ExtensionCatalogEntry[] {
  const byName = new Map<string, ExtensionCatalogEntry>();
  for (const runtime of ctx.registry.values()) {
    if (!runtime.name) continue;
    // 行包入口模块的自述（Runtime.plugin = 首次注册时的源插件对象——
    // vendor registry 检视面；registry 本体零应用词汇）
    const meta = (runtime as unknown as { plugin?: { extension?: unknown } }).plugin?.extension;
    if (
      !meta || typeof meta !== 'object' ||
      typeof (meta as { name?: unknown }).name !== 'string' ||
      typeof (meta as { label?: unknown }).label !== 'string' ||
      typeof (meta as { description?: unknown }).description !== 'string'
    ) continue;
    const m = meta as ExtensionMeta;
    if (byName.has(m.name)) continue;
    const listeners = m.listeners ?? [];
    byName.set(m.name, {
      name: m.name,
      row: runtime.name,
      label: m.label,
      description: m.description,
      targets: [...new Set(listeners.map((l) => l.event))],
      ...(m.automatic ? { automatic: true } : {}),
      ...((m.fields?.length ?? 0) > 0 ? { configNs: m.name, fields: m.fields } : {}),
      ...(listeners.length > 0 ? { listeners } : {}),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * viewer 虚拟 Agent id（连接侧单点声明，M19/D3）：直答路径的对键在此
 * 边界显式计算（pairKey(VIEWER, agentId)），后端服务不猜 viewer。
 * 多 viewer 鉴权不在 M19 范围（管道可承载；本常量是唯一 viewer 假设点）。
 */
const VIEWER_AGENT_ID = 'user';

/** 对桶会话键 → 承载 Agent id（非 viewer 端；自会话/两端皆 Agent 时取已注册端） */
function agentOfPair(conversationId: string, has: (id: string) => boolean): string {
  if (!conversationId.includes('~')) return conversationId;
  const parts = conversationId.split('~');
  return (
    parts.find((p) => p !== VIEWER_AGENT_ID && has(p)) ??
    parts.find((p) => has(p)) ??
    conversationId
  );
}

/** vendor hook 行形状（_hooks 私有读取的只读视景元素） */
type HookRow = { ctx?: { fiber?: { name?: string } }; prepend?: boolean; global?: boolean; description?: string };
type HooksTable = Record<string, HookRow[]>;

/**
 * vendor 事件表只读视景（events/listeners · events/descriptions 两处共用；
 * events 层无公开列举 API，_hooks 私有读取是唯一路径——RPC 形状测试兜底
 * vendor 升级）。每事件为**有序** Hook 数组（数组序 = waterfall 执行序）。
 */
function hooksTableOf(ctx: Context): HooksTable {
  return (ctx.events as unknown as { _hooks: HooksTable })._hooks;
}

/**
 * 公开事件执行链（events/listeners 与 events/descriptions 共用读取核）：
 * 跳过 internal/*，仅保留有 ctx 的监听器，owner = fiber 名（缺省匿名）。
 */function chainEntriesOf(ctx: Context): Record<string, Array<{ owner: string; prepend: boolean; global: boolean; description?: string }>> {
  const chains: Record<string, Array<{ owner: string; prepend: boolean; global: boolean; description?: string }>> = {};
  for (const [name, hooks] of Object.entries(hooksTableOf(ctx))) {
    if (typeof name !== 'string' || name.startsWith('internal/')) continue;
    const listeners = (hooks ?? [])
      .filter((h) => h?.ctx)
      .map((h) => ({
        owner: h.ctx!.fiber?.name ?? '(anonymous)',
        prepend: h.prepend === true,
        global: h.global === true,
        ...(typeof h.description === 'string' && h.description ? { description: h.description } : {}),
      }));
    if (listeners.length > 0) chains[name] = listeners;
  }
  return chains;
}

/** runtime 的在役 fiber 清单（uid 非空 = 未卸载；plugin/catalog 与 plugin/rows 统计共用判据） */
function liveFibersOf<F extends { uid: number | null }>(runtime: { fibers: Iterable<F> }): F[] {
  return [...runtime.fibers].filter((f) => f.uid !== null);
}

export function apply(ctx: Context) {
  const web = ctx.webServer;

  // ============ conversation：投递 / 中止 / 快照 ============

  web.registerRpc('conversation/deliver', async (params, caller) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    // 附件引用与 message 平级（webui 发送面）：白名单校验后并入消息——
    // 字符串消息升级为 {role:'user', content, attachments}；对象消息合并
    // （平级 attachments 优先于 message 内嵌的同名字段）。
    const siblingAttachments = attachmentsOf(p.attachments);
    const parsed = messageOf(p.message);
    const message =
      siblingAttachments === undefined
        ? parsed
        : typeof parsed === 'string'
          ? { role: 'user' as const, content: parsed, attachments: siblingAttachments }
          : { ...parsed, attachments: siblingAttachments };
    const placementRaw = optStr(p.placement);
    // 白名单窄化（source 同款纪律）：lane/placement 只接受目录词汇，非法值按缺省丢弃
    const placement = placementRaw === 'steer' || placementRaw === 'next-run' ? placementRaw : undefined;
    const laneRaw = optStr(p.lane);
    const lane = laneRaw === 'next-step' || laneRaw === 'next-turn' ? laneRaw : undefined;
    const sender = optStr(p.sender) ?? VIEWER_AGENT_ID;
    const source = optStr(p.source);
    // 直答路径的会话键在此显式计算（M19/D3：边界算则前端透传——前端
    // 不传 conversationId；群/独立会话显式传键不受影响）
    const conversationId = optStr(p.conversationId) ?? pairKey(sender, agentId);
    // 会话级模型覆盖合并点（P6/D4）：显式入参优先（临时换模不回写）；
    // 缺省时查 conv-settings（非 singles 会话——独立会话的覆盖恒走
    // session.json，防双源）。两服务均为可选能力（行未装 = 无覆盖语义）。
    let modelOverride = optStr(p.model);
    if (!modelOverride) {
      const singles = ctx.get('singles', false) as
        | { get(sid: string): unknown }
        | undefined;
      const notSingle = !singles || singles.get(conversationId) === null;
      const convSettings = ctx.get('convSettings', false) as
        | { get(conversationId: string): { model?: string } }
        | undefined;
      if (notSingle && convSettings) {
        const stored = convSettings.get(conversationId).model;
        if (stored) modelOverride = stored;
      }
    }
    // 等闲停靠预报（outcome timeout 前的中间态）：next-run + 忙 → parked
    if (placement === 'next-run' && ctx.conversation.isBusy(agentId, conversationId)) {
      caller.ack('parked', { agentId, conversationId });
    }
    const outcome = await ctx.conversation.deliver(agentId, message, {
      conversationId,
      sender,
      ...(source === 'user' || source === 'agent' || source === 'event' ? { source } : {}),
      ...(lane ? { lane } : {}),
      ...(placement ? { placement } : {}),
      ...(optNum(p.timeoutMs) !== undefined ? { timeoutMs: optNum(p.timeoutMs) } : {}),
      // M18-G + P6：会话级模型覆盖（入参 > conv-settings 存储）透传 router 信封
      ...(modelOverride ? { model: modelOverride } : {}),
    });
    if (outcome.kind === 'steered') {
      // busy ack 附 agentId（前端提示文案取名；steered = 已插话注入）
      caller.ack('busy', { agentId, conversationId, handle: outcome.handle });
    } else if (outcome.kind === 'queued') {
      caller.ack('busy', { agentId, conversationId, queued: true, handle: outcome.handle });
    } else if (outcome.kind === 'timeout') {
      throw new Error('会话忙：next-run 等待空闲超时，消息未投递');
    }
    return outcome;
  });

  web.registerRpc('conversation/interrupt', (params) => {
    const p = obj(params);
    return { aborted: ctx.conversation.abort(reqStr(p, 'agentId'), optStr(p.conversationId)) };
  });

  web.registerRpc('conversation/stats', () => ctx.conversation.stats());

  // ============ conversation：next-turn 排队面（DSH queue 姿势） ============

  // 会话键解析与 deliver 同口径（前端直答路径不传 conversationId——
  // 边界显式算 viewer 对桶键，D3；singles/群显式传键不受影响）
  const queueConversationId = (p: Record<string, unknown>): string | undefined =>
    optStr(p.conversationId) ?? pairKey(optStr(p.sender) ?? VIEWER_AGENT_ID, reqStr(p, 'agentId'));

  web.registerRpc('conversation/queue', (params) => {
    const p = obj(params);
    return { items: ctx.conversation.queue(reqStr(p, 'agentId'), queueConversationId(p)) };
  });

  web.registerRpc('conversation/queue-remove', (params) => {
    const p = obj(params);
    return { removed: ctx.conversation.removeQueued(reqStr(p, 'agentId'), queueConversationId(p), reqStr(p, 'id')) };
  });

  web.registerRpc('conversation/queue-steer', (params) => {
    const p = obj(params);
    // outcome：steered = 已注入活跃 run；requeued = 窗口已关放回原位
    //（DSH 收敛竞态——不报失败，仍按队列投递）；not-found = 已消费/已删
    return { outcome: ctx.conversation.steerQueued(reqStr(p, 'agentId'), queueConversationId(p), reqStr(p, 'id')) };
  });

  // ============ interaction：待答清单 / 应答 ============

  web.registerRpc('interaction/list', (params) => {
    const p = obj(params);
    const state = optStr(p.state);
    return {
      interactions: ctx.durableInteraction.list({
      ...(optStr(p.key) ? { key: optStr(p.key) } : {}),
      ...(optStr(p.owner) ? { owner: optStr(p.owner) } : {}),
      ...(state === 'pending' || state === 'answered' || state === 'closed' ? { state } : {}),
    }),
    };
  });

  web.registerRpc('interaction/reply', (params) => {
    const p = obj(params);
    return ctx.durableInteraction.reply(reqStr(p, 'id'), (p.answer ?? null) as never);
  });

  // ============ session：历史回放 / 删消息 / 归档触发 ============

  web.registerRpc('session/history', async (params) => {
    const p = obj(params);
    const conversationId = reqStr(p, 'conversationId');
    // 服务端分页（M16）：limit/offset 从尾部往回取——offset = 跳过最新的
    // offset 条，limit = 页大小（缺省 = 全量回读，向后兼容旧调用方）。
    // 返回 total（总条数）与 hasMore（更早是否还有），前端据此判上翻。
    const limit = optPageNum(p.limit);
    const offset = optPageNum(p.offset) ?? 0;
    const all = await ctx.session.records(conversationId);
    const summary = ctx.session.summary(conversationId);
    const page =
      limit === undefined
        ? all
        : all.slice(Math.max(0, all.length - offset - limit), Math.max(0, all.length - offset));
    return {
      conversationId,
      records: page,
      total: all.length,
      ...(limit !== undefined ? { hasMore: offset + limit < all.length } : {}),
      ...(summary !== undefined ? { summary } : {}),
    };
  });

  web.registerRpc('session/delete-message', async (params) => {
    const p = obj(params);
    const deleted = await ctx.session.deleteMessage(reqStr(p, 'conversationId'), reqStr(p, 'messageId'));
    return { deleted };
  });

  // 截断（M17-C 行内编辑 truncateAfter）：删除该消息及其后全部记录
  web.registerRpc('session/truncate', async (params) => {
    const p = obj(params);
    const removed = await ctx.session.truncateAfter(reqStr(p, 'conversationId'), reqStr(p, 'messageId'));
    return { removed };
  });

  // 归档触发（src session.compress 对照）：archive 为可选能力——非 strict
  // 解析，未装载时方法存在但返回错误（摘 archive 行不拖垮整个 RPC 面）。
  // 受理即返回（整理 run + 归档重建后台进行；完成经 archive/completed 广播）。
  web.registerRpc('session/archive', (params) => {
    const p = obj(params);
    const conversationId = reqStr(p, 'conversationId');
    const agentId = optStr(p.agentId) ?? agentOfPair(conversationId, (id) => ctx.agents.has(id));
    const archive = ctx.get('archive', false) as
      | { requestArchive(cid: string, aid: string): Promise<void> }
      | undefined;
    if (!archive) throw new Error('archive 服务未装载（归档触发不可用）');
    void archive.requestArchive(conversationId, agentId).catch((err: unknown) => {
      ctx.logger.warn(`[web-api] 归档触发失败（${conversationId}）: ${String(err)}`);
    });
    return { triggered: true, conversationId, agentId };
  });

  // ============ agents：清单 / 工具生效集 ============

  web.registerRpc('agents/list', () => ({
    // 预设 Agent（__standard__ 等）不进名册（src 过滤语义）：仅供独立会话选用，
    // 目录见 agents/presets
    agents: ctx.agents.list().filter((a) => a.preset !== true),
  }));

  // 预设 Agent 目录（独立会话选用 UI / 空会话默认路由目标；可选能力行——
  // 语义见 session/archive 处权威注释）。
  web.registerRpc('agents/presets', () => {
    const presets = ctx.get('agentPresets', false) as
      | { list(): Array<{ meta: { label: string; description?: string; default?: boolean } ; agent: { id: string; description?: string } }> }
      | undefined;
    if (!presets) throw new Error('agentPresets 服务未装载（预设目录不可用）');
    return {
      presets: presets.list().map((d) => ({
        id: d.agent.id,
        name: d.agent.description ?? d.agent.id,
        label: d.meta.label,
        description: d.meta.description ?? '',
        default: d.meta.default === true,
      })),
    };
  });

  web.registerRpc('agents/tool-defs', (params) => {
    const agentId = reqStr(obj(params), 'agentId');
    const config = ctx.agents.require(agentId);
    // 可见面与 router 信封同口径（2026-09-02 反馈 #1）：能力门禁（requiredTags）
    // 先过滤，再按 AgentConfig.tools 解析 include/exclude
    const caps = capabilitySetOf(ctx, agentId);
    const all = ctx.tools.list().filter((t) => toolAllowedFor(t, caps)).map((t) => t.name);
    const names = resolveToolNames(config.tools, all) ?? all;
    // defs：生效集的完整定义（description/parameters；execute 不跨 JSON）
    const defs = ctx.tools
      .list()
      .filter((t) => names.includes(t.name))
      .map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.parameters ?? {} }));
    return { agentId, names, defs };
  });

  // 全量工具目录（M17-A：ExtToolsPane 数据源；含 requiredTags 能力门禁）
  web.registerRpc('tools/list', () => ({
    tools: ctx.tools.list().map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? {},
      ...(t.requiredTags ? { requiredTags: t.requiredTags } : {}),
    })),
  }));

  // ============ group：成员表 / 投递 / 历史 ============

  web.registerRpc('group/list', () => ({ groups: ctx.group.list() }));

  web.registerRpc('group/create', (params) => {
    const p = obj(params);
    const id = optStr(p.id) ?? `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const members = Array.isArray(p.members) ? p.members.map(String) : [];
    const group = ctx.group.create({
      id,
      name: reqStr(p, 'name'),
      members,
      ...(optStr(p.description) ? { description: optStr(p.description) } : {}),
    });
    return { group };
  });

  web.registerRpc('group/delete', (params) => ({
    deleted: ctx.group.delete(reqStr(obj(params), 'groupId')),
  }));

  web.registerRpc('group/join', (params) => {
    const p = obj(params);
    return { joined: ctx.group.join(reqStr(p, 'groupId'), reqStr(p, 'agentId')) };
  });

  web.registerRpc('group/leave', (params) => {
    const p = obj(params);
    return { left: ctx.group.leave(reqStr(p, 'groupId'), reqStr(p, 'agentId')) };
  });

  web.registerRpc('group/rename', (params) => {
    const p = obj(params);
    return { renamed: ctx.group.rename(reqStr(p, 'groupId'), reqStr(p, 'name')) };
  });

  web.registerRpc('group/send', async (params) => {
    const p = obj(params);
    // 多模态附件引用（M4 群聊图片）：白名单校验后随本体落盘 + hint 信封直达
    const attachments = attachmentsOf(p.attachments);
    // trigger 语义（受理即返回；参与者 run 在后台进行，事件面照常广播）
    const result = await ctx.group.send(reqStr(p, 'groupId'), reqStr(p, 'from'), reqStr(p, 'content'), {
      ...(attachments !== undefined ? { attachments } : {}),
    });
    return { message: result.message, triggered: result.triggered };
  });

  web.registerRpc('group/history', async (params) => {
    const p = obj(params);
    const groupId = reqStr(p, 'groupId');
    return {
      groupId,
      messages: await ctx.group.records(groupId, optNum(p.limit) ?? 50, optNum(p.offset) ?? 0),
    };
  });

  // ============ singles：独立会话元数据（M18-G） ============

  // singles 为可选能力行（语义见 session/archive 处权威注释）
  function requireSingles() {
    const singles = ctx.get('singles', false) as
      | {
          listActive(): unknown[];
          create(input?: unknown): unknown;
          update(id: string, input: unknown): unknown;
          archive(id: string): unknown;
          remove(id: string): void;
        }
      | undefined;
    if (!singles) throw new Error('singles 服务未装载（独立会话面不可用）');
    return singles;
  }

  web.registerRpc('singles/list', () => ({ singles: requireSingles().listActive() }));

  web.registerRpc('singles/create', (params) => {
    const p = obj(params);
    const single = requireSingles().create({
      ...(optStr(p.agentId) ? { agentId: optStr(p.agentId) } : {}),
      ...(optStr(p.model) ? { model: optStr(p.model) } : {}),
      ...(optStr(p.title) ? { title: optStr(p.title) } : {}),
      ...(optStr(p.workspaceId) ? { workspaceId: optStr(p.workspaceId) } : {}),
      ...(p.reuse === true ? { reuse: true } : {}),
    });
    return { single };
  });

  // update：model 语义 undefined=不变 / null=清除覆盖；agentId ''=清空待选；
  // workspaceId ''=移入未分组（薄行原样透传，校验住 owning 服务）
  web.registerRpc('singles/update', (params) => {
    const p = obj(params);
    const single = requireSingles().update(reqStr(p, 'id'), {
      ...(p.agentId !== undefined ? { agentId: String(p.agentId) } : {}),
      ...(p.model !== undefined ? { model: p.model === null ? null : String(p.model) } : {}),
      ...(p.title !== undefined ? { title: String(p.title) } : {}),
      ...(p.workspaceId !== undefined ? { workspaceId: String(p.workspaceId) } : {}),
    });
    return { single };
  });

  web.registerRpc('singles/archive', (params) => ({
    single: requireSingles().archive(reqStr(obj(params), 'id')),
  }));

  web.registerRpc('singles/delete', (params) => {
    requireSingles().remove(reqStr(obj(params), 'id'));
    return { deleted: true };
  });

  // ============ conv-settings：会话级覆盖（P6/D4——1v1/群会话快速选模） ============

  // 可选能力行（同 singles）；独立会话（sid）不收——模型覆盖走
  // singles/update（session.json 自包含语义，防双源；ChatInput 按会话
  // 形态分流写口）。deliver 边界已合并生效（见 conversation/deliver）。
  function requireConvSettings() {
    const convSettings = ctx.get('convSettings', false) as
      | {
          get(conversationId: string): { model?: string };
          set(conversationId: string, patch: Record<string, string | null | undefined>): { model?: string };
        }
      | undefined;
    if (!convSettings) throw new Error('convSettings 服务未装载（会话设置面不可用）');
    return convSettings;
  }

  web.registerRpc('conv-settings/get', (params) => ({
    conversationId: reqStr(obj(params), 'conversationId'),
    settings: requireConvSettings().get(reqStr(obj(params), 'conversationId')),
  }));

  // set：patch.model = 'name@model' | 裸名 | null（null/'' = 清除覆盖）
  web.registerRpc('conv-settings/set', (params) => {
    const p = obj(params);
    const conversationId = reqStr(p, 'conversationId');
    const patch = obj(p.patch);
    const settings = requireConvSettings().set(conversationId, {
      model: patch.model === null || patch.model === undefined ? null : String(patch.model),
    });
    return { conversationId, settings };
  });

  // ============ goal / todo：任务追踪读面（webui 会话 dock） ============
  // 两域均为可选能力（ac-goal / ac-todo 行未装 = 面不可用）；桶键 =
  // conversationId（前端按会话形态计算：1v1 对键 / singles sid）。写路径
  // 归 Agent 工具（goal/todo）——UI 只读渲染，变更随 tool/after-execute
  // 帧触发前端刷新，不经此处回写。

  function requireGoals() {
    const goals = ctx.get('goals', false) as
      | {
          snapshot(agentId: string, key: string): { current?: unknown; history: unknown[] };
        }
      | undefined;
    if (!goals) throw new Error('goals 服务未装载（ac-goal 行未装配，目标面不可用）');
    return goals;
  }

  web.registerRpc('goal/get', (params) => {
    const p = obj(params);
    return { goal: requireGoals().snapshot(reqStr(p, 'agentId'), reqStr(p, 'conversationId')) };
  });

  function requireTodos() {
    const todos = ctx.get('todos', false) as
      | { list(agentId: string, key: string): unknown[] }
      | undefined;
    if (!todos) throw new Error('todos 服务未装载（ac-todo 行未装配，待办面不可用）');
    return todos;
  }

  web.registerRpc('todo/get', (params) => {
    const p = obj(params);
    return { todos: requireTodos().list(reqStr(p, 'agentId'), reqStr(p, 'conversationId')) };
  });

  // ============ usage：用量汇总 ============

  web.registerRpc('usage/tokens', () => ({
    byAgent: ctx.usage.byAgent(),
    byModel: ctx.usage.byModel(),
    byDay: ctx.usage.byDay(),
    byDayModel: ctx.usage.byDayModel(),
    byConversation: ctx.usage.byConversation(),
    byPair: ctx.usage.byPair(),
    totals: ctx.usage.totals(),
  }));

  // ============================================================
  // M17-D 运行跟踪面：runs/snapshot（纯读推导）+ 会话 Token 仪表
  // ============================================================

  // 运行矩阵快照：会话文件扫描（messageCount/size/mtime + 尾部摘要）+
  // 运行中（conversation/stats）+ 群组面 + 用量汇总。纯读——不写任何域数据。
  // last = 每会话尾部一条摘要（Port B P4 名册 lastActivity/lastMessage 合成源）。
  web.registerRpc('runs/snapshot', () => {
    const conversations = ctx.session
      .ids()
      .map((cid) => {
        const last = ctx.session.tail(cid);
        return {
          conversationId: cid,
          ...(ctx.session.stats(cid) ?? {}),
          ...(last
            ? {
                last: {
                  role: last.role,
                  text: last.content.slice(0, 120),
                  ts: last.timestamp,
                  // 中性格式归属（D13）：优先 agent_id；旧 baked 行回落 name
                  ...(last.agent_id !== undefined ? { agent_id: last.agent_id } : {}),
                  ...(last.name !== undefined ? { name: last.name } : {}),
                },
              }
            : {}),
        };
      })
      .filter((c) => c.messageCount !== undefined || c.size !== undefined);
    const stats = ctx.conversation.stats();
    return {
      generatedAt: Date.now(),
      conversations,
      running: stats.running,
      queued: stats.queued,
      groups: ctx.group.list().map((g) => ({
        groupId: g.id,
        name: g.name,
        memberCount: g.members.length,
        // M18-G：矩阵视图需要成员名单（轴并集与落格推导）
        members: g.members,
      })),
      usageTotals: ctx.usage.totals(),
    };
  });

  // 软中断（src /api/runs/interrupt 对照；convKey = conversationId）
  web.registerRpc('runs/interrupt', (params) => {
    const p = obj(params);
    return { aborted: ctx.conversation.abort(reqStr(p, 'conversationId')) };
  });

  // 会话 Token 仪表（会话头）：messageCount 来自会话文件；prompt
  // token 近似 = usage 流的 lastContextPrompt（当次上下文覆盖轨；按
  // 会话键聚合——M19 对桶键与 Agent id 不再同形）。百分比分母 = 归档
  // 预算 maxContextTokens（settings['archive'] 合成[M24 A1]，缺省 1M
  // ——与 ac-archive budgetsFor 同口径）；派生 avgTokensPerMsg
  // / estimatedMsgsRemaining（前端 Header 仪表直接消费，M18 前端反馈 #3：
  // 此前前端硬编码 0%）。
  // status 阈值按占 maxContextTokens 的比例（M18 反馈：绝对阈值在 1M 分母
  // 下 6% 就红）：<50% low / <75% moderate / <90% high / ≥90% critical。
  web.registerRpc('session/tokens', (params) => {
    const conversationId = reqStr(obj(params), 'conversationId');
    const st = ctx.session.stats(conversationId);
    const promptTokens = ctx.usage.byConversation()[conversationId]?.lastContextPrompt ?? 0;
    const archiveSettings = ctx.agents.settingsOf(
      agentOfPair(conversationId, (id) => ctx.agents.has(id)),
      'archive',
    ) as { maxContextTokens?: unknown } | undefined;
    const maxContextTokens =
      typeof archiveSettings?.maxContextTokens === 'number' && archiveSettings.maxContextTokens > 0
        ? archiveSettings.maxContextTokens
        : 1_000_000;
    const messageCount = st?.messageCount ?? 0;
    const avgTokensPerMsg = messageCount > 0 ? promptTokens / messageCount : 0;
    const usagePercent = Math.min(100, (promptTokens / maxContextTokens) * 100);
    const estimatedMsgsRemaining =
      avgTokensPerMsg > 0 ? Math.max(0, Math.floor((maxContextTokens - promptTokens) / avgTokensPerMsg)) : 0;
    const status =
      usagePercent < 50 ? 'low' : usagePercent < 75 ? 'moderate' : usagePercent < 90 ? 'high' : 'critical';
    return {
      conversationId,
      messageCount,
      lastContextPrompt: promptTokens,
      maxContextTokens,
      avgTokensPerMsg: Math.round(avgTokensPerMsg),
      usagePercent,
      estimatedMsgsRemaining,
      status,
    };
  });

  // ============================================================
  // M17-A 补齐面：timer / backup / jobs / config / llm / plugin / system
  // ============================================================

  // ============ timer：定时任务管理面 ============

  web.registerRpc('timer/list', () => ({ entries: ctx.timers.list() }));

  web.registerRpc('timer/entries', (params) => {
    const owner = optStr(obj(params).agentId) ?? GLOBAL_TIMER_OWNER;
    return { owner, entries: ctx.timers.entries(owner) };
  });

  web.registerRpc('timer/save', (params) => {
    const p = obj(params);
    const owner = optStr(p.agentId) ?? GLOBAL_TIMER_OWNER;
    ctx.timers.save(owner, validateTimerEntries(p.entries));
    return { saved: true, owner };
  });

  web.registerRpc('timer/trigger', (params) => {
    const p = obj(params);
    const owner = optStr(p.agentId) ?? GLOBAL_TIMER_OWNER;
    return { triggered: ctx.timers.triggerNow(owner, reqStr(p, 'entryId')) };
  });

  // ============ backup：数据备份面 ============

  web.registerRpc('backup/run', async () => ({ backup: await ctx.backup.run({ force: true }) }));

  // ============ config：全局配置面（白名单 + sanitize + 池凭据侧信道） ============

  web.registerRpc('config/get', () => {
    const config = ctx.config.all();
    backfillPoolMasks(ctx, config); // 池条目 api_key 掩码（'' = 未设置）
    return { config };
  });

  web.registerRpc('config/set', (params) => {
    const p = obj(params);
    const key = reqStr(p, 'key');
    assertConfigKey(key);
    if (p.value === undefined) throw new Error('参数 value 缺失');
    // 池域：先提取 api_key 进凭据库（掩码语义），再 sanitize 落 config
    const extracted = extractPoolCredentials(ctx, key, p.value);
    ctx.config.set(key, sanitizeConfigValue(extracted));
    return { set: true, key };
  });

  web.registerRpc('config/delete', (params) => {
    const key = reqStr(obj(params), 'key');
    assertConfigKey(key);
    ctx.config.delete(key);
    return { deleted: true, key };
  });

  // 全量保存（settings 底部"保存配置"）：白名单域内 replace 语义——
  // payload 有的键覆盖写入、payload 缺的键删除；白名单外键一律不动
  // （app 内部键归各域服务所有，设置面板不可触）。
  // 池域条目 api_key 先提取进凭据库（掩码=不动 / 空=删 / 新值=存），
  // config.json 永不落 key。
  web.registerRpc('config/save', (params) => {
    const next = obj(params).config;
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('参数 config 须为对象');
    }
    const payload = sanitizeConfigValue(next) as Record<string, unknown>;
    // 注意顺序：sanitize 先剥掉掩码值条目（= 保持不变），再对存留的
    // 池条目提取真实 key（''/新值）——被 sanitize 丢掉的掩码条目不触凭据库。
    const current = ctx.config.all();
    for (const key of CONFIG_KEY_PREFIXES) {
      if (key in payload) {
        const extracted = extractPoolCredentials(ctx, key, payload[key]);
        ctx.config.set(key, extracted);
      } else if (key in current) {
        ctx.config.delete(key);
      }
    }
    return { saved: true };
  });

  // ============ llm：模型池查看面 + 模型发现 + 连接凭据写口 ============

  web.registerRpc('llm/providers', () => ({
    providers: ctx.llm.providers(),
    stats: ctx.llm.stats(),
  }));

  // 连接凭据写口（PoolManager 删除连接时同步删凭据——否则种子名的
  // 发现回写会凭残留凭据把已删条目"复活"）。value '' = 删除。
  web.registerRpc('llm/pool-credential', (params) => {
    const p = obj(params);
    const name = reqStr(p, 'name');
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('参数 name 须为安全字符（字母/数字/_/-）');
    ctx.credentials.setGlobal(`pool:${name}`, typeof p.value === 'string' ? p.value : '');
    return { set: true, name };
  });

  // 免注册连接探测（PoolManager 新建弹窗"填 Key 即读清单"）：base_url +
  // api_key 直接构造临时客户端调 /models——不经注册面（保存前可用）；
  // 不写任何缓存（条目落盘后的清单走 llm/models 注册路径）。
  web.registerRpc('llm/probe-models', async (params) => {
    const p = obj(params);
    const baseUrl = reqStr(p, 'base_url');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('base_url 须为 http(s) URL');
    const client = new OpenAICompletions({ baseUrl });
    const models = await client.listModels({
      api_key: optStr(p.api_key) || undefined,
      signal: AbortSignal.timeout(20_000),
    });
    return { models: [...new Set(models)].sort() };
  });

  // 视觉能力探测（模型能力元数据）：逐模型发 1×1 图最小请求三态判定
  // （true 收图 / false 拒图 / null 未知——凭据错/限流不猜）。免注册路径
  // （base_url + api_key，保存前可用）与注册路径（provider + pool:<名>
  // 凭据，经 llm 服务实例）双形态；并发 4 防限流。结果由前端并入
  // entry.models 对象形态（{model, vision}）落盘。
  web.registerRpc('llm/probe-vision', async (params) => {
    const p = obj(params);
    const models = (Array.isArray(p.models) ? p.models : [])
      .filter((m): m is string => typeof m === 'string' && m !== '')
      .slice(0, 50);
    if (models.length === 0) throw new Error('参数 models 缺失（须为非空模型名数组）');
    const results: Record<string, boolean | null> = {};
    const baseUrl = optStr(p.base_url);
    let probe: (model: string) => Promise<boolean | undefined>;
    if (baseUrl) {
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error('base_url 须为 http(s) URL');
      const client = new OpenAICompletions({ baseUrl });
      const apiKey = optStr(p.api_key) || undefined;
      probe = (model) => client.probeVision(model, { api_key: apiKey, signal: AbortSignal.timeout(30_000) });
    } else {
      const name = reqStr(p, 'provider');
      if (!ctx.llm.providers().includes(name)) {
        throw new Error(`未知 llm provider "${name}"（已注册：${ctx.llm.providers().join(', ') || '无'}）`);
      }
      const apiKey = ctx.credentials.getGlobal(`pool:${name}`) || undefined;
      probe = (model) => ctx.llm.probeVision(name, model, { api_key: apiKey, signal: AbortSignal.timeout(30_000) });
    }
    // 并发 4（每模型一次真实补全请求——限流友好；结果按模型名回填）
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, models.length) }, async () => {
        while (cursor < models.length) {
          const model = models[cursor++];
          results[model] = (await probe(model)) ?? null;
        }
      }),
    );
    return { results };
  });

  // 模型发现（llm-provider-model-plan P3）：GET /models 经 provider 实例
  // 代理（凭据从凭据库附加——浏览器直连会跨域 401）；发现结果回写
  // config.llmProviders[name].models 缓存（refresh 或缓存缺失时）→
  // config/changed → ac-llm-pool 热更重挂（meta.models 进裸名路由）。
  web.registerRpc('llm/models', async (params) => {
    const p = obj(params);
    const name = reqStr(p, 'name');
    if (!ctx.llm.providers().includes(name)) {
      throw new Error(`未知 llm provider "${name}"（已注册：${ctx.llm.providers().join(', ') || '无'}）`);
    }
    const models = await ctx.llm.listModels(name, {
      // 凭据锚定连接：pool:<名>（未配置凭据即 401——未配置 = 不可用，如实呈现）
      api_key: ctx.credentials.getGlobal(`pool:${name}`) || undefined,
      // 探测超时上限：网络半开/不可达端点不拖死前端探测（20s 足够清单请求）
      signal: AbortSignal.timeout(20_000),
    });
    // 归一（去重 + 字典序）：缓存落盘确定性 + 下拉稳定
    const normalized = [...new Set(models)].sort();
    // 缓存回写：refresh=true 或条目尚无 models 时落盘（seed 名会物化出
    // config 条目——继承种子 baseUrl，属预期；名字安全字符集防点路径逃逸）
    const pool = (ctx.config.get<Record<string, unknown>>('llmProviders') ?? {});
    const entry = pool[name];
    const hasCache =
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && Array.isArray((entry as Record<string, unknown>).models);
    if ((p.refresh === true || !hasCache) && /^[A-Za-z0-9_-]+$/.test(name)) {
      // 【能力元数据保留】models 宽容双形态归一后按新清单合并——已有
      // vision/hidden 标志随同名模型保留（刷新清单不丢探测结果/隐藏位），
      // 新模型裸名直入；写回最小形态（无标志 = 裸 string，有标志 = 对象）。
      const existing = normalizePoolModels((entry as { models?: unknown } | undefined)?.models);
      const merged: Array<string | PoolModelEntry> = normalized.map((model) => {
        const prev = existing.find((e) => e.model === model);
        return prev && (prev.vision === true || prev.hidden === true) ? prev : model;
      });
      ctx.config.set(`llmProviders.${name}.models`, merged);
    }
    // 响应带能力元数据（前端徽章/过滤；models 维持裸名数组向后兼容）
    const modelMeta: Record<string, { vision?: boolean; hidden?: boolean }> = {};
    for (const e of normalizePoolModels((entry as { models?: unknown } | undefined)?.models)) {
      if (e.vision === true || e.hidden === true) {
        modelMeta[e.model] = { ...(e.vision ? { vision: true } : {}), ...(e.hidden ? { hidden: true } : {}) };
      }
    }
    return { name, models: normalized, modelMeta };
  });

  // ============ plugin：插件库全流程 + 权限词汇表 ============

  web.registerRpc('plugin/stage', async (params) => {
    const p = obj(params);
    return { staging: await ctx.pluginRegistry.stage(reqStr(p, 'dir'), optStr(p.owner) ?? 'host') };
  });

  web.registerRpc('plugin/staging-list', () => ({ staging: ctx.pluginRegistry.listStaging() }));

  web.registerRpc('plugin/staging-files', (params) => ({
    files: ctx.pluginRegistry.listStagingFiles(reqStr(obj(params), 'id')),
  }));

  web.registerRpc('plugin/staging-file', (params) => {
    const p = obj(params);
    return ctx.pluginRegistry.readStagingFile(reqStr(p, 'id'), reqStr(p, 'path'));
  });

  web.registerRpc('plugin/approve', async (params) => {
    const p = obj(params);
    const id = reqStr(p, 'id');
    const grants = Array.isArray(p.grants) ? p.grants.map(String) : undefined;
    const result = await ctx.pluginRegistry.approve(id, grants);
    return { installed: result.manifest, permissions: result.permissions, load: result.load };
  });

  web.registerRpc('plugin/reject', async (params) => ({
    rejected: await ctx.pluginRegistry.rejectStaging(reqStr(obj(params), 'id')),
  }));

  web.registerRpc('plugin/installed', () => ({ installed: ctx.pluginRegistry.listInstalled() }));

  // 已装载 + 装载失败 + 熔断跳过 + 安全模式（M22 D6 三态徽章 + M23 G9
  // 第四态"已熔断" + L8 安全模式横幅数据源）
  web.registerRpc('plugin/loaded', () => ({
    loaded: ctx.pluginRegistry.listLoaded(),
    failed: ctx.pluginRegistry.listFailed(),
    skipped: ctx.pluginRegistry.listSkipped(),
    safeMode: ctx.pluginRegistry.isSafeMode(),
  }));

  // 扩展目录（M22 D4① → A1 注册制）：registry 自述聚合（行卸载 → 条目隐藏）
  web.registerRpc('plugin/extension-catalog', () => {
    return { extensions: collectExtensionCatalog(ctx) };
  });

  // 开发目录扫描（M22 D7②）：<root>/plugins/<agentId>/<name>/ 布局 + 数据根透出
  web.registerRpc('plugin/dev-scan', () => ctx.pluginRegistry.devScan());

  // ============================================================
  // M24 P3：plugin/catalog —— 目录信息架构后端（X2）
  //   · 内置组 = 包源清单（dev 扫描 src/ac-*/ 的 package.json 元数据
  //     ——rowMetaOf 解析先例；非 cordis.yml：yml 只答"装了什么"答不了
  //     "有什么可装"），仅收声明 `agentchat.plugin: true` 的行包（纯库/
  //     组合根 fail-closed 出局；npm 发现面 = keywords "agentchat"），
  //     装配状态列与 cordis registry 交叉（已装配/未装配）。
  //     生产 bundle 首期内置组为空 + note 注明"内置目录仅开发形态可用"
  //     （生产源后裁触发 = 首个生产 bundle 部署，显式缩水 §四.7）。
  //   · 本地组 = registry.json 安装态 ∪ devScan 开发面 ∪ 会话装载
  //     （M23 F11 判据收编为单一清单）∪ 待审暂存并入徽章态（state='pending'）。
  // ============================================================
  web.registerRpc('plugin/catalog', () => {
    // ---- 内置组（包源扫描）----
    const rowsByName = new Map<string, { fibers: number; active: boolean }>();
    for (const runtime of ctx.registry.values()) {
      if (!runtime.name) continue;
      const fibers = liveFibersOf(runtime);
      rowsByName.set(runtime.name, { fibers: fibers.length, active: fibers.length > 0 });
    }
    // yml 裸行 id 映射（2026-08-30：含未装配/偏好停用行——loader 树在册即
    // 可 patch。registry（plugin/rows）只覆盖已装载行，停用行的卡片 toggle
    // 失去 entryId 锚点后消失，用户被迫滚回顶部还原区——反直觉）。
    const entryIdByPkg = new Map<string, string>();
    const loaderRef = ctx.get('loader', false) as
      | { entries(): Array<{ options?: { id?: unknown; name?: unknown }; subtree?: unknown }> }
      | undefined;
    if (loaderRef) {
      for (const entry of loaderRef.entries()) {
        if (entry.subtree !== undefined && entry.subtree !== null) continue; // include 行自身（子树载体）
        const name = entry.options?.name;
        const id = entry.options?.id;
        if (typeof name === 'string' && typeof id === 'string' && id && !entryIdByPkg.has(name)) {
          entryIdByPkg.set(name, id);
        }
      }
    }
    const builtin: Array<{
      name: string;
      version?: string;
      description?: string;
      assembled: boolean;
      fibers: number;
      /** yml 裸行 id（停用行也有——卡片装配 toggle 的锚点） */
      entryId?: string;
    }> = [];
    let builtinNote: string | undefined;
    try {
      const trackDir = fileURLToPath(new URL('../../', import.meta.url));
      const dirs = readdirSync(trackDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('ac-'))
        .map((e) => e.name);
      for (const dir of dirs) {
        const pkg = readBuiltinPkg(join(trackDir, dir, 'package.json'));
        if (!pkg) continue; // 单包 package.json 缺失/损坏 → 跳过不阻断（mtime 缓存读）
        if (pkg.name !== dir) continue; // 名不符 → 不采信（与 rowMetaOf 同判据）
        // 目录判据（X2 收敛）：仅收声明 `agentchat.plugin: true` 的行包。
        // 纯库（ac-*-core 等，定义即零 cordis 依赖）与组合根（ac-app）是
        // 行的实现细节而非装配单元——fail-closed：未声明 = 不进目录（新包
        // 默认出局，行包漏声明的后果是良性 no-op 而非假可供性）。
        if (pkg.agentchat?.plugin !== true) continue;
        const row = rowsByName.get(pkg.name);
        const entryId = entryIdByPkg.get(pkg.name);
        builtin.push({
          name: pkg.name,
          ...(typeof pkg.version === 'string' && pkg.version ? { version: pkg.version } : {}),
          ...(typeof pkg.description === 'string' && pkg.description ? { description: pkg.description } : {}),
          assembled: row?.active === true,
          fibers: row?.fibers ?? 0,
          ...(entryId ? { entryId } : {}),
        });
      }
      builtin.sort((a, b) => a.name.localeCompare(b.name));
      if (builtin.length === 0 && dirs.length > 0) {
        builtinNote = '未发现声明 agentchat.plugin 的行包（纯库/组合根非装配单元，不进目录）';
      }
    } catch {
      builtinNote = '内置目录仅开发形态可用（未扫描到 src/ac-* 包源；生产 bundle 首期不内置清单）';
    }

    // ---- 本地组（registry ∪ devScan ∪ 会话装载 ∪ 待审暂存）----
    type LocalState = 'loaded' | 'installed' | 'failed' | 'skipped' | 'dev' | 'pending';
    const localByName = new Map<
      string,
      {
        name: string;
        version?: string;
        description?: string;
        owner?: string;
        dir?: string;
        state: LocalState;
        error?: string;
        reason?: string;
        sessionOnly?: boolean;
        uiNonIsolated?: boolean;
        provides?: unknown;
        permissions?: unknown;
      }
    >();
    const upsert = (
      name: string,
      patch: Partial<{
        version: string;
        description: string;
        owner: string;
        dir: string;
        state: LocalState;
        error: string;
        reason: string;
        sessionOnly: boolean;
        uiNonIsolated: boolean;
        provides: unknown;
        permissions: unknown;
      }>,
    ): void => {
      const prev = localByName.get(name) ?? { name, state: 'dev' as LocalState };
      localByName.set(name, { ...prev, ...patch });
    };
    for (const inst of ctx.pluginRegistry.listInstalled()) {
      upsert(inst.manifest.name, {
        version: inst.manifest.version,
        ...(inst.manifest.description ? { description: inst.manifest.description } : {}),
        ...(inst.owner ? { owner: inst.owner } : {}),
        dir: inst.dir,
        ...(inst.manifest.permissions ? { permissions: inst.manifest.permissions } : {}),
        ...(inst.manifest.provides ? { provides: inst.manifest.provides } : {}),
        ...(inst.manifest.ui?.isolated === false ? { uiNonIsolated: true } : {}),
        state: 'installed',
      });
    }
    for (const l of ctx.pluginRegistry.listLoaded()) {
      upsert(l.name, {
        version: l.manifest.version,
        ...(l.manifest.description ? { description: l.manifest.description } : {}),
        ...(l.agentId ? { owner: l.agentId } : {}),
        ...(l.dir ? { dir: l.dir } : {}),
        ...(l.manifest.provides ? { provides: l.manifest.provides } : {}),
        ...(l.manifest.ui?.isolated === false ? { uiNonIsolated: true } : {}),
        ...(l.sessionOnly ? { sessionOnly: true } : {}),
        state: 'loaded',
      });
    }
    for (const f of ctx.pluginRegistry.listFailed()) {
      // 装载失败仍保留安装/开发面信息，state 升级为 failed
      upsert(f.name, { state: 'failed', error: f.error });
    }
    for (const s of ctx.pluginRegistry.listSkipped()) {
      upsert(s.name, { state: 'skipped', reason: s.reason });
    }
    for (const d of ctx.pluginRegistry.devScan().dev) {
      upsert(d.name, {
        ...(d.version ? { version: d.version } : {}),
        ...(d.description ? { description: d.description } : {}),
        owner: d.owner,
        dir: d.dir,
        ...(d.permissions ? { permissions: d.permissions } : {}),
        // dev-only：无既有条目时才落 'dev'（已安装/已装载优先）
        ...(localByName.has(d.name) ? {} : { state: 'dev' as LocalState }),
      });
    }
    // 待审暂存并入徽章态（独立条目——manifest.name 可能与已装条目无关）
    const pending: Array<{
      pendingId: string;
      name: string;
      version: string;
      owner: string;
      requiredGrants: unknown;
      createdAt: string;
    }> = ctx.pluginRegistry.listStaging().map((s) => ({
      pendingId: s.id,
      name: s.manifest.name,
      version: s.manifest.version,
      owner: s.owner,
      requiredGrants: s.requiredGrants,
      createdAt: s.createdAt,
    }));

    return {
      builtin,
      ...(builtinNote ? { note: builtinNote } : {}),
      local: [...localByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      pending,
    };
  });

  // 装配行清单（M18 前端反馈 #6：扩展与工具面板看不到插件清单——内置
  // 能力全部是 cordis.yml 装配行，不经 pluginRegistry；从 cordis registry
  // 只读透出）。rows = 当前进程内活跃的插件行（含 loader/include 自身）。
  // 2026-08-28 前端反馈 #2：行附 package.json 元数据（description/version/
  // origin）。M23 F11：动态插件（Agent 开发/安装面）标 origin 'dynamic'
  // 单列分组——判据 = registry.json（安装态）∪ listLoaded()（会话态）；
  // installed+failed 与已 unload 的安装态不在 loaded 里，按名字只查
  // loaded 会漏一半。yml 行与动态插件同名时首期按 registry 名单近似
  // （精确 fiber 归属随 P7）。
  web.registerRpc('plugin/rows', () => {
    const dynamicNames = new Map<string, { owner?: string }>();
    for (const inst of ctx.pluginRegistry.listInstalled()) {
      dynamicNames.set(inst.manifest.name, { owner: inst.owner });
    }
    for (const l of ctx.pluginRegistry.listLoaded()) {
      if (!dynamicNames.has(l.name)) dynamicNames.set(l.name, l.agentId ? { owner: l.agentId } : {});
    }
    const rows: Array<{
      name: string;
      fibers: number;
      active: boolean;
      origin: 'package' | 'internal' | 'dynamic';
      description?: string;
      version?: string;
      /** origin=dynamic：owner Agent（开发/安装归属） */
      owner?: string;
      /** yml 裸 id（M24 P4：行偏好层开关锚点——patch 文件按装配文件原文 id 匹配） */
      entryId?: string;
    }> = [];
    for (const runtime of ctx.registry.values()) {
      const fibers = liveFibersOf(runtime);
      const dynamic = dynamicNames.get(runtime.name ?? '');
      const meta = rowMetaOf(runtime.name);
      // 行偏好开关锚点 = yml 裸 id（entry.options.id）。entry.id 是
      // namespaced 形态（<树前缀>:<裸id>，include 行无 id 时前缀每 boot
      // 随机）——patch 匹配走装配文件原文 id（applyEntryPatches），
      // namespaced id 永不命中（2026-08-30 事故：前端写入了 namespaced
      // id，热通道静默 skip 却谎报 hot）
      const entryRef = fibers[0]?.entry as { id?: string; options?: { id?: unknown } } | undefined;
      const entryId =
        typeof entryRef?.options?.id === 'string' && entryRef.options.id
          ? entryRef.options.id
          : entryRef?.id;
      rows.push({
        name: runtime.name ?? '(anonymous)',
        fibers: fibers.length,
        active: fibers.length > 0,
        origin: dynamic ? 'dynamic' : meta.origin,
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.version ? { version: meta.version } : {}),
        ...(dynamic?.owner ? { owner: dynamic.owner } : {}),
        ...(entryId ? { entryId } : {}),
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return { rows };
  });

  web.registerRpc('plugin/uninstall', async (params) => ({
    uninstalled: await ctx.pluginRegistry.uninstall(reqStr(obj(params), 'name')),
  }));
  // 会话级/开发态装载（src plugins/session/* 对照；sessionOnly 直通）
  web.registerRpc('plugin/load', async (params) => {
    const p = obj(params);
    const dir = reqStr(p, 'dir');
    const sessionOnly = p.sessionOnly === true;
    const grants =
      Array.isArray(p.grants) && p.grants.every((g) => typeof g === 'string')
        ? (p.grants as PluginPermission[])
        : undefined;
    return ctx.pluginRegistry.load({
      dir,
      sessionOnly,
      ...(optStr(p.agentId) ? { agentId: optStr(p.agentId) } : {}),
      ...(grants ? { allowedPermissions: grants } : {}),
      ...(p.watch === true ? { watch: true } : {}),
    });
  });

  web.registerRpc('plugin/unload', async (params) => ({
    unloaded: await ctx.pluginRegistry.unload(reqStr(obj(params), 'name')),
  }));

  // 权限词汇表（前端 grants 勾选源 / 徽章）
  web.registerRpc('plugin/permissions', () => ({
    contractsVersion: HOST_CONTRACTS_VERSION,
    permissions: KNOWN_PERMISSIONS,
    defaultGrants: DEFAULT_GRANTED_PERMISSIONS,
    executionExplicitRequired: EXECUTION_EXPLICIT_REQUIRED,
    reviewExplicitRequired: REVIEW_EXPLICIT_REQUIRED,
  }));

  // 行偏好层 plugin/patch-list·patch-set 已迁往 ac-plugin-registry 行注册
  // （2026-08-30：急救通道必须住在级联闭包外——本行静态 inject conversation
  // 等在 agent-loop 级联中阵亡，行停用后 UI 无法自救）

  // ============================================================
  // M25 P3：反依赖图（fiber 名 × fiber.inject 键集传递闭包）
  // 停用承重行级联警告数据源 + ctx.get 软依赖盲区说明 + 保护行标记
  // （security / plugin-gates：二次确认特殊文案，不指望图）。
  // ============================================================
  web.registerRpc('plugin/dep-graph', () => {
    /** 直接依赖（fiber.inject 键集——含静态 inject 声明；软依赖 ctx.get
     *  不在图内[盲区]，前端注明） */
    const direct = new Map<string, Set<string>>();
    const rowNames = new Set<string>();
    for (const runtime of ctx.registry.values()) {
      if (!runtime.name) continue;
      rowNames.add(runtime.name);
    }
    // 顶层行视角：每行的 inject 集 = 该行子树全部 fiber 的 inject 键并集
    const serviceOwner = new Map<string, string>();
    for (const runtime of ctx.registry.values()) {
      if (!runtime.name) continue;
      const deps = direct.get(runtime.name) ?? new Set<string>();
      for (const fiber of runtime.fibers) {
        if (fiber.uid === null) continue;
        for (const key of Object.keys(fiber.inject ?? {})) {
          if (key !== runtime.name) deps.add(key);
        }
      }
      direct.set(runtime.name, deps);
    }
    // 服务键 → 提供行名：reflect 提供面（symbol 键字典；impl.name +
    // impl.fiber → runtime 名；直构服务挂 root fiber → 伪行 '(root)'）
    {
      type ReflectImpl = { name?: string; fiber?: { runtime?: { name?: string } } };
      const reflectStore = (ctx.root.reflect as unknown as { store?: object }).store;
      if (reflectStore !== undefined) {
        for (const key of Reflect.ownKeys(reflectStore)) {
          const impl = (reflectStore as Record<symbol, ReflectImpl>)[key as symbol];
          if (!impl || typeof impl !== 'object') continue;
          if (impl.name && !serviceOwner.has(impl.name)) {
            serviceOwner.set(impl.name, impl.fiber?.runtime?.name ?? '(root)');
          }
        }
      }
    }
    // 依赖键归一到行名：键 = 服务名（如 'llm'）→ 提供行 = 服务键归属
    // （fiber.own store 优先；回退 ac-<服务名> 前缀约定——'llm' → 'ac-llm'；
    // 未命中键保留原文呈现，闭包只对行名边计算）
    const resolveRow = (key: string): string | undefined => {
      if (rowNames.has(key)) return key;
      const owner = serviceOwner.get(key);
      if (owner !== undefined) return owner;
      if (rowNames.has(`ac-${key}`)) return `ac-${key}`;
      return undefined;
    };
    /** 行级依赖边：row → 提供行（dep 键解析后的行名并集） */
    const rowDeps = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    for (const [row, deps] of direct) {
      const set = rowDeps.get(row) ?? new Set<string>();
      for (const dep of deps) {
        const target = resolveRow(dep);
        if (target === undefined || target === row) continue;
        set.add(target);
        let dset = dependents.get(target);
        if (!dset) {
          dset = new Set();
          dependents.set(target, dset);
        }
        dset.add(row);
      }
      rowDeps.set(row, set);
    }
    /** 传递闭包（dependents 可达集——停用 X 将断链的全部行） */
    const closureOf = (start: string): string[] => {
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const next of dependents.get(cur) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      return [...seen].sort();
    };
    const PROTECTED_ROWS = ['ac-security', 'ac-plugin-gates'];
    return {
      rows: [...rowNames].sort().map((name) => ({
        name,
        /** 声明式依赖（原始 inject 键集——含未归一到行名的服务键） */
        deps: [...(direct.get(name) ?? [])].sort(),
        /** 行级依赖（归一后） */
        rowDeps: [...(rowDeps.get(name) ?? [])].sort(),
        /** 停用该行将断链的行（传递闭包——级联警告数据源） */
        dependents: closureOf(name),
        protected: PROTECTED_ROWS.includes(name),
      })),
      note: '依赖边 = fiber.inject 键集（声明式硬依赖；服务键按 ac-<键> 前缀约定归一到行名）；ctx.get 软依赖是盲区（不在图内——UI 如实注明）。保护行 = 二次确认特殊文案。',
    };
  });

  // ============ events：事件执行链可视化（M23 P4，A4 第 1 层：静态读出） ============
  //
  // dump ctx.events._hooks——每事件**有序** Hook 数组（数组序 = waterfall
  // 执行序），经 hook.ctx.fiber.name 归属 + prepend 标记；零分发开销、只读、
  // 零 vendor 改动。归属首期裸 fiber 名如实呈现（监听器挂服务 fiber 时显示
  // 类名），fiber→行聚合随 P7 升级；不承诺 internal/* 全景（G2——只见公开
  // 事件与 global 监听器）。（_hooks 私有读取的理由与形状见 hooksTableOf。）
  web.registerRpc('events/listeners', () => {
    // M25 §3.5 归属升级：owner 裸 fiber 名 → 聚合行名（row 字段；
    // owner 原文保留——治理键不变，聚合只改呈现）
    const aggregate = computeRowAggregates(ctx);
    const events = Object.entries(chainEntriesOf(ctx)).map(([name, listeners]) => ({
      name,
      listeners: listeners.map((l) => ({
        owner: l.owner,
        row: aggregate.get(l.owner) ?? l.owner,
        prepend: l.prepend,
        global: l.global,
        ...(l.description ? { description: l.description } : {}),
      })),
    }));
    events.sort((a, b) => a.name.localeCompare(b.name));
    return { events };
  });

  // ============================================================
  // M25 P2：事件描述声明制（events/descriptions）+ 治理面（policy-list/set）
  //   · 声明目录 = 行包自述（collectExtensionCatalog——A1 注册制，随行
  //     装载增删）∪ 动态插件 manifest provides.events；
  //   · 全量事件清单以声明目录为准（events/listeners 天然漏零监听器事件）；
  //   · 交叉 = 按 owner::event 关联执行链（未声明的监听器如实只显 owner）；
  //   · description 只透传真实声明（2026-08-30 反馈：不再模板兜底——
  //     "X 在 Y 上的监听"式同义反复是噪音；缺省时事件节点不显示描述行，
  //     行为角色注释 role 仍在监听器叶节点呈现）。
  // ============================================================
  web.registerRpc('events/descriptions', () => {
    // 1) 行包自述声明目录（registry 聚合——行装载即条目在）
    const declared: Array<{
      owner: string;
      event: string;
      /** 事件描述（仅真实声明；未声明 = 缺省，前端不渲染描述行） */
      description?: string;
      role?: string;
      facet?: string;
      respectsEnabled?: boolean;
      /** 声明来源：builtin（行包自述）| dynamic（manifest provides.events） */
      source: 'builtin' | 'dynamic';
      automatic?: boolean;
    }> = [];
    for (const ext of collectExtensionCatalog(ctx)) {
      for (const l of ext.listeners ?? []) {
        declared.push({
          owner: ext.row,
          event: l.event,
          ...(l.description ? { description: l.description } : {}),
          ...(l.role ? { role: l.role } : {}),
          ...(l.facet ? { facet: l.facet } : {}),
          ...(l.respectsEnabled ? { respectsEnabled: true } : {}),
          source: 'builtin',
          ...(ext.automatic ? { automatic: true } : {}),
        });
      }
    }
    // 2) 动态插件声明（manifest provides.events：M25 P2 扩展形状）
    for (const loaded of ctx.pluginRegistry.listLoaded()) {
      const provides = loaded.manifest.provides?.events;
      if (!provides) continue;
      for (const item of provides) {
        declared.push({
          owner: loaded.name,
          event: typeof item === 'string' ? item : item.name,
          ...(typeof item !== 'string' && item.description ? { description: item.description } : {}),
          source: 'dynamic',
        });
      }
    }
    // 3) 交叉执行链（与 events/listeners 同核读取；剥离 description 保持本 RPC 载荷形状）
    const chains = Object.fromEntries(
      Object.entries(chainEntriesOf(ctx)).map(([name, ls]) => [
        name,
        ls.map(({ owner, prepend, global }) => ({ owner, prepend, global })),
      ]),
    );
    return { descriptions: declared, chains };
  });

  // 治理面（可选能力行——语义见 session/archive 处权威注释）
  web.registerRpc('events/policy-list', () => {
    const policy = ctx.get('eventPolicy', false) as
      | { disabledKeys(): Set<string>; isDisabled(owner: string, event: string): boolean }
      | undefined;
    if (!policy) throw new Error('eventPolicy 服务未装载（事件治理面不可用）');
    const keys = [...policy.disabledKeys()].sort();
    return {
      disabled: keys,
      // 交叉呈现：键 × 当前执行链（哪些键当前确有可停条目——治理键
      // stale = 良性 no-op：注册不存在了）
      live: keys.filter((k) => {
        const [owner, event] = k.split('::');
        return owner !== undefined && event !== undefined && policy.isDisabled(owner, event);
      }),
    };
  });

  web.registerRpc('events/policy-set', async (params) => {
    const p = obj(params);
    const policy = ctx.get('eventPolicy', false) as
      | { setPolicy(key: string, disabled: boolean): Promise<string[]> }
      | undefined;
    if (!policy) throw new Error('eventPolicy 服务未装载（事件治理面不可用）');
    const key = reqStr(p, 'key');
    const disabled = p.disabled !== false;
    const next = await policy.setPolicy(key, disabled);
    return {
      set: true,
      key,
      disabled,
      disabledList: next,
      // 影响提示：吞注册只管后续注册——已注册条目需重载/重启
      note: disabled
        ? '停用已写入 config events.disabled：后续注册（运行时装载/插件重载）即被吞；boot 期已注册条目需重启进程（yml 行）或重载插件生效。'
        : '启用已写入——重载插件或重启进程后恢复注册。',
    };
  });

  // ============ system：版本面 + 重启触发面 ============

  web.registerRpc('system/version', () => {
    const pkg = readRootPackage();
    return { current: pkg?.version ?? '0.0.0', name: pkg?.name ?? 'agentchat' };
  });

  web.registerRpc('system/restart', (params) => {
    const reason = optStr(obj(params).reason) ?? 'ui-system-restart';
    const outcome = requestSystemRestart(ctx, reason);
    if (!outcome.ok) throw new Error(outcome.error);
    return { restarting: true, reason };
  });

  // ============================================================
  // M17-E：文件与工作区 HTTP 面（ac-workspace owning 方法直通）
  // ============================================================

  // 工作区目录树（懒加载；path 相对 <root>/files，空 = 根）
  web.route('GET', '/api/workspace/tree', (call) => {
    const rel = call.query.get('path') ?? '';
    try {
      web.replyJson(call.res, 200, ctx.workspace.tree(rel));
    } catch (err) {
      web.replyJson(call.res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 本机目录浏览（M18 路径穿透白名单的文件夹选择弹窗；只列目录名，
  // 不读文件内容；path 空 = 快捷根清单。files:true 附带常规文件名清单
  // ——配置弹窗的文件路径选择，如 persona file；名级曝光同边界）
  web.registerRpc('workspace/browse-dirs', (params) => {
    const p = obj(params);
    return ctx.workspace.browseDirs(
      typeof p.path === 'string' ? p.path : '',
      p.files === true ? { files: true } : undefined,
    );
  });

  // 文件内容预览（文本直读 / 二进制 base64）
  web.route('GET', '/api/workspace/file', (call) => {
    const rel = call.query.get('path');
    if (!rel) return web.replyJson(call.res, 400, { error: 'path 缺失' });
    try {
      web.replyJson(call.res, 200, ctx.workspace.readFile(rel));
    } catch {
      web.replyJson(call.res, 404, { error: '文件不存在或不可读' });
    }
  });

  // 原始字节直链（HTML 新窗口打开等）
  web.route('GET', '/api/workspace/raw', (call) => {
    const rel = call.query.get('path');
    if (!rel) return web.replyJson(call.res, 400, { error: 'path 缺失' });
    try {
      const file = ctx.workspace.resolveFile(rel);
      const data = readFileSync(file);
      call.res.writeHead(200, { 'content-type': guessContentType(file) });
      call.res.end(data);
    } catch {
      web.replyJson(call.res, 404, { error: '文件不存在或不可读' });
    }
  });

  // 附件上传（multipart：file + 可选 agentId → files/<agentId>/_tmp/）
  web.route('POST', '/api/upload', (call) => {
    const body = call.body as MultipartBody | undefined;
    if (!body?.files?.file) return web.replyJson(call.res, 400, { error: 'multipart 字段 file 缺失' });
    const agentId = body.fields.agentId || undefined;
    try {
      web.replyJson(call.res, 200, ctx.workspace.saveUpload(agentId, body.files.file.filename, body.files.file.data));
    } catch (err) {
      web.replyJson(call.res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 用户工作区登记（沙箱白名单根 / 文件树根分组锚点）
  web.route('GET', '/api/workspaces', (call) => {
    web.replyJson(call.res, 200, { workspaces: ctx.workspace.listWorkspaces() });
  });

  web.route('POST', '/api/workspaces', (call) => {
    const p = (call.body ?? {}) as Record<string, unknown>;
    const wsPath = typeof p.path === 'string' ? p.path.trim() : '';
    if (!wsPath) return web.replyJson(call.res, 400, { error: 'path 缺失' });
    const workspace = ctx.workspace.registerWorkspace(wsPath, typeof p.name === 'string' ? p.name : undefined);
    web.replyJson(call.res, 200, { workspace });
  });

  web.route('PATCH', '/api/workspaces/:id', (call) => {
    const p = (call.body ?? {}) as Record<string, unknown>;
    const patch: { name?: string; path?: string } = {};
    if (typeof p.name === 'string') patch.name = p.name;
    if (typeof p.path === 'string') patch.path = p.path;
    const workspace = ctx.workspace.updateWorkspace(call.params.id, patch);
    if (!workspace) return web.replyJson(call.res, 404, { error: 'workspace 不存在' });
    web.replyJson(call.res, 200, { workspace });
  });

  web.route('DELETE', '/api/workspaces/:id', (call) => {
    web.replyJson(call.res, 200, { deleted: ctx.workspace.removeWorkspace(call.params.id) });
  });

  // Agent 头像（multipart 上传 / 删除 / 静态读取；存 agentStore 目录）
  web.route('POST', '/api/agents/:agentId/avatar', (call) => {
    const body = call.body as MultipartBody | undefined;
    if (!body?.files?.file) return web.replyJson(call.res, 400, { error: 'multipart 字段 file 缺失' });
    try {
      ctx.agentStore.saveAvatar(call.params.agentId, body.files.file.data, extname(body.files.file.filename));
      web.replyJson(call.res, 200, { success: true });
    } catch (err) {
      web.replyJson(call.res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  web.route('DELETE', '/api/agents/:agentId/avatar', (call) => {
    web.replyJson(call.res, 200, { deleted: ctx.agentStore.removeAvatar(call.params.agentId) });
  });

  web.route('GET', '/api/agents/:agentId/avatar', (call) => {
    const file = ctx.agentStore.avatarPath(call.params.agentId);
    if (!file) return web.replyJson(call.res, 404, { error: '无头像' });
    try {
      call.res.writeHead(200, { 'content-type': guessContentType(file), 'cache-control': 'no-cache' });
      call.res.end(readFileSync(file));
    } catch {
      web.replyJson(call.res, 404, { error: '头像读取失败' });
    }
  });
}
