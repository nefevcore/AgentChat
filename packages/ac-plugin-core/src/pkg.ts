// ============================================================
// pkg.ts —— 包即插件描述符层（cr-903 / cr-901 v2.1 批2 切片一 §4.1）
//
// 唯一插件格式 = npm 包（或等价目录），AgentChat 专属声明住 package.json
// `ac` 字段：faces 三面（node 进壳进程授权面 / web 浏览器降级面 / data
// 零装载纯物化）+ permissions + provides。兼容门自求值：装载器读
// engines 字段自做 semver 判定（DSH 同款自实现，不依赖 pnpm）——
// engines.node 门 strip 能力，engines.agentchat 门平台 ABI。
//
// 迁移投影（批 2 双读窗口）：无 ac 字段但目录内有旧 manifest.json 的
// 插件按旧格式投影——entry→faces.node、ui→faces.web、contracts 字段
// 沿用 1.x 轴求值（HOST_CONTRACTS_VERSION），批 6 拆旧时随 manifest
// 形态一并退役。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isContractsCompatible, HOST_CONTRACTS_VERSION } from './contracts.ts';
import { validatePluginManifest, KNOWN_PERMISSIONS, type PluginManifest, type PluginPermission } from './manifest.ts';

/**
 * 当前平台 ABI 版本（engines.agentchat 求值轴）。major 位 = 插件兼容面
 * （ctx.* 服务签名破坏、ac 字段词汇收紧必须升 major）。版本范围随 v2
 * 发版冻结（cr-901 §4.1——批 2 先立轴，冻结值发版时定）。
 */
export const AGENTCHAT_ABI_VERSION = '2.0.0';

/** faces 三面（node 进壳 / web 浏览器 / data 零装载） */
export interface AcFaces {
  node?: { entry: string };
  web?: { entry: string; seats?: string[] };
  data?: { skills?: string; theme?: string };
}

/** package.json 的 ac 字段 */
export interface AcField {
  faces?: AcFaces;
  permissions?: PluginPermission[];
  provides?: PluginManifest['provides'];
}

/** 包即插件描述符（新旧格式归一后的装载面词汇） */
export interface PluginPackage {
  name: string;
  version: string;
  /** 兼容门（自求值面）：node 门 strip、agentchat 门 ABI */
  engines?: { node?: string; agentchat?: string };
  /** 旧 manifest.contracts 字段（迁移期沿 1.x 轴求值；与 engines 并存时 engines 赢） */
  legacyContracts?: string;
  ac?: AcField;
  /** 描述符来源（审计/审批卡展示面） */
  form: 'package' | 'legacy-manifest';
}

export interface EnginesVerdict {
  ok: boolean;
  /** 逐轴失败原因（审批卡/回执展示面） */
  failures: string[];
}

/**
 * engines 自求值（纯函数；fail-closed）。未声明轴 = 放行（存量默认兼容
 * 语义承 contracts.ts）；非法 range = 不兼容。node 轴接受 'v' 前缀形态
 *（engines.node 惯例裸版本、process.version 带 v——两侧都容）。
 * legacyContracts 沿 HOST_CONTRACTS_VERSION（1.x）轴求值。
 */
export function evaluateEngines(
  pkg: PluginPackage,
  host: { node?: string; agentchat?: string } = {},
): EnginesVerdict {
  const failures: string[] = [];
  const nodeRange = pkg.engines?.node;
  const nodeActual = host.node ?? process.version;
  if (nodeRange !== undefined
    && !isContractsCompatible(nodeRange, nodeActual.replace(/^v/, ''))) {
    failures.push('engines.node ' + nodeRange + ' 不满足当前 Node ' + nodeActual);
  }
  const acRange = pkg.engines?.agentchat;
  const acActual = host.agentchat ?? AGENTCHAT_ABI_VERSION;
  if (acRange !== undefined) {
    if (!isContractsCompatible(acRange, acActual)) {
      failures.push('engines.agentchat ' + acRange + ' 不满足平台 ABI ' + acActual);
    }
  } else if (pkg.legacyContracts !== undefined
    && !isContractsCompatible(pkg.legacyContracts, HOST_CONTRACTS_VERSION)) {
    failures.push('contracts ' + pkg.legacyContracts + ' 不满足宿主契约 ' + HOST_CONTRACTS_VERSION + '（旧字段，迁移期沿 1.x 轴求值）');
  }
  return { ok: failures.length === 0, failures };
}

/** 字符串数组字段校验（非数组/含非串 → undefined） */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) return undefined;
  const list = value as string[];
  return list.length > 0 ? list : undefined;
}

/** 权限词汇校验（未知词 → 过滤；全滤空 → undefined） */
function permissionsOf(value: unknown): PluginPermission[] | undefined {
  const list = stringArray(value);
  if (list === undefined) return undefined;
  const known = list.filter((p): p is PluginPermission =>
    (KNOWN_PERMISSIONS as readonly string[]).includes(p));
  return known.length > 0 ? known : undefined;
}

/** faces 字段校验（非法面/缺 entry → 忽略该面） */
function facesOf(raw: unknown): AcFaces | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const faces: AcFaces = {};
  const face = (key: 'node' | 'web' | 'data'): Record<string, unknown> | undefined => {
    const v = obj[key];
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? v as Record<string, unknown>
      : undefined;
  };
  const node = face('node');
  if (node !== undefined && typeof node.entry === 'string' && node.entry !== '') {
    faces.node = { entry: node.entry };
  }
  const web = face('web');
  if (web !== undefined && typeof web.entry === 'string' && web.entry !== '') {
    const seats = stringArray(web.seats);
    faces.web = { entry: web.entry, ...(seats !== undefined ? { seats } : {}) };
  }
  const data = face('data');
  if (data !== undefined) {
    const d: { skills?: string; theme?: string } = {};
    if (typeof data.skills === 'string' && data.skills !== '') d.skills = data.skills;
    if (typeof data.theme === 'string' && data.theme !== '') d.theme = data.theme;
    if (Object.keys(d).length > 0) faces.data = d;
  }
  return Object.keys(faces).length > 0 ? faces : undefined;
}

/**
 * 读插件包目录描述符（package.json ac 字段优先；无 ac 字段且目录内有
 * manifest.json → 旧格式投影）。name/version 缺失或 package.json 损坏 →
 * throw（fail-loud：安装门禁面，非法包不进回执后段）。
 */
export function readPluginPackage(dir: string): PluginPackage {
  const pkgPath = path.join(dir, 'package.json');
  let pkgJson: Record<string, unknown> | null = null;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    pkgJson = null; // 无 package.json → 尝试旧格式
  }
  if (pkgJson !== null) {
    const name = typeof pkgJson.name === 'string' ? pkgJson.name : '';
    const version = typeof pkgJson.version === 'string' ? pkgJson.version : '';
    if (name === '' || version === '') {
      throw new Error('插件包 package.json 缺 name/version：' + dir);
    }
    const enginesRaw = pkgJson.engines !== null && typeof pkgJson.engines === 'object' && !Array.isArray(pkgJson.engines)
      ? pkgJson.engines as Record<string, unknown>
      : undefined;
    const acRaw = pkgJson.ac;
    return {
      name,
      version,
      form: 'package',
      ...(enginesRaw !== undefined || (pkgJson as { contracts?: unknown }).contracts !== undefined ? {
        engines: {
          ...(typeof enginesRaw?.node === 'string' ? { node: enginesRaw.node } : {}),
          ...(typeof enginesRaw?.agentchat === 'string' ? { agentchat: enginesRaw.agentchat } : {}),
        },
        // 旧顶层 contracts 字段（迁移期兼容——manifest 形态之外 package.json
        // 也可携带；engines.agentchat 在场时本字段退位）
        ...(typeof (pkgJson as { contracts?: unknown }).contracts === 'string'
          && enginesRaw?.agentchat === undefined
          ? { legacyContracts: (pkgJson as { contracts: string }).contracts } : {}),
      } : {}),
      ...(acRaw !== null && typeof acRaw === 'object' && !Array.isArray(acRaw) ? {
        ac: {
          faces: facesOf((acRaw as Record<string, unknown>).faces),
          permissions: permissionsOf((acRaw as Record<string, unknown>).permissions),
          provides: (acRaw as { provides?: AcField['provides'] }).provides,
        },
      } : {}),
    };
  }
  // 旧格式投影：manifest.json → faces/provides/permissions/contracts
  const manifest = readLegacyManifest(dir);
  return projectLegacyManifest(manifest, dir);
}

/** 旧 manifest.json 读取（损坏/非法 → throw，与 v1 loadManifestFromDir 同语义） */
function readLegacyManifest(dir: string): PluginManifest {
  const manifestPath = path.join(dir, 'manifest.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err: unknown) {
    throw new Error('插件包缺 package.json 且 manifest.json 不可读：' + dir + '（' + (err instanceof Error ? err.message : String(err)) + '）');
  }
  const check = validatePluginManifest(raw);
  if (!check.ok) throw new Error('manifest 非法: ' + check.errors.join('；'));
  return check.manifest!;
}

/**
 * 包描述符 → v1 manifest 形态逆投影（store 装载链的 package 形态回退：
 * manifest.json 缺席时由 package.json ac 字段投影——v1 装载/登记面不改，
 * 包即插件唯一格式在批 2 落位；批 6 拆旧时随 manifest 形态退役）。
 */
export function packageToManifest(pkg: PluginPackage): PluginManifest {
  return {
    name: pkg.name,
    version: pkg.version,
    entry: pkg.ac?.faces?.node?.entry ?? 'index.ts',
    ...(pkg.legacyContracts !== undefined ? { contracts: pkg.legacyContracts } : {}),
    ...(pkg.ac?.permissions !== undefined && pkg.ac.permissions.length > 0 ? { permissions: pkg.ac.permissions } : {}),
    ...(pkg.ac?.provides !== undefined ? { provides: pkg.ac.provides } : {}),
    ...(pkg.ac?.faces?.web !== undefined ? {
      ui: {
        entry: pkg.ac.faces.web.entry,
        ...(pkg.ac.faces.web.seats !== undefined ? { slots: pkg.ac.faces.web.seats } : {}),
      },
    } : {}),
  };
}

/** 旧 manifest → 包描述符投影（faces.node = entry；faces.web = ui；contracts → legacyContracts） */
export function projectLegacyManifest(manifest: PluginManifest, dir: string): PluginPackage {  const faces: AcFaces = {};
  if (manifest.entry !== '') faces.node = { entry: manifest.entry };
  if (manifest.ui !== undefined && manifest.ui.entry !== undefined) {
    faces.web = {
      entry: manifest.ui.entry,
      ...(manifest.ui.slots !== undefined && manifest.ui.slots.length > 0 ? { seats: manifest.ui.slots } : {}),
    };
  }
  return {
    name: manifest.name,
    version: manifest.version,
    form: 'legacy-manifest',
    ...(manifest.contracts !== undefined ? { legacyContracts: manifest.contracts } : {}),
    ac: {
      ...(Object.keys(faces).length > 0 ? { faces } : {}),
      ...(manifest.permissions !== undefined && manifest.permissions.length > 0 ? { permissions: manifest.permissions } : {}),
      ...(manifest.provides !== undefined ? { provides: manifest.provides } : {}),
    },
  };
}
