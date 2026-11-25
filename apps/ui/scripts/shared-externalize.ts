// ============================================================
// shared-externalize.ts —— 共享面路径归一外部化插件（cr-1310）
//
// 根因（cr-1296/1300 三例同族实证）：rollup external 按说明符字面匹配，
// 通道包内部相对引用链（feed-core → ./feed.ts → ./fallback-probes.ts）
// 解析后是绝对路径、永不命中字面清单 → 共享面模块被内联成副本，单例
// 语义失守（stats 分裂 / 双 rAF 链 / 计数两份）。
//
// 治本：resolveId 把命中共享面源文件集合的相对引用归一为宿主模块表
// 说明符（裸包深路径词形）——归一词即表内词：external 直标 + 产物
// require 命中 module-system 种子①支（宿主实例）+ 纯度门同词闭环。
// 匹配依据 = 解析后路径，不依赖说明符字面——共享面新增模块只需入
// shared-modules.ts / host-module-table.ts，相对引用链随归一自动外部化，
// 不再逐例维护（cr-1296/1300 的逐例入清单 = 治标路径，就此退役）。
//
// 挂载位 = build-channel 第二遍（isolated 自含档不挂——沙盒独立模块表
// 无种子面，归一即断链）；第一遍是裸构建词收集面，不挂（挂了会把
// 自包深词混进 globalRequires 对账集合）。
//
// 词形注记：vite/rollup 模块 id 在 Windows 呈正斜杠形、node:path 原生
// 调用呈反斜杠形——两侧一律 normPath 归一后对拍（不归一则前缀守卫
// 静默失配、插件整体失效，Windows-only 隐性）。表内深词映射到不存在
// 的源文件 = 说明符漂移，本模块 import 即 fail-loud（打表外词 = 运行
// 时 throw「模块不可解析」——错在装载面，但词表漂移构建期即可诊断）。
// ============================================================
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_MODULE_SPECS } from './host-module-table.ts';

const normPath = (p: string) => p.split(sep).join('/');
// '../../..' 相对模块 URL 解析为目录（fileURLToPath 带尾斜杠）——去尾保前缀对拍成立
const repoRoot = normPath(fileURLToPath(new URL('../../..', import.meta.url))).replace(/\/$/, '');
const pkgRoot = repoRoot + '/packages';

/**
 * 相对引用查表面：共享面源文件（正斜杠绝对路径）→ 宿主模块表说明符。
 * 双词形同文件（'X/client' 与 'X/client/index.ts'）取 explicit 长词——
 * 两词同为种子（sharedModules 双键同 import），运行时同实例，取长词
 * 仅为确定性。种子词（vue/pinia/cordis/骨架包）不进本表——不经归一。
 */
const fileToSpec = new Map<string, string>();
for (const spec of HOST_MODULE_SPECS) {
  const m = /^(ac-client-(?:ui|theme)-[^/]+)(\/.*)$/.exec(spec);
  if (m === null) continue;
  const sub = m[2] === '/client' ? '/index.ts' : m[2].slice('/client'.length);
  const file = pkgRoot + '/' + m[1] + '/client' + sub;
  if (!existsSync(file)) {
    throw new Error('[shared-externalize] 宿主模块表深词指向不存在的源文件（说明符漂移——清单与源码须同步）：' + spec);
  }
  const prev = fileToSpec.get(file);
  if (prev === undefined || spec.length > prev.length) fileToSpec.set(file, spec);
}

/**
 * 相对引用归一判定：解析后绝对路径命中共享面集合 → 宿主模块表说明符；
 * 未命中（非共享相对引用 / 裸说明符 / 仓库外 importer）→ undefined。
 * specs 可注入合成索引（测试面）；缺省 = 全仓共享面。
 */
export function normalizeSharedImport(source: string, importer: string | undefined, specs = fileToSpec): string | undefined {
  if (!source.startsWith('.')) return undefined;
  if (importer === undefined) return undefined;
  const importerN = normPath(importer);
  if (!importerN.startsWith(repoRoot + '/')) return undefined;
  // 键契约 = 正斜杠绝对路径（fileToSpec 构建即归一；注入面同契约）
  return specs.get(normPath(resolve(dirname(importerN), source)));
}

/**
 * vite/rollup resolveId 插件。enforce:'pre' 先于 vite:resolve 认领相对
 * 引用；命中 → { id: 说明符, external: true }——rollup 直标外部并按
 * 该 id 发射 require 词（外部化判定不经 isExternal 字面面）。
 */
export function sharedExternalizePlugin(specs = fileToSpec) {
  return {
    name: 'ac-shared-externalize',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      const spec = normalizeSharedImport(source, importer, specs);
      return spec === undefined ? undefined : { id: spec, external: true };
    },
  };
}
