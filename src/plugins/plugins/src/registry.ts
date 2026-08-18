// ============================================================
// @agentchat/plugins/src/registry.ts —— 全局插件库（发布/安装/扫描）
//
// 目录约定（<workspace>/plugins/）：
//   registry.json          安装记录（name → manifest 快照/目录/owner/hash）
//   <name>/                已安装插件（manifest.json + 入口 + 源码）
//   .staging/<id>/         待审查暂存副本（市场安装 stage / WebUI 人工暂存产出）
//   .staging/<id>.json     暂存记录（人审 approve 消费：WebUI 审查弹窗 / CLI）
//   .backup/<name>-<ver>-<ts>/ 被替换的旧版本
//
// 发布 ≠ 启用：安装只是让插件进入全局插件库并可在启动时扫描加载；
// Agent 需在自己的 config.presets 中引用 manifest.name 才真正启用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { buildSync } from 'esbuild';
import type { Context } from '@agentchat/cordis';
import type { StagingFileContent, StagingFileInfo } from '@agentchat/protocol';
import {
  validatePluginManifest,
  type InstalledPluginRecord,
  type PluginManifest,
  type PluginPermission,
  type PluginRegistryDoc,
  type PluginSource,
  type PluginStagingRecord,
} from '@agentchat/agent-config';
import { getOrCreatePluginHost } from './host';
import type { PluginLoadResult } from './host';
import {
  DEFAULT_GRANTED_PERMISSIONS,
  assertPermissionsGranted,
  grantPermissions,
  requiredGrants,
} from './permissions';

const REGISTRY_FILE = 'registry.json';
const STAGING_DIR = '.staging';
const BACKUP_DIR = '.backup';
const MARKET_DIR = '.market';
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.staging', '.backup', '.market']);
const STAGING_ID_RE = /^[a-z0-9-]+$/;
const INSTALLED_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** staging 人审文件读取上限（1 MiB；防止把大二进制读进内存/响应） */
const MAX_REVIEW_FILE_BYTES = 1024 * 1024;

/** 插件库根目录 */
export function pluginsRoot(workspaceDir: string): string {
  return path.join(workspaceDir, 'plugins');
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
  } catch (err: any) {
    throw new Error(`manifest.json 解析失败: ${err?.message ?? String(err)}`);
  }
  const check = validatePluginManifest(raw);
  if (!check.ok) throw new Error(`manifest 非法: ${check.errors.join('；')}`);
  return check.manifest!;
}

/** 递归复制插件目录（排除 node_modules/.git/.staging/.backup） */
export function copyPluginDir(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      const first = rel.split(path.sep)[0];
      return !EXCLUDE_DIRS.has(first);
    },
  });
}

/**
 * P5 发布期浏览器打包（MVP）：若暂存目录已有预构建 entry 则直接使用；
 * 否则若存在 ui/index.ts，用 esbuild 打包为 ui.entry（缺省 ui/dist/index.js）。
 * 构建失败或两者皆无 → 拒绝 stage。
 */
function buildPluginUi(stagedDir: string, manifest: PluginManifest): void {
  const ui = manifest.ui!;
  const uiEntry = ui.entry ?? 'ui/dist/index.js';
  const prebuilt = path.resolve(stagedDir, uiEntry);
  const source = path.resolve(stagedDir, 'ui/index.ts');

  if (fs.existsSync(prebuilt) && fs.statSync(prebuilt).isFile()) {
    return; // 预构建产物已存在，无需编译
  }
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`插件 "${manifest.name}" 声明了 manifest.ui，但暂存目录中既无预构建入口 "${uiEntry}"，也无源码 "ui/index.ts"，无法构建 UI（请先本地构建或提供 ui/index.ts）`);
  }

  const outfile = path.resolve(stagedDir, uiEntry);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  try {
    buildSync({
      entryPoints: [source],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external: ['vue'],
      logLevel: 'silent',
    });
  } catch (err: any) {
    throw new Error(`插件 "${manifest.name}" UI 构建失败（ui/index.ts → ${uiEntry}）: ${err?.message ?? String(err)}`);
  }
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

/** 读取插件库 registry（不存在返回空文档） */
export function readRegistry(workspaceDir: string): PluginRegistryDoc {
  const file = path.join(pluginsRoot(workspaceDir), REGISTRY_FILE);
  if (!fs.existsSync(file)) return { version: 1, plugins: {} };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as PluginRegistryDoc;
    if (doc.version !== 1 || !doc.plugins || typeof doc.plugins !== 'object') {
      throw new Error('registry 格式不受支持');
    }
    return doc;
  } catch (err: any) {
    throw new Error(`读取插件库 registry 失败: ${err?.message ?? String(err)}`);
  }
}

function writeRegistry(workspaceDir: string, doc: PluginRegistryDoc): void {
  const root = pluginsRoot(workspaceDir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, REGISTRY_FILE), JSON.stringify(doc, null, 2) + '\n', 'utf-8');
}

// ============================================================
// staging —— 发布第一阶段：校验 + 暂存，等宿主用户审查
// ============================================================

/**
 * 暂存插件（sourceDir → .staging/<id>/），返回审查记录。
 * @param source 来源锚定（市场安装：repo/ref/commit；本地发布缺省 local）
 */
export function stagePlugin(
  workspaceDir: string,
  sourceDir: string,
  owner: string,
  source?: PluginSource,
): PluginStagingRecord {
  const sourceManifest = loadManifestFromDir(sourceDir);
  const root = pluginsRoot(workspaceDir);
  const stagingRoot = path.join(root, STAGING_DIR);
  fs.mkdirSync(stagingRoot, { recursive: true });

  const id = `${sourceManifest.name}-${Date.now().toString(36)}`;
  const stagedDir = path.join(stagingRoot, id);
  copyPluginDir(sourceDir, stagedDir);

  // 重要：重读暂存 manifest（copy 后的真相源）；若声明 ui 则先构建产物再计算哈希，
  // 保证 hash 覆盖源码 + ui/dist 构建产物（人审的是将要执行的代码）。
  const manifest = loadManifestFromDir(stagedDir);
  if (manifest.ui) buildPluginUi(stagedDir, manifest);
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
}

/** 列出全部待审查暂存记录 */
export function listStaging(workspaceDir: string): PluginStagingRecord[] {
  const stagingRoot = path.join(pluginsRoot(workspaceDir), STAGING_DIR);
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

function readStagingRecord(workspaceDir: string, id: string): PluginStagingRecord {
  if (!STAGING_ID_RE.test(id)) throw new Error(`staging id 非法: ${id}`);
  const file = path.join(pluginsRoot(workspaceDir), STAGING_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`暂存记录不存在: ${id}（可用 agentchat plugin staging 或 WebUI 待审暂存查看）`);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as PluginStagingRecord;
}

/** 读取暂存记录（HTTP 人审端点用；id 白名单校验 + 记录存在性） */
export function getStagingRecord(workspaceDir: string, id: string): PluginStagingRecord {
  return readStagingRecord(workspaceDir, id);
}

/** 拒绝暂存：删除 .staging 目录与记录；返回是否确有删除 */
export function rejectStaging(workspaceDir: string, id: string): { id: string; removedDir?: string } {
  const record = readStagingRecord(workspaceDir, id);
  const json = path.join(pluginsRoot(workspaceDir), STAGING_DIR, `${id}.json`);
  fs.rmSync(json, { force: true });
  if (fs.existsSync(record.stagedDir)) {
    fs.rmSync(record.stagedDir, { recursive: true, force: true });
    return { id, removedDir: record.stagedDir };
  }
  return { id };
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
}

/** 批准暂存并安装（同名不同版本 → 旧版本移入 .backup；同名同版本 → 拒绝）
 * @param grants 宿主显式授予的权限（process/shell 必须显式授予；fs/network 默认授予） */
export function approveStaging(workspaceDir: string, id: string, grants?: unknown): ApproveResult {
  const record = readStagingRecord(workspaceDir, id);

  // 权限边界：未授予的高危权限在安装前拒绝（记录授予快照进 registry）
  const granted: PluginPermission[] = grantPermissions(grants);
  assertPermissionsGranted(record.manifest, granted);

  const root = pluginsRoot(workspaceDir);
  fs.mkdirSync(root, { recursive: true });

  if (!fs.existsSync(record.stagedDir)) {
    throw new Error(`暂存目录已不存在: ${record.stagedDir}（请重新 stage）`);
  }
  const stagedHash = hashPluginDir(record.stagedDir);
  if (stagedHash !== record.hash) {
    throw new Error('暂存内容哈希不一致（暂存后文件被改动），拒绝安装');
  }

  const doc = readRegistry(workspaceDir);
  const existing = doc.plugins[record.manifest.name];
  if (existing && existing.manifest.version === record.manifest.version) {
    throw new Error(`插件 "${record.manifest.name}@${record.manifest.version}" 已安装（同版本拒绝重复发布）`);
  }

  const targetDir = path.join(root, record.manifest.name);
  let replaced: ApproveResult['replaced'];
  if (existing || fs.existsSync(targetDir)) {
    const oldVersion = existing?.manifest.version ?? 'unknown';
    const backupDir = path.join(root, BACKUP_DIR, `${record.manifest.name}-${oldVersion}-${Date.now().toString(36)}`);
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backupDir);
    replaced = { oldVersion, backupDir };
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.renameSync(record.stagedDir, targetDir);

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
  writeRegistry(workspaceDir, doc);

  // 清理暂存记录
  fs.rmSync(path.join(pluginsRoot(workspaceDir), STAGING_DIR, `${id}.json`), { force: true });

  return {
    name: record.manifest.name,
    version: record.manifest.version,
    manifest: record.manifest,
    permissions: granted,
    installedDir: targetDir,
    ...(replaced ? { replaced } : {}),
    hash: record.hash,
  };
}

/** 插件库已安装清单 */
export function listInstalled(workspaceDir: string): InstalledPluginRecord[] {
  const doc = readRegistry(workspaceDir);
  return Object.values(doc.plugins).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * 卸载已安装插件：registry 移除 + 目录移 .backup。
 * 不修改任何 Agent 的 config.presets（保留引用无害：顺序表/烘焙对未注册名自动跳过）。
 */
export function uninstallPlugin(workspaceDir: string, name: string): { name: string; backupDir?: string } {
  if (!INSTALLED_NAME_RE.test(name)) throw new Error(`插件名非法: ${name}`);
  const doc = readRegistry(workspaceDir);
  const record = doc.plugins[name];
  const root = pluginsRoot(workspaceDir);
  const targetDir = path.join(root, name);
  if (!record && !fs.existsSync(path.join(targetDir, 'manifest.json'))) {
    throw new Error(`插件 "${name}" 未安装`);
  }

  const version = record?.manifest.version ?? 'unknown';
  const backupDir = path.join(root, BACKUP_DIR, `${name}-${version}-${Date.now().toString(36)}`);
  if (fs.existsSync(targetDir)) {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    fs.renameSync(targetDir, backupDir);
  }

  if (record) {
    delete doc.plugins[name];
    writeRegistry(workspaceDir, doc);
  }
  return { name, ...(fs.existsSync(backupDir) ? { backupDir } : {}) };
}

// ============================================================
// staging 人审查看器（HTTP 只读代理；路径守卫 + 大小上限）
// ============================================================

/** 列出暂存目录全部文件（相对路径 posix 化，排序确定） */
export function listStagingFiles(workspaceDir: string, id: string): StagingFileInfo[] {
  const record = getStagingRecord(workspaceDir, id);
  const root = path.resolve(record.stagedDir);
  const out: StagingFileInfo[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const full = path.join(dir, entry.name);
        out.push({
          path: path.relative(root, full).split(path.sep).join('/'),
          size: fs.statSync(full).size,
        });
      }
    }
  };
  if (!fs.existsSync(root)) throw new Error(`暂存目录已不存在: ${root}`);
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 读取暂存文件内容（只读；拒绝绝对路径/.. 逃逸/目录/超大文件） */
export function readStagingFile(workspaceDir: string, id: string, rel: string): StagingFileContent {
  const record = getStagingRecord(workspaceDir, id);
  const root = path.resolve(record.stagedDir);

  const normalized = String(rel).replaceAll('\\', '/');
  if (
    normalized === ''
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((seg) => seg === '..' || seg === '')
  ) {
    throw new Error(`暂存文件路径非法（仅允许相对路径）: ${rel}`);
  }

  const full = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!full.startsWith(rootWithSep)) throw new Error(`暂存文件路径逃逸: ${rel}`);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`暂存文件不存在: ${rel}`);

  const realRoot = fs.realpathSync(root);
  const realFull = fs.realpathSync(full);
  if (!realFull.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) {
    throw new Error(`暂存文件路径逃逸（符号链接）: ${rel}`);
  }

  const size = fs.statSync(full).size;
  if (size > MAX_REVIEW_FILE_BYTES) {
    throw new Error(`文件过大（${size} 字节 > ${MAX_REVIEW_FILE_BYTES} 字节上限），请下载到本地审查`);
  }
  return { path: normalized, content: fs.readFileSync(full, 'utf-8') };
}

// ============================================================
// 启动扫描 —— 把插件库中已安装插件挂到给定 ctx
// ============================================================

/** 启动时扫描插件库并加载全部已安装插件（缺目录/损坏记录跳过不阻断启动）；
 * 复用 ctx.pluginHost（无则创建），保证与 dev 工具/HTTP 层同一装载器实例。 */
export async function loadInstalledPlugins(ctx: Context, workspaceDir: string): Promise<PluginLoadResult[]> {
  const host = getOrCreatePluginHost(ctx);
  const results: PluginLoadResult[] = [];
  for (const record of listInstalled(workspaceDir)) {
    // 幂等守卫：市场组合行可能先装载（行/扫描双路径只装一次）
    if (host.has(record.manifest.name) || host.isLoading(record.manifest.name)) continue;
    const dir = path.join(pluginsRoot(workspaceDir), record.dir);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      ctx.logger?.('plugins').warn(`已安装插件 "${record.manifest.name}" 目录缺失，跳过加载`);
      continue;
    }
    try {
      results.push(await host.load({
        manifest: record.manifest,
        dir,
        agentId: record.owner,
        sessionOnly: false,
        // 按安装时授予的权限快照恢复（registry 中的授予是宿主确认过的）
        allowedPermissions: record.permissions ?? [...DEFAULT_GRANTED_PERMISSIONS],
      }));
      ctx.logger?.('plugins').info(`插件库插件 "${record.manifest.name}@${record.manifest.version}" 已加载`);
    } catch (err: any) {
      ctx.logger?.('plugins').error(`插件库插件 "${record.manifest.name}" 加载失败: ${err?.message ?? String(err)}`);
    }
  }
  return results;
}
