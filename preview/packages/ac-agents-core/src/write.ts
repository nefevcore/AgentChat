// ============================================================
// write.ts —— 身份写面词汇（cr-542；M8.8 前置 agent-admin 写侧 RPC 编排的
// 纯库半边）
//
// 主线 ac-agent-admin 的 sanitize（白名单 + model 引用归一 + id 派生）与
// 变更键报告是「写口语义」——各域 owning 化后属 AgentConfig 契约邻域，按
// 机制归位表（纯算法 → 纯库）落 ac-agents-core（契约 owning 包）。三处
// 语义订正（每处都是主线形态的缝，见下）：
//   · 变更键 = 并集 JSON 比较：主线 computeDiff 只从 subject 侧比较——键删除
//     （null 删 settings[name]）恒漏报，只能靠调用点补丁键兜底（updateAssembly
//     曾如此）；本实现一次断根。
//   · 清除词形 = null 标记 + 合成时删键（applyConfigPatch）：主线以「null 覆盖
//     落盘 + 消费侧 falsy 回落」双轨表达清除（deepMerge 删不掉键的绕道）；
//     文件即注册的写面里键存在性本身有语义，故清除 = 删键单轨。
//   · 缺 model 的非 virtual 身份不物化默认连接（缺键 = 跟随全局默认）：写口
//     固化创建时点的默认模型会让全局换默认对存量身份失效。
// ============================================================
import { assertAgentId, isAgentIdentity } from './tree.ts';
import type { AgentConfig } from './config.ts';

/** AgentConfig 字段白名单（fail-closed：未知键拒绝而非静默剔除——全局专属键
 *  已随各域 owning 化退役；连接凭据归 provider 定义，身份面不可覆盖） */
export const AGENT_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  'id', 'model', 'provider', 'virtual', 'system', 'tools', 'llmParams',
  'maxSteps', 'name', 'description', 'tags', 'settings',
]);

/** sanitize 选项 */
export interface SanitizeOptions {
  /** create 派生 id 的撞名判定（缺省 = 恒不撞；调用方传编辑面既有 id 面） */
  idTaken?: (id: string) => boolean;
}

/**
 * 写面入参归一（create 与 update 共用）：白名单校验 → id 定位/派生 →
 * model 引用拆分 → 词法闸。返回**补丁形**（只含白名单键；null = 清除标记）。
 *   · current 给出 = update 语义（id 由现值固定，补丁未覆盖的键不动）
 *   · current 缺席 = create 语义（id 缺省按 name 派生 slug，词法闸生效）
 */
export function sanitizeAgentInput(
  input: Record<string, unknown>,
  current?: AgentConfig,
  options: SanitizeOptions = {},
): Record<string, unknown> {
  const unknown = Object.keys(input).filter((key) => !AGENT_CONFIG_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`字段不在 AgentConfig 白名单（身份面各域已 owning 化）: ${unknown.join(', ')}`);
  }
  const { id, model, provider, ...rest } = input;
  const agentId = current?.id
    ?? (typeof id === 'string' && id !== '' ? id : undefined)
    ?? (current === undefined ? deriveAgentId(rest.name, options.idTaken) : undefined);
  if (agentId === undefined) throw new Error('缺少 agent id（create 须携带 id 或 name；update 按 agentId 定位）');
  // create 词法闸：路径安全 + 身份词形（禁 `~`——对键桶承重墙，主线同款；
  // update 的 id 由现值固定，存量域不改判）
  if (current === undefined) {
    assertAgentId(agentId);
    if (!isAgentIdentity(agentId)) throw new Error(`Agent id "${agentId}" 非法（禁 ~——对键桶会话键词形，非身份词）`);
  }
  if (rest.tags !== undefined
    && (!Array.isArray(rest.tags) || rest.tags.some((tag) => typeof tag !== 'string'))) {
    throw new Error('tags 须为字符串数组（档位词/模式词——能力 tag 已退役）');
  }
  let nextProvider = typeof provider === 'string' && provider !== '' ? provider : undefined;
  const clearProvider = provider === null || provider === '';
  let nextModel: string | undefined;
  let clearModel = false;
  if (model !== undefined) {
    if (model === null || model === '') {
      clearModel = true;
    } else if (typeof model !== 'string') {
      throw new Error('model 须为字符串（裸模型 id 或 name@model 引用）');
    } else {
      const ref = splitModelRef(model);
      nextProvider = ref.provider ?? nextProvider;
      nextModel = ref.model;
    }
  }
  const patch: Record<string, unknown> = { ...rest, id: agentId };
  if (nextModel !== undefined) patch.model = nextModel;
  else if (clearModel) patch.model = null;
  if (nextProvider !== undefined) patch.provider = nextProvider;
  else if (clearProvider) patch.provider = null;
  return patch;
}

/** create：补丁形 → 全量档（null 清除标记丢弃 = 缺键语义） */
export function configFromPatch(patch: Record<string, unknown>): AgentConfig {
  return dropNulls(patch) as unknown as AgentConfig;
}

/**
 * 装配补丁（agents/assembly/update 写口——cr-552）：tools 意图 + settings
 * per-name 合并语义（主线 M22 D5 形态）。纯函数（合成 + 变更键，不落盘）：
 *   · patch.tools：include/exclude 全空意图 = 删 tools 键（恢复缺省全工具）；
 *   · patch.settings[name]：object = 浅合并进既有（字段级 null = 删单字段，
 *     清空到无字段 = 删 name）；null = 删整段；
 *   · 未知顶层键 fail-closed。
 */
export function applyAssemblyPatch(
  current: AgentConfig,
  patch: Record<string, unknown>,
): { config: AgentConfig; changed: string[] } {
  const unknown = Object.keys(patch).filter((k) => k !== 'tools' && k !== 'settings');
  if (unknown.length > 0) throw new Error(`装配补丁字段不在白名单: ${unknown.join(', ')}`);
  const next: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) };
  if (patch.tools !== undefined) {
    const t = objOf(patch.tools);
    const include = t.include === undefined ? undefined : strArray(t.include, 'tools.include');
    const exclude = t.exclude === undefined ? undefined : strArray(t.exclude, 'tools.exclude');
    if (include === undefined && exclude === undefined) {
      delete next.tools; // 全空意图 = 恢复缺省（全部工具）
    } else {
      const tools: Record<string, unknown> = {};
      if (include !== undefined && include.length > 0) tools.include = include;
      if (exclude !== undefined && exclude.length > 0) tools.exclude = exclude;
      if (Object.keys(tools).length > 0) next.tools = tools;
      else delete next.tools;
    }
  }
  if (patch.settings !== undefined) {
    const settings = objOf(patch.settings);
    const currentSettings = isPlainObject(next.settings) ? next.settings : {};
    const merged: Record<string, unknown> = { ...currentSettings };
    for (const [name, value] of Object.entries(settings)) {
      if (value === undefined) continue; // 未携带 = 不动
      if (value === null) { delete merged[name]; continue; }
      const base = isPlainObject(merged[name]) ? merged[name] : {};
      const mergedFields: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(objOf(value))) {
        if (v === null) delete mergedFields[k];
        else mergedFields[k] = v;
      }
      if (Object.keys(mergedFields).length > 0) merged[name] = mergedFields;
      else delete merged[name];
    }
    if (Object.keys(merged).length > 0) next.settings = merged;
    else delete next.settings;
  }
  return { config: next as unknown as AgentConfig, changed: changedConfigKeysOf(next, current as unknown as Record<string, unknown>) };
}


/**
 * update：现值 × 补丁 → 合成档（null = 删键；对象 = 深合并；其余 = 覆盖）。
 * 纯函数化（不落盘）——落盘归编辑面唯一写口。
 */
export function applyConfigPatch(
  current: AgentConfig,
  patch: Record<string, unknown>,
): AgentConfig {
  return mergeWithDeletes(
    current as unknown as Record<string, unknown>,
    patch,
  ) as unknown as AgentConfig;
}

/**
 * 变更键报告（并集 JSON 比较）：两侧键并集逐键比对，身份键 id 不报
 * （差异补丁语义恒保留身份键）。键删除与键新增都是变更——单轨比较断根
 * 主线「只从 subject 侧比较」的漏报。
 */
export function changedConfigKeysOf(
  next: Record<string, unknown>,
  current: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(next), ...Object.keys(current)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (key === 'id') continue;
    if (jsonOf(next[key]) !== jsonOf(current[key])) changed.push(key);
  }
  return changed;
}

// ---- 内部 ----

/** 窄化：非空对象（装配补丁字段） */
function objOf(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('装配补丁字段须为对象');
  }
  return v as Record<string, unknown>;
}

/** 窄化：字符串数组 */
function strArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new Error(`装配补丁 ${label} 须为字符串数组`);
  }
  return v as string[];
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** 深合并 + null 删键（数组与原生值不深并——覆盖语义） */
function mergeWithDeletes(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value)
      ? mergeWithDeletes(prev, value)
      : value;
  }
  return out;
}

/** 去 null（create 合成用；嵌套 null 一并丢弃） */
function dropNulls(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue;
    out[key] = isPlainObject(value) ? dropNulls(value) : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * id 派生（create 缺 id）：name → slug（ASCII 字母数字与连字符；非 ASCII
 * 名如中文整词不可 slug → agent-<时基> 序号），撞名追加 -2/-3…（上限防
 * 病态注册表）。
 */
function deriveAgentId(name: unknown, idTaken?: (id: string) => boolean): string {
  const base = typeof name === 'string' && name !== ''
    ? name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
  const stem = base !== '' ? base : `agent-${Date.now().toString(36).slice(-5)}`;
  let candidate = stem;
  for (let n = 2; idTaken?.(candidate) === true; n++) {
    candidate = `${stem}-${n}`;
    if (n > 1000) throw new Error(`agent id 派生防撞超限（${stem}）`);
  }
  return candidate;
}

/**
 * 模型引用拆分：'provider@model' → 两字段（'@' 在首位或缺失 = 裸模型 id）。
 * 语义单源 = ac-llm splitModelRef（宿主侧不引模型行包——cutover 归并单源）。
 */
function splitModelRef(ref: string): { provider?: string; model: string } {
  const at = ref.indexOf('@');
  if (at <= 0) return { model: ref };
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}
