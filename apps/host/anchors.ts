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

/**
 * 出厂通道播种（bundle 形态）：dist/plugins → <dataRoot>/plugins 一次性拷贝。
 *
 * 语义：
 *   · 指纹戳（.factory-stamp.json 记 version + 出厂目录名集）幂等——同代跳过；
 *   · 只动出厂名册内的目录（同名覆盖 = 出厂赢，与行集合并「保留字护栏」同语义）；
 *     用户自装目录（名册外）零触碰；
 *   · 播种失败 warn 不炸 boot（通道缺席 = 前端降级，核心 RPC 面不受影响），
 *     戳不写——下次 boot 重试。
 */
export function seedFactoryPlugins(
  dataRoot: string,
  anchors: HostAnchors = resolveAnchors(path.dirname(fileURLToPathSafe())),
): void {
  const src = anchors.factoryPluginsDir;
  if (src === null) return; // 仓库形态：无播种面
  try {
    let names: string[] = [];
    try { names = fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return; /* 安装根无 plugins——无播种面 */ }
    if (names.length === 0) return;
    let version = 'unknown';
    try {
      version = String(JSON.parse(fs.readFileSync(path.join(anchors.home ?? src, 'version.json'), 'utf-8')).version ?? 'unknown');
    } catch { /* version.json 缺席——用 unknown 档 */ }
    const dest = path.join(dataRoot, 'plugins');
    const stampPath = path.join(dest, '.factory-stamp.json');
    const sig = JSON.stringify({ version, names: [...names].sort() });
    try {
      const prev = fs.readFileSync(stampPath, 'utf-8');
      if (JSON.parse(prev).sig === sig) return; // 同代已播种
    } catch { /* 无戳/坏戳——重播 */ }
    fs.mkdirSync(dest, { recursive: true });
    for (const name of names) {
      const target = path.join(dest, name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(path.join(src, name), target, { recursive: true });
    }
    fs.writeFileSync(stampPath, JSON.stringify({ sig }, null, 2) + '\n', 'utf-8');
    process.stderr.write('[host] 出厂通道播种 ' + names.length + ' 个 → ' + dest + '\n');
  } catch (err) {
    process.stderr.write('[host] 出厂通道播种失败（通道面降级，RPC 不受影响）：' + String(err) + '\n');
  }
}

// import.meta.url 的安全取值（测试替身经 cwd 注入时仍以本模块真身定位缺省基点）
function fileURLToPathSafe(): string {
  return import.meta.url;
}
// 注：seedFactoryPlugins 缺省 anchors 参数在 bundle 内解析正确（import.meta.url
// 指向 dist/agentchat.mjs），但显式传参是唯一受支持形态——boot.ts 接线即如此。
