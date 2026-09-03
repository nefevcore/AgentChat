// ============================================================
// src/scripts/migrate-llm-pool-v2.ts —— LLM 池 v2 一次性迁移
// （llm-provider-model-plan P7：模型别名池 → Provider 连接池）
//
// 用法：npx tsx src/scripts/migrate-llm-pool-v2.ts [数据根] [--dry-run]
//   数据根缺省 = AGENTCHAT_DATA_ROOT ?? './data'。
//
// 四步迁移：
//   1. 池（<root>/config.json llmProviders）：旧别名条目（provider+model
//      形态）按 provider 分组合并为连接条目（base_url/defaultModel/default/
//      models 归并；种子名条目 model 键归一 defaultModel）；无法定目标
//      （无 provider 且非种子名）的条目原样保留（运行期 pool 行告警）。
//   2. 凭据（<root>/credentials.json）：全局 pool:<别名> → pool:<provider>
//      （目标已存在则丢弃别名值）；Agent 级 <agent>_<provider> → 全局
//      pool:<provider>（仅当全局为空——D3 收窄，存量凭据并入）。
//   3. Agent 档案（<root>/agents/*/config.json）：model = 别名 → 拆写
//      provider+model；model 带 name@model → 防御性拆分；其余不动。
//   4. 独立会话（<root>/singles/*/session.json）：model = 别名 →
//      `provider@model` 单值引用。
//
// 脚本纪律（migrate-hooks-to-settings 同款）：
//   · 幂等：已是 v2 形态的数据零变更；重跑零变更；
//   · marker：<root>/.migrated-llm-pool-v2（有变更落盘；重跑整体跳过）；
//   · --dry-run：只报告不写盘；
//   · 迁移恒等门：migratePool / resolveAgentModel / resolveSingleModelRef
//     纯函数导出，tests 锁定。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encryptValue, decryptValue } from 'ac-credentials';

/** 内置种子名（与 ac-llm-pool BUILTIN_SEEDS 同源表——脚本独立副本防运行时依赖） */
const SEED_NAMES = ['openai', 'deepseek', 'glm'] as const;

// ---- 纯函数（迁移恒等门入口） ----

/** 别名解析结果：别名条目名 → 目标 { provider, model } */
export type AliasMap = Map<string, { provider: string; model: string }>;

/** 池迁移结果 */
export interface PoolMigration {
  pool: Record<string, unknown>;
  /** 被合并消失的别名（含种子名 model 键归一条目）→ 目标连接 */
  aliases: AliasMap;
  /** 无法定目标的残留条目名（报告用） */
  unresolved: string[];
  changed: boolean;
}

interface PoolEntry {
  base_url?: unknown;
  defaultModel?: unknown;
  default?: unknown;
  models?: unknown;
  provider?: unknown;
  model?: unknown;
}

function isEntry(v: unknown): v is PoolEntry {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * 池迁移（纯函数）：
 *   · 旧别名条目（provider+model）→ 按 provider 分组合并；条目消失、
 *     进 aliases 映射（agent/singles 改写依据）；
 *   · 种子名条目：model 键归一 defaultModel（条目保留；旧 model 进 aliases
 *     ——agent.model 若存的是该模型名，可无损改写为 provider+model）；
 *   · v2 条目（base_url/defaultModel）原样保留，别名并入（不覆盖显值）；
 *   · 幂等：全 v2 形态输入 → changed=false。
 */
export function migratePool(raw: Record<string, unknown>): PoolMigration {
  const aliases: AliasMap = new Map();
  const unresolved: string[] = [];
  /** 合并收集器：目标名 → 归并字段 */
  const merged = new Map<string, { baseUrl?: string; defaultModel?: string; default: boolean; models: string[]; existing?: Record<string, unknown> }>();
  const out: Record<string, unknown> = {};
  const consumed = new Set<string>(); // 被合并消失的条目名

  const ensure = (name: string) => {
    let m = merged.get(name);
    if (!m) {
      m = { default: false, models: [] };
      merged.set(name, m);
    }
    return m;
  };

  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith('$')) {
      out[name] = value;
      continue;
    }
    if (!isEntry(value)) {
      out[name] = value;
      continue;
    }
    const entry = value;
    const provider = strOf(entry.provider);
    const baseUrl = strOf(entry.base_url);
    const defaultModel = strOf(entry.defaultModel);
    const model = strOf(entry.model);
    const isSeed = (SEED_NAMES as readonly string[]).includes(name);

    // v2 自定义连接（有 base_url/defaultModel 且无 provider 键）：原样保留
    if (!provider && (baseUrl || defaultModel)) {
      const m = ensure(name);
      m.existing = { ...entry };
      if (baseUrl) m.baseUrl = baseUrl;
      if (defaultModel) m.defaultModel = defaultModel;
      if (entry.default === true) m.default = true;
      if (Array.isArray(entry.models)) m.models.push(...entry.models.filter((x): x is string => typeof x === 'string'));
      continue;
    }

    // 旧别名条目（provider+model）：合并进目标 provider 条目
    if (provider) {
      const m = ensure(provider);
      if (baseUrl && !m.baseUrl) m.baseUrl = baseUrl;
      if (model && !m.defaultModel) m.defaultModel = model;
      if (entry.default === true) m.default = true;
      if (Array.isArray(entry.models)) m.models.push(...entry.models.filter((x): x is string => typeof x === 'string'));
      if (m.existing && strOf(m.existing.base_url as unknown) === undefined && baseUrl) m.existing.base_url = baseUrl;
      consumed.add(name);
      aliases.set(name, { provider, model: model ?? name });
      continue;
    }

    // 种子名条目：model 键归一 defaultModel（条目保留）
    if (isSeed) {
      const m = ensure(name);
      m.existing = { ...entry };
      delete (m.existing as PoolEntry).model;
      delete (m.existing as PoolEntry).provider;
      if (model && !m.defaultModel) m.defaultModel = model;
      if (defaultModel) m.defaultModel = defaultModel;
      if (baseUrl) m.baseUrl = baseUrl;
      if (entry.default === true) m.default = true;
      if (Array.isArray(entry.models)) m.models.push(...entry.models.filter((x): x is string => typeof x === 'string'));
      if (model) aliases.set(name, { provider: name, model });
      continue;
    }

    // 无 provider 且非种子名：无法定目标 → 原样保留（运行期 pool 行告警）
    unresolved.push(name);
    out[name] = value;
  }

  // 收集器 → 输出条目（v2 形态）
  for (const [name, m] of merged) {
    const entry: Record<string, unknown> = { ...(m.existing ?? {}) };
    if (m.baseUrl) entry.base_url = m.baseUrl;
    if (m.defaultModel) entry.defaultModel = m.defaultModel;
    if (m.models.length > 0) entry.models = [...new Set(m.models)].sort();
    if (m.default) entry.default = true;
    else delete entry.default;
    if (Object.keys(entry).length > 0) out[name] = entry;
  }

  // 变更检测：键集或内容差异
  const before = JSON.stringify(raw);
  const after = JSON.stringify(out);
  return { pool: out, aliases, unresolved, changed: before !== after };
}

/** Agent 档案 model 改写（纯函数）：别名 → provider+model；name@model → 拆分 */
export function resolveAgentModel(
  model: unknown,
  provider: unknown,
  aliases: AliasMap,
): { model?: string; provider?: string; changed: boolean } {
  if (typeof model !== 'string' || !model) return { model: undefined, provider: undefined, changed: false };
  const at = model.indexOf('@');
  if (at > 0 && at < model.length - 1) {
    // name@model 引用（迁移窗口防御）：拆分存储
    return { model: model.slice(at + 1), provider: model.slice(0, at), changed: true };
  }
  const alias = aliases.get(model);
  if (alias) {
    // 仅当现 provider 缺失或与别名目标一致时改写（显式 provider 优先保留）
    if (typeof provider === 'string' && provider && provider !== alias.provider) {
      return { model, provider, changed: false };
    }
    return { model: alias.model, provider: alias.provider, changed: true };
  }
  return { model, provider: typeof provider === 'string' ? provider : undefined, changed: false };
}

/** 独立会话 model 改写（纯函数）：别名 → `provider@model` 单值引用 */
export function resolveSingleModelRef(model: unknown, aliases: AliasMap): { model?: string; changed: boolean } {
  if (typeof model !== 'string' || !model) return { model: undefined, changed: false };
  if (model.includes('@')) return { model, changed: false }; // 已是引用形态
  const alias = aliases.get(model);
  if (alias) return { model: `${alias.provider}@${alias.model}`, changed: true };
  return { model, changed: false };
}

/** marker 文件路径 */
export function markerFile(root: string): string {
  return path.join(root, '.migrated-llm-pool-v2');
}

/**
 * 孤立别名凭据归位（纯函数）：`pool:<别名>` 键在池已清空/条目已删的
 * 场景下失去映射来源——按旧别名命名惯例（条目名 = 模型 id，如
 * `deepseek-v4-flash` / `glm-5.3` = `<provider>-<...>`）做已知 provider
 * 前缀匹配 → `pool:<provider>`。已知 provider 名 = 池条目名 ∪ 内置种子。
 * 无法前缀匹配的孤立键原样保留（报告）。
 */
export function resolveOrphanPoolCredentialKeys(
  credentialKeys: string[],
  poolEntryNames: readonly string[],
): { moves: Map<string, string>; unresolved: string[] } {
  const known = new Set<string>([...poolEntryNames, ...SEED_NAMES]);
  const moves = new Map<string, string>();
  const unresolved: string[] = [];
  for (const key of credentialKeys) {
    const m = /^__GLOBAL___POOL:(.+)_API_KEY$/.exec(key);
    if (!m) continue;
    const alias = m[1];
    // 凭据键全大写——已知名匹配与前缀匹配均按小写口径
    const aliasLower = alias.toLowerCase();
    if (known.has(alias) || [...known].some((p) => p.toLowerCase() === aliasLower)) continue; // 本身就是 provider 名（无需迁移）
    const provider = [...known].find((p) => aliasLower.startsWith(p.toLowerCase() + '-'));
    if (provider) moves.set(key, `__GLOBAL___${upper(`pool:${provider}`)}_API_KEY`);
    else unresolved.push(key);
  }
  return { moves, unresolved };
}

/**
 * 清理全局 llm 死引用（纯函数）：旧式 `llm: {$ref}` / 字符串引用指向的
 * 条目已不在新池 → 删除该键（运行时零消费者，纯残留）。返回是否变更。
 */
export function cleanLegacyLlmRef(
  config: Record<string, unknown>,
  pool: Record<string, unknown>,
): boolean {
  const llm = config.llm;
  if (llm === undefined) return false;
  const refOf = (v: unknown): string | null =>
    typeof v === 'string' ? v
      : v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>).$ref === 'string'
        ? ((v as Record<string, unknown>).$ref as string)
        : null;
  const ref = refOf(llm);
  if (ref === null) return false; // 显式内嵌对象（非引用）保留
  if (pool[ref] !== undefined) return false; // 引用仍有效
  delete config.llm;
  return true;
}

function upper(s: string): string {
  return s.toUpperCase();
}

// ---- CLI（直接执行时） ----

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.migrating`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('migrate-llm-pool-v2.ts')) {
  const dryRun = process.argv.includes('--dry-run');
  const root = path.resolve(
    process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] ??
      process.env.AGENTCHAT_DATA_ROOT ??
      './data',
  );
  if (fs.existsSync(markerFile(root)) && !dryRun) {
    console.log(`marker 在场（${markerFile(root)}）——迁移已完成，整体跳过。手工改档后可删 marker 重跑。`);
    process.exit(0);
  }
  let touched = 0;

  // ---- ① 池 ----
  const configFile = path.join(root, 'config.json');
  const config = readJson(configFile) ?? {};
  const rawPool = (config.llmProviders ?? {}) as Record<string, unknown>;
  const migration = migratePool(rawPool);
  const aliases = migration.aliases;
  // 旧式全局 llm 死引用清理（引用目标已不在新池 → 删除键；运行时零消费者）
  const llmRefCleaned = cleanLegacyLlmRef(config, migration.pool);
  if (migration.changed || llmRefCleaned) {
    touched++;
    if (!dryRun) {
      writeJsonAtomic(configFile, { ...config, llmProviders: migration.pool });
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}config.json：llmProviders → v2（别名合并 ${aliases.size}、未解析保留 ${migration.unresolved.length}${migration.unresolved.length ? `：${migration.unresolved.join(', ')}` : ''}）${llmRefCleaned ? '；清理全局 llm 死引用' : ''}`);
  }

  // Agent provider 快照（② 凭据迁移与 ③ 档案改写共用：先读档案）
  const agentsDir = path.join(root, 'agents');
  const agentFiles: Array<{ id: string; file: string; raw: Record<string, unknown> }> = [];
  if (fs.existsSync(agentsDir)) {
    for (const id of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!id.isDirectory()) continue;
      const file = path.join(agentsDir, id.name, 'config.json');
      if (!fs.existsSync(file)) continue;
      const raw = readJson(file);
      if (raw) agentFiles.push({ id: id.name, file, raw });
    }
  }

  // ---- ② 凭据（同机加解密：machineKey 绑定本机） ----
  const credsFile = path.join(root, 'credentials.json');
  if (fs.existsSync(credsFile)) {
    const store = readJson(credsFile) ?? {};
    const upper = (s: string) => s.toUpperCase();
    // CredentialsService.key('__global__', 'pool:<名>') 的 upper 形态
    const gk = (provider: string) => `__GLOBAL___${upper(`pool:${provider}`)}_API_KEY`;
    const moves: Array<[string, string]> = []; // 旧 key → 新 key
    const drops: string[] = [];
    // 别名池凭据 → provider 池凭据
    for (const [alias, target] of aliases) {
      const oldKey = `__GLOBAL___${upper(`pool:${alias}`)}_API_KEY`;
      const newKey = gk(target.provider);
      if (typeof store[oldKey] === 'string' && oldKey !== newKey) {
        if (typeof store[newKey] === 'string') drops.push(oldKey);
        else moves.push([oldKey, newKey]);
      }
    }
    // Agent 级凭据 → 全局 pool（仅当全局为空——D3 语义）
    for (const { raw } of agentFiles) {
      const provider = typeof raw.provider === 'string' ? raw.provider : '';
      if (!provider) continue;
      const agentKey = `${upper(String(raw.id ?? ''))}_${upper(provider)}_API_KEY`;
      const newKey = gk(provider);
      if (typeof store[agentKey] === 'string') {
        if (typeof store[newKey] === 'string' || moves.some(([, n]) => n === newKey)) drops.push(agentKey);
        else moves.push([agentKey, newKey]);
      }
    }
    // 孤立别名池凭据（池清空/条目已删场景——别名映射无从推起）：按旧别名
    // 命名惯例（<provider>-<model>）前缀归位 pool:<provider>
    const poolNames = Object.keys(migration.pool).filter((k) => !k.startsWith('$'));
    const orphan = resolveOrphanPoolCredentialKeys(Object.keys(store), poolNames);
    for (const [oldKey, newKey] of orphan.moves) {
      if (typeof store[newKey] === 'string' || moves.some(([, n]) => n === newKey)) drops.push(oldKey);
      else moves.push([oldKey, newKey]);
    }
    if (orphan.unresolved.length > 0) {
      console.warn(`孤立池凭据无法归位（手工处理）：${orphan.unresolved.join(', ')}`);
    }
    if (moves.length > 0 || drops.length > 0) {
      touched++;
      const next = { ...store };
      for (const key of drops) delete next[key];
      for (const [oldKey, newKey] of moves) {
        const plain = decryptValue(String(store[oldKey]));
        if (plain === null) {
          console.warn(`凭据 ${oldKey} 解密失败（换机/损坏）——原样保留`);
          continue;
        }
        delete next[oldKey];
        next[newKey] = encryptValue(plain);
      }
      if (!dryRun) writeJsonAtomic(credsFile, next);
      console.log(`${dryRun ? '[dry-run] ' : ''}credentials.json：迁移 ${moves.length} 条 / 丢弃 ${drops.length} 条（目标已存在）`);
    }
  }

  // ---- ③ Agent 档案 ----
  let agentMigrated = 0;
  for (const { file, raw } of agentFiles) {
    const resolved = resolveAgentModel(raw.model, raw.provider, aliases);
    if (!resolved.changed) continue;
    const next: Record<string, unknown> = { ...raw, model: resolved.model, provider: resolved.provider };
    agentMigrated++;
    if (!dryRun) writeJsonAtomic(file, next);
  }
  if (agentMigrated > 0) {
    touched++;
    console.log(`${dryRun ? '[dry-run] ' : ''}agents/：${agentMigrated} 个档案 model 归一（别名 → provider+model）`);
  }

  // ---- ④ 独立会话 ----
  const singlesDir = path.join(root, 'singles');
  let singleMigrated = 0;
  if (fs.existsSync(singlesDir)) {
    for (const dir of fs.readdirSync(singlesDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = path.join(singlesDir, dir.name, 'session.json');
      if (!fs.existsSync(file)) continue;
      const raw = readJson(file);
      if (!raw) continue;
      const resolved = resolveSingleModelRef(raw.model, aliases);
      if (!resolved.changed) continue;
      singleMigrated++;
      if (!dryRun) writeJsonAtomic(file, { ...raw, model: resolved.model });
    }
  }
  if (singleMigrated > 0) {
    touched++;
    console.log(`${dryRun ? '[dry-run] ' : ''}singles/：${singleMigrated} 个会话 model 归一（别名 → provider@model）`);
  }

  if (!dryRun && touched > 0) {
    fs.writeFileSync(markerFile(root), new Date().toISOString(), 'utf-8');
  }
  console.log(
    `完成：${touched} 处数据域变更${dryRun ? '（dry-run 未写盘）' : touched > 0 ? `（marker 已落盘：${markerFile(root)}）` : '（已是 v2 形态——marker 不落盘，保持可重扫）'}`,
  );
}
