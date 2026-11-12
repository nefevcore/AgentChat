// ============================================================
// config-chain.ts —— 行内 config 迁移链（cr-1037 / docs/design/assembly/config-upgrade.md）
//
// 行 config 是用户数据（指纹不覆盖——定义面无策略、config 面有策略）：
// 插件演进改键名时，存量 config 经 owning 包声明的相邻边迁移链升级。
// 声明面：owning 包 package.json ac.configMigrations 指向包内迁移模块
//（约定路径 src/config-migrations.ts，导出 configMigrations:
// Record<行id, MigrationEdge<Record<string, unknown>>[]>——函数进不了
// JSON，路径声明是发现面单源）；链完备性由校验器四断言保证（构建期
// gen 链 + 运行时 runChain 双保险）。
//
// 无损门槛：map 为纯函数（旧 config → 新 config），写不出无损边的语义
// 变化不写边——旧值整体移入 config.legacy（LEGACY_KEY 保留键）+ notice
// 明示手动重设。configVersion 由执行面维护（机制保留键，边只换算
// 用户键面），仅存在迁移边的行出现——避免 schema 噪音。
//
// 键名换轨边的写法约定：显式删旧键、写新键（解构剔除 + 重建——透传式
// {...c, 新键: c.旧键} 会留旧键垃圾）；多键迁移逐键明写，不猜。
//
// 纪律红线：改任何行级 config 键名的 CR 必须同批处理存量——登记迁移
// 边或显式写明「存量作废 + notice」；编辑面未知键 warn 不阻断（前向
// 兼容回退场景）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  chainCurrent, runChain,
  type MigrationEdge, type EdgeReport,
} from 'ac-migration-core';

/** 行 config 形态值（键值自由记录——纯库不解释内容） */
export type RowConfig = Record<string, unknown>;

/** 行 config 迁移链边（owning 包声明——map 为纯函数） */
export type ConfigMigrationEdge = MigrationEdge<RowConfig>;

/** config.legacy 保留键（无损门槛逃生口——旧值整体移入，明示手动重设） */
export const LEGACY_KEY = 'legacy';

/** 机制保留键（执行面维护——用户键面/边 map 不触碰） */
export const CONFIG_VERSION_KEY = 'configVersion';

/** 包声明（package.json ac 字段词汇——模块路径发现面单源） */
export interface PackageConfigMigrationsDecl {
  /** 迁移模块路径（包内约定位 src/config-migrations.ts） */
  module: string;
}

/** 声明词汇白名单（fail-closed：未知字段拒绝） */
const DECL_KEYS: readonly string[] = ['module'];

/** 包迁移声明解析（ac.configMigrations：坏形/白名单外 = throw） */
export function parseConfigMigrationsDecl(
  raw: unknown,
  pkgFile: string,
): PackageConfigMigrationsDecl | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('ac.configMigrations 必须是映射：' + pkgFile);
  }
  const decl = raw as Record<string, unknown>;
  for (const key of Object.keys(decl)) {
    if (!DECL_KEYS.includes(key)) {
      throw new Error(
        'ac.configMigrations 含白名单外字段：' + key + '（词汇 = module）：' + pkgFile,
      );
    }
  }
  if (typeof decl.module !== 'string' || decl.module === '') {
    throw new Error('ac.configMigrations.module 必须是非空字符串（包内迁移模块路径）：' + pkgFile);
  }
  return { module: decl.module };
}

/** 声明模块路径白名单（包内 src/ 下单文件 .ts——防路径逃逸） */
export function assertMigrationModulePath(modulePath: string, pkgFile: string): void {
  if (!/^\.\/src\/[\w.-]+\.ts$/.test(modulePath)) {
    throw new Error(
      'ac.configMigrations.module 路径非法（须为包内 ./src/<file>.ts）：' + modulePath + '——' + pkgFile,
    );
  }
}

/** 读取并校验迁移模块（动态 import——构建期 gen 链与运行时共用）。返回
 * 行 id → 边数组；声明缺席 = null；声明的模块坏形 = throw。 */
export async function importConfigMigrations(
  pkgDir: string,
  decl: PackageConfigMigrationsDecl | null,
): Promise<Record<string, ConfigMigrationEdge[]> | null> {
  if (decl === null) return null;
  assertMigrationModulePath(decl.module, pkgDir);
  const mod = await import(pathToFileURL(path.join(pkgDir, decl.module)).href) as {
    configMigrations?: unknown,
  };
  const rows = mod.configMigrations;
  if (rows === undefined || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error(
      '迁移模块须导出 configMigrations: Record<行id, 边数组>：' + decl.module,
    );
  }
  const out: Record<string, ConfigMigrationEdge[]> = {};
  for (const [rowId, edges] of Object.entries(rows as Record<string, unknown>)) {
    if (!Array.isArray(edges)) {
      throw new Error('迁移链边数组非法（行 ' + rowId + '）：' + decl.module);
    }
    out[rowId] = edges as ConfigMigrationEdge[];
  }
  return out;
}

// —— 执行语义（纯函数——boot 惰性迁移与编辑面共用） ——

/** 单行 config 迁移结果（审计面——notice 由调用方拼装） */
export interface RowConfigMigrationOutcome {
  /** 迁移后 config（含 configVersion 戳——已到 current） */
  config: RowConfig;
  /** 逐边应用记录（空 = 无损路径无换档，或 legacy 路径） */
  reports: EdgeReport[];
  /** 不可迁说明（非空 = legacy 路径已走） */
  notices: string[];
}

/** 读 configVersion（缺席 = v0 起点形态；非整数/负数 = v0——用户数据宽容） */
export function readConfigVersion(config: RowConfig | undefined): number {
  const v = config?.[CONFIG_VERSION_KEY];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** 判定行是否需要 config 迁移（stored 版本落后于链 current） */
export function needsConfigMigration(
  chain: ConfigMigrationEdge[],
  config: RowConfig | undefined,
): boolean {
  if (chain.length === 0) return false;
  return readConfigVersion(config) < chainCurrent(chain);
}

/** 剥离机制键后的用户键面（map 输入——机制键不是用户数据） */
export function stripVersion(config: RowConfig | undefined): RowConfig {
  if (config === undefined) return {};
  const rest: RowConfig = {};
  for (const [k, v] of Object.entries(config)) {
    if (k !== CONFIG_VERSION_KEY) rest[k] = v;
  }
  return rest;
}

/** 执行单行 config 迁移（纯函数）：
 * · stored < current → 逐边应用 → configVersion 戳为 current；
 * · 链缺边（planChain 校验红）/ 边 map 抛错 → 无损门槛：旧值整体移入
 *   config.legacy + notice 明示手动重设（configVersion 仍戳 current——
 *   不反复触发）；
 * · 未来版本（stored > current）→ 同 legacy 路径（新数据旧代码，不静默
 *   降级读——与 patch 链断言 4 同语义）。 */
export function runConfigMigration(
  chain: ConfigMigrationEdge[],
  config: RowConfig | undefined,
  rowId: string,
): RowConfigMigrationOutcome {
  const current = chainCurrent(chain);
  const stored = readConfigVersion(config);
  try {
    const { value, reports } = runChain(chain, {
      version: stored,
      value: stripVersion(config),
    });
    return { config: { ...value, [CONFIG_VERSION_KEY]: current }, reports, notices: [] };
  } catch (err: unknown) {
    const legacy = stripVersion(config);
    return {
      config: { [LEGACY_KEY]: legacy, [CONFIG_VERSION_KEY]: current },
      reports: [],
      notices: [
        '行 ' + rowId + ' config 不可迁（' + String(err) + '）——旧值移入 config.legacy，该设置需手动重设',
      ],
    };
  }
}

// —— 聚合面（构建期 gen 链校验完备性；运行时 boot 惰性迁移共用） ——

/** 聚合声明（跨包扫描产物：行 id → 边数组 + 来源包名——fail-loud 附出处） */
export interface AggregatedConfigChains {
  chains: Record<string, ConfigMigrationEdge[]>;
  /** 行 id → 声明包目录名（撞名/报错定位） */
  owners: Record<string, string>;
}

/**
 * 扫 repoRoot 下各包 package.json 的 ac.configMigrations → import 迁移
 * 模块（链四断言校验由消费方跑——gen 链构建期即红）。fail-loud：坏声明/
 * 坏模块/跨包行 id 撞名。空聚合（无包声明）= 合法零态。
 */
export async function aggregateConfigChains(repoRoot: string): Promise<AggregatedConfigChains> {
  const chains: Record<string, ConfigMigrationEdge[]> = {};
  const owners: Record<string, string> = {};
  const packagesDir = path.join(repoRoot, 'packages');
  for (const name of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const pkgFile = path.join(packagesDir, name.name, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    let pkg: { ac?: { configMigrations?: unknown } };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8')) as { ac?: { configMigrations?: unknown } };
    } catch (err: unknown) {
      throw new Error('包 package.json 坏 JSON（config 迁移聚合）：' + pkgFile + '——' + String(err));
    }
    const decl = parseConfigMigrationsDecl(pkg.ac?.configMigrations, pkgFile);
    if (decl === null) continue;
    const rows = (await importConfigMigrations(path.join(packagesDir, name.name), decl)) ?? {};
    for (const [rowId, edges] of Object.entries(rows)) {
      if (rowId in owners) {
        throw new Error('config 迁移链跨包撞行 id：' + rowId + '（' + owners[rowId] + ' 与 ' + name.name + '）');
      }
      owners[rowId] = name.name;
      chains[rowId] = edges;
    }
  }
  return { chains, owners };
}