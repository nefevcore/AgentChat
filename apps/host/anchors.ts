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
      ?? (home !== null ? path.join(home, 'shell.mjs') : path.resolve(here, '../shell/boot.ts')),
    factoryPluginsDir: home !== null ? path.join(home, 'plugins') : null,
  };
}

// import.meta.url 的安全取值（测试替身经 cwd 注入时仍以本模块真身定位缺省基点）
function fileURLToPathSafe(): string {
  return import.meta.url;
}
// 注：seedFactoryPlugins 缺省 anchors 参数在 bundle 内解析正确（import.meta.url
// 指向 dist/agentchat.mjs），但显式传参是唯一受支持形态——boot.ts 接线即如此。
