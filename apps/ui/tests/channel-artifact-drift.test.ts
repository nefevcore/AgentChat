// ============================================================
// channel-artifact-drift.test.ts —— 通道产物漂移对账门（cr-942）
//
// 防的事故（cr-938 实录）：跨包共享模块的导出面收紧后（draftParking.ts 删
// draftsVersion），只重建了部分依赖包的 client/dist——旧产物向新宿主模块表
// import 已删词 → undefined → 点击新会话时 pendingView 读 .value 整面崩溃。
// 产物是构建态，此前测试面无任何对账，漂移只能靠人肉记忆「删共享导出须
// 全量重建」。
//
// 门形态（纯文件系统 + 文本扫描，亚秒级）：
//   ① 存在性：ac.faces.web entry 包必有 client/dist/index.js + manifest.json；
//   ② rev 一致：manifest 与盘面产物等值（无残留/缺文件/局部改写）；
//   ③ 符号对账：产物 require(通道包) 属性访问词 ⊆ 目标源码导出面——
//      cr-938 根因的直接锁定。
//
// 红了怎么办：跑 `pnpm --filter ac-ui-app build:channel` 全量重建；重建后仍
// 红 = 源码新导出未被宿主模块表/深导出面覆盖，按 host-module-table.ts 头注
// 的破坏面声明处置。
// ============================================================
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const pkgRoot = join(repoRoot, 'packages');

interface ChannelPkg { name: string; dir: string; theme: boolean; entry: string | undefined }

/** 通道包清点（与 build-channel.mjs 同口径：前缀族 + ac.faces.web 在场） */
function channelPkgs(): ChannelPkg[] {
  const out: ChannelPkg[] = [];
  for (const e of readdirSync(pkgRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const theme = e.name.startsWith('ac-client-theme-');
    if (!theme && !e.name.startsWith('ac-client-ui-')) continue;
    let pkg: any;
    try { pkg = JSON.parse(readFileSync(join(pkgRoot, e.name, 'package.json'), 'utf-8')); }
    catch { continue; }
    const web = pkg?.ac?.faces?.web;
    if (!(web && typeof web === 'object'
      && ((typeof web.entry === 'string' && web.entry !== '') || typeof web.theme === 'string'))) continue;
    out.push({ name: e.name, dir: join(pkgRoot, e.name), theme, entry: web.entry });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

/** 单文件导出面（含 re-export 源解析，seen 防环） */
function fileExports(file: string, seen: Set<string> = new Set()): Set<string> {
  const syms = new Set<string>();
  if (!file || seen.has(file) || !existsSync(file)) return syms;
  seen.add(file);
  const text = readFileSync(file, 'utf-8');
  if (/\.vue$/.test(file)) syms.add('default');
  for (const m of text.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) syms.add(m[1]);
  for (const m of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    const fm = /\bfrom\s*['"]([^'"]+)['"]/.exec(m[0]);
    for (const part of m[1].split(',')) {
      if (/\bfrom\b/.test(part)) continue;
      const name = part.trim().split(/\s+as\s+/).pop()?.trim().replace(/^type\s+/, '');
      if (name) syms.add(name);
    }
    if (fm) for (const s of fileExports(resolveFrom(dirname(file), fm[1]), seen)) syms.add(s);
  }
  for (const m of text.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const s of fileExports(resolveFrom(dirname(file), m[1]), seen)) syms.add(s);
  }
  if (/\bexport\s+default\b/.test(text)) syms.add('default');
  return syms;
}

function resolveFrom(dir: string, spec: string): string {
  if (!spec.startsWith('.')) return '';
  const base = join(dir, spec);
  for (const cand of [base, base + '.ts', base + '.vue', join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return '';
}

/** 通道深路径说明符 → 源文件；非通道词（种子/包外）返回 null */
function resolveChannelSpec(spec: string, pkgs: ChannelPkg[]): { file: string } | null {
  for (const p of pkgs) {
    if (spec !== p.name && !spec.startsWith(p.name + '/')) continue;
    const rest = spec === p.name ? '/client' : spec.slice(p.name.length);
    if (rest !== '/client' && !rest.startsWith('/client/')) return null;
    const rel = rest === '/client' ? 'index.ts' : rest.slice('/client/'.length);
    const base = join(p.dir, 'client', rel);
    for (const cand of [base, base + '.ts', base + '.vue', join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile()) return { file: cand };
    }
  }
  return null;
}

describe('通道产物漂移对账门（cr-942）', () => {
  const pkgs = channelPkgs();

  it('通道包清点非空（当前 ' + pkgs.length + ' 包——新包自动入账）', () => {
    expect(pkgs.length).toBeGreaterThanOrEqual(10);
  });

  it('① 存在性：entry 包必有 client/dist/index.js + manifest.json', () => {
    const missing: string[] = [];
    for (const p of pkgs) {
      if (p.theme || !p.entry) continue;
      const dist = join(p.dir, 'client', 'dist');
      if (!existsSync(join(dist, 'index.js'))) missing.push(p.name + ': dist/index.js');
      if (!existsSync(join(dist, 'manifest.json'))) missing.push(p.name + ': dist/manifest.json');
    }
    expect(missing, '产物缺席——跑 pnpm --filter ac-ui-app build:channel：' + missing.join(', ')).toEqual([]);
  });

  it('② rev 一致：manifest 与盘面产物等值（无残留/缺文件/局部改写）', () => {
    const problems: string[] = [];
    for (const p of pkgs) {
      const dist = join(p.dir, 'client', 'dist');
      const mf = join(dist, 'manifest.json');
      if (!existsSync(mf)) continue;
      const manifest = JSON.parse(readFileSync(mf, 'utf-8'));
      const files: Record<string, { hash: string; size: number }> = manifest.files ?? {};
      const onDisk = readdirSync(dist).filter(n => statSync(join(dist, n)).isFile() && n !== 'manifest.json').sort();
      const listed = Object.keys(files).sort();
      if (onDisk.join('|') !== listed.join('|')) {
        problems.push(p.name + ': files 表 ≠ 盘面——盘上 [' + onDisk.join(',') + '] 表内 [' + listed.join(',') + ']');
        continue;
      }
      const hash = createHash('sha256').update(p.name);
      for (const name of listed) {
        const meta = files[name];
        const buf = readFileSync(join(dist, name));
        if (meta.hash !== sha256(buf).slice(0, 16) || meta.size !== buf.length) {
          problems.push(p.name + '/' + name + ': 内容与清单不符（局部改写？）');
        }
        hash.update(String(meta.size) + ':' + name + ':' + meta.hash);
      }
      if (manifest.rev !== hash.digest('hex').slice(0, 16)) {
        problems.push(p.name + ': rev ≠ 重算值（清单被手工编辑？）');
      }
    }
    expect(problems).toEqual([]);
  });

  it('③ 符号对账：产物 require(通道包) 属性访问词 ⊆ 目标源码导出面', () => {
    const problems: string[] = [];
    let crossRequireCount = 0;
    for (const p of pkgs) {
      const bundle = join(p.dir, 'client', 'dist', 'index.js');
      if (!existsSync(bundle)) continue;
      const text = readFileSync(bundle, 'utf-8');
      // 属性扫描用剥掉字符串字面量的副本——防 alias 恰为路径段（如 timerApi）
      // 在 spec 字符串内匹配出 '.ts'/'.vue' 假符号（初版 17 条假阳性实录）
      const codeOnly = text.replace(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
      for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
        const alias = m[1]; const spec = m[2];
        const target = resolveChannelSpec(spec, pkgs);
        if (!target) continue;
        crossRequireCount++;
        const surface = fileExports(target.file);
        for (const a of codeOnly.matchAll(new RegExp('\\b' + alias.replace(/\$/g, '\\$') + '\\.([\\w$]+)', 'g'))) {
          const sym = a[1];
          if (!surface.has(sym)) {
            problems.push(p.name + ' 产物引用 ' + spec + ' 的 ' + sym + '——源码导出面无此词（产物过时或导出被删）');
          }
        }
      }
    }
    expect(crossRequireCount, '通道交叉 require 计数为 0——提取面失效，门已真空').toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
