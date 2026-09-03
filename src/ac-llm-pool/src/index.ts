// ============================================================
// ac-llm-pool —— 配置驱动的 LLM provider 连接注册行
//
// llm-provider-model-plan P2（种子机制已移除——用户裁决 2026-09-01：
// 连接池 = 唯一事实源）：
//   · 读 config.llmProviders（池 v2 = 连接定义）：条目名 = provider 名，
//     base_url 为连接必要条件（OpenAI 兼容端点）；defaultModel 为该连接
//     默认模型；models 为 /models 发现缓存（拉通才存在）。
//   · api_key 不进工厂——凭据链（ac-credentials）按 pool:<名>
//     per-request 注入；无凭据即 401（未配置 = 不可用，如实呈现）。
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
import type {} from 'ac-llm'; // ctx.llm 服务类型增强（type-only，无运行时依赖）
import type {} from 'ac-config'; // ctx.config 服务类型增强（type-only）

export const name = 'ac-llm-pool';
export const inject = ['llm', 'config'];

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
  /** 全局默认连接标记（ac-agent-presets / ac-agent-admin 消费） */
  default?: boolean;
  /** 旧别名条目残留（provider+model 形态；迁移后消失） */
  provider?: string;
  model?: string;
}

/** 模型能力元数据（models 数组对象形态；vision = 探测确认收图，
 *  hidden = 前端下拉隐藏显示——路由不受影响，纯 UI 呈现语义） */
export interface PoolModelEntry {
  model: string;
  vision?: true;
  hidden?: true;
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
      const o = m as { model: string; vision?: unknown; hidden?: unknown };
      entry = {
        model: o.model,
        ...(o.vision === true ? { vision: true } : {}),
        ...(o.hidden === true ? { hidden: true } : {}),
      };
    }
    if (entry === undefined || seen.has(entry.model)) continue;
    seen.add(entry.model);
    out.push(entry);
  }
  return out;
}

/** 期望注册集的单条 */
interface Desired {
  baseUrl: string;
  defaultModel: string | undefined;
  models: string[];
  /** 能力元数据（探测/手配的 vision + UI hidden）：签名与 stats 消费 */
  modelMeta: Record<string, { vision?: true; hidden?: true }>;
  visionModels: string[];
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
    desired.set(name, {
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
    });
  }
  return desired;
}

/** 内容签名（变更检测；models 序列化稳定性由发现端字典序保证——
 *  modelMeta 随附，探测标志/隐藏位变更即热更重挂） */
function signatureOf(d: Desired): string {
  return JSON.stringify([d.baseUrl, d.defaultModel ?? '', d.models, d.modelMeta, d.visionModels]);
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
 *   · 无具体模型可物化（无 defaultModel/model）→ undefined。
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
        : undefined;
  if (!model) return undefined;
  const provider =
    typeof entry.provider === 'string' && entry.provider && !entry.base_url
      ? entry.provider // 旧别名条目：指向另一 provider 名
      : name;
  return { provider, model };
}

export function apply(ctx: Context) {
  const llm = ctx.llm;
  const disposers = new Map<string, () => unknown>();
  const signatures = new Map<string, string>();

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
    }
    // 挂：新增或重挂
    for (const [name, d] of desired) {
      if (signatures.has(name)) continue;
      try {
        disposers.set(name, registerOne(name, d));
        signatures.set(name, signatureOf(d));
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
