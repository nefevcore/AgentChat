// ============================================================
// patch-chain.ts —— agent.patch 形态迁移链（cr-1036 批2）
//
// agent.patch.yml 格式换轨器注册边（migration-chain-completeness §2.2
// 首批收编）：一次性 migrate 脚本禁令——换档逻辑只存于链边，工具与
// boot 只做链驱动执行。版本链：
//   v0 = 前菜单身份（config.json ∨ 旧映射 agent.patch.yml——组合读归一）
//   v1 = 数组差量（cr-1004 批2 词形：条目数组〔加法/disabled/config〕
//        + agent.json 档案拆分）
//   v2 = 菜单片段（cr-1022 批2 词形：行定义 + src-fingerprint +
//        '# ac-menu: 1' 标记——current）
//
// 边换算为纯函数（目录上下文随形态值行进）；B−T 语义逐位对齐原
// migrate 脚本孤本（legacyToMenuDefs——对账自检兜底等价性）。
// v0/v1 语义词汇（席位/捆绑边界）在此冻结——它们是历史边的本体
// 输入，链在即词汇在。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import {
  type MigrationEdge, type EdgeReport, type VersionedValue,
  assertChainIntegrity, runChain,
} from 'ac-migration-core';
import type { MenuEntry } from 'ac-rowset-core';
import { menuDefinitionFingerprint, mergeMenu } from 'ac-rowset-core';
import type { AgentConfig } from './config.ts';
import { normalizeLegacyTags } from './config.ts';
import {
  patchToConfig, readAgentPatchAt, readAgentPatchV3At, writeAgentPatchV3At,
  writeAgentProfileAt, writePluginConfigAt, mergeLevelsIntoEntries,
  PATCH_FILE, PROFILE_FILE, type AgentPatchDoc, type PatchOrigin,
} from './patch-doc.ts';

/** v0/v1 差量语义下的恒并席位（旧 SEAT_ROW_IDS——B−T 停用面护栏词，冻结） */
export const LEGACY_SEAT_ROW_IDS: readonly string[] = [
  'conversation', 'persona', 'conduct', 'llm-pool', 'auto-title', 'host-face-client',
];

/** v1 差量语义下的捆绑行边界（旧 bundle 词行集——不在旧基础集，冻结） */
export const LEGACY_BUNDLE_ROW_IDS: readonly string[] = [
  'fs-tools', 'fs-search', 'str-replace-editor', 'shell-tools',
  'harness-tools', 'sap-adt', 'bench', 'plugin-dev', 'restart',
];

/** v1 差量条目（cr-1004 批2 词形——id/disabled/config） */
export interface LegacyEntry {
  id: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
}

/** 目录上下文（边换算外部输入——出厂目录与基线戳，随形态值行进） */
export interface PatchChainContext {
  /** 身份目录（agents/<id>/ ∨ agents/<pid>/children/<cid>/） */
  dir: string;
  /** 骨架区行（恒装面——菜单合成输入） */
  skeleton: MenuEntry[];
  /** 出厂能力区行（定义拷贝与指纹来源） */
  capability: MenuEntry[];
  /** 基线戳（存在合成指纹——v1→v2 边写入） */
  stamp: string;
}

/** 链上形态值（各版本形态载荷并集——ctx 随行，warnings/notices 汇聚审计） */
export interface PatchForm {
  ctx: PatchChainContext;
  /** v0 组合读归一身份（档案/levels/settings 载荷面） */
  config?: AgentConfig;
  /** v1 差量条目 */
  v1Entries?: LegacyEntry[];
  /** v2 定义 + 指纹 */
  v2Defs?: MenuEntry[];
  v2Fingerprints?: Record<string, string>;
  warnings: string[];
  notices: string[];
}

/** 目录全量并集（边换算的寻址面） */
function byIdOf(ctx: PatchChainContext): Map<string, MenuEntry> {
  const byId = new Map<string, MenuEntry>();
  for (const row of [...ctx.skeleton, ...ctx.capability]) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return byId;
}

/** 需求闭包（picked 就地补全 requires） */
function closeRequires(byId: Map<string, MenuEntry>, picked: Set<string>): void {
  const queue = [...picked];
  while (queue.length > 0) {
    for (const req of byId.get(queue.pop() as string)?.requires ?? []) {
      if (byId.has(req) && !picked.has(req)) {
        picked.add(req);
        queue.push(req);
      }
    }
  }
}

/** 边 0→1：前菜单身份 → v1 数组差量（B−T 逆差量化——白名单 ⇒ 显式离差）。 */
function migrateV0ToV1(form: PatchForm): PatchForm {
  const { ctx, config } = form;
  if (config === undefined) throw new Error('v0 形态值缺 config（组合读失败——不可迁）');
  const byId = byIdOf(ctx);
  const entries: LegacyEntry[] = [];
  const tokens = config.rows === undefined
    ? undefined
    : Array.isArray(config.rows) ? config.rows : config.rows.include;
  const excludes = config.rows !== undefined && !Array.isArray(config.rows) ? config.rows.exclude ?? [] : [];
  if (tokens === undefined) {
    // 缺省 = 旧基础集（全集 − 捆绑行）——v1 空差量即其本身；exclude 增量停用原样
    for (const x of excludes) entries.push({ id: x, disabled: true });
  } else {
    // 白名单形态：目标集 = 席位 ∪ 点名 + 闭包；v1 表达 = 捆绑行显式加法 +
    // 非捆绑行补集显式停用（逐位等价：并集还原目标集）
    const target = new Set(LEGACY_SEAT_ROW_IDS.filter((id) => byId.has(id)));
    const queue: string[] = [];
    for (const token of tokens) {
      if (!byId.has(token)) {
        form.warnings.push('条目未命中目录：' + token);
        continue;
      }
      if (!target.has(token)) {
        target.add(token);
        queue.push(token);
      }
    }
    while (queue.length > 0) {
      for (const req of byId.get(queue.pop() as string)?.requires ?? []) {
        if (byId.has(req) && !target.has(req)) {
          target.add(req);
          queue.push(req);
        }
      }
    }
    for (const id of [...byId.keys()].sort()) {
      if (LEGACY_BUNDLE_ROW_IDS.includes(id)) {
        if (target.has(id)) entries.push({ id });
      } else if (!target.has(id) && !LEGACY_SEAT_ROW_IDS.includes(id)) {
        entries.push({ id, disabled: true });
      }
    }
  }
  return { ...form, v1Entries: entries };
}

/** 边 1→2：v1 数组差量 → v2 菜单片段（桥换算收编——原 migrate 脚本孤本）。 */
function migrateV1ToV2(form: PatchForm): PatchForm {
  const { ctx } = form;
  const byId = byIdOf(ctx);
  const rowConfigOf = new Map<string, Record<string, unknown>>();
  const disabled = new Set<string>();
  const adds = new Set<string>();
  for (const entry of form.v1Entries ?? []) {
    if (entry.disabled === true) {
      if (!byId.has(entry.id)) {
        form.notices.push('disable 点名不在基座菜单（跳过）：' + entry.id);
        continue;
      }
      if (LEGACY_SEAT_ROW_IDS.includes(entry.id)) {
        form.notices.push(entry.id + '：恒并基座席位不可停用（拒绝生效）');
        continue;
      }
      disabled.add(entry.id);
      continue;
    }
    if (!byId.has(entry.id)) {
      form.warnings.push('agent.patch.yml 条目未命中目录：' + entry.id);
      continue;
    }
    adds.add(entry.id);
    if (entry.config !== undefined) {
      rowConfigOf.set(entry.id, { ...(rowConfigOf.get(entry.id) ?? {}), ...entry.config });
    }
  }
  const picked = new Set([...byId.keys()].filter((id) => !LEGACY_BUNDLE_ROW_IDS.includes(id)));
  for (const id of adds) picked.add(id);
  closeRequires(byId, picked);
  for (const id of disabled) picked.delete(id);
  const defs: MenuEntry[] = [];
  const fingerprints: Record<string, string> = {};
  for (const row of ctx.capability) {
    if (!picked.has(row.id)) continue;
    defs.push({
      id: row.id,
      ...(row.name !== undefined ? { name: row.name } : {}),
      ...(row.requires !== undefined ? { requires: row.requires } : {}),
    });
    const cfg = rowConfigOf.get(row.id);
    if (cfg !== undefined) defs[defs.length - 1].config = cfg;
    fingerprints[row.id] = menuDefinitionFingerprint(row);
  }
  defs.sort((a, b) => (a.id < b.id ? -1 : 1));
  // v0 载荷 levels 归位（v1 存量 levels 住 agent.json——读侧窗口承接，不动）
  mergeLevelsIntoEntries(defs, form.config?.levels);
  return { ...form, v2Defs: defs, v2Fingerprints: fingerprints };
}

/** agent.patch 形态链（注册边——模块加载期断言完备） */
export const PATCH_CHAIN: MigrationEdge<PatchForm>[] = [
  { from: 0, to: 1, migrate: migrateV0ToV1 },
  { from: 1, to: 2, migrate: migrateV1ToV2 },
];
assertChainIntegrity('agent.patch', PATCH_CHAIN);

// —— 形态探测（纯读——v3 标记 → v1 数组 → v0 映射 → v0 config.json） ——

const MENU_MARK_RE = /^#\s*ac-menu:\s*1\s*$/m;

/** 读 v1 数组差量（无菜单标记的顶层数组——cr-1004 批2 词形；缺席 = null） */
function readLegacyEntries(dir: string): LegacyEntry[] | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8');
  } catch {
    return null;
  }
  if (MENU_MARK_RE.test(text)) return null; // v2 菜单片段
  const data = yaml.load(text) as unknown;
  if (!Array.isArray(data)) return null; // v0 映射形态
  return data.filter((e) => e !== null && typeof e === 'object' && typeof (e as LegacyEntry).id === 'string') as LegacyEntry[];
}

/** 读 v0 config.json（id 对账；tools→rows 归一；缺席/不匹配 = null） */
function readLegacyConfigFile(dir: string): AgentConfig | null {
  const agentId = path.basename(dir);
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf-8');
  } catch {
    return null;
  }
  try {
    const cfg = JSON.parse(raw) as Partial<AgentConfig> & { tools?: unknown };
    if (typeof cfg.id !== 'string' || cfg.id !== agentId) return null;
    if (cfg.rows === undefined && cfg.tools !== undefined) {
      (cfg as Record<string, unknown>).rows = cfg.tools;
      delete (cfg as Record<string, unknown>).tools;
    }
    return normalizeLegacyTags(cfg as AgentConfig);
  } catch {
    throw new Error('config.json 不可读：' + dir);
  }
}

/** 形态探测（目录实体纯读；无身份 = null） */
export function detectPatchForm(ctx: PatchChainContext): VersionedValue<PatchForm> | null {
  const blank = { warnings: [] as string[], notices: [] as string[] };
  const v3 = readAgentPatchV3At(ctx.dir);
  if (v3 !== null) {
    return { version: 2, value: { ctx, v2Defs: v3.defs, v2Fingerprints: v3.fingerprints, ...blank } };
  }
  const entries = readLegacyEntries(ctx.dir);
  if (entries !== null) {
    return { version: 1, value: { ctx, v1Entries: entries, ...blank } };
  }
  const mapping = readAgentPatchAt(ctx.dir);
  if (mapping !== null) {
    return { version: 0, value: { ctx, config: patchToConfig(path.basename(ctx.dir), mapping), ...blank } };
  }
  const cfg = readLegacyConfigFile(ctx.dir);
  if (cfg !== null) {
    return { version: 0, value: { ctx, config: cfg, ...blank } };
  }
  return null;
}

// —— 链驱动执行（migrate 工具与 boot 惰性迁移共用入口） ——

/** 身份迁移结果（审计面——fromVersion + 逐边报告 + 对账） */
export interface PatchMigrationOutcome {
  /** 起始形态版本（0 = 前菜单身份，1 = 数组差量） */
  fromVersion: number;
  /** 逐边应用记录（notice 报告每边） */
  reports: EdgeReport[];
  /** 写入的 v2 定义与指纹 */
  defs: MenuEntry[];
  fingerprints: Record<string, string>;
  /** v0 载荷侧写（档案面——调用方报告用） */
  wroteProfile: boolean;
  warnings: string[];
  notices: string[];
}

/** 链驱动身份迁移（v0/v1 → v2 落盘 + 对账自检；已最新/无身份 = null）。
 * v0 全量：settings 拆单元 + origin 并入档案 + preset-origin.json 转
 * .migrated；v1 只换 patch（档案已在 agent.json）。config.json 收编转
 * .migrated（cr-1036 批3——形态死亡，留审计副本）。 */
export function migrateAgentPatchAt(ctx: PatchChainContext): PatchMigrationOutcome | null {
  const stored = detectPatchForm(ctx);
  if (stored === null || stored.version >= 2) return null;
  const config = stored.version === 0 ? stored.value.config : undefined;
  if (stored.version === 0 && config === undefined) return null;
  // v0 载荷侧写先行（档案/单元文件——patch 写入前落定，等价性可对账）
  let wroteProfile = false;
  let origin: PatchOrigin | undefined;
  if (stored.version === 0 && config !== undefined) {
    for (const [unit, value] of Object.entries(config.settings ?? {})) {
      writePluginConfigAt(ctx.dir, unit, value);
    }
    const legacyDoc = readAgentPatchAt(ctx.dir);
    origin = legacyDoc?.origin;
    const originPath = path.join(ctx.dir, 'preset-origin.json');
    if (origin === undefined && fs.existsSync(originPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(originPath, 'utf-8')) as PatchOrigin;
        if (typeof parsed.template === 'string' && typeof parsed.hash === 'string') origin = parsed;
      } catch { /* 坏 origin = 留旧文件 */ }
    }
    if (fs.existsSync(originPath) && origin !== undefined) {
      fs.renameSync(originPath, originPath + '.migrated');
    }
    writeAgentProfileAt(ctx.dir, {
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      ...(config.llmParams !== undefined ? { 'llm-params': config.llmParams } : {}),
      ...(config.maxSteps !== undefined ? { 'max-steps': config.maxSteps } : {}),
      ...(config.access !== undefined && config.access !== 'base-access' ? { tier: config.access } : {}),
      ...(config.toolMode !== undefined && config.toolMode !== 'tc-base' ? { 'tool-mode': config.toolMode } : {}),
      ...(config.name !== undefined ? { name: config.name } : {}),
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.virtual === true ? { virtual: true } : {}),
      ...(origin !== undefined ? { origin } : {}),
    });
    wroteProfile = true;
  }
  // 链驱动换轨 + 对账自检（迁移前后行集逐位比对——漂移即红，不落盘）
  const { value, reports } = runChain(PATCH_CHAIN, stored);
  const defs = value.v2Defs ?? [];
  const fingerprints = value.v2Fingerprints ?? {};
  writeAgentPatchV3At(ctx.dir, defs, fingerprints, ctx.stamp);
  const written = readAgentPatchV3At(ctx.dir);
  const actual = written !== null
    ? mergeMenu({ skeleton: ctx.skeleton, patch: written.defs }).entries.map((d) => d.id).sort()
    : null;
  const expected = [...new Set([...ctx.skeleton.map((d) => d.id), ...defs.map((d) => d.id)])].sort();
  if (actual === null || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('对账失败（迁移前后行集不等价）：' + ctx.dir);
  }
  // config.json 收编（转 .migrated——旧读者窗口退役，cr-1036 批3）
  const cfgPath = path.join(ctx.dir, 'config.json');
  if (fs.existsSync(cfgPath)) fs.renameSync(cfgPath, cfgPath + '.migrated');
  return { fromVersion: stored.version, reports, defs, fingerprints, wroteProfile, warnings: value.warnings, notices: value.notices };
}

/** v3 幂等重写（--rebase：基线戳重算——非迁移，工具直用 writeAgentPatchV3At） */
export { PATCH_FILE, PROFILE_FILE };
export type { AgentPatchDoc };
