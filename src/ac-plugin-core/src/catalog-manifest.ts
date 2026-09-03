// ============================================================
// ac-plugin-core/src/catalog-manifest.ts —— 内置目录清单（生产 bundle 形态）
//
// 背景：plugin/catalog 内置组与 plugin/rows 行元数据在开发形态靠运行时
// 扫描（src/ac-*/package.json + node 解析）；发布 bundle 无 src/无
// node_modules——两条扫描面双空。生产源 = **构建期固化清单**：
// scripts/build-bundle.mjs 生成 dist/plugin-catalog.json（内置包元数据 +
// cordis.yml 行 id↔name 映射），运行时扫描失败/为空时读它回退
// （AGENTCHAT_PLUGIN_MANIFEST 可显式指路——测试注入/自定义部署）。
// 放纯库（ac-plugin-core）：ac-web-api（目录 RPC）与 ac-plugin-registry
// （行枚举/偏好层）共同依赖，零 cordis 耦合。
// ============================================================
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 内置组条目（声明 agentchat.plugin: true 的行包；构建期采集） */
export interface CatalogBuiltinEntry {
  name: string;
  version?: string;
  description?: string;
}

/** 装配行映射（cordis.yml 全量行，含 disabled——行偏好停用锚点） */
export interface CatalogRowEntry {
  /** yml 裸行 id（patch 匹配走装配文件原文 id） */
  id: string;
  /** 行包名 */
  name: string;
}

export interface CatalogManifest {
  builtin: readonly CatalogBuiltinEntry[];
  rows: readonly CatalogRowEntry[];
  /** name → 内置条目（同名首个胜） */
  readonly builtinByName: ReadonlyMap<string, CatalogBuiltinEntry>;
  /** name → yml 裸行 id（loader 缺席时的停用锚点；同名首个胜） */
  readonly entryIdByPkg: ReadonlyMap<string, string>;
}

/**
 * 解析清单文本（fail-soft：形态非法 → null，调用方走原扫描路径）。
 * 校验判据：顶层对象 + builtin/rows 均为数组；条目 name（与 id）为非空
 * string；version/description 为 string 时收编。同名/同包首条胜（Map 覆盖
 * 不发生——先到先得，与 loader entries 的 has-name 判据同款）。
 */
export function parseCatalogManifest(raw: string): CatalogManifest | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const { builtin: builtinRaw, rows: rowsRaw } = doc as { builtin?: unknown; rows?: unknown };
  if (!Array.isArray(builtinRaw) || !Array.isArray(rowsRaw)) return null;

  const builtin: CatalogBuiltinEntry[] = [];
  const builtinByName = new Map<string, CatalogBuiltinEntry>();
  for (const entry of builtinRaw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name === '') continue;
    if (builtinByName.has(e.name)) continue;
    const item: CatalogBuiltinEntry = {
      name: e.name,
      ...(typeof e.version === 'string' && e.version ? { version: e.version } : {}),
      ...(typeof e.description === 'string' && e.description ? { description: e.description } : {}),
    };
    builtin.push(item);
    builtinByName.set(e.name, item);
  }

  const rows: CatalogRowEntry[] = [];
  const entryIdByPkg = new Map<string, string>();
  for (const entry of rowsRaw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '' || typeof e.name !== 'string' || e.name === '') continue;
    if (entryIdByPkg.has(e.name)) continue;
    rows.push({ id: e.id, name: e.name });
    entryIdByPkg.set(e.name, e.id);
  }

  return { builtin, rows, builtinByName, entryIdByPkg };
}

/**
 * 读清单：`AGENTCHAT_PLUGIN_MANIFEST` 显式路径优先（测试注入），缺省 =
 * baseUrl 同目录的 plugin-catalog.json（bundle 形态即 dist/——构建期产物
 * 与 bundle 同目录；dev 源码形态该文件不存在 → null 走 src 扫描）。
 * baseUrl 收 string | URL（import.meta.url 直传）。
 * fail-soft：读不到/解析失败 → null。
 */
export function readCatalogManifest(baseUrl: string | URL): CatalogManifest | null {
  const envPath = process.env.AGENTCHAT_PLUGIN_MANIFEST;
  const url = envPath ? pathToFileURL(envPath).href : new URL('plugin-catalog.json', baseUrl).href;
  try {
    return parseCatalogManifest(fs.readFileSync(fileURLToPath(url), 'utf-8'));
  } catch {
    return null;
  }
}

/** 目录内置条目形状（plugin/catalog 的 builtin 项；RPC 契约子集） */
export interface CatalogBuiltinItem {
  name: string;
  version?: string;
  description?: string;
  assembled: boolean;
  fibers: number;
  /** yml 裸行 id（停用行也有——卡片装配 toggle 的锚点） */
  entryId?: string;
}

/**
 * 清单内置组 → 目录条目（纯映射，测试锁）：装配状态/fibers/entryId 经
 * lookup 从运行时事实取（registry 交叉 + loader/清单行映射）——清单只
 * 答"有什么可装"，"装没装"恒为运行时事实。按名排序稳定输出。
 */
export function manifestBuiltinCatalog(
  manifest: CatalogManifest,
  lookup: {
    rowState(name: string): { active: boolean; fibers: number };
    entryId(name: string): string | undefined;
  },
): CatalogBuiltinItem[] {
  const out = manifest.builtin.map((entry) => {
    const row = lookup.rowState(entry.name);
    const entryId = lookup.entryId(entry.name);
    return {
      name: entry.name,
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      assembled: row.active === true,
      fibers: row.fibers ?? 0,
      ...(entryId ? { entryId } : {}),
    };
  });
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
