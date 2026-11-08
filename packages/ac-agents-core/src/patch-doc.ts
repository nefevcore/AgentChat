// ============================================================
// patch-doc.ts —— agent.patch.yml 装配 overlay 读写（cr-906 / cr-901
// v2.1 批4 §4.4）
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
import type { AgentConfig } from './config.ts';
import { accessOf, normalizeLegacyTags, toolModeOf } from './config.ts';
import { agentDir, assertAgentId } from './tree.ts';

/** agent.patch.yml 文件名（agents/<id>/ 内） */
export const PATCH_FILE = 'agent.patch.yml';

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
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
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

/** 读 patch 文档（缺席 = null；损坏 = throw fail-loud——编辑面/迁移脚本代写文档） */
export function readAgentPatch(dataRoot: string, agentId: string): AgentPatchDoc | null {
  let text: string;
  try {
    text = fs.readFileSync(agentPatchFile(dataRoot, agentId), 'utf-8');
  } catch {
    return null;
  }
  const data = yaml.load(text) as unknown;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
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
  'agent.patch', // agent.patch.yml
  'preset-origin', // preset-origin.json（cr-812 模板升级通路——切片三并入 origin 块）
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

/** 读全部插件配置（扫 <unit>.json——非保留字、可解析；合成 settings 形状） */
export function readPluginConfigs(dataRoot: string, agentId: string): Record<string, unknown> {
  const dir = agentDir(dataRoot, agentId);
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
