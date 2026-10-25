// ============================================================
// seats-gate.test.ts —— 29 通道 manifest 全装对账门（cr-690 B1）
//
// 门语义：① 29 个通道产物 manifest 全部过 checkUiManifest（schema 面）；
// ② 静态扫描主线包 client 面 register key（生成器同款扫描）与 manifest
// seats 声明全量一致（数据面——漂移即门红）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkUiManifest } from 'ac-webui-core';

// vitest root = 仓库根（preview/packages/vitest.config.ts）——__dirname 相对路径锚
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const channelRoot = path.join(repoRoot, 'preview', 'apps', 'ui', 'channel');
const srcRoot = path.join(repoRoot, 'src');

const SKELETON = ['conversation', 'tool', 'settings', 'markdown-render'];

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

describe('cr-690 B1 · 29 通道全装对账门', () => {
  it('产物 manifest 全部过 checkUiManifest（schema 面）', () => {
    const dirs = fs.readdirSync(channelRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(dirs.length).toBeGreaterThanOrEqual(29);
    for (const e of dirs) {
      const m = JSON.parse(fs.readFileSync(path.join(channelRoot, e.name, 'manifest.json'), 'utf-8'));
      const check = checkUiManifest(m);
      if (!check.ok) throw new Error(e.name + ': ' + check.warnings.join('；'));
    }
  });

  it('manifest seats 声明 = 静态扫描 register key（数据面）', () => {
    const scanned = scanSeats();
    const drift: string[] = [];
    for (const e of fs.readdirSync(channelRoot, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const m = JSON.parse(fs.readFileSync(path.join(channelRoot, e.name, 'manifest.json'), 'utf-8'));
      const declared = (m.seats || []).map((s: { seat: string }) => s.seat).sort().join('|');
      const want = (scanned.get(e.name) || []).sort().join('|');
      if (declared !== want) drift.push(e.name + ': manifest [' + declared + '] vs 扫描 [' + want + ']');
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });
});
