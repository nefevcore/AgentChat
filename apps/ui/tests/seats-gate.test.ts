// ============================================================
// seats-gate.test.ts —— 通道包 seats 全装对账门（cr-690 B1；cr-920 声明
// 源迁 packages/ac-client-ui-* 的 ac.faces.web）
//
// 门语义：① 各包 web 面声明经 readChannelManifest 投影过
// checkUiManifest（schema 面）；② 静态扫描包 client 面 register key
// 与 seats 声明全量一致（数据面——漂移即门红）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkUiManifest, readChannelManifest } from 'ac-webui-core';

// vitest root = 仓库根（根 vitest.config.ts）——__dirname 相对路径锚
const repoRoot = path.resolve(__dirname, '..', '..', '..');
// ◐c 迁移批（cr-696）+ cr-703：ac-client-ui-* 包住 packages/（cr-920 起即通道本体）
const srcRoot = path.join(repoRoot, 'packages');

/** web 面声明包清单（ac.faces.web 在场者——短名） */
function webPackages(): string[] {
  return fs.readdirSync(srcRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('ac-client-ui-'))
    .filter((e) => JSON.parse(fs.readFileSync(path.join(srcRoot, e.name, 'package.json'), 'utf-8')).ac?.faces?.web !== undefined)
    .map((e) => e.name.slice('ac-client-ui-'.length));
}

/** 生成器同款静态扫描：包 client 面 register key（字面量 + SLOT_KEY 常量解析） */
function scanSeats(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const names = fs.readdirSync(srcRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('ac-client-ui-'))
    .map((e) => e.name.slice('ac-client-ui-'.length));
  const exportedConsts = new Map<string, string>();
  const filesOf = (d: string): string[] => {
    const dir = path.join(srcRoot, 'ac-client-ui-' + d, 'client');
    if (!fs.existsSync(dir)) return [];
    const acc: string[] = [];
    const walk = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|vue)$/.test(e.name)) acc.push(full);
      }
    };
    walk(dir);
    return acc;
  };
  for (const d of names) {
    for (const f of filesOf(d)) {
      const m = fs.readFileSync(f, 'utf-8').match(/export const SLOT_KEY = '([^']+)'/);
      if (m) exportedConsts.set('ac-client-ui-' + d + '/client/' + path.relative(path.join(srcRoot, 'ac-client-ui-' + d, 'client'), f).split(path.sep).join('/'), m[1]);
    }
  }
  for (const d of names) {
    const seats = new Set<string>();
    for (const f of filesOf(d)) {
      const text = fs.readFileSync(f, 'utf-8');
      for (const m of text.matchAll(/slots\.register\(\s*'([^']+)'/g)) seats.add(m[1]);
      for (const m of text.matchAll(/slots\.register\(\s*SLOT_KEY/g)) {
        const own = text.match(/export const SLOT_KEY = '([^']+)'/);
        if (own) { seats.add(own[1]); continue; }
        for (const im of text.matchAll(/import\s*\{[^}]*SLOT_KEY[^}]*\}\s*from\s*'([^']+)'/g)) {
          const key = exportedConsts.get(im[1].replace(/\.ts$/, ''));
          if (key) seats.add(key);
        }
      }
    }
    if (seats.size > 0) out.set(d, [...seats].sort());
  }
  return out;
}

describe('cr-690 B1 · 通道包全装对账门', () => {
  it('web 面声明投影全部过 checkUiManifest（schema 面）', () => {
    const names = webPackages();
    expect(names.length).toBeGreaterThanOrEqual(29);
    for (const name of names) {
      const read = readChannelManifest(path.join(srcRoot, 'ac-client-ui-' + name));
      if (read === null) throw new Error(name + ': 无 web 面声明');
      const check = checkUiManifest(read.manifest);
      if (!check.ok) throw new Error(name + ': ' + check.warnings.join('；'));
    }
  });

  it('seats 声明 = 静态扫描 register key（数据面）', () => {
    const scanned = scanSeats();
    const drift: string[] = [];
    for (const name of webPackages()) {
      const read = readChannelManifest(path.join(srcRoot, 'ac-client-ui-' + name));
      const declared = (read?.manifest.seats || []).map((s) => s.seat).sort().join('|');
      const want = (scanned.get(name) || []).sort().join('|');
      if (declared !== want) drift.push(name + ': 声明 [' + declared + '] vs 扫描 [' + want + ']');
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });
});
