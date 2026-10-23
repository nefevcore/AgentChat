// ============================================================
// manifest.ts —— 插件 client 通道（M7.4；R7-9 框架面代码化）
//
// 裁决簿〈插件 client 通道〉：用户插件完全自定义 UI = 主线能力；
// 项目 ui 行同走此通道——唯一通道，不为第一方开特权路径（cr-474）。
// 机制骨架：client 半边 = manifest 数据声明（entry/platform/席位
// 贡献拓扑），第三方零宿主代码（S2：注入 = plugin-registry 读 manifest
// 数据进 boot graph，非执行第三方 apply）；资产静态服务
//（/ui-plugin/:name/*）；安装/卸载 = manifest 出现/消失 → 前端
// boot graph diff 热装载。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 席位贡献（ui 树装配拓扑——layout 拓扑契约的消费面词汇） */
export interface SeatContribution {
  /** 席位名（tool-card / dock / settings 节等——开放词汇） */
  seat: string;
  /** 席位内定位（可选——骨架拓扑契约细节） */
  slot?: string;
}

/** manifest.ui schema（数据声明——与主线 PluginUiManifest 同语义） */
export interface UiManifest {
  name: string;
  version: string;
  /** 入口相对路径（模块根内） */
  entry: string;
  /** 平台（当前仅 web；缺省 web） */
  platform?: 'web';
  /** 席位贡献拓扑（③级挂拓扑的最小面——新席位声明归骨架层） */
  seats?: SeatContribution[];
  /** 隔离装载（isolated runtime——第三方默认 true） */
  isolated?: boolean;
  /** 样式表相对路径列 */
  styles?: string[];
  /**
   * 需共享基座解析的说明符清单（裸包名或子路径——8.5c 深路径扩展；
   * isolated:false 的第一方模块资产用）。通道模块 bundle 外部化这些
   * 说明符——装载时由宿主注入同构实例（单例契约：pinia store /
   * cordis Context / 席位注册表 / toast 全局栈全树唯一）。
   * 清单 = 构建面外部化与装载面注入的同一份单源。
   */
  channelImports?: string[];
}

/** 校验结果（warnings 非空 = fail-loud——行集静态断言同风格） */
export interface ManifestCheck {
  ok: boolean;
  warnings: string[];
}

/**
 * manifest 校验（纯函数）：形状 + 路径安全（entry/styles 相对路径
 * 不逃逸模块根）。第三方代码零宿主执行——校验纯数据。
 */
export function checkUiManifest(m: unknown): ManifestCheck {
  const warnings: string[] = [];
  if (m === null || typeof m !== 'object') return { ok: false, warnings: ['manifest 非对象'] };
  const x = m as Record<string, unknown>;
  if (typeof x.name !== 'string' || x.name.length === 0) warnings.push('name 缺失或空');
  else if (!/^[a-z0-9-]+$/.test(x.name)) warnings.push('name 词汇非法（小写字母/数字/连字符）：' + x.name);
  if (typeof x.version !== 'string' || x.version.length === 0) warnings.push('version 缺失或空');
  if (x.entry !== undefined && typeof x.entry !== 'string') warnings.push('entry 非字符串');
  if (x.platform !== undefined && x.platform !== 'web') warnings.push('platform 仅支持 web');
  if (x.seats !== undefined) {
    if (!Array.isArray(x.seats)) warnings.push('seats 非数组');
    else for (const s of x.seats) {
      if (s === null || typeof s !== 'object' || typeof (s as Record<string, unknown>).seat !== 'string' || (s as Record<string, unknown>).seat === '') {
        warnings.push('seats[].seat 缺失或空');
      }
    }
  }
  if (x.isolated !== undefined && typeof x.isolated !== 'boolean') warnings.push('isolated 非布尔');
  if (x.channelImports !== undefined) {
    if (!Array.isArray(x.channelImports)) warnings.push('channelImports 非数组');
    else for (const ci of x.channelImports) {
      if (typeof ci !== 'string' || ci.length === 0) warnings.push('channelImports[] 非空字符串缺失');
      else if (ci.startsWith('.') || ci.includes('\\') || path.isAbsolute(ci)) warnings.push('channelImports[] 须为裸包名或子路径说明符（非相对/绝对路径）：' + ci);
      else if (ci.split('/').includes('..')) warnings.push('channelImports[] 路径逃逸：' + ci);
    }
  }
  if (x.styles !== undefined) {
    if (!Array.isArray(x.styles)) warnings.push('styles 非数组');
    else for (const st of x.styles) {
      if (typeof st !== 'string') warnings.push('styles[] 非字符串');
      else if (isAbsoluteOrEscape(st)) warnings.push('styles[] 路径逃逸：' + st);
    }
  }
  if (typeof x.entry === 'string' && isAbsoluteOrEscape(x.entry)) warnings.push('entry 路径逃逸：' + x.entry);
  return { ok: warnings.length === 0, warnings };
}

function isAbsoluteOrEscape(rel: string): boolean {
  return path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..');
}

// —— boot graph 组装（宿主行集内 ui 声明 → graph 下发） ——

/** boot graph 条目（前端装载清单——ui 树行集清单） */
export interface BootGraphEntry {
  name: string;
  version: string;
  /** 平台（当前仅 web） */
  platform: 'web';
  /** 资产基址（/ui-plugin/<name>/） */
  base: string;
  entry: string;
  styles: string[];
  seats: SeatContribution[];
  isolated: boolean;
  /** 共享基座裸包名清单（manifest 原样平移；空数组 = 无） */
  channelImports: string[];
}

/**
 * 组装 boot graph（宿主侧）：扫插件目录列（manifest.json 逐个校验
 * ——坏 manifest fail-loud 跳过并记 warning），产出前端装载清单。
 * graph 变更 = 通知帧（前端重拉 diff——安装/卸载语义）。
 */
export function assembleBootGraph(pluginsDir: string): { graph: BootGraphEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const graph: BootGraphEntry[] = [];
  let entries: fs.Dirent[];
  try {
    // 通道源 = 非隐藏目录（插件库的 .staging/.backup 是宿主内部状态，
    // 不是客户端通道面——cr-543：未审暂存绝不下发浏览器）
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch {
    return { graph, warnings };
  }
  for (const e of entries) {
    const dir = path.join(pluginsDir, e.name);
    const mfile = path.join(dir, 'manifest.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(mfile, 'utf-8'));
    } catch {
      warnings.push('插件 ' + e.name + ' manifest 缺席或坏 JSON——跳过');
      continue;
    }
    const check = checkUiManifest(parsed);
    if (!check.ok) {
      warnings.push('插件 ' + e.name + ' manifest 校验失败：' + check.warnings.join('；'));
      continue;
    }
    const m = parsed as UiManifest;
    graph.push({
      name: m.name,
      version: m.version,
      platform: m.platform ?? 'web',
      base: '/ui-plugin/' + m.name + '/',
      entry: m.entry,
      styles: m.styles ?? [],
      seats: m.seats ?? [],
      isolated: m.isolated ?? true,
      channelImports: m.channelImports ?? [],
    });
  }
  return { graph, warnings };
}

// —— 静态服务（/ui-plugin/:name/*——主线 service.ts serveUiAsset 语义平移） ——

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * 静态资产解析（纯函数）：/ui-plugin/<name>/<rel> → 插件目录内文件
 * 路径 + content-type；未知名/路径逃逸/不存在 → null（404/403 语义）。
 */
export function resolveUiAsset(
  pluginsDir: string,
  name: string,
  rel: string,
): { file: string; contentType: string } | null {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const root = path.resolve(pluginsDir, name);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null; // 逃逸
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { file: full, contentType: CONTENT_TYPES[path.extname(full)] ?? 'application/octet-stream' };
}
