// ============================================================
// anchors.ts —— 运行时资产锚（cr-702 发布链换轨）
//
// 两种形态单源解析：
//   · bundle（发布产物）：AGENTCHAT_HOME env 指向 dist 安装根——
//     row-catalog.json / templates/ / plugins/ / webui 静态面 / shell.mjs
//     全在该根下（build-bundle.mjs 产物布局）；
//   · 仓库（dev/测试）：各资产按源码树相对定位（本文件目录为基点）。
//
// env 显式覆盖（AGENTCHAT_CATALOG/TEMPLATES/STATIC/SHELL_BOOT）优先于
// 两形态缺省——诊断/定制部署通道。
//
// dev 壳 bundle 偏好（cr-961 冷启 IO 治本）：仓库形态下 dist/shell.mjs
//（pnpm build:shell 产物）在场且指纹新鲜 → 优先于源码直载（1904 文件
// 装载 → 1 文件）；任何输入源码漂移（mtime/size 对拍失配）→ 回落源码。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HostAnchors {
  /** bundle 安装根（AGENTCHAT_HOME）；仓库形态 = null */
  home: string | null;
  /** 行集目录（宿主/壳共享） */
  catalogFile: string;
  /** 内置 Agent 模板配置集目录 */
  templatesDir: string;
  /** webui 静态面目录（index.html 所在） */
  staticDir: string;
  /** 壳 boot 入口（宿主 spawn 壳的 bootFile——.ts 仓库 / .mjs bundle） */
  shellBoot: string;
  /** 出厂通道产物目录（bundle 形态播种源）；仓库形态 = null（plugins 归开发者自建） */
  factoryPluginsDir: string | null;
}

/**
 * dev 壳 bundle 解析（cr-961）：dist/shell.mjs + 指纹旁车在场且全部输入
 * mtime/size 对拍一致 → bundle 路径；旁车缺席/失配/任何 stat 失败 → null
 *（回落源码直载——dev 改码后无需重建即自动回源，产物只在显式
 * pnpm build:shell 后生效）。enabled 注入面：测试环境恒 false（源码形态
 * 确定性——与 AGENTCHAT_EXE 的 VITEST 惯例同源）。
 */
export function devShellBundle(here: string, enabled: boolean = process.env.VITEST === undefined): string | null {
  if (!enabled) return null;
  const repoRoot = path.resolve(here, '../..');
  const bundle = path.join(repoRoot, 'dist', 'shell.mjs');
  const sidecar = path.join(repoRoot, 'dist', 'shell.bundle.json');
  try {
    if (!fs.existsSync(bundle)) return null;
    const stamp = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as { version?: unknown; entries?: unknown };
    if (stamp.version !== 1 || !Array.isArray(stamp.entries)) return null;
    for (const e of stamp.entries as Array<[string, number, number]>) {
      const st = fs.statSync(path.join(repoRoot, e[0]!)); // 失配/缺席 → throw → 回落
      if (st.mtimeMs !== e[1] || st.size !== e[2]) return null;
    }
    return bundle;
  } catch {
    return null;
  }
}

export function resolveAnchors(here: string): HostAnchors {
  const homeEnv = process.env.AGENTCHAT_HOME;
  const home = homeEnv !== undefined && homeEnv !== '' ? path.resolve(homeEnv) : null;
  return {
    home,
    catalogFile: process.env.AGENTCHAT_CATALOG
      ?? (home !== null ? path.join(home, 'row-catalog.json') : path.resolve(here, '../catalog/row-catalog.json')),
    templatesDir: process.env.AGENTCHAT_TEMPLATES
      ?? (home !== null ? path.join(home, 'templates') : path.resolve(here, '../../packages/ac-host-rows/templates')),
    staticDir: process.env.AGENTCHAT_STATIC
      ?? (home !== null ? path.join(home, 'webui') : path.resolve(here, '../ui/dist')),
    shellBoot: process.env.AGENTCHAT_SHELL_BOOT
      ?? (home !== null ? path.join(home, 'shell.mjs') : devShellBundle(here) ?? path.resolve(here, '../shell/boot.ts')),
    factoryPluginsDir: home !== null ? path.join(home, 'plugins') : null,
  };
}

// import.meta.url 的安全取值（测试替身经 cwd 注入时仍以本模块真身定位缺省基点）
function fileURLToPathSafe(): string {
  return import.meta.url;
}
// 注：seedFactoryPlugins 缺省 anchors 参数在 bundle 内解析正确（import.meta.url
// 指向 dist/agentchat.mjs），但显式传参是唯一受支持形态——boot.ts 接线即如此。
