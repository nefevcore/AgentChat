// ============================================================
// ac-plugin-core/src/store.ts —— 插件库 staging 人审文件域
//
// src plugins/registry.ts 的文件域原样搬运（资产 #4：staging 人审管 +
// 哈希/只读代理/权限快照/来源锚定）。目录约定：
//   <root>/plugins/registry.json          安装记录（name → 快照）
//   <root>/plugins/<name>/                已安装插件
//   <root>/plugins/.staging/<id>/         待审查暂存副本
//   <root>/plugins/.staging/<id>.json     暂存记录（人审 approve 消费）
//   <root>/plugins/.backup/<name>-<ver>-<ts>/  被替换的旧版本
//
// preview 缩水：不做发布期 esbuild 构建（manifest.ui 要求预构建产物；
// 入口存在性校验由装载侧 ac-webui.addEntry 完成）。
// 发布 ≠ 启用：安装只进插件库；启用 = 装载（loader 安装态）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  grantPermissions,
  requiredGrants,
  assertPermissionsGranted,
  validatePluginManifest,
  type InstalledPluginRecord,
  type PluginManifest,
  type PluginPermission,
  type PluginRegistryDoc,
  type PluginSource,
  type PluginStagingRecord,
} from './manifest.ts';
import { atomicWriteFile, renameWithRetry, withRootLock } from './fsx.ts';

const REGISTRY_FILE = 'registry.json';
const STAGING_DIR = '.staging';
const BACKUP_DIR = '.backup';
/**
 * 目录排除集（copy 与 hash 共用——G10 统一：现状只排顶层 node_modules 的
 * 复制与排任意层的哈希不一致 → 深层依赖被复制却不入 hash，F3 复验盲区
 * + 未审查依赖进供应链面。统一为任意深度同名目录全排）。
 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.staging', '.backup', '.market']);
const STAGING_ID_RE = /^[a-z0-9-]+$/;
const INSTALLED_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** staging 人审文件读取上限（1 MiB） */
export const MAX_REVIEW_FILE_BYTES = 1024 * 1024;

/** 插件库根目录 */
export function pluginsRoot(root: string): string {
  return path.join(root, 'plugins');
}

/** 读取插件目录的 manifest.json 并校验；失败抛错 */
export function loadManifestFromDir(dir: string): PluginManifest {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`插件目录缺少 manifest.json: ${dir}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err: unknown) {
    throw new Error(`manifest.json 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const check = validatePluginManifest(raw);
  if (!check.ok) throw new Error(`manifest 非法: ${check.errors.join('；')}`);
  return check.manifest!;
}

/** 路径是否命中排除集（任意深度的目录名；copy filter 与 hash walk 共用） */
function isExcludedDir(source: string, src: string): boolean {
  const rel = path.relative(src, source);
  if (rel === '') return false;
  return rel.split(path.sep).some((seg) => EXCLUDE_DIRS.has(seg));
}

/** 递归复制插件目录（排除集与 hashPluginDir 统一——任意深度） */
export function copyPluginDir(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => !isExcludedDir(source, src),
  });
}

/** 计算插件目录内容哈希（相对路径排序后 SHA-256，确定性） */
export function hashPluginDir(dir: string): string {
  const hash = createHash('sha256');
  const files: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(path.join(d, entry.name));
      } else if (entry.isFile()) {
        files.push(path.join(d, entry.name));
      }
    }
  };
  walk(dir);
  files.sort();
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 读取插件库 registry（不存在返回空文档；损坏抛错——变更路径用） */
export function readRegistry(root: string): PluginRegistryDoc {
  const file = path.join(pluginsRoot(root), REGISTRY_FILE);
  if (!fs.existsSync(file)) return { version: 1, plugins: {} };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as PluginRegistryDoc;
    if (doc.version !== 1 || doc.plugins === null || typeof doc.plugins !== 'object') {
      throw new Error('registry 格式不受支持');
    }
    return doc;
  } catch (err: unknown) {
    throw new Error(`读取插件库 registry 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** registry fail-soft 读取结果：corrupt 非空 = 原文件损坏已转存、本次空档 */
export interface RegistryReadResult {
  doc: PluginRegistryDoc;
  corrupt?: { message: string; backup?: string };
}

/**
 * registry fail-soft 读取（C2，2026-08-31 审计）：坏 registry.json 曾是
 * 三个状态文件中唯一 fail-closed 的——boot 扫描 loadInstalled 读到即崩
 * → supervisor 退避重拉 ×5 → 熔断全下线，手编坏一个 JSON 锁死宿主。
 * 损坏时坏文件转存 `<file>.corrupt`（唯一副本不静默覆盖）后按空档继续；
 * 变更路径（approve/uninstall）仍走严格版 readRegistry（对调用方报错）。
 */
export function readRegistryFailSoft(root: string): RegistryReadResult {
  try {
    return { doc: readRegistry(root) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const file = path.join(pluginsRoot(root), REGISTRY_FILE);
    let backup: string | undefined;
    try {
      backup = `${file}.corrupt`;
      fs.renameSync(file, backup);
    } catch {
      backup = undefined; // 转存失败（文件被占用等）：原文件保留，本次按空档
    }
    return {
      doc: { version: 1, plugins: {} },
      corrupt: { message, ...(backup ? { backup } : {}) },
    };
  }
}

function writeRegistry(root: string, doc: PluginRegistryDoc): void {
  const dir = pluginsRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // M23 F5：tmp+rename 原子写（现状裸 writeFileSync——半写文件会让 boot
  // 读档直接抛错）+ Windows rename retry（atomicWriteFile 内含）
  atomicWriteFile(path.join(dir, REGISTRY_FILE), JSON.stringify(doc, null, 2) + '\n');
}

/** .backup 子目录名（版本 + 时间 + 随机后缀——同毫秒碰撞防护，G10） */
function backupDirName(name: string, version: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${name}-${version}-${Date.now().toString(36)}${rand}`;
}

// ============================================================
// staging —— 发布第一阶段：校验 + 暂存，等宿主用户审查
// ============================================================

/**
 * 暂存插件（sourceDir → .staging/<id>/），返回审查记录。
 * 数据根串行队列内执行（M23 F5：全 mutation 入口统一串行）。
 * @param source 来源锚定（市场安装：repo/ref/commit；本地发布缺省 local）
 * @param options.uiIsolatedDefault 免审安装通道（installFromDir）：manifest.ui
 *   存在且未显式声明 isolated → 规范化为 isolated: true 写入暂存副本（F7——
 *   浏览器侧常驻面缺省隔离；人审 approve 路径不传此参照旧）。哈希在规范化
 *   之后计算——安装态 hash 与目录内容一致。
 */
export function stagePlugin(
  root: string,
  sourceDir: string,
  owner: string,
  source?: PluginSource,
  options: { uiIsolatedDefault?: boolean } = {},
): Promise<PluginStagingRecord> {
  return withRootLock(root, () => {
    const sourceManifest = loadManifestFromDir(sourceDir);
    const stagingRoot = path.join(pluginsRoot(root), STAGING_DIR);
    fs.mkdirSync(stagingRoot, { recursive: true });

    // id = name + 毫秒 + 随机段（同名并发/跨进程同毫秒碰撞防护，G10）
    const id = `${sourceManifest.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const stagedDir = path.join(stagingRoot, id);
    copyPluginDir(sourceDir, stagedDir);

    // 重读暂存 manifest（copy 后的真相源）；免审通道 UI 缺省 isolated 规范化
    let manifest = loadManifestFromDir(stagedDir);
    if (options.uiIsolatedDefault && manifest.ui && manifest.ui.isolated === undefined) {
      manifest = { ...manifest, ui: { ...manifest.ui, isolated: true } };
      fs.writeFileSync(
        path.join(stagedDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf-8',
      );
    }
    const hash = hashPluginDir(stagedDir);

    const record: PluginStagingRecord = {
      id,
      manifest,
      sourceDir: path.resolve(sourceDir),
      stagedDir,
      hash,
      owner,
      createdAt: new Date().toISOString(),
      requiredGrants: requiredGrants(manifest),
      ...(source ? { source } : {}),
    };
    fs.writeFileSync(path.join(stagingRoot, `${id}.json`), JSON.stringify(record, null, 2) + '\n', 'utf-8');
    return record;
  });
}

/** 列出全部待审查暂存记录 */
export function listStaging(root: string): PluginStagingRecord[] {
  const stagingRoot = path.join(pluginsRoot(root), STAGING_DIR);
  if (!fs.existsSync(stagingRoot)) return [];
  const out: PluginStagingRecord[] = [];
  for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(stagingRoot, entry.name), 'utf-8')) as PluginStagingRecord);
    } catch { /* skip 损坏记录 */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function readStagingRecord(root: string, id: string): PluginStagingRecord {
  if (!STAGING_ID_RE.test(id)) throw new Error(`staging id 非法: ${id}`);
  const file = path.join(pluginsRoot(root), STAGING_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`暂存记录不存在: ${id}`);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as PluginStagingRecord;
}

/** 读取暂存记录（人审端点用；id 白名单校验 + 记录存在性） */
export function getStagingRecord(root: string, id: string): PluginStagingRecord {
  return readStagingRecord(root, id);
}

/** 拒绝暂存：删除 .staging 目录与记录；返回是否确有删除（串行队列内） */
export function rejectStaging(root: string, id: string): Promise<{ id: string; removedDir?: string }> {
  return withRootLock(root, () => {
    const record = readStagingRecord(root, id);
    const json = path.join(pluginsRoot(root), STAGING_DIR, `${id}.json`);
    fs.rmSync(json, { force: true });
    if (fs.existsSync(record.stagedDir)) {
      fs.rmSync(record.stagedDir, { recursive: true, force: true });
      return { id, removedDir: record.stagedDir };
    }
    return { id };
  });
}

// ============================================================
// approve —— 发布第二阶段：审查通过后安装进插件库
// ============================================================

export interface ApproveResult {
  name: string;
  version: string;
  manifest: PluginManifest;
  permissions: PluginPermission[];
  installedDir: string;
  replaced?: { oldVersion: string; backupDir: string };
  hash: string;
  source?: PluginSource;
}

/**
 * 批准暂存并安装（同名不同版本 → 旧版本移 .backup；同名同版本 → 拒绝）。
 *
 * M23 F6 可补偿分步：旧顺序"旧目录→.backup → staged→target →
 * writeRegistry → 删 staging 记录"全程无 try/catch，writeRegistry 抛错 =
 * 新代码就位未注册 + 旧版已进 .backup + staging 残留。重构后每步补偿
 * 全覆盖（在数据根串行队列内执行）：
 *   ① 旧目录 → .backup（失败 = 原状抛错，无残留）
 *   ② staged → target（失败 = 回滚①，staged 原位）
 *   ③ writeRegistry（失败 = 回滚②①：新代码回 staged、旧版复位，再抛）
 *   ④ 删 staging 记录（best-effort：注册已生效，残留记录只影响暂存清单）
 */
export function approveStaging(root: string, id: string, grants?: unknown): Promise<ApproveResult> {
  return withRootLock(root, () => {
    const record = readStagingRecord(root, id);

    // 权限边界：未授予的高危权限在安装前拒绝（授予快照进 registry）
    const granted: PluginPermission[] = grantPermissions(grants);
    assertPermissionsGranted(record.manifest, granted);

    const dir = pluginsRoot(root);
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(record.stagedDir)) {
      throw new Error(`暂存目录已不存在: ${record.stagedDir}（请重新 stage）`);
    }
    const stagedHash = hashPluginDir(record.stagedDir);
    if (stagedHash !== record.hash) {
      throw new Error('暂存内容哈希不一致（暂存后文件被改动），拒绝安装');
    }

    const doc = readRegistry(root);
    const existing = doc.plugins[record.manifest.name];
    if (existing && existing.manifest.version === record.manifest.version) {
      throw new Error(`插件 "${record.manifest.name}@${record.manifest.version}" 已安装（同版本拒绝重复发布）`);
    }

    const targetDir = path.join(dir, record.manifest.name);
    let replaced: ApproveResult['replaced'];
    // ① 旧版本备份
    if (existing || fs.existsSync(targetDir)) {
      const oldVersion = existing?.manifest.version ?? 'unknown';
      const backupDir = path.join(dir, BACKUP_DIR, backupDirName(record.manifest.name, oldVersion));
      fs.mkdirSync(path.dirname(backupDir), { recursive: true });
      if (fs.existsSync(targetDir)) renameWithRetry(targetDir, backupDir);
      replaced = { oldVersion, backupDir };
    }

    // ② 暂存目录就位（失败 → 回滚①）
    try {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      renameWithRetry(record.stagedDir, targetDir);
    } catch (err: unknown) {
      if (replaced && fs.existsSync(replaced.backupDir) && !fs.existsSync(targetDir)) {
        try {
          renameWithRetry(replaced.backupDir, targetDir); // 回滚①：旧版复位
        } catch (restoreErr: unknown) {
          throw new Error(
            `安装失败且旧版本回滚失败：${err instanceof Error ? err.message : String(err)}；` +
              `旧版备份保留在 ${replaced.backupDir}（回滚错误：${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}）`,
          );
        }
      }
      throw err;
    }

    // ③ 注册（失败 → 回滚②①：新代码回暂存位、旧版复位）
    const installed: InstalledPluginRecord = {
      manifest: record.manifest,
      dir: record.manifest.name,
      owner: record.owner,
      permissions: granted,
      hash: record.hash,
      installedAt: new Date().toISOString(),
      ...(record.source ? { source: record.source } : {}),
    };
    doc.plugins[record.manifest.name] = installed;
    try {
      writeRegistry(root, doc);
    } catch (err: unknown) {
      const rollbackErrors: string[] = [];
      try {
        renameWithRetry(targetDir, record.stagedDir); // 新代码回暂存位
      } catch (e2: unknown) {
        rollbackErrors.push(`新代码未能移回暂存位（残留 ${targetDir}）：${e2 instanceof Error ? e2.message : String(e2)}`);
      }
      if (replaced && !rollbackErrors.length && fs.existsSync(replaced.backupDir)) {
        try {
          renameWithRetry(replaced.backupDir, targetDir); // 旧版复位
        } catch (e2: unknown) {
          rollbackErrors.push(`旧版本未能复位（备份保留在 ${replaced.backupDir}）：${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
      throw new Error(
        `写入 registry 失败: ${err instanceof Error ? err.message : String(err)}` +
          (rollbackErrors.length ? `；补偿回滚未完成——${rollbackErrors.join('；')}` : '（已回滚到安装前状态）'),
      );
    }

    // ④ 清暂存记录（best-effort）
    try {
      fs.rmSync(path.join(pluginsRoot(root), STAGING_DIR, `${id}.json`), { force: true });
    } catch {
      /* 记录文件被占用等瞬时失败：安装已生效，残留记录只影响暂存清单 */
    }

    return {
      name: record.manifest.name,
      version: record.manifest.version,
      manifest: record.manifest,
      permissions: granted,
      installedDir: targetDir,
      ...(replaced ? { replaced } : {}),
      hash: record.hash,
      ...(record.source ? { source: record.source } : {}),
    };
  });
}

/** 插件库已安装清单（C2 fail-soft：registry 损坏按空清单，坏文件已转存） */
export function listInstalled(root: string): InstalledPluginRecord[] {
  const { doc } = readRegistryFailSoft(root);
  return Object.values(doc.plugins).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * 卸载已安装插件：registry 移除 + 目录移 .backup（串行队列内；审计在
 * 服务层入账——uninstall 删 registry 条目后卸载史不可追，audit.jsonl
 * 必须同入流水，G7）。
 * 不修改任何 Agent 配置（保留引用无害：行序表对未注册名自动跳过）。
 */
export function uninstallPlugin(root: string, name: string): Promise<{ name: string; backupDir?: string }> {
  return withRootLock(root, () => {
    if (!INSTALLED_NAME_RE.test(name)) throw new Error(`插件名非法: ${name}`);
    const doc = readRegistry(root);
    const record = doc.plugins[name];
    const dir = pluginsRoot(root);
    const targetDir = path.join(dir, name);
    if (!record && !fs.existsSync(path.join(targetDir, 'manifest.json'))) {
      throw new Error(`插件 "${name}" 未安装`);
    }

    const version = record?.manifest.version ?? 'unknown';
    const backupDir = path.join(dir, BACKUP_DIR, backupDirName(name, version));
    if (fs.existsSync(targetDir)) {
      fs.mkdirSync(path.dirname(backupDir), { recursive: true });
      renameWithRetry(targetDir, backupDir);
    }

    if (record) {
      delete doc.plugins[name];
      writeRegistry(root, doc);
    }
    return { name, ...(fs.existsSync(backupDir) ? { backupDir } : {}) };
  });
}

// ============================================================
// staging 人审查看器（只读；路径守卫 + 大小上限）
// ============================================================

export interface StagingFileInfo {
  path: string;
  size: number;
}

export interface StagingFileContent {
  path: string;
  content: string;
}

/** 列出暂存目录全部文件（相对路径 posix 化，排序确定） */
export function listStagingFiles(root: string, id: string): StagingFileInfo[] {
  const record = getStagingRecord(root, id);
  const dir = path.resolve(record.stagedDir);
  const out: StagingFileInfo[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(d, entry.name));
      } else if (entry.isFile()) {
        const full = path.join(d, entry.name);
        out.push({
          path: path.relative(dir, full).split(path.sep).join('/'),
          size: fs.statSync(full).size,
        });
      }
    }
  };
  if (!fs.existsSync(dir)) throw new Error(`暂存目录已不存在: ${dir}`);
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 读取暂存文件内容（只读；拒绝绝对路径/../ 逃逸/目录/超大文件） */
export function readStagingFile(root: string, id: string, rel: string): StagingFileContent {
  const record = getStagingRecord(root, id);
  const dir = path.resolve(record.stagedDir);

  const normalized = String(rel).replaceAll('\\', '/');
  if (
    normalized === ''
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((seg) => seg === '..' || seg === '')
  ) {
    throw new Error(`暂存文件路径非法（仅允许相对路径）: ${rel}`);
  }

  const full = path.resolve(dir, normalized);
  const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!full.startsWith(dirWithSep)) throw new Error(`暂存文件路径逃逸: ${rel}`);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`暂存文件不存在: ${rel}`);

  const realDir = fs.realpathSync(dir);
  const realFull = fs.realpathSync(full);
  if (!realFull.startsWith(realDir.endsWith(path.sep) ? realDir : realDir + path.sep)) {
    throw new Error(`暂存文件路径逃逸（符号链接）: ${rel}`);
  }

  const size = fs.statSync(full).size;
  if (size > MAX_REVIEW_FILE_BYTES) {
    throw new Error(`文件过大（${size} 字节 > ${MAX_REVIEW_FILE_BYTES} 字节上限），请下载到本地审查`);
  }
  return { path: normalized, content: fs.readFileSync(full, 'utf-8') };
}
