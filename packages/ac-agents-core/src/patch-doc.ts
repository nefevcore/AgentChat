// ============================================================
// patch-doc.ts —— agent.patch.yml 装配差量 + agent.json 档案读写
//（cr-906 / cr-918 / cr-1004 批2：装配差量化——patch 顶层 = 纯 cordis
// 条目数组〔加法/disabled/config + `# ac-base` 基线戳〕；档案字段与
// origin 块迁 agent.json〔agent-data.md §三〕。旧映射形态读侧迁移窗口
// 〔migrate 脚本收口后退役〕，写恒新形态。）
//
// Agent 定义 = 装配（装了什么 × 什么档位）+ 插件配置（各插件自定
// 自读）+ 人格（persona 插件消费的数据）。agent.patch.yml = 装配
// overlay：rows + 档位（tier / tool-mode——X1 回滚：settings 行内
// 档位归装配；cr-953 起投影结构化 access/toolMode 字段，不再重建
// tags）+ 档案面（model/provider/llm-params/max-steps/name/
// description）+ origin 块（创建来源 preset + 指纹——取代
// preset-origin.json，随切片三接入）。system 退役（平台行分权组装）。
//
// 读写形态（批4 + cr-918）：readAgentConfig 读 agent.patch.yml 在场即赢，
// 投影回 AgentConfig 形状；config.json 旧读路径窗口兼容（存量未迁移根，
// 含存量 tags——读侧经 normalizeLegacyTags 归一）。
// writeAgentConfig 单写 patch（cr-918 镜像双落退役）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { menuDefinitionFingerprint, type AssemblyEntry, type MenuEntry, type RowDescriptor } from 'ac-rowset-core';
import type { AgentConfig } from './config.ts';
import { accessOf, normalizeLegacyTags, toolModeOf } from './config.ts';
import { agentDir, assertAgentId } from './tree.ts';

/** agent.patch.yml 文件名（agents/<id>/ 内） */
export const PATCH_FILE = 'agent.patch.yml';

/** agent.json 文件名（档案数据——cr-1004 批2：装配之外的 everything else） */
export const PROFILE_FILE = 'agent.json';

/** origin 块（cr-812 PresetOrigin 形状平移——模板升级 copy-on-write 判定面；
 * 批4 切片三起并入 agent.patch.yml，preset-origin.json 转镜像窗口） */
export interface PatchOrigin {
  /** 模板键（如 creator） */
  template: string;
  /** 物化时模板指纹（config+docs+skills） */
  hash: string;
  /** 物化时 config 指纹（升级判「config 是否被编辑」） */
  configHash?: string;
  /** 物化时文档逐名内容指纹 */
  docs?: Record<string, string>;
  /** 物化时技能逐名内容指纹 */
  skills?: Record<string, string>;
}

/** 装配 overlay 文档（yaml 顶层数——cordis 方言邻接词汇） */
export interface AgentPatchDoc {
  origin?: PatchOrigin;
  /** 装配点名/排除（语义同 AgentConfig.rows 双形态） */
  rows?: string[] | { include?: string[]; exclude?: string[] };
  /** 访问档位（缺省 base-access；投影 AgentConfig.access） */
  tier?: 'base-access' | 'sandbox-access' | 'full-access';
  /** 工具调用模式（缺省 tc-base；投影 AgentConfig.toolMode） */
  'tool-mode'?: 'tc-none' | 'tc-base' | 'tc-programmatic';
  /**
   * 能力标签余词（cr-953 退役面：requiredTags 门禁已退役、余词无消费面
   * ——读侧经 normalizeLegacyTags 归一〔admin/browser 层级词入 levels〕
   * 后丢弃，writeAgentConfig 不再写本键。字段保留以容忍存量文档）
   */
  tags?: string[];
  model?: string;
  provider?: string;
  'llm-params'?: Record<string, unknown>;
  'max-steps'?: number;
  name?: string;
  description?: string;
  /** 虚拟身份（不跑 loop——user 桩等） */
  virtual?: boolean;
  /** 行内插件档位（X1 回滚：档位词归装配——unit → 档位词/布尔） */
  levels?: Record<string, string | boolean>;
  /** 具名插件设置（窗口期随行；切片二拆 plugin-config/<unit>.json） */
  settings?: Record<string, unknown>;
}

/** 按目录实体读写核心（迁移脚本面：children 树不经 dataRoot 寻址） */
export function readAgentPatchAt(dir: string): AgentPatchDoc | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8');
  } catch {
    return null;
  }
  const data = yaml.load(text) as unknown;
  if (Array.isArray(data)) return null; // v2 差量形态——非映射
  if (data === null || typeof data !== 'object') {
    throw new Error('agent.patch.yml 顶层必须是映射：' + dir);
  }
  return data as AgentPatchDoc;
}

export function writeAgentPatchAt(dir: string, doc: AgentPatchDoc): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PATCH_FILE);
  const header = '# agent.patch —— Agent 装配 overlay（cr-906 / cr-901 v2.1 批4）：rows + 档位 + 档案面 + origin。' + String.fromCharCode(10)
    + '# 编辑面/迁移脚本代写；tier/tool-mode 缺省 = base-access / tc-base。' + String.fromCharCode(10);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, header + yaml.dump(doc, { lineWidth: 120, noRefs: true }), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 单元文件直写核心（同上——目录实体寻址） */
export function writePluginConfigAt(dir: string, unit: string, value: unknown): void {
  assertUnitName(unit);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, unit + '.json');
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + String.fromCharCode(10), 'utf-8');
  fs.renameSync(tmp, file);
}
/** patch 文件位 */
export function agentPatchFile(dataRoot: string, agentId: string): string {
  return path.join(agentDir(dataRoot, agentId), PATCH_FILE);
}

/** 读 patch 文档（缺席/v2 数组形态 = null；损坏 = throw fail-loud——编辑面/迁移脚本代写文档） */
export function readAgentPatch(dataRoot: string, agentId: string): AgentPatchDoc | null {
  let text: string;
  try {
    text = fs.readFileSync(agentPatchFile(dataRoot, agentId), 'utf-8');
  } catch {
    return null;
  }
  const data = yaml.load(text) as unknown;
  if (Array.isArray(data)) return null; // v2 差量形态（cr-1004 批2）——档案/origin 在 agent.json
  if (data === null || typeof data !== 'object') {
    throw new Error('agent.patch.yml 顶层必须是映射：' + agentPatchFile(dataRoot, agentId));
  }
  return data as AgentPatchDoc;
}

/**
 * patch 文档 → AgentConfig 投影（cr-953：tier/tool-mode → 结构化
 * access/toolMode；doc.tags 余词经 normalizeLegacyTags 归一〔admin/
 * browser 层级词入 levels〕；system 恒缺席）
 */
export function patchToConfig(agentId: string, doc: AgentPatchDoc): AgentConfig {
  return normalizeLegacyTags({
    id: agentId,
    ...(doc.tier !== undefined ? { access: doc.tier } : {}),
    ...(doc['tool-mode'] !== undefined ? { toolMode: doc['tool-mode'] } : {}),
    ...(doc.model !== undefined ? { model: doc.model } : {}),
    ...(doc.provider !== undefined ? { provider: doc.provider } : {}),
    ...(doc.rows !== undefined ? { rows: doc.rows } : {}),
    ...(doc['llm-params'] !== undefined ? { llmParams: doc['llm-params'] } : {}),
    ...(doc['max-steps'] !== undefined ? { maxSteps: doc['max-steps'] } : {}),
    ...(doc.name !== undefined ? { name: doc.name } : {}),
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    ...(doc.virtual === true ? { virtual: true } : {}),
    ...(doc.levels !== undefined ? { levels: doc.levels } : {}),
    ...(doc.settings !== undefined ? { settings: doc.settings } : {}),
    ...(doc.tags !== undefined ? { tags: doc.tags } : {}),
  });
}

/**
 * AgentConfig → patch 文档（cr-953：结构化 access/toolMode → tier/
 * tool-mode 键；tags 不再写——余词无消费面；settings 随行；system
 * 不迁——退役面）
 */
export function configToPatch(config: AgentConfig, origin?: PatchOrigin): AgentPatchDoc {
  const access = accessOf(config);
  const toolMode = toolModeOf(config);
  return {
    ...(origin !== undefined ? { origin } : {}),
    ...(config.rows !== undefined ? { rows: config.rows } : {}),
    ...(access !== 'base-access' ? { tier: access } : {}),
    ...(toolMode !== 'tc-base' ? { 'tool-mode': toolMode } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.llmParams !== undefined ? { 'llm-params': config.llmParams } : {}),
    ...(config.maxSteps !== undefined ? { 'max-steps': config.maxSteps } : {}),
    ...(config.name !== undefined ? { name: config.name } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.virtual === true ? { virtual: true } : {}),
    ...(config.settings !== undefined ? { settings: config.settings } : {}),
    ...(config.levels !== undefined ? { levels: config.levels } : {}),
  };
}

// —— 插件配置拆分（cr-906 批4 切片二：settings 域降格——各插件自定自读）——

/** agents/<id>/ 顶层文件形态保留字（.json 文件位冲突面——目录域
 *（memory/ files/ sessions/ …）与 <unit>.json 文件无文件系统冲突，
 * memory 单元写 memory.json 合法——保留字只锁文件占位名） */
export const RESERVED_UNIT_NAMES: ReadonlySet<string> = new Set([
  'config', 'auth', // config.json / auth.json
  'agent', // agent.json（cr-1004 批2：档案数据——非插件单元）
  'agent.patch', // agent.patch.yml
  'preset-origin', // preset-origin.json（cr-812 模板升级通路——切片三并入 origin 块）
  'boot-graph', // boot-graph.json（cr-909 审计快照——含时间戳，进 settings 即污染主体指纹）
]);

/** 插件配置单元名校验（param-case；保留字/路径组件拒绝） */
export function assertUnitName(unit: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(unit)) {
    throw new Error('插件配置单元名词法非法（param-case）：' + JSON.stringify(unit));
  }
  if (RESERVED_UNIT_NAMES.has(unit)) {
    throw new Error('插件配置单元名撞保留字：' + unit);
  }
}

/** 插件配置文件位：agents/<id>/<unit>.json（框架不解释内容——各插件自定自读） */
export function pluginConfigFile(dataRoot: string, agentId: string, unit: string): string {
  assertUnitName(unit);
  return path.join(agentDir(dataRoot, agentId), unit + '.json');
}

/** 读单份插件配置（缺席/损坏 = undefined——插件自读自判语义） */
export function readPluginConfig(dataRoot: string, agentId: string, unit: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(pluginConfigFile(dataRoot, agentId, unit), 'utf-8'));
  } catch {
    return undefined;
  }
}

/** 写单份插件配置（原子写；写者 = 各插件/编辑面） */
export function writePluginConfig(dataRoot: string, agentId: string, unit: string, value: unknown): void {
  assertAgentId(agentId);
  fs.mkdirSync(agentDir(dataRoot, agentId), { recursive: true });
  const file = pluginConfigFile(dataRoot, agentId, unit);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + String.fromCharCode(10), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 读全部插件配置（扫 <unit>.json——非保留字、可解析；合成 settings 形状）。
 * 目录实体寻址版（children 域共用——主身份 readPluginConfigs 的内核） */
export function readPluginConfigsAt(dir: string): Record<string, unknown> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const unit = e.name.slice(0, -'.json'.length);
    if (RESERVED_UNIT_NAMES.has(unit)) continue;
    try {
      out[unit] = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf-8'));
    } catch {
      // 损坏 = 该单元缺席语义（插件自读自判）
    }
  }
  return out;
}

/** 读全部插件配置（数据根寻址——readPluginConfigsAt 的主身份包装） */
export function readPluginConfigs(dataRoot: string, agentId: string): Record<string, unknown> {
  return readPluginConfigsAt(agentDir(dataRoot, agentId));
}


// —— cr-1004 批2：agent.json 档案 + agent.patch.yml v2 差量形态 ——

/** 档案数据（agent.json——agent-data.md §三：装配之外的一切：模型路由 /
 * 授权档 / 展示 / levels（批2b 归位装配条目 config 前的窗口位）/ origin 模板溯源） */
export interface AgentProfile {
  model?: string;
  provider?: string;
  'llm-params'?: Record<string, unknown>;
  'max-steps'?: number;
  /** 访问档位（AgentConfig.access 的盘上键——cr-947 词面） */
  tier?: 'base-access' | 'sandbox-access' | 'full-access';
  'tool-mode'?: 'tc-none' | 'tc-base' | 'tc-programmatic';
  name?: string;
  description?: string;
  virtual?: boolean;
  /** 行内插件档位（批2b 迁装配条目 config——窗口位随档案） */
  levels?: Record<string, string | boolean>;
  /** 模板溯源（从 agent.patch.yml origin 块迁入全量——agent-data §三） */
  origin?: PatchOrigin;
}

const BASE_STAMP_RE = /^#\s*ac-base:\s*(\S+)\s*$/m;

/** 读 agent.json（缺席 = null；损坏 = throw——档案代写文档） */
export function readAgentProfileAt(dir: string): AgentProfile | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf-8');
  } catch {
    return null;
  }
  const data = yaml.load(text) as unknown;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('agent.json 顶层必须是映射：' + dir);
  }
  return data as AgentProfile;
}

/** 写 agent.json（原子写） */
export function writeAgentProfileAt(dir: string, profile: AgentProfile): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PROFILE_FILE);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2) + String.fromCharCode(10), 'utf-8');
  fs.renameSync(tmp, file);
}

// —— levels → 装配条目 config 归位（cr-1004 批2b / agent-assembly §四） ——

/** 行内档位单元 → 行 id（存储归位映射单源：levels.<unit> 落差量条目
 * config.level；dev-tools 行已退役〔cr-520〕且 'dev' 能力词无消费面——键退役） */
export const LEVELS_ROW_OF: Record<string, string | undefined> = {
  browser: 'browser',
  collab: 'collab-tools',
};
/** 反向映射（组合读面：条目 config.level → AgentConfig.levels） */
export const LEVELS_UNIT_OF: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(LEVELS_ROW_OF).map(([unit, row]) => [row, unit]),
);

/** levels 并入菜单定义（写侧单源：同 id 定义 config 合并；行不在菜单 =
 * 不进即不装，不因档位静默长行——cr-1022 哲学） */
export function mergeLevelsIntoEntries(entries: MenuEntry[], levels: Record<string, string | boolean> | undefined): MenuEntry[] {
  if (levels === undefined) return entries;
  for (const [unit, value] of Object.entries(levels)) {
    const row = LEVELS_ROW_OF[unit];
    if (row === undefined) continue; // 退役词（dev-tools 等）——消费面已亡
    const hit = entries.find((e) => e.id === row);
    if (hit !== undefined) hit.config = { ...(hit.config ?? {}), level: value };
  }
  return entries;
}

// —— cr-1022 批2：agent.patch.yml v3 菜单片段（行定义 + src-fingerprint） ——

/** v3 菜单片段文档：顶层数组 = 行定义（id/name/requires/config——白名单
 * §2.1），src-fingerprint 为溯源元数据（§2.3 定义副本是缓存——读侧剥离，
 * 不进菜单合成词汇）。批3 boot 对账校准面消费。 */
export interface AgentPatchV3 {
  /** 菜单标记（头注释 ac-menu: 1——v2/v3 同为数组形态的判别位） */
  menu: true;
  /** 基线戳（沿用 v2 词汇——存在合成指纹，漂移 = rebase） */
  base?: string;
  defs: MenuEntry[];
  /** 行 id → 定义指纹（写入时随行；批3 校准面对账） */
  fingerprints: Record<string, string>;
}

const MENU_MARK_RE = /^#\s*ac-menu:\s*1\s*$/m;

/** 读 v3 菜单片段（标记缺席/文件缺席 = null——v2 与旧形态走各自读面；
 * 损坏 = throw fail-loud：编辑面/迁移脚本代写文档） */
export function readAgentPatchV3At(dir: string): AgentPatchV3 | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8');
  } catch {
    return null;
  }
  if (!MENU_MARK_RE.test(text)) return null;
  const data = yaml.load(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('agent.patch.yml v3 顶层必须是行定义数组：' + dir);
  }
  const defs: MenuEntry[] = [];
  const fingerprints: Record<string, string> = {};
  for (const raw of data) {
    const e = raw as Record<string, unknown> | null;
    if (typeof e?.id !== 'string') {
      throw new Error('agent.patch.yml v3 条目缺 id：' + dir);
    }
    const fp = e['src-fingerprint'];
    delete (e as Record<string, unknown>)['src-fingerprint'];
    if (typeof fp === 'string') fingerprints[e.id] = fp;
    defs.push(e as unknown as MenuEntry);
  }
  const stamped = BASE_STAMP_RE.exec(text);
  return { menu: true, ...(stamped !== null ? { base: stamped[1] } : {}), defs, fingerprints };
}

/** 写 v3 菜单片段（cr-1025 重写原子纪律：临时文件 + fsync + 原子 rename，
 * 重写前留一代备份 agent.patch.yml.bak——保护行集合与 config，非旧定义） */
export function writeAgentPatchV3At(
  dir: string,
  defs: MenuEntry[],
  fingerprints: Record<string, string>,
  base?: string,
): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PATCH_FILE);
  const dump = defs.map((def) => ({
    ...def,
    ...(def.id in fingerprints ? { 'src-fingerprint': fingerprints[def.id] } : {}),
  }));
  const header = '# agent.patch v3 —— 菜单片段（cr-1022 批2）：行定义数组（id/name/requires/config + src-fingerprint 溯源）；档案与 origin 在 agent.json。' + String.fromCharCode(10)
    + '# ac-menu: 1' + String.fromCharCode(10)
    + (base !== undefined ? '# ac-base: ' + base + String.fromCharCode(10) : '');
  const body = header + yaml.dump(dump, { lineWidth: 120, noRefs: true });
  try {
    fs.copyFileSync(file, file + '.bak'); // 留一代备份（成功后可清——批3 校准面接手）
  } catch { /* 首写无备份源 */ }
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** 菜单定义 config.level → levels（组合读面；档案 levels 为批2b 前存量窗口） */
export function levelsOfEntries(entries: MenuEntry[] | null, profileLevels: Record<string, string | boolean> | undefined): Record<string, string | boolean> | undefined {
  const levels: Partial<Record<string, string | boolean>> = {};
  for (const e of entries ?? []) {
    const unit = LEVELS_UNIT_OF[e.id];
    const level = e.config?.level;
    if (unit !== undefined && (typeof level === 'string' || typeof level === 'boolean')) levels[unit] = level;
  }
  for (const [k, v] of Object.entries(profileLevels ?? {})) {
    if (levels[k] === undefined && LEVELS_ROW_OF[k] !== undefined) levels[k] = v; // 存量窗口
  }
  return Object.keys(levels).length > 0 ? levels as Record<string, string | boolean> : undefined;
}

/** AgentConfig.rows → v3 菜单片段定义（cr-1022 批2 写侧单源）：正清单
 * 从出厂能力区拷贝定义 + src-fingerprint（§2.2 模板物化语义）；rows
 * 缺席 = 全部能力行（与旧基础集 ∩ 能力行逐位等价）。能力目录缺席
 * fail-loud。{include}/{exclude} 形态照 resolveToolNames 词形归一。 */
export function rowsToMenuDefs(
  rows: AgentConfig['rows'],
  capability: MenuEntry[],
): { defs: MenuEntry[]; fingerprints: Record<string, string> } {
  const byId = new Map(capability.map((d) => [d.id, d] as const));
  const tokens = Array.isArray(rows) ? rows : rows?.include;
  const excludes = new Set(Array.isArray(rows) ? [] : rows?.exclude ?? []);
  // 缺省面 = 全部能力行（AgentConfig.rows 缺省 = 行集全集——正清单直落）
  const picked = tokens === undefined
    ? capability
    : tokens.filter((t) => !excludes.has(t)).map((t) => byId.get(t)).filter((d): d is MenuEntry => d !== undefined);
  const defs: MenuEntry[] = [];
  const fingerprints: Record<string, string> = {};
  for (const def of picked) {
    defs.push({ id: def.id, ...(def.name !== undefined ? { name: def.name } : {}), ...(def.requires !== undefined ? { requires: def.requires } : {}) });
    fingerprints[def.id] = menuDefinitionFingerprint(def);
  }
  return { defs, fingerprints };
}

/** 写 agent.patch.yml（原子写；header 注释 = 形态说明） */
export function writeAgentPatch(dataRoot: string, agentId: string, doc: AgentPatchDoc): void {
  assertAgentId(agentId);
  fs.mkdirSync(agentDir(dataRoot, agentId), { recursive: true });
  const file = agentPatchFile(dataRoot, agentId);
  const header = '# agent.patch —— Agent 装配 overlay（cr-906 / cr-901 v2.1 批4）：rows + 档位 + 档案面 + origin。' + String.fromCharCode(10)
    + '# 编辑面/迁移脚本代写；tier/tool-mode 缺省 = base-access / tc-base。' + String.fromCharCode(10);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, header + yaml.dump(doc, { lineWidth: 120, noRefs: true }), 'utf-8');
  fs.renameSync(tmp, file);
}
