// ============================================================
// webui-graph.ts —— webui-v3 wire 注册面（cr-926 切片①；设计源 docs/design/webui-v3.md §4.2/§4.3.2）
//
// graph 锚 = 宿主活装配态（裁决一）：cordis internal/plugin 事件（fiber
// 构造/销毁）把 entry name 打进脏集，microtask flush 对账该名字在
// loader 已装载 entries 里的活态（fiber 在场且未停用 = 图成员）。激活趟
// 与稳态同一实现：构造时种入树内全部 entry 名同步 flush，此后增量。
// 装载/卸载/停用的瞬间 wire 跟着变——一致性由构造保证，零签名/播种。
//
// 纯合成面（声明校验/撞名/种子对拍/拓扑/rev）住 ac-webui-core wire.ts；
// 本文件只承担宿主侧：fiber 事件时序、loader 内部表读取、包定位
//（entry 名 → 模块 URL → 最近祖先 package.json——装载解析链同源）、
// ac.faces.web + client/dist/manifest.json 读取。
//
// 降级语义（§4.2）：解析失败/校验违例 = 警告 + 跳过 + warnings 域上报；
// 出厂行 fail-loud 分类随 webui 基座文档接线落位（本面先统一警告档）。
// ============================================================
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Context } from '@agentchat/cordis';
import type { Entry, EntryTree } from '@agentchat/cordis-loader';
import { checkWebFace, synthesizeWire, type Wire, type WireRowInput } from 'ac-webui-core';

/** 裸包名行说明符（@scope/name 或 name；子路径/路径/协议形 = null） */
function exactPackageSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined;
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined;
}

interface InternalResolver {
  version: 'v1' | 'v2';
  resolveSync: (...args: any[]) => { url: string };
}

/** 模块 URL → 最近祖先 package.json（名字须匹配期望包名——防嵌套误认） */
function nearestPackage(moduleUrl: string, expected: string | undefined): { path: string; packageName: string } | undefined {
  if (!moduleUrl.startsWith('file:')) return undefined;
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const name = JSON.parse(readFileSync(candidate, 'utf8')).name;
        if (typeof name === 'string' && (expected === undefined || name === expected)) {
          return { path: candidate, packageName: name };
        }
      } catch { /* 损坏 manifest 继续上溯 */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * 行名 → 包 manifest 定位（DSH locatePkgJson 同构）：装载解析链同源——
 * 优先 Node internal resolveSync（含 ESM hooks），无 internal 落
 * createRequire / URL 直推。定位失败 = undefined（非 web 行或不可解析）。
 */
export function locatePkgJson(
  loaderName: string,
  baseUrl: string,
  internal: InternalResolver | undefined,
): { path: string; packageName: string } | undefined {
  if (loaderName.startsWith('cordis:')) return undefined;
  const pathLike = loaderName.startsWith('.') || loaderName.startsWith('file:') || isAbsolute(loaderName);
  const expected = pathLike ? undefined : exactPackageSpecifier(loaderName);
  if (!pathLike && expected === undefined) return undefined;
  if (internal !== undefined && typeof internal.resolveSync === 'function') {
    let moduleUrl: string;
    try {
      moduleUrl = internal.version === 'v2'
        ? internal.resolveSync(baseUrl, { specifier: loaderName, attributes: {} }).url
        : internal.resolveSync(loaderName, baseUrl, {}).url;
    } catch {
      return undefined;
    }
    return nearestPackage(moduleUrl, expected);
  }
  if (expected === undefined) {
    const moduleUrl = loaderName.startsWith('file:')
      ? loaderName
      : isAbsolute(loaderName) ? pathToFileURL(loaderName).href : new URL(loaderName, baseUrl).href;
    return nearestPackage(moduleUrl, expected);
  }
  try {
    return { path: createRequire(baseUrl).resolve(`${expected}/package.json`), packageName: expected };
  } catch {
    return undefined;
  }
}

export interface WebuiGraphOptions {
  /** 种子词表（壳构建期生成——wire 顶层 seeds；§4.4 版本治理） */
  shellSeeds?: Record<string, string>;
}

/**
 * wire 注册面：脏集 + microtask flush + 活态对账。rev 变化才通知
 * （onGraphChanged——WS wire/graph 帧推送的数据源）。构造即激活趟
 * （同步 seed + flush）；此后每次 fiber 事件增量对账。
 */
export class WebuiWireGraph {
  private readonly shellSeeds: Record<string, string>;
  private readonly table = new Map<string, { sourceKey: string; pkgDir: string; files: Set<string>; input: WireRowInput }>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private flushQueued = false;
  private current: Wire;

  private readonly ctx: Context;
  private readonly tree: EntryTree;

  constructor(ctx: Context, tree: EntryTree, options: WebuiGraphOptions = {}) {
    this.ctx = ctx;
    this.tree = tree;
    this.shellSeeds = options.shellSeeds ?? {};
    // 树归属判定不在此做恒等比较（ctx.loader 取到的是 trace 代理，identity
    // 恒假）；flush 按 this.tree.entries() 索引对账——名字不在本树 = 空集
    // 走出表分支，天然收窄到本域。
    const markDirty = (name: string | undefined) => {
      if (name === undefined || name === '') return;
      this.dirty.add(name);
      if (this.flushQueued) return;
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        this.flush();
      });
    };
    const markFiber = (fiber: { entry?: Entry }) => markDirty(fiber.entry?.options.name);
    ctx.on('internal/plugin', markFiber);
    // fiber 激活也打脏：构造事件的 microtask flush 常落在 fiber 就位前
    //（装载窗），激活瞬间补一发对账——安装后行必进 wire（与卸载对称）
    ctx.on('internal/status', markFiber);
    // 卸载/停用/移除路径的确定性事件（Loader 自有目录——remove/_dispose/
    // update 全发；internal/plugin 在 dispose 窗常缺席实测）
    ctx.on('loader/partial-dispose', (entry: Entry) => markDirty(entry.options.name));
    for (const entry of tree.entries()) this.dirty.add(entry.options.name);
    this.current = this.compose([]);
    this.flush(); // 激活趟：与稳态同一实现（同步 seed + flush）
  }

  /** 当前 wire 文档（稳定对象——rev 不变即不换引用） */
  wire(): Wire {
    return this.current;
  }

  /**
   * 资产解析（/ui-asset/:id/:rev/:file 数据源）：行在表 + rev 匹配当前行
   * （重建 = 新 URL，旧 rev URL 天然 404）+ 文件在产物清单 files 白名单。
   * 返回绝对路径；越权/缺席 = null。realpath 囚笼归路由层（本面只出
   * 候选路径——表行恒为包内 client/dist，囚笼由路由再验）。
   */
  assetFile(id: string, rev: string, file: string): string | null {
    const record = this.table.get(id);
    if (record === undefined || record.input.revision !== rev) return null;
    if (!record.files.has(file)) return null;
    return join(record.pkgDir, 'client', 'dist', file);
  }

  /** 行包目录清单（stat-poll 探测面——wire/rebuilt 帧的输入） */
  pkgDirs(): Map<string, string> {
    return new Map([...this.table].map(([id, r]) => [id, r.pkgDir]));
  }

  /** 重扫全部表行（产物重建后——manifest 重读 → 新 rev → 通知） */
  rescan(): void {
    for (const record of this.table.values()) {
      this.dirty.add(record.sourceKey.split('\0')[1]!);
    }
    this.flush();
  }

  /** rev 变化通知（拉模型——监听方重读 wire()） */
  onGraphChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 立即对账（测试/WS 推送面显式驱动；稳态走 microtask） */
  flush(): void {
    if (this.dirty.size === 0) return;
    const byName = new Map<string, Entry[]>();
    for (const entry of this.tree.entries()) {
      const list = byName.get(entry.options.name);
      if (list) list.push(entry);
      else byName.set(entry.options.name, [entry]);
    }
    const resolveWarnings: string[] = [];
    let changed = false;
    for (const name of [...this.dirty]) {
      this.dirty.delete(name);
      if (this.processOne(name, byName.get(name) ?? [], resolveWarnings)) changed = true;
    }
    if (!changed) {
      // 解析警告即使行集未变也要上报（激活趟可见）
      if (resolveWarnings.length > 0) this.mergeWarnings(resolveWarnings);
      return;
    }
    const next = this.compose(resolveWarnings);
    if (next.rev === this.current.rev && next.warnings.join('\n') === this.current.warnings.join('\n')) return;
    this.current = next;
    for (const notify of this.listeners) {
      try {
        notify();
      } catch (error) {
        this.ctx.logger.error(error);
      }
    }
  }

  private mergeWarnings(extra: string[]): void {
    if (extra.length === 0) return;
    this.current = { ...this.current, warnings: [...this.current.warnings, ...extra] };
    for (const notify of this.listeners) {
      try {
        notify();
      } catch (error) {
        this.ctx.logger.error(error);
      }
    }
  }

  /** 对账一个行名：活 sources → 表增删（返回表是否变化） */
  private processOne(name: string, entries: Entry[], warnings: string[]): boolean {
    let live: { key: string; located: { path: string; packageName: string }; built: { input: WireRowInput; files: Set<string> } } | undefined;
    let pending = false; // entry 在树但 fiber 未就位（装载中）——既不增也不删
    let activeEntries = 0;
    for (const entry of entries) {
      if (entry.disabled) continue;
      activeEntries++;
      if (entry.fiber === undefined) { pending = true; continue; }
      if (entry.fiber.uid === null) continue; // 已销毁（卸载窗）——非活源
      const baseUrl = entry.parent.tree.ctx.baseUrl;
      if (baseUrl === undefined) {
        warnings.push(`行 ${name}：装配树无解析基址`);
        continue;
      }
      const located = locatePkgJson(name, baseUrl, this.internalOf());
      if (located === undefined) continue; // 非 web 面（无 ac.faces.web）或不可解析
      const built = this.readRowInput(located, warnings);
      if (built === undefined) continue;
      const key = `${baseUrl}\0${name}`;
      const prev = this.table.get(located.packageName);
      if (prev !== undefined && prev.sourceKey !== key) {
        warnings.push(`撞名防御：包 ${located.packageName} 多活源（${prev.sourceKey} / ${key}），跳过后者`);
        continue;
      }
      live = { key, located, built };
      break; // 一个行名至多一活源（撞名已防）
    }
    if (live !== undefined) {
      const prev = this.table.get(live.located.packageName);
      if (prev !== undefined && prev.sourceKey === live.key
        && JSON.stringify(prev.input) === JSON.stringify(live.built.input)) return false;
      this.table.set(live.located.packageName, {
        sourceKey: live.key,
        pkgDir: dirname(live.located.path),
        files: live.built.files,
        input: live.built.input,
      });
      return true;
    }
    if (pending) return false; // 装载窗：entry 已在树、fiber 未就位——不动表
    if (activeEntries > 0) {
      // 活 entry 而无 web 面声明（解析失败/违例已记 warnings）= 降级出表
    }
    // 无 entry / 全停用 / 全降级：该名字关联行出表（卸载/停用）
    let changed = false;
    for (const [pkg, record] of this.table) {
      if (record.sourceKey.split('\0')[1] !== name) continue;
      this.table.delete(pkg);
      changed = true;
    }
    return changed;
  }

  /** 包 → WireRowInput（ac.faces.web 校验 + client/dist/manifest.json rev） */
  private readRowInput(located: { path: string; packageName: string }, warnings: string[]): { input: WireRowInput; files: Set<string> } | undefined {
    let pkg: Record<string, any>;
    try {
      pkg = JSON.parse(readFileSync(located.path, 'utf8'));
    } catch (error) {
      warnings.push(`${located.packageName}：package.json 不可读（${error instanceof Error ? error.message : String(error)}）`);
      return undefined;
    }
    const web = pkg.ac?.faces?.web;
    if (web === undefined) return undefined; // 非 web 面行
    const check = checkWebFace(web);
    if (!check.ok) {
      warnings.push(`${located.packageName}：ac.faces.web 违例——${check.warnings.join('；')}`);
      return undefined;
    }
    const distDir = join(dirname(located.path), 'client', 'dist');
    let manifest: Record<string, any>;
    try {
      manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
    } catch {
      warnings.push(`${located.packageName}：client/dist/manifest.json 缺失或损坏（web 面产物未构建？）`);
      return undefined;
    }
    if (typeof manifest.rev !== 'string' || manifest.rev === '') {
      warnings.push(`${located.packageName}：产物清单缺 rev`);
      return undefined;
    }
    // entry/styles 单源 = 产物清单（构建器写）；seeds 声明位 = ac.faces.web.seeds
    //（§4.3.2），缺席落产物清单记录的构建期区间（§4.5 版本对拍面）
    const entryRel: string | undefined = typeof manifest.entry === 'string'
      ? manifest.entry
      : typeof web.entry === 'string' ? web.entry.replace(/^\.\/client\/dist\//, '') : undefined;
    // theme 行声明位 styles = ./client/dist/<file> 显式词形（checkWebFace 门）
    // ——回退位剥前缀归产物相对名（与 entry 同款）
    const styles: string[] | undefined = Array.isArray(manifest.styles)
      ? manifest.styles
      : Array.isArray(web.styles) ? web.styles.map((s: string) => s.replace(/^\.\/client\/dist\//, '')) : undefined;
    const seeds: Record<string, string> | undefined = web.seeds !== null && typeof web.seeds === 'object'
      ? web.seeds
      : manifest.seeds !== null && typeof manifest.seeds === 'object' ? manifest.seeds : undefined;
    const files = new Set(Object.keys(manifest.files ?? {}));
    files.add('manifest.json');
    const input: WireRowInput = {
      id: located.packageName,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      revision: manifest.rev,
      ...(entryRel !== undefined ? { entry: entryRel } : {}),
      ...(styles !== undefined ? { styles } : {}),
      ...(Array.isArray(web.inject) ? { inject: web.inject } : {}),
      seats: Array.isArray(web.seats) ? web.seats : [],
      // theme 行 id 投影（cr-936 主题包——壳 registerThemeId 消费）
      ...(typeof web.theme === 'string' ? { themeId: web.theme } : {}),
      ...(typeof web.isolated === 'boolean' ? { isolated: web.isolated } : {}),
      ...(seeds !== undefined ? { seeds } : {}),
    };
    return { input, files };
  }

  private compose(extraWarnings: string[]): Wire {
    const wire = synthesizeWire([...this.table.values()].map((r) => r.input), this.shellSeeds);
    return extraWarnings.length === 0 ? wire : { ...wire, warnings: [...wire.warnings, ...extraWarnings] };
  }

  private internalOf(): InternalResolver | undefined {
    const internal = (this.ctx as any).loader?.internal;
    return internal !== undefined && typeof internal.resolveSync === 'function' ? internal : undefined;
  }
}
