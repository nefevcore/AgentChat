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
export function isVisible(field: FieldMeta, nsConfig: Record<string, unknown>): boolean {
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
 * - llm：GET 时后端会展开成完整对象，保存只保留 $ref 紧凑引用（防 config.json 膨胀/失去池引用）
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
    } else {
      delete cleaned.llm;
    }
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
      for (const k of ['tavilyApiKey', 'serpapiApiKey', 'braveApiKey']) {
        if ((entry as any)[k] === MASK) delete (entry as any)[k];
      }
    }
  }
  return cleaned;
}
