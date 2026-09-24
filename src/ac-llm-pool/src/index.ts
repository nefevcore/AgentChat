// ============================================================
// ac-llm-pool —— 配置驱动的 LLM provider 连接注册行
//
// llm-provider-model-plan P2（种子机制已移除——用户裁决 2026-09-01：
// 连接池 = 唯一事实源）：
//   · 读 config.llmProviders（池 v2 = 连接定义）：条目名 = provider 名，
//     base_url 为连接必要条件（OpenAI 兼容端点）；defaultModel 为该连接
//     默认模型；models 为 /models 发现缓存（拉通才存在）；timeout_ms /
//     headers 为连接参数透传（D3：无进展超时 + 网关自定义头）。
//   · api_key 不进工厂——凭据注入（./credentials.ts，2026-09-05 自
//     ac-credentials 迁入：LLM 域感知凭据横切服务，方向修正）按
//     pool:<名> per-request 注入；无凭据即 401（未配置 = 不可用，如实呈现）。
//   · 未配置 = 不注册：模型下拉/警示判定只看连接池，无任何隐式兜底
//     （不再有"内置种子/环境变量开箱即用"语义）。
//   · 热更：订阅 config/changed → diff（内容签名）→ 撤/挂注册。撤注册
//     走 register 返回的 disposer（手动调用 + 行卸载自动执行，双调用
//     no-op——cordis fiber.effect 契约）；已实例化 provider 自动 close()。
//   · 无 base_url 条目（迁移前别名残留）跳过并 warn——迁移脚本
//     （scripts/migrate-llm-pool-v2.ts）负责收敛。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { extname } from 'node:path';
import * as fs from 'node:fs';
import { OpenAICompletions } from 'ac-openai-completions';
import { registerCredentialsInjection } from './credentials.ts';
import {
  resolveSessionHeader,
  registerSessionAffinityInjection,
  type SessionHeaderSpec,
} from './session-affinity.ts';
import type {} from 'ac-llm'; // ctx.llm 服务类型增强（type-only，无运行时依赖）
import type {} from 'ac-config'; // ctx.config 服务类型增强（type-only）

export const name = 'ac-llm-pool';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'llm-pool',
  label: 'LLM 连接池',
  description: '配置驱动 provider 注册行：读 config llmProviders 连接池（base_url + defaultModel + 模型发现缓存；连接池 = 唯一事实源）',
  automatic: true,
};
export const inject = ['llm', 'config'];

// 凭据注入（llm/before-chat → pool:<provider> apiKey；2026-09-05 自
// ac-credentials 迁入——纯函数与订阅装配详见 ./credentials.ts）
export { resolveLlmApiKey } from './credentials.ts';
export { resolveSessionHeader, sessionHeaderValue } from './session-affinity.ts';

/** 池条目 v2 形状（连接定义；model 键为旧别名条目容错读取） */
export interface LlmPoolEntry {
  /** OpenAI 兼容 base URL（连接必要条件） */
  base_url?: string;
  /** 该连接的默认模型（Agent 创建未显式选模型时的物化兜底） */
  defaultModel?: string;
  /** /models 发现缓存（宽容双形态：裸名 string 或 {model, vision?, hidden?}；
   *  读侧经 normalizePoolModels 归一——裸名进路由清单，vision/hidden 是
   *  能力元数据：vision 并集进物化门控，hidden 过滤前端下拉显示） */
  models?: Array<string | PoolModelEntry>;
  /**
   * 视觉模型清单（多模态一期：精确 > 前缀 `m-`/`m/` > 通配 `*`）：
   * 命中的模型把 user 消息 attachments 物化为 image_url content 块；
   * 未配置/未命中一律剥离（非视觉模型收到图片块会 400，fail-closed）。
   * 例：['deepseek-v4-flash-vision-exp', 'glm-4v', 'glm-4.5v'] 或整条
   * 视觉专用连接直接 ['*']。与 models[].vision 探测标志取并集生效。
   */
  visionModels?: string[];
  /**
   * 单次请求无进展超时毫秒（D3 透传协议层 timeoutMs）：建连/响应头/
   * 每条 SSE data 事件刷新计时——活跃长生成不限总时长，静默流窗口内
   * 中止。正有限数才生效，其余忽略（回落协议层缺省 180s）。
   */
  timeout_ms?: number;
  /**
   * 接口格式（2026-09-10 Responses 扩展，对齐 DSH/pi-ai 的 api 键）：
   * 'responses' = POST {base}/responses（OpenAI 新模型 / xAI 等支持的
   * 格式）；缺省/其余值 = chat/completions。仅换线格式——messages 进 /
   * chunks 出的域契约不变，Agent/路由/loop 零感知。
   */
  api?: 'completions' | 'responses';
  /**
   * 自定义请求头（D3：部分网关需非标鉴权头）：并入每条 completions
   * 请求，同名覆盖内置 content-type/authorization。仅 string 值项生效
   * （其余静默丢弃——normalizePoolHeaders 唯一解析点）。
   */
  headers?: Record<string, string>;
  /**
   * 会话亲和头（2026-09 连通性复查）：部分托管网关要求每会话稳定的
   * session 头（如 opencode.ai 的 x-opencode-session，缺发即 400
   * MissingSessionID）。缺省 = 按内置事实清单自动匹配 base_url；
   * { name: '<头名>' } 显式指定；false 强制关闭。头值始终按会话
   * 确定性派生（详见 ./session-affinity.ts）。
   */
  sessionHeader?: SessionHeaderSpec;
  /** 全局默认连接标记（ac-agent-presets / ac-agent-admin 消费） */
  default?: boolean;
  /** 旧别名条目残留（provider+model 形态；迁移后消失） */
  provider?: string;
  model?: string;
}

/** 模型能力元数据（models 数组对象形态；vision = 探测确认收图，
 *  hidden = 前端下拉隐藏显示——路由不受影响，纯 UI 呈现语义；
 *  manual = 手工新增条目——/models 发现刷新时保留〔端点不暴露清单
 *  只能手工加的场景〕，仅参与合并语义，不进门控/签名） */
export interface PoolModelEntry {
  model: string;
  vision?: true;
  hidden?: true;
  manual?: true;
}

/**
 * models 数组宽容归一（读侧唯一解析点）：裸名 string / 对象
 * {model, vision?, hidden?} 双形态 → 统一对象形态；非法项丢弃、按名去重
 * （首个胜）。web-api 回写与 webui 下拉过滤共用。
 */
export function normalizePoolModels(raw: unknown): PoolModelEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PoolModelEntry[] = [];
  for (const m of raw) {
    let entry: PoolModelEntry | undefined;
    if (typeof m === 'string' && m) entry = { model: m };
    else if (m !== null && typeof m === 'object' && typeof (m as { model?: unknown }).model === 'string' && (m as { model: string }).model) {
      const o = m as { model: string; vision?: unknown; hidden?: unknown; manual?: unknown };
      entry = {
        model: o.model,
        ...(o.vision === true ? { vision: true } : {}),
        ...(o.hidden === true ? { hidden: true } : {}),
        ...(o.manual === true ? { manual: true } : {}),
      };
    }
    if (entry === undefined || seen.has(entry.model)) continue;
    seen.add(entry.model);
    out.push(entry);
  }
  return out;
}

/**
 * 池条目 headers 宽容归一（读侧唯一解析点）：只收 string 值项——网关
 * 鉴权头是字符串语义，静默强转数字/对象易藏配置错误；全空按未配置
 * （undefined = 协议层零自定义头）。
 */
export function normalizePoolHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 期望注册集的单条 */
interface Desired {
  baseUrl: string;
  defaultModel: string | undefined;
  models: string[];
  /** 能力元数据（探测/手配的 vision + UI hidden）：签名与 stats 消费 */
  modelMeta: Record<string, { vision?: true; hidden?: true }>;
  visionModels: string[];
  /** 无进展超时毫秒（正有限数才透传；缺省回落协议层 180s） */
  timeoutMs?: number;
  /** 接口格式（'responses' = Responses API 端点；缺省 chat/completions） */
  api: 'completions' | 'responses';
  /** 自定义请求头（string 值项过滤后透传；空对象按未配置） */
  headers?: Record<string, string>;
  /** 会话亲和头名（resolveSessionHeader 解析产物；undefined = 不注入） */
  sessionHeader?: string;
}

/** 期望注册集：有 base_url 的连接条目（其余跳过并上报） */
export function desiredProviders(
  pool: Record<string, unknown> | undefined,
  onSkipped?: (name: string) => void,
): Map<string, Desired> {
  const desired = new Map<string, Desired>();
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return desired;
  for (const [name, raw] of Object.entries(pool)) {
    if (name.startsWith('$')) continue; // $ref/$comment 内部键
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as LlmPoolEntry;
    if (!entry.base_url) {
      // 连接必要条件缺失（旧别名残留）：跳过
      onSkipped?.(name);
      continue;
    }
    const modelEntries = normalizePoolModels(entry.models);
    const modelMeta: Record<string, { vision?: true; hidden?: true }> = {};
    for (const e of modelEntries) {
      if (e.vision === true || e.hidden === true) modelMeta[e.model] = { ...(e.vision ? { vision: true } : {}), ...(e.hidden ? { hidden: true } : {}) };
    }
    const timeoutRaw = entry.timeout_ms;
    const timeoutMs =
      typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined;
    const headers = normalizePoolHeaders(entry.headers);
    const sessionHeader = resolveSessionHeader(entry.base_url, entry.sessionHeader);
    desired.set(name, {
      ...(sessionHeader ? { sessionHeader } : {}),
      baseUrl: entry.base_url,
      defaultModel:
        typeof entry.defaultModel === 'string' && entry.defaultModel
          ? entry.defaultModel
          : typeof entry.model === 'string' && entry.model
            ? entry.model // 旧别名条目的 model 键容错
            : undefined,
      models: modelEntries.map((e) => e.model),
      modelMeta,
      visionModels: Array.isArray(entry.visionModels)
        ? entry.visionModels.filter((m) => typeof m === 'string' && m)
        : [],
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      api: entry.api === 'responses' ? 'responses' : 'completions',
      ...(headers !== undefined ? { headers } : {}),
    });
  }
  return desired;
}

/** 内容签名（变更检测；models 序列化稳定性由发现端字典序保证——
 *  modelMeta 随附，探测标志/隐藏位变更即热更重挂；timeout_ms/headers/
 *  api 同批进签名（D3/D4）——连接参数与接口格式变更即重挂） */
function signatureOf(d: Desired): string {
  return JSON.stringify([d.baseUrl, d.defaultModel ?? '', d.models, d.modelMeta, d.visionModels, d.timeoutMs ?? -1, d.headers ?? null, d.api, d.sessionHeader ?? null]);
}

/**
 * 媒体 MIME 猜测（按扩展名；ac-workspace CONTENT_TYPES 的图片 + GLM
 * file 块支持文档子集同口径——本地小表防跨行 import 实现面的反模式）。
 * 图片 → image_url 块；文档（pdf/txt/...）→ file 块 file_data。
 */
const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 物化缓存条目上限（LRU：命中即续期，超限逐最旧；data URL 常驻内存） */
const MEDIA_CACHE_MAX_ENTRIES = 24;

/**
 * 媒体引用物化器（多模态一期 + M4 LRU 缓存）：workspace 相对路径 →
 * data: base64 URL。文件读取走 workspace 服务方法（resolveFile，
 * owning 域，无越权读）；服务缺席/文件缺失/读取失败/扩展名不在
 * MIME 表 → undefined（适配层降级文本占位）。http(s) 引用不经此
 * （适配层直传）。
 * 缓存键 = ref；新鲜度 = stat(mtimeMs+size)——文件被覆写即失效重物化，
 * 同图跨轮回放命中缓存免重复读盘+编码。每条连接一个 resolver 实例
 * （工厂闭包），缓存随 provider 实例生命周期（注销 close 即回收）。
 */
function workspaceMediaResolver(ctx: Context): (ref: string) => Promise<string | undefined> {
  const cache = new Map<string, { mtimeMs: number; size: number; url: string }>();
  return async (ref: string) => {
    const ws = ctx.get('workspace', false) as
      | { resolveFile?(relPath: string): string }
      | undefined;
    if (typeof ws?.resolveFile !== 'function') return undefined;
    let file: string;
    let stat: { mtimeMs: number; size: number };
    try {
      file = ws.resolveFile(ref);
      stat = fs.statSync(file);
    } catch {
      return undefined;
    }
    const mime = MEDIA_MIME[extname(file).toLowerCase()];
    if (mime === undefined) return undefined; // 不在 MIME 表不物化（fail-closed）
    const hit = cache.get(ref);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      cache.delete(ref);
      cache.set(ref, hit); // LRU 续期
      return hit.url;
    }
    try {
      const data = await fs.promises.readFile(file);
      const url = `data:${mime};base64,${data.toString('base64')}`;
      cache.set(ref, { mtimeMs: stat.mtimeMs, size: stat.size, url });
      if (cache.size > MEDIA_CACHE_MAX_ENTRIES) {
        cache.delete(cache.keys().next().value as string); // 逐最旧（插入序首位）
      }
      return url;
    } catch {
      return undefined;
    }
  };
}

/**
 * 默认池连接（ac-agent-presets / ac-agent-admin 物化口共源——P5 口径统一）：
 * `default:true` 优先，缺省第一条（非 $ 前缀对象条目）。
 *   · v2 条目（base_url/defaultModel）→ provider = 条目名，model = defaultModel；
 *   · 旧别名条目（provider+model）→ provider = entry.provider，model = entry.model；
 *   · 无 defaultModel/model → 回落 models 缓存可见清单的"最新"一项（降序
 *     字典序首项，跳过 hidden——与 PoolManager「读取清单后自动取第一个」
 *     同一语义。自定义提供方常只填连接不选默认模型，2026-09-10 反馈：
 *     该形态做默认连接时「默认/继承全局」物化失败致建 Agent 报错）；
 *   · 无任何可物化模型 → undefined。
 */
export function defaultPoolConnection(
  pool: Record<string, unknown> | undefined,
): { provider: string; model: string } | undefined {
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return undefined;
  const entries = Object.entries(pool).filter(
    ([k, v]) => !k.startsWith('$') && v !== null && typeof v === 'object' && !Array.isArray(v),
  ) as Array<[string, LlmPoolEntry]>;
  const def = entries.find(([, v]) => v.default === true) ?? entries[0];
  if (!def) return undefined;
  const [name, entry] = def;
  const model =
    typeof entry.defaultModel === 'string' && entry.defaultModel
      ? entry.defaultModel
      : typeof entry.model === 'string' && entry.model
        ? entry.model
        : newestVisibleModel(entry);
  if (!model) return undefined;
  const provider =
    typeof entry.provider === 'string' && entry.provider && !entry.base_url
      ? entry.provider // 旧别名条目：指向另一 provider 名
      : name;
  return { provider, model };
}

/** models 缓存可见清单的降序首项（≈ 命名最新；hidden = 旧模型归档标记跳过） */
function newestVisibleModel(entry: LlmPoolEntry): string | undefined {
  const visible = normalizePoolModels(entry.models).filter((m) => m.hidden !== true);
  return [...visible].sort((a, b) => b.model.localeCompare(a.model))[0]?.model;
}

export function apply(ctx: Context) {
  const llm = ctx.llm;
  const disposers = new Map<string, () => unknown>();
  const signatures = new Map<string, string>();

  // 凭据注入（llm/before-chat → pool:<provider> apiKey）：随本行生命周期
  // 订阅/回收；credentials 行未装载 = 不注入（可选能力）
  registerCredentialsInjection(ctx);

  // 会话亲和头注入（llm/before-chat → preset 网关按会话派生稳定头）：
  // headerOf 查当前期望集（sync 维护 name → sessionHeader，热更跟随）
  const sessionHeaders = new Map<string, string>();
  registerSessionAffinityInjection(ctx, (provider) => sessionHeaders.get(provider));

  const registerOne = (name: string, d: Desired): (() => unknown) => {
    // 视觉门控统一：显式 visionModels（前缀/通配）∪ 探测标志的
    // models[].vision ——适配层零改动，两来源同一语义
    const effectiveVision = [...d.visionModels, ...Object.entries(d.modelMeta).filter(([, m]) => m.vision).map(([model]) => model)];
    const disposer = llm.register(
      name,
      () =>
        new OpenAICompletions({
          baseUrl: d.baseUrl,
          defaultModel: d.defaultModel,
          // D3 连接参数透传：无进展超时 + 自定义网关头（缺省回落协议层默认）
          ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}),
          ...(d.headers !== undefined ? { headers: d.headers } : {}),
          // D4 接口格式：'responses' = POST /responses（请求体/事件流在
          // 协议库内转换，域契约不变）
          api: d.api,
          ...(effectiveVision.length > 0 ? { visionModels: effectiveVision } : {}),
          // 媒体引用物化：workspace 相对路径（files/... 前缀）→ data: base64
          // URL。workspace 为可选能力（行未装 = 附件降级文本占位，不炸请求）；
          // 调用时经 ctx.get 解析（root-traced，M12 铁律 2）。
          ...(effectiveVision.length > 0 ? { resolveMedia: workspaceMediaResolver(ctx) } : {}),
          // 凭据不进工厂：ac-credentials 按 pool:<名> per-request 注入
        }),
      {
        models: d.models,
        baseUrl: d.baseUrl, // 连接锚点：诊断 + llm/models 发现 RPC
        description: `OpenAI 兼容连接 ${d.baseUrl}`,
        // 能力元数据透出（llm/providers stats → 前端徽章/过滤）
        ...(Object.keys(d.modelMeta).length > 0 ? { modelMeta: d.modelMeta } : {}),
        // 视觉门控有效并集（显式 visionModels ∪ models[].vision）：
        // 适配层物化与 ctx.llm.visionOf 查询口（系统提示词注入）同源
        ...(effectiveVision.length > 0 ? { visionModels: effectiveVision } : {}),
      },
    );
    return () => void disposer();
  };

  /** 期望集 → 撤/挂 diff。boot 期（首sync）重名 fail-loud；热更期容错续命。 */
  const sync = (boot: boolean): void => {
    const desired = desiredProviders(
      ctx.config.get<Record<string, unknown>>('llmProviders'),
      (name) => {
        ctx.logger.warn(
          '[llm-pool] 池条目 "%C" 缺 base_url（连接必要条件；旧别名残留？）——未注册；请运行迁移脚本 scripts/migrate-llm-pool-v2.ts',
          name,
        );
      },
    );
    // 撤：消失或内容变更（disposer 手动调用幂等；工厂/实例同步摘除）
    for (const [name, sig] of signatures) {
      const next = desired.get(name);
      if (next && signatureOf(next) === sig) continue;
      disposers.get(name)?.();
      disposers.delete(name);
      signatures.delete(name);
      sessionHeaders.delete(name);
    }
    // 挂：新增或重挂
    for (const [name, d] of desired) {
      if (signatures.has(name)) continue;
      try {
        disposers.set(name, registerOne(name, d));
        signatures.set(name, signatureOf(d));
        if (d.sessionHeader) sessionHeaders.set(name, d.sessionHeader);
      } catch (err) {
        if (boot) throw err; // boot 期 fail-loud（fiber FAILED 可诊断）
        ctx.logger.error(
          '[llm-pool] 注册 provider "%C" 失败（跳过）: %C',
          name,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  sync(true);
  // 热更：池配置变更 → diff 重挂（models 发现缓存回写 / 用户编辑连接）
  ctx.on('config/changed', () => sync(false), { description: '池配置热更：diff 重挂 provider 注册' });
}
