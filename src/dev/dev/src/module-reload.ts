// ============================================================
// @agentchat/dev/src/module-reload.ts —— L1.5 主动模块重载
//
// 设计（docs/restart-design.md §2）：
//   · 何时重载 —— 写者宣告：agent 调 reload_modules 工具（requires dev）；
//   · 重载什么 —— 机械发现：水位线扫描 + loadCache 求交，不信任自报清单
//     （bash sed/heredoc/git checkout/格式化器触碰的文件集对 agent 不透明，
//      自报会漏报或多报；显式 files 只是扫描结果的补充，取并集）。
//
// 链路：工具发现变更 → ToolInterrupt(scope='modules', files)
//   → loop resolveInterrupt → 装配层 interruptHandler（agents/config.ts）
//   → assembly.reloadModules(files)（先 ctx.hmr.reloadFiles 后 resolveTools
//      重新烘焙）→ continue + patch → 本 run 下一 step 用新闭包。
//
// 失败语义：重导入失败 → hmr 双缓存回滚旧模块 → 旧树继续跑 → 续跑消息
// 反馈错误（agent 可修复后重试）。框架/内核文件（externals）不可重载，
// 命中即拒绝并提示走 system_restart（进程重启）。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { defineTool, workspaceRoot } from '@agentchat/toolkit';
import { ToolInterrupt } from '@agentchat/agent-loop';
import { CAPABILITY_DEV, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';

/**
 * HMR 服务的最小结构面（vendored @agentchat/cordis-hmr 的公开子集）。
 * 结构化契约而非包依赖：dev 包保持领域独立，boot/组合路径注入真实实例。
 */
export interface ModuleReloadHmr {
  /** 水位线（epoch ms）：mtime ≥ 此值的文件视为已变更；初始化 = 进程启动 */
  readonly watermark: number;
  /** 是否框架/内核文件（externals——进程内不可重载，只能 42 重启） */
  isExternal(url: string): boolean;
  /** 是否已加载模块（ESM loadCache 命中；只关心已加载模块） */
  isLoaded(url: string): boolean;
}

/** 扫描时跳过的目录（依赖/构建产物/测试/前端——与 fs-search 遍历口径一致） */
const SCAN_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'coverage', '.git',
  'tests', 'test', '__tests__', 'workspace',
]);

/** 参与扫描的源码扩展名（isLoaded 交集是权威过滤，这里只是减少噪音） */
const SCAN_EXTS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** 深度优先扫描源码根：mtime ≥ since 的文件（绝对路径） */
export function scanChangedFiles(roots: string[], since: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        // src/ui 是前端（vite 构建），后端模块不经 loadCache
        if (depth === 0 && ent.name === 'ui') continue;
        walk(full, depth + 1);
      } else if (ent.isFile() && SCAN_EXTS.test(ent.name)) {
        try {
          if (fs.statSync(full).mtimeMs >= since) out.push(full);
        } catch { /* 文件刚好被删——忽略 */ }
      }
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root)) walk(root, 0);
  }
  return out;
}

/** 变更集发现计划（§2.3 流程第 1–3 步的纯函数形态） */
export interface ModuleReloadPlan {
  /** 应重载的已加载模块 file:// URL（扫描变更 ∩ loadCache ∪ 显式已加载） */
  targets: string[];
  /** 命中的框架/内核文件（externals）——拒绝重载，提示走 system_restart */
  framework: string[];
  /** 显式指定但未加载的文件（新文件经父模块重导入自然生效，信息性提示） */
  unloaded: string[];
  /** 本次扫描使用的水位线（epoch ms） */
  watermark: number;
}

/** 归一化显式文件参数（绝对/相对路径或 file:// URL）→ file:// URL */
function toFileUrl(input: string, projectRoot: string): string {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) return s;
  return pathToFileURL(path.resolve(projectRoot, s)).href;
}

/**
 * 变更集发现：扫描源码根（<projectRoot>/src）→ 映射 file:// URL →
 * 与 loadCache 求交（isLoaded）→ externals 分类；显式 files 取并集。
 */
export function planModuleReload(
  hmr: ModuleReloadHmr,
  projectRoot: string,
  explicitFiles?: unknown,
): ModuleReloadPlan {
  const watermark = hmr.watermark;
  const scanned = scanChangedFiles([path.join(projectRoot, 'src')], watermark);
  const explicit = new Set<string>();
  for (const f of Array.isArray(explicitFiles) ? explicitFiles : []) {
    const url = toFileUrl(f as string, projectRoot);
    if (url) explicit.add(url);
  }

  const targets = new Set<string>();
  const framework = new Set<string>();
  const unloaded = new Set<string>();

  // 扫描结果：只关心已加载模块；未加载的变更（测试/新文件）静默跳过
  for (const file of scanned) {
    const url = pathToFileURL(file).href;
    if (hmr.isExternal(url)) framework.add(url);
    else if (hmr.isLoaded(url)) targets.add(url);
  }
  // 显式补充：取并集；未加载的显式文件单独反馈（新文件无需单独处理——
  // 父模块缓存清除后重导入自然拉取最新，§2.3）
  for (const url of explicit) {
    if (hmr.isExternal(url)) framework.add(url);
    else if (hmr.isLoaded(url)) targets.add(url);
    else unloaded.add(url);
  }

  return {
    targets: [...targets],
    framework: [...framework],
    unloaded: [...unloaded],
    watermark,
  };
}

/** URL → 可读相对路径（消息/日志用） */
function displayPath(url: string, projectRoot: string): string {
  try {
    return path.relative(projectRoot, fileURLToPath(url)).split(path.sep).join('/');
  } catch {
    return url;
  }
}

/** 项目根：workspaceRoot 上两级（workspace/default → workspace → 项目根；与 fs-search 项目根口径一致） */
export function moduleReloadProjectRoot(): string {
  return path.dirname(path.dirname(workspaceRoot()));
}

/**
 * reload_modules 工具（requires dev）：宣告源码修改完成 → 水位线发现 →
 * 语义化中断（scope='modules'）。真正执行重载的是装配层中断处理器
 * （先模块后烘焙），本工具只做发现与宣告。
 *
 * @param getHmr 惰性取 HMR 服务（组合树行序不定，执行期再取；缺省 = 不可用）
 * @param projectRoot 扫描锚定的项目根（缺省 = workspaceRoot 上两级；测试/嵌入可覆写）
 */
export function makeReloadModulesTool(
  getHmr: () => ModuleReloadHmr | undefined,
  _config: AgentConfig,
  projectRoot?: string,
): Tool {
  return defineTool({
    name: 'reload_modules', label: '热重载模块', requires: [CAPABILITY_DEV],
    description: '修改后端源码后热重载模块（无需重启进程）。框架/内核文件改动需用 system_restart。',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array', items: { type: 'string' },
          description: '显式指定要重载的文件（通常留空，自动扫描变更）',
        },
        reason: { type: 'string', description: '重载原因（记入日志）' },
      },
    },
    extractLabel: (args) => {
      const files = Array.isArray(args.files) ? (args.files as unknown[]).length : 0;
      return files ? `热重载模块 +${files}` : '热重载模块';
    },
    execute: async (args) => {
      const hmr = getHmr();
      if (!hmr) {
        return JSON.stringify({
          status: 'error',
          data: {
            message: '模块热重载不可用：需要 Loader 组合路径（hmr 行）+ --expose-internals 启动。'
              + '当前环境源码变更只能经 system_restart 进程重启生效。',
          },
        });
      }
      const root = projectRoot ?? moduleReloadProjectRoot();
      const plan = planModuleReload(hmr, root, args.files);

      // 框架/内核文件命中 → 拒绝并导向进程重启（§2.3 步骤 3）
      if (plan.framework.length > 0) {
        const names = plan.framework.slice(0, 5).map((u) => displayPath(u, root)).join('、');
        return JSON.stringify({
          status: 'error',
          data: {
            message: `拒绝重载：命中框架/内核文件（${plan.framework.length} 个：${names}${plan.framework.length > 5 ? '…' : ''}）。`
              + 'externals 不能进程内重载，请改用 system_restart（进程重启）。',
          },
        });
      }

      // 无可重载目标：静默成功（水位线之后无已加载模块的源码变更）
      if (plan.targets.length === 0) {
        return JSON.stringify({
          status: 'ok',
          data: {
            message: `未发现需要重载的模块变更（水位线 ${new Date(plan.watermark).toISOString()} 之后无已加载模块的源码改动）`
              + (plan.unloaded.length > 0
                ? `；显式指定的文件未加载（${plan.unloaded.slice(0, 3).map((u) => displayPath(u, root)).join('、')}），新文件经父模块重导入自然生效`
                : ''),
            reloaded: [],
          },
        });
      }

      // 宣告完成 → 语义化中断：装配层执行「先模块后烘焙」，本 run 下一 step 生效
      throw new ToolInterrupt({
        type: 'reload-requested', scope: 'modules', files: plan.targets,
      });
    },
  });
}
