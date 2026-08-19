// ============================================================
// @agentchat/boot/src/composition.ts —— DSH 形态组合引擎
//
// 空 root + 补丁栈：cordis.yml 每次启动重写为 []（防 Loader 写回把
// 组合结果烤进文件），整棵插件树由补丁层按序叠出：
//
//   bundle 基座层（composition.base.yml，随宿主发布）
//     ← bundle 表面层（composition.web-app.yml 等，按 profile 组栈）
//       ← profile 用户层（<profileDir>/cordis.patch.yml，本地差异/gitignore）
//         ← 机器层（$AGENTCHAT_HOME|~/.agentchat/cordis.patch.yml，跨 profile 偏好）
//           ← --patch 覆盖（CLI，argv 顺序）
//
// 补丁语义 = vendored include 的 applyEntryPatches：insert 追加行 /
// 按 id 覆盖（config 整行替换不合并）/ disable。行序无激活语义。
//
// 用户层/机器层支持热生效：文件变化 → 重组合 → include.refresh()
// （对 base 数据重新应用新补丁栈，Loader 事务性增删行）。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { Context } from '@agentchat/cordis';
import type { Loader } from '@agentchat/cordis-loader';
import { workspaceRoot as toolkitWorkspaceRoot } from '@agentchat/toolkit';
import { applyEntryPatches, entryListSchema, type Include, type PatchOptions } from '@agentchat/cordis-include';

export { type PatchOptions };

/** 空根内容：每次启动重写（ Loader 的 tree 写回可能把组合行烤进来，重置是防线） */
export const EMPTY_ROOT_CONTENT = [
  '# AgentChat profile root — 空条目表。组合在补丁层完成：',
  '#   bundle: composition.base.yml + 表面层（可用 profile: base / web-app）',
  '#   ← 用户层: cordis.patch.yml（本目录）',
  '#   ← 机器层: $AGENTCHAT_HOME/cordis.patch.yml',
  '#   ← 覆盖: agentchat dev --patch <file.yml>',
  '# 本文件每次启动都会被重写。请编辑补丁层，不要在此堆行。',
  '[]',
  '',
].join('\n');

export const ROOT_FILENAME = 'cordis.yml';
export const PATCH_FILENAME = 'cordis.patch.yml';
/** 基座 bundle 补丁（随 @agentchat/boot 源码走，src/lib 双布局兼容） */
export const BUNDLE_PATCH_FILE = fileURLToPath(new URL('./composition.base.yml', import.meta.url));

/**
 * 组合 profile：决定 base 之上叠加哪些表面 bundle。
 * - base：仅基座（无表面行——不 boot HTTP 服务器）
 * - web-app：+ WebUI 表面（webui 行 + boot-finalize enableWebUI）
 * 后续 tui/headless 各自扩展（落地时才加文件，不预建）。
 */
export type BundleProfile = 'base' | 'web-app';

/** 各 profile 的 bundle 补丁文件栈（叠序即数组序；base 恒在最底） */
export const BUNDLE_PATCH_FILES: Readonly<Record<BundleProfile, readonly string[]>> = {
  base: [BUNDLE_PATCH_FILE],
  'web-app': [
    BUNDLE_PATCH_FILE,
    fileURLToPath(new URL('./composition.web-app.yml', import.meta.url)),
  ],
};

export function isBundleProfile(value: string): value is BundleProfile {
  return value === 'base' || value === 'web-app';
}

/** 机器级偏好目录（DSH $DSH_HOME 对应物） */
export function agentchatHome(): string {
  return process.env.AGENTCHAT_HOME || path.join(osHome(), '.agentchat');
}

function osHome(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

/** 读取一个补丁层文件；不存在/为空返回 undefined；非法结构抛错（fail loud） */
export function loadPatchLayer(file: string, label: string): PatchOptions[] | undefined {
  if (!fs.existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA });
  } catch (err: any) {
    throw new Error(`补丁层 ${label} 解析失败（${file}）: ${err?.message ?? String(err)}`);
  }
  if (raw === null || raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`补丁层 ${label} 必须是补丁数组（${file}）`);
  }
  return raw as PatchOptions[];
}

export interface ComposeOptions {
  /** profile 目录（root cordis.yml 与用户补丁层所在；缺省 cwd） */
  profileDir?: string;
  /** 基座 bundle 补丁文件（显式指定 = 替换整个 bundle 栈，不叠表面层；测试用） */
  bundleFile?: string;
  /** 组合 profile：决定 base 之上叠加哪个表面 bundle（缺省 base；bundleFile 存在时忽略） */
  profile?: BundleProfile;
  /** 机器层目录（缺省 agentchatHome()；传 null 跳过） */
  homeDir?: string | null;
  /** CLI --patch 覆盖（argv 顺序） */
  overlays?: string[];
  /** 跳过用户层（--dump-config 场景） */
  skipUserLayer?: boolean;
  /**
   * 工作区目录（market 动态层的数据源；null = 不生成市场行）。
   * 缺省按 AGENTCHAT_WORKSPACE / workspace/default 解析（同 market.ts）。
   */
  marketDir?: string | null;
}

export interface ComposedStack {
  patches: PatchOptions[];
  /** 参与组合的补丁文件（供 watch；仅存在的文件） */
  files: string[];
}

/** vendored include 的装载入口 URL（优先 lib 构建产物，回退 src；绝对路径不受 baseUrl 影响） */
export function includeEntryUrl(): string {
  const base = fileURLToPath(new URL('../../../vendor/include/', import.meta.url));
  const lib = path.resolve(base, 'lib/index.js');
  const src = path.resolve(base, 'src/index.ts');
  return pathToFileURL(fs.existsSync(lib) ? lib : src).href;
}

/** 市场桥插件入口 URL（组合行的 name 指向它；行 config.name 区分插件） */
export function marketBridgeUrl(): string {
  return pathToFileURL(path.resolve(
    fileURLToPath(new URL('../../../plugins/plugins/src/market/bridge.ts', import.meta.url)),
  )).href;
}

/**
 * market 动态层：registry 已安装插件 → 组合行（id: market/<name>）。
 * 行指向桥插件（装载走 ctx.pluginHost，权限/契约门禁不绕过）；
 * 用户层因此可按 id 定点停用/改配置市场插件——与内置行同权。
 */
export async function marketLayerRows(workspaceDir: string): Promise<PatchOptions[]> {
  const { listInstalled } = await import('@agentchat/plugins/src/registry');
  const bridge = marketBridgeUrl();
  return listInstalled(workspaceDir).map((record) => ({
    insert: [{
      id: `market/${record.manifest.name}`,
      name: bridge,
      config: { name: record.manifest.name },
    }],
  }));
}

/** 缺省 workspace（解析链单一事实源在 @agentchat/toolkit：env → cwd 已有 → 机器 home） */
function resolveDefaultWorkspaceDir(): string {
  return toolkitWorkspaceRoot();
}

/** 组装补丁栈：bundle（base → 表面）→ market 动态层 → 用户层 → 机器层 → 覆盖。不存在的层跳过。 */
export async function composeLayers(options: ComposeOptions = {}): Promise<ComposedStack> {
  const profileDir = options.profileDir ?? process.cwd();
  const files: string[] = [];

  // bundle 栈：显式 bundleFile = 整栈替换（测试迷你树，不叠表面）；
  // 否则按 profile 组栈（缺省 base）。随包发布的文件缺失 = 打包事故，fail loud。
  const bundleFiles = options.bundleFile
    ? [options.bundleFile]
    : BUNDLE_PATCH_FILES[options.profile ?? 'base'];
  const patches: PatchOptions[] = [];
  for (const file of bundleFiles) {
    if (!options.bundleFile && !fs.existsSync(file)) {
      throw new Error(`bundle 补丁文件缺失（打包事故？）: ${file}`);
    }
    const layer = loadPatchLayer(file, `bundle(${path.basename(file, '.yml')})`);
    if (layer) { patches.push(...layer); files.push(file); }
  }

  if (options.marketDir !== null) {
    const rows = await marketLayerRows(options.marketDir ?? resolveDefaultWorkspaceDir());
    patches.push(...rows);
  }

  if (!options.skipUserLayer) {
    const userFile = path.join(profileDir, PATCH_FILENAME);
    const user = loadPatchLayer(userFile, 'profile 用户层');
    if (user) { patches.push(...user); files.push(userFile); }
  }

  if (options.homeDir !== null) {
    const homeFile = path.join(options.homeDir ?? agentchatHome(), PATCH_FILENAME);
    const home = loadPatchLayer(homeFile, '机器层');
    if (home) { patches.push(...home); files.push(homeFile); }
  }

  for (const overlay of options.overlays ?? []) {
    const resolved = path.resolve(process.cwd(), overlay);
    const layer = loadPatchLayer(resolved, `--patch ${overlay}`);
    if (layer) { patches.push(...layer); files.push(resolved); }
  }

  return { patches, files };
}

/** 重写 profile root 为空表（返回 root 文件绝对路径） */
export function prepareProfileRoot(profileDir: string): string {
  const root = path.join(profileDir, ROOT_FILENAME);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.writeFileSync(root, EMPTY_ROOT_CONTENT, 'utf8');
  return root;
}

export interface BootComposedOptions extends ComposeOptions {
  /** root Context 预备钩子（provide 启动环境等；DSH launch-environment 对应物） */
  onContext?: (ctx: Context) => void | Promise<void>;
  /** Loader/include 日志 */
  enableLogs?: boolean;
}

export interface BootedComposition {
  ctx: Context;
  include: Include;
  /** 热重载：按新栈重组合并应用（watch 回调用） */
  reapply: (patches: PatchOptions[]) => Promise<void>;
}

/**
 * 启动组合树：空 root 重写 → Loader → include(path=root, patches=栈)。
 * 返回的 reapply 供补丁文件 watch 后热生效（include.refresh 对 base 数据
 * 重新应用新补丁栈，Loader 事务性增删/启停行）。
 */
export async function bootComposed(options: BootComposedOptions = {}): Promise<BootedComposition> {
  const profileDir = options.profileDir ?? process.cwd();
  const root = prepareProfileRoot(profileDir);
  const { patches } = await composeLayers(options);

  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(profileDir).href + '/';
  await options.onContext?.(ctx);

  const loaderModule = await import('@agentchat/cordis-loader');
  await ctx.plugin((loaderModule as { default: unknown }).default as any);
  // include 行用绝对文件 URL：loader 对行 name 的解析锚点是 ctx.baseUrl
  // （= profileDir），临时/任意 profile 目录下裸包名解析不到 node_modules。
  await (ctx.loader as Loader).create({
    name: includeEntryUrl(),
    config: { path: './' + ROOT_FILENAME, patches, enableLogs: options.enableLogs ?? false },
  });

  const include = findInclude(ctx);
  if (!include) throw new Error('include 树未创建（组合引导失败）');

  // 热重组合：base 数据恒为空 root（[]），直接用导出的 applyEntryPatches
  // 纯函数算出目标树再走公开的 root.update（Loader 事务性增删/启停行）。
  // 不用 include.refresh()：root 内容不变时它的 read() 短路为 noop。
  // 不用 internal/update 事件：其 handler 的 enqueue 语义等价于本实现。
  const reapply = async (next: PatchOptions[]) => {
    const data = applyEntryPatches([], next, (message, ...args) => {
      ctx.root.logger?.('loader').warn(message, ...args);
    });
    await include.root.update(data);
    include.config = { ...include.config, patches: next };
  };

  return { ctx, include, reapply };
}

/** 在 loader 条目树中定位 include 子树 */
export function findInclude(ctx: Context): Include | undefined {
  const loader = (ctx as { loader?: Loader }).loader;
  for (const entry of loader?.entries() ?? []) {
    const tree = entry.subtree as Include | undefined;
    if (tree && 'refresh' in tree && 'filename' in tree) return tree;
  }
  return undefined;
}

/** dump 模式：default = 当前 profile 的宿主出厂态（bundle+market）；full = 全栈（含用户/机器/覆盖） */
export type DumpMode = 'default' | 'full';

/**
 * 离线打印有效组合（DSH --dump-config 对应物）：补丁栈叠在空根上，
 * 结果经 include 的 entryListSchema 序列化（!!js 表达式往返无损）。
 * 不 boot、不触网、不读运行态——所见即所启。
 */
export async function dumpComposedYaml(options: ComposeOptions & { mode: DumpMode }): Promise<string> {
  const composed = await composeLayers(
    options.mode === 'default'
      ? { ...options, skipUserLayer: true, homeDir: null, overlays: [] }
      : options,
  );
  const data = applyEntryPatches([], composed.patches, () => {});
  return yaml.dump(data, { schema: entryListSchema });
}

/**
 * 监视补丁层文件并热重组合（目录级 watch，文件可后建）。
 * @returns 停止函数
 */
export function watchPatchLayers(
  files: string[],
  onChange: () => void,
  debounceMs = 300,
): () => void {
  const dirs = new Set(files.map((f) => path.dirname(f)));
  const names = new Set(files.map((f) => path.basename(f)));
  let timer: NodeJS.Timeout | undefined;
  const disposers: Array<() => void> = [];

  const trigger = (file: string) => {
    if (!names.has(path.basename(file))) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  for (const dir of dirs) {
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (filename) trigger(filename.toString());
      });
      disposers.push(() => watcher.close());
    } catch { /* 目录不存在（如尚未创建的 home）——跳过 */
    }
  }
  return () => {
    clearTimeout(timer);
    for (const dispose of disposers) dispose();
  };
}
