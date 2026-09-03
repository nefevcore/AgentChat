// ============================================================
// settings/schema.ts —— Schema 归一化（唯一实现）
// 后端 schema 存在两种格式：
//   1. 数组：[{ name, label, type, ... }]（llm/search/namespace schemas）
//   2. 对象：{ fieldKey: { label, type, ... }, _label: {...} }（旧插件格式）
// 本模块统一为 FieldMeta[]，options 统一为 { label, value }[]。
// ============================================================

import type { FieldMeta } from './types';

/** 归一化单个字段：对象格式的 { label, type, ... } 或数组元素的 { name, label, ... } */
function normalizeOne(keyOrName: string, raw: Record<string, any> | undefined): FieldMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const meta: FieldMeta = {
    key: raw.name ?? keyOrName,
    label: raw.label || keyOrName,
    description: raw.description ?? '',
    type: raw.type ?? 'text',
  };
  if (raw.options !== undefined) {
    meta.options = Array.isArray(raw.options)
      ? raw.options.map((o: any) =>
          typeof o === 'string' ? { label: o, value: o } : { label: String(o.label ?? o.value), value: o.value },
        )
      : undefined;
  }
  if (raw.min !== undefined) meta.min = raw.min;
  if (raw.max !== undefined) meta.max = raw.max;
  if (raw.step !== undefined) meta.step = raw.step;
  if (raw.display !== undefined) meta.display = raw.display;
  if (raw.default !== undefined) meta.default = raw.default;
  if (raw.sensitive !== undefined) meta.sensitive = raw.sensitive;
  if (raw.accept !== undefined) meta.accept = raw.accept;
  if (raw.showWhen !== undefined) meta.showWhen = raw.showWhen;
  return meta;
}

/** 把任意格式的 schema（数组或对象）归一化为 FieldMeta[] */
export function toFields(raw: unknown): FieldMeta[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item: any) => {
        // 已是归一化 FieldMeta（带 key）则直接使用
        if (item && typeof item === 'object' && item.key) return { ...item } as FieldMeta;
        // 后端数组格式（带 name）
        return normalizeOne(String(item?.name ?? ''), item);
      })
      .filter((f): f is FieldMeta => f !== null);
  }
  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, any>)
      .filter(([k]) => k !== '_label' && k !== '$comment')
      .map(([k, v]) => normalizeOne(k, v))
      .filter((f): f is FieldMeta => f !== null);
  }
  return [];
}

/** showWhen 过滤：某字段是否应显示（同级配置满足条件） */
function isVisible(field: FieldMeta, nsConfig: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  return Object.entries(field.showWhen).every(([k, v]) => nsConfig[k] === v);
}

/** 过滤：showWhen + 搜索关键字 */
export function filterFields(fields: FieldMeta[], nsConfig: Record<string, unknown>, query: string): FieldMeta[] {
  const visible = fields.filter(f => isVisible(f, nsConfig));
  const q = query.trim().toLowerCase();
  if (!q) return visible;
  return visible.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
}

/** 判断当前值是否非默认（用于高亮/显示恢复按钮） */
export function isNonDefault(val: unknown, def: unknown): boolean {
  if (def === undefined || def === null) return val !== undefined && val !== null && val !== '';
  if (val === undefined || val === null) return false;
  return JSON.stringify(val) !== JSON.stringify(def);
}

/** 数字解析：非数字回退原值 */
export function parseNum(val: any): any {
  const n = Number(val);
  return isNaN(n) ? val : n;
}

/** ratio 显示格式化 */
export function formatRatio(val: number | undefined, display?: string): string {
  if (val === undefined || val === null) return '';
  if (display === 'percent') return Math.round(val * 100) + '%';
  return String(val);
}

/**
 * 保存前归一化全局配置（数据一致性）：
 * - llm：GET 时后端会把 $ref 展开成完整对象，保存时折叠回 {$ref} 紧凑引用
 *   （防 config.json 膨胀/失去池引用）；显式内嵌对象（无 $ref，可能是非池的
 *   独立 LLM 配置）保留原样，不静默丢弃
 * - 清理掩码 api_key（••••••••），防止残留写回
 */
export function sanitizeGlobalConfig(raw: Record<string, any>): Record<string, any> {
  const MASK = '••••••••';
  const cleaned = JSON.parse(JSON.stringify(raw, (k, v) => v ?? undefined));
  if (cleaned.llm !== undefined) {
    if (typeof cleaned.llm === 'string') {
      // 旧格式字符串引用，保留原样
    } else if (cleaned.llm && typeof cleaned.llm === 'object' && cleaned.llm.$ref) {
      cleaned.llm = { $ref: cleaned.llm.$ref };
    }
    // 显式内嵌对象（无 $ref）：合法配置形态，保留
  }
  if (cleaned.llm && typeof cleaned.llm === 'object' && cleaned.llm.api_key === MASK) delete cleaned.llm.api_key;
  if (cleaned.llmProviders && typeof cleaned.llmProviders === 'object') {
    for (const entry of Object.values(cleaned.llmProviders)) {
      if (entry && typeof entry === 'object' && (entry as any).api_key === MASK) delete (entry as any).api_key;
    }
  }
  if (cleaned.searchProviders && typeof cleaned.searchProviders === 'object') {
    for (const entry of Object.values(cleaned.searchProviders)) {
      if (!entry || typeof entry !== 'object') continue;
      for (const k of ['tavilyApiKey', 'serpapiApiKey', 'braveApiKey', 'deepseekApiKey']) {
        if ((entry as any)[k] === MASK) delete (entry as any)[k];
      }
    }
  }
  return cleaned;
}

// ============================================================
// 池"设为默认"同步（搜索池 / 模型池共用核心）
//
// 背景（bug 修复）：池条目的 default:true 只在全局引用缺失或中性时被解析层
// 采用；若全局残留显式引用对象（provider/apiKey 等字段，或 GET 展开回写的
// 完整对象），会静默遮蔽池默认——用户在池面板点"设为默认"后看似不生效。
// 同步函数在池每次更新时调用，让"设为默认"确定性地落到全局引用：
// - 有默认条目且全局引用未指向它 → 重写为 { ...用户覆盖, $ref: 默认条目 }
// - 默认条目被删且引用悬空 → 删除全局引用（解析层回落池首项/内嵌）
// - 其余情形（已一致 / 无默认条目但引用完好）→ 不动
// ============================================================

/** 池中 default:true 的条目名（无则 null；$ 前缀内部键忽略） */
function defaultPoolEntryName(pools: Record<string, any>): string | null {
  const entries = Object.entries(pools ?? {}).filter(([k]) => !k.startsWith('$'));
  return entries.find(([, v]) => v && (v as any).default)?.[0] ?? null;
}

/**
 * 重写全局引用时的覆盖保留规则：
 * - 遮蔽字段（shadowKeys）一律剥离——它们决定"用哪个条目"，保留即遮蔽
 * - 目标默认条目自带的字段不保留——条目自己的值优先，避免旧条目的调优字段
 *   （如 reasoning_effort）反客为主遮蔽新条目；GET 展开对象的全部字段都在
 *   条目里，因此展开对象重写后自然还原为纯 {$ref}
 * - 值与旧引用条目（oldEntry）相同的字段视为展开残留而非用户覆盖，丢弃
 * - 其余字段（两个条目都没有的用户调优，如 temperature）保留
 */
function collectKeepOverrides(
  current: unknown,
  defEntry: Record<string, any>,
  shadowKeys: string[],
  oldEntry?: Record<string, any>,
): Record<string, any> {
  const keep: Record<string, any> = {};
  if (!current || typeof current !== 'object') return keep;
  for (const [k, v] of Object.entries(current as Record<string, any>)) {
    if (k === '$ref' || v === undefined) continue;
    if (shadowKeys.includes(k)) continue;
    if (k in defEntry) continue;
    if (oldEntry && k in oldEntry && JSON.stringify(oldEntry[k]) === JSON.stringify(v)) continue;
    keep[k] = v;
  }
  return keep;
}

/**
 * 搜索池"设为默认"同步：把全局 tool.web_search 指向默认池条目（$ref）。
 */
export function applySearchPoolDefault(
  pools: Record<string, any>,
  globalConfig: Record<string, any>,
): void {
  const defName = defaultPoolEntryName(pools);
  const ns = globalConfig['tool.web_search'];

  if (!defName) {
    if (ns && typeof ns === 'object' && ns.$ref && !pools[ns.$ref]) {
      delete globalConfig['tool.web_search'];
    }
    return;
  }
  if (ns && typeof ns === 'object' && ns.$ref === defName) return;

  const shadowKeys = [
    'provider', 'tavilyApiKey', 'serpapiApiKey', 'braveApiKey', 'deepseekApiKey',
    // 旧版本遗留死字段（全库零消费者），重写时一并清理
    'quota', 'creditsFile',
  ];
  const oldRef = (ns && typeof ns === 'object' && typeof ns.$ref === 'string') ? ns.$ref : null;
  const keep = collectKeepOverrides(ns, pools[defName] ?? {}, shadowKeys, oldRef ? pools[oldRef] : undefined);
  globalConfig['tool.web_search'] = { ...keep, $ref: defName };
}

/**
 * 模型池「设为默认」同步已退役（llm-provider-model-plan 池 v2）：
 * 连接池的默认 = 条目 default:true 标记，服务端 defaultPoolConnection
 * 直读——不再维护全局 llm 引用键（存量 llm 键由 sanitize 折叠容错）。
 */