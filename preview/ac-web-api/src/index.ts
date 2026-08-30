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
//   backup/run|list           （M17-A：数据备份面）
//   jobs/list|get|read|kill   （M17-A：后台任务面）
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
import { resolveToolNames } from 'ac-agents';
import { pairKey } from 'ac-agent-loop';
import type { LlmMessage } from 'ac-llm';
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
import type {} from 'ac-jobs';
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
  'jobs',
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

/** deliver 的入站消息：字符串或 {role, content} 形 LlmMessage（role 白名单校验） */
function messageOf(v: unknown): string | LlmMessage {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'object' && v !== null) {
    const m = v as { role?: unknown; content?: unknown; name?: unknown };
    const role = m.role;
    if (
      (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') &&
      typeof m.content === 'string'
    ) {
      return {
        role,
        content: m.content,
        ...(typeof m.name === 'string' ? { name: m.name } : {}),
      };
    }
  }
  throw new Error('参数 message 缺失（须为非空字符串或 {role, content}）');
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
// 扩展目录常量（M22 D4① P2a 静态起步）：UI「扩展」单元 = 消费事件的
// 扩展行（非 src 的 hook 注册条目）。条目与进程实际装载的行联动——
// 可见性 = row ∈ cordis registry（行摘除 → 条目自动隐藏，plugin/rows
// 同源）。落点 = preview 事件词汇（UI 映射三组徽章：运行前/工具链/运行后）。
// P3（另立项）：扩展行 apply 时注册目录元数据，消灭静态表。
// ============================================================

/** 事件落点（preview 事件词汇子集——扩展行实际消费的 seam） */
export type ExtensionTarget =
  | 'loop/before-run'
  | 'tool/before-execute'
  | 'tool/transform-result'
  | 'loop/transform-run'
  | 'loop/after-run';

/**
 * 监听器级声明（M25 P2 事件描述声明制）：owning 行在目录声明
 * { event, 事件描述, 监听器角色, facet?, respectsEnabled? }。
 * · respectsEnabled：该行是否自查 enabled（ADR-4 自查约定）——
 *   Agent·事件视图据此告警"停用未必生效"（agentGate 普及后自然收敛）；
 * · facet：作者命名的稳定行为切面（agentGate 子键覆盖回落行为级）。
 */
export interface ExtensionListenerDecl {
  /** 事件名（preview 目录词汇） */
  event: string;
  /** 该监听器在此事件上做什么（角色注释——执行链渲染） */
  role?: string;
  /** 事件描述（目录·事件视图；未声明的事件不进描述清单） */
  description?: string;
  /** 行为切面（settings[名][facet].enabled ?? settings[名].enabled） */
  facet?: string;
  /** 该行是否自查 enabled（缺省 false——UI 注明"停用未必生效"） */
  respectsEnabled?: boolean;
}

/** 扩展目录条目（plugin/extension-catalog 载荷元素） */
export interface ExtensionCatalogEntry {
  /** AgentConfig.settings 键（persona/memory/…；动态插件 = manifest.name） */
  name: string;
  /** 装配行包名；可见性 = row ∈ plugin/rows */
  row: string;
  label: string;
  description: string;
  /** 事件落点（空 = 纯能力供给行，如 web-tools 工具行） */
  targets: ExtensionTarget[];
  /** 基础设施行：装载即生效，per-Agent 不可关 */
  automatic?: boolean;
  /** 全局默认参数命名空间（M24 P4 弹窗数据源：插件库·配置弹窗写 config/set → settings.<configNs>） */
  configNs?: string;
  /**
   * per-Agent 参数面字段（settings[name].*；形状由 owning 行实现声明）。
   * 2026-08-30 演进：string → string | {name, description?}——配置弹窗
   * 渲染字段级描述（不然用户不清楚每个配置的作用）；裸 string 兼容保留。
   */
  fields?: Array<string | { name: string; description?: string }>;
  /** 监听器级声明（M25 P2：事件描述 + 角色 + facet + respectsEnabled） */
  listeners?: ExtensionListenerDecl[];
}

/** 内置扩展行目录（11 条；字段集 = 各行 settings[具名] 实际消费形状；
 *  M24 P4：configNs 赋值 = 全局默认层写锚点；M25 P2：listeners 监听器级
 *  声明——事件描述 + 角色 + facet + respectsEnabled） */
const EXTENSION_CATALOG: ExtensionCatalogEntry[] = [
  {
    name: 'mcp', row: 'ac-mcp', label: 'MCP 工具发现', description: '首 run 懒建连 + tools/list 发现注册（per-Agent 暴露走工具清单的 include/exclude）', targets: ['loop/before-run'], automatic: true,
    listeners: [{ event: 'loop/before-run', role: 'MCP 工具懒建连' }],
  },
  {
    name: 'skill', row: 'ac-skill', label: '技能注入', description: '注入 <available_skills> 全局技能目录（whitelist per-Agent 白名单）', targets: ['loop/before-run'], configNs: 'skill',
    fields: [
      { name: 'whitelist', description: '技能白名单——留空 = 全部全局技能可见；每行一个技能名' },
      { name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
    ],
    listeners: [{ event: 'loop/before-run', role: '注入 <available_skills>', description: 'Agent 循环启动前拦截（人格/框架/记忆等扩展装配链的一环）', respectsEnabled: true }],
  },
  {
    name: 'persona', row: 'ac-persona', label: '人设注入', description: 'AGENT.md / persona 文本角色块前置注入 system prompt（file 优先 text 回退）', targets: ['loop/before-run'], configNs: 'persona',
    fields: [
      { name: 'text', description: '人设正文（与 file 二选一，file 优先）' },
      { name: 'file', description: '人设来源文件——裸名走 Agent 目录（如 AGENT.md），路径走文件系统；frontmatter 自动剥离' },
      { name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
    ],
    listeners: [{ event: 'loop/before-run', role: '前置 <persona> 块', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
  },
  {
    name: 'system-prompt', row: 'ac-system-prompt', label: '系统提示装配', description: 'framework/系统环境/术语约定/指引/后台任务/对话信息分块装配（override 可全量覆盖）', targets: ['loop/before-run'], configNs: 'system-prompt',
    fields: [
      { name: 'framework', description: 'framework 块正文——留空用内置默认' },
      { name: 'guidelines', description: '指引块正文（协作约定/文件工作流指引）' },
      { name: 'systemEnv', description: '系统环境块附加说明（workdir/allowedPaths 自动注入，此处为补充文字）' },
      { name: 'conversationPartner', description: '对话对象行显示名（缺省用端点注册表显示名）' },
      { name: 'override', description: 'SYSTEM.md 覆盖语义——true 时替换全部静态块（对话信息仍追加）' },
      { name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
    ],
    listeners: [{ event: 'loop/before-run', role: '分块装配', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
  },
  {
    name: 'datetime', row: 'ac-datetime', label: '日期注入', description: 'system 尾部追加仅日期行（日内稳定，KV cache 友好；无会话键不注入）', targets: ['loop/before-run'], configNs: 'datetime',
    fields: [{ name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' }],
    listeners: [{ event: 'loop/before-run', role: '日期行', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
  },
  {
    name: 'memory', row: 'ac-memory', label: '记忆加载', description: '长期记忆注入 <memory> 块（键=conversationId，maxTokens 预算截断）', targets: ['loop/before-run'], configNs: 'memory',
    fields: [
      { name: 'maxTokens', description: '记忆注入 token 预算——尾部近期记忆保留 + 截断标记' },
      { name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
    ],
    listeners: [{ event: 'loop/before-run', role: '<memory> 块注入', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
  },
  {
    name: 'session', row: 'ac-session', label: '工具前持久化', description: '工具副作用执行前 fail-closed checkpoint：排空该会话写入队列后才放行', targets: ['tool/before-execute'], automatic: true,
    listeners: [{ event: 'tool/before-execute', role: 'fail-closed checkpoint', description: '工具执行前拦截（安全策略/审计/参数改写）——承重：关停破坏会话桶一致性' }],
  },
  {
    name: 'security', row: 'ac-security', label: '安全检查·脱敏', description: '工具执行前能力门禁 + per-Agent 沙箱 + bash 命令扫描；工具结果变换脱敏（凭据明文/密钥模式）', targets: ['tool/before-execute', 'tool/transform-result'], configNs: 'security',
    fields: [
      { name: 'capabilities', description: '能力标签追加覆盖层（只加不减）——新授权建议写 Agent tags（M24 X4 单源）' },
      { name: 'workdir', description: 'per-Agent 工作目录（相对路径的锚点）' },
      { name: 'allowedPaths', description: '沙箱路径白名单（绝对路径；与 workspace 根合并）' },
      { name: 'denyPaths', description: '沙箱路径黑名单（优先于白名单；控制面文件自动注入）' },
      { name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
    ],
    listeners: [
      { event: 'tool/before-execute', role: '门禁+沙箱+bash 扫描', description: '工具执行前拦截（安全策略/审计/参数改写）——承重：关停失去全部 Agent 的门禁与沙箱', facet: 'gate', respectsEnabled: true },
      { event: 'tool/transform-result', role: '输出脱敏', description: '工具结果变换（脱敏/安全审查 seam——after 通知变换后终值）', facet: 'redact', respectsEnabled: true },
    ],
  },
  {
    name: 'web-tools', row: 'ac-web-tools', label: '网络工具行', description: 'web_search（多 provider + key 三源链）/browser 工具（provider per-Agent 选源）', targets: [], automatic: true, configNs: 'web-tools',
    fields: [
      { name: 'provider', description: 'web_search 提供方（tavily/serpapi/brave/duckduckgo/deepseek）' },
      { name: 'baseURL', description: '自定义 API 基址（覆盖提供方缺省）' },
      { name: 'model', description: '搜索模型（deepseek 提供方用）' },
      { name: 'maxUses', description: 'browser 工具每页最大使用次数' },
      { name: 'maxTokens', description: 'browser 页面内容 token 预算' },
      { name: 'apiVersion', description: 'API 版本（提供方相关）' },
      { name: 'defaultResults', description: '搜索缺省返回条数' },
      { name: 'defaultDepth', description: '网页抓取缺省深度' },
      { name: 'defaultTopic', description: '搜索缺省话题（general/news/finance）' },
      { name: 'rawContentMaxLen', description: '原文内容最大长度（超长截断）' },
    ],
    listeners: [],
  },
  {
    name: 'archive', row: 'ac-archive', label: '超长归档', description: '会话超阈值触发整理归档（预算 per-Agent 覆盖）', targets: ['loop/after-run'], automatic: true, configNs: 'archive',
    fields: [
      { name: 'maxContextTokens', description: '归档触发阈值——上下文估算超过即整理归档' },
      { name: 'archiveTokenRatio', description: '归档保留比（整理后概要预算占比）' },
      { name: 'keepRecentRatio', description: '近期消息保留比（尾部不归档比例）' },
    ],
    listeners: [{ event: 'loop/after-run', role: '阈值检测触发归档', description: 'run 结束通知（持久化/审计/指标订阅）' }],
  },
  {
    name: 'usage', row: 'ac-usage', label: 'Token 用量记录', description: 'after-run 双轨记账 + 审计流水（用量看板数据源）', targets: ['loop/after-run'], automatic: true,
    listeners: [{ event: 'loop/after-run', role: '双轨记账', description: 'run 结束通知（持久化/审计/指标订阅）——承重：关停用量看板断流' }],
  },
  {
    name: 'plugin-gates', row: 'ac-plugin-gates', label: '装载 gate 策略', description: '权限 + 契约双 gate（import 之前 fail-closed，代码不进进程）——保护行', targets: [], automatic: true,
    listeners: [{ event: 'plugin/before-load', role: '权限+契约双 gate', description: '插件装载前拦截（权限/契约 gate——代码不进进程）——承重：关停失去供应链防线' }],
  },
];

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

export function apply(ctx: Context) {
  const web = ctx.webServer;

  // ============ conversation：投递 / 中止 / 快照 ============

  web.registerRpc('conversation/deliver', async (params, caller) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    const message = messageOf(p.message);
    const placement = optStr(p.placement);
    const sender = optStr(p.sender) ?? VIEWER_AGENT_ID;
    const source = optStr(p.source);
    // 直答路径的会话键在此显式计算（M19/D3：边界算则前端透传——前端
    // 不传 conversationId；群/独立会话显式传键不受影响）
    const conversationId = optStr(p.conversationId) ?? pairKey(sender, agentId);
    // 等闲停靠预报（outcome timeout 前的中间态）：next-run + 忙 → parked
    if (placement === 'next-run' && ctx.conversation.isBusy(agentId, conversationId)) {
      caller.ack('parked', { agentId, conversationId });
    }
    const outcome = await ctx.conversation.deliver(agentId, message, {
      conversationId,
      sender,
      ...(source === 'user' || source === 'agent' || source === 'event' ? { source } : {}),
      ...(optStr(p.lane) ? { lane: optStr(p.lane) as 'next-step' | 'next-turn' } : {}),
      ...(placement ? { placement: placement as 'steer' | 'next-run' } : {}),
      ...(optNum(p.timeoutMs) !== undefined ? { timeoutMs: optNum(p.timeoutMs) } : {}),
      // M18-G：会话级模型覆盖（singles 引用语义）透传 router 信封
      ...(optStr(p.model) ? { model: optStr(p.model) } : {}),
    });
    if (outcome.kind === 'steered') {
      caller.ack('busy', { handle: outcome.handle });
    } else if (outcome.kind === 'queued') {
      caller.ack('busy', { queued: true, handle: outcome.handle });
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

  // 预设 Agent 目录（独立会话选用 UI / 空会话默认路由目标）。
  // 可选能力行：未装载时方法存在但返回错误（摘行不拖垮 RPC 面）。
  web.registerRpc('agents/presets', () => {
    const presets = ctx.get('agentPresets') as
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
    const all = ctx.tools.list().map((t) => t.name);
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
    // trigger 语义（受理即返回；参与者 run 在后台进行，事件面照常广播）
    const result = await ctx.group.send(reqStr(p, 'groupId'), reqStr(p, 'from'), reqStr(p, 'content'));
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

  // singles 为可选能力行：未装载时方法存在但返回错误（摘行不拖垮 RPC 面）
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

  web.registerRpc('backup/list', () => ({ backups: ctx.backup.list() }));

  // ============ jobs：后台任务面 ============

  web.registerRpc('jobs/list', (params) => ({
    jobs: ctx.jobs.list(optStr(obj(params).ownerAgentId)),
  }));

  web.registerRpc('jobs/get', (params) => {
    const p = obj(params);
    return { job: ctx.jobs.get(reqStr(p, 'id'), optStr(p.ownerAgentId)) };
  });

  web.registerRpc('jobs/read', (params) => {
    const p = obj(params);
    return ctx.jobs.read(reqStr(p, 'id'), optStr(p.ownerAgentId));
  });

  web.registerRpc('jobs/kill', (params) => {
    const p = obj(params);
    return ctx.jobs.kill(reqStr(p, 'id'), optStr(p.ownerAgentId), optStr(p.reason));
  });

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

  // ============ llm：模型池查看面（池编辑 = config 键面，非池 CRUD） ============

  web.registerRpc('llm/providers', () => ({
    providers: ctx.llm.providers(),
    stats: ctx.llm.stats(),
  }));

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

  // 扩展目录（M22 D4①）：静态常量 ∩ cordis registry（行摘除 → 条目隐藏）
  web.registerRpc('plugin/extension-catalog', () => {
    const rows = new Set<string>();
    for (const runtime of ctx.registry.values()) {
      if (runtime.name) rows.add(runtime.name);
    }
    return { extensions: EXTENSION_CATALOG.filter((e) => rows.has(e.row)) };
  });

  // 开发目录扫描（M22 D7②）：<root>/plugins/<agentId>/<name>/ 布局 + 数据根透出
  web.registerRpc('plugin/dev-scan', () => ctx.pluginRegistry.devScan());

  // ============================================================
  // M24 P3：plugin/catalog —— 目录信息架构后端（X2）
  //   · 内置组 = 包源清单（dev 扫描 preview/ac-*/ 的 package.json 元数据
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
      const fibers = [...runtime.fibers].filter((f) => f.uid !== null);
      rowsByName.set(runtime.name, { fibers: fibers.length, active: fibers.length > 0 });
    }
    const builtin: Array<{
      name: string;
      version?: string;
      description?: string;
      assembled: boolean;
      fibers: number;
    }> = [];
    let builtinNote: string | undefined;
    try {
      const previewDir = fileURLToPath(new URL('../../', import.meta.url));
      const dirs = readdirSync(previewDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('ac-'))
        .map((e) => e.name);
      for (const dir of dirs) {
        const pkg = readBuiltinPkg(join(previewDir, dir, 'package.json'));
        if (!pkg) continue; // 单包 package.json 缺失/损坏 → 跳过不阻断（mtime 缓存读）
        if (pkg.name !== dir) continue; // 名不符 → 不采信（与 rowMetaOf 同判据）
        // 目录判据（X2 收敛）：仅收声明 `agentchat.plugin: true` 的行包。
        // 纯库（ac-*-core 等，定义即零 cordis 依赖）与组合根（ac-app）是
        // 行的实现细节而非装配单元——fail-closed：未声明 = 不进目录（新包
        // 默认出局，行包漏声明的后果是良性 no-op 而非假可供性）。
        if (pkg.agentchat?.plugin !== true) continue;
        const row = rowsByName.get(pkg.name);
        builtin.push({
          name: pkg.name,
          ...(typeof pkg.version === 'string' && pkg.version ? { version: pkg.version } : {}),
          ...(typeof pkg.description === 'string' && pkg.description ? { description: pkg.description } : {}),
          assembled: row?.active === true,
          fibers: row?.fibers ?? 0,
        });
      }
      builtin.sort((a, b) => a.name.localeCompare(b.name));
      if (builtin.length === 0 && dirs.length > 0) {
        builtinNote = '未发现声明 agentchat.plugin 的行包（纯库/组合根非装配单元，不进目录）';
      }
    } catch {
      builtinNote = '内置目录仅开发形态可用（未扫描到 preview/ac-* 包源；生产 bundle 首期不内置清单）';
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
      /** yml/include 树行 id（M24 P4：行偏好层开关的真实锚点——patch 按 id 匹配） */
      entryId?: string;
    }> = [];
    for (const runtime of ctx.registry.values()) {
      const fibers = [...runtime.fibers].filter((f) => f.uid !== null);
      const dynamic = dynamicNames.get(runtime.name ?? '');
      const meta = rowMetaOf(runtime.name);
      rows.push({
        name: runtime.name ?? '(anonymous)',
        fibers: fibers.length,
        active: fibers.length > 0,
        origin: dynamic ? 'dynamic' : meta.origin,
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.version ? { version: meta.version } : {}),
        ...(dynamic?.owner ? { owner: dynamic.owner } : {}),
        // loader 树行 id（yml 行可 patch；内联/动态行无 entry）
        ...(fibers[0]?.entry?.id ? { entryId: fibers[0].entry.id } : {}),
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

  web.registerRpc('plugin/reload', (params) => ({
    reloaded: ctx.pluginRegistry.reload(reqStr(obj(params), 'name')),
  }));

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

  // ============ plugin：行偏好层 cordis.patch.yml（M23 P3-lite，A2/F12） ============

  web.registerRpc('plugin/patch-list', () => ctx.pluginRegistry.listPatches());

  // 写 patch（三态返回：hot（P7 保留，首期恒不返回）/ written+restart-required /
  // no-include-row；首期只写文件 + 显式重启生效提示——H2 裁剪）
  web.registerRpc('plugin/patch-set', async (params) => {
    const p = obj(params);
    return ctx.pluginRegistry.setPatch(reqStr(p, 'id'), p.disabled !== false);
  });

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
  // 事件与 global 监听器）。RPC 形状测试兜底 vendor 升级（events 层无公开
  // 列举 API，_hooks 私有读取是唯一路径）。
  web.registerRpc('events/listeners', () => {
    // M25 §3.5 归属升级：owner 裸 fiber 名 → 聚合行名（row 字段；
    // owner 原文保留——治理键不变，聚合只改呈现）
    const aggregate = computeRowAggregates(ctx);
    const hooksTable = (ctx.events as unknown as {
      _hooks: Record<string, Array<{ ctx?: { fiber?: { name?: string } }; prepend?: boolean; global?: boolean; description?: string }>>;
    })._hooks;
    const events: Array<{
      name: string;
      listeners: Array<{ owner: string; row: string; prepend: boolean; global: boolean; description?: string }>;
    }> = [];
    for (const [name, hooks] of Object.entries(hooksTable)) {
      if (typeof name !== 'string' || name.startsWith('internal/')) continue;
      const listeners = (hooks ?? [])
        .filter((h) => h?.ctx)
        .map((h) => {
          const owner = h.ctx!.fiber?.name ?? '(anonymous)';
          return {
            owner,
            row: aggregate.get(owner) ?? owner,
            prepend: h.prepend === true,
            global: h.global === true,
            // 注册时自述（ctx.on 第三参 description）——事件视图叶节点直接渲染
            ...(typeof h.description === 'string' && h.description ? { description: h.description } : {}),
          };
        });
      if (listeners.length > 0) events.push({ name, listeners });
    }
    events.sort((a, b) => a.name.localeCompare(b.name));
    return { events };
  });

  // ============================================================
  // M25 P2：事件描述声明制（events/descriptions）+ 治理面（policy-list/set）
  //   · 声明目录 = EXTENSION_CATALOG listeners（owning 行声明）∪ 动态插件
  //     manifest provides.events（string | {name, description}）；
  //   · 全量事件清单以声明目录为准（events/listeners 天然漏零监听器事件）；
  //   · 交叉 = 按 owner::event 关联执行链（未声明的监听器如实只显 owner）。
  // ============================================================
  web.registerRpc('events/descriptions', () => {
    // 1) 出厂行声明目录（∩ cordis registry：行摘除 → 条目隐藏）
    const rows = new Set<string>();
    for (const runtime of ctx.registry.values()) {
      if (runtime.name) rows.add(runtime.name);
    }
    const declared: Array<{
      owner: string;
      event: string;
      description: string;
      role?: string;
      facet?: string;
      respectsEnabled?: boolean;
      /** 声明来源：builtin（出厂行目录）| dynamic（manifest provides.events） */
      source: 'builtin' | 'dynamic';
      automatic?: boolean;
    }> = [];
    for (const ext of EXTENSION_CATALOG) {
      if (!rows.has(ext.row)) continue;
      for (const l of ext.listeners ?? []) {
        declared.push({
          owner: ext.row,
          event: l.event,
          description: l.description ?? `${ext.label} 在 ${l.event} 上的监听`,
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
          description:
            (typeof item === 'string' ? undefined : item.description) ??
            `动态插件 ${loaded.name} 声明订阅`,
          source: 'dynamic',
        });
      }
    }
    // 3) 交叉执行链（events/listeners 形状内联；_hooks 直读）
    const hooksTable = (ctx.events as unknown as {
      _hooks: Record<string, Array<{ ctx?: { fiber?: { name?: string } }; prepend?: boolean; global?: boolean }>>;
    })._hooks;
    const chains: Record<string, Array<{ owner: string; prepend: boolean; global: boolean }>> = {};
    for (const [name, hooks] of Object.entries(hooksTable)) {
      if (typeof name !== 'string' || name.startsWith('internal/')) continue;
      const listeners = (hooks ?? [])
        .filter((h) => h?.ctx)
        .map((h) => ({
          owner: h.ctx!.fiber?.name ?? '(anonymous)',
          prepend: h.prepend === true,
          global: h.global === true,
        }));
      if (listeners.length > 0) chains[name] = listeners;
    }
    return { descriptions: declared, chains };
  });

  // 治理面（可选能力行：ac-event-policy 未装载时方法存在但返回错误）
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
  // 不读文件内容；path 空 = 快捷根清单）
  web.registerRpc('workspace/browse-dirs', (params) => {
    const p = obj(params);
    return ctx.workspace.browseDirs(typeof p.path === 'string' ? p.path : '');
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
