// @vitest-environment jsdom
// ============================================================
// seats-audit-v3.test.ts —— 30 通道全装运行时对账门 v3 承接（cr-937；
// 承 cr-798 seats-boot-audit 旧链门——webui-v3 cutover 后按 wire 面重建）
//
// 与 seats-gate.test.ts（静态扫描门）互补的运行时门：全部通道行按
// bootUiClientV3 真装载（jsdom），对账三轴：
//   ① channel 零 err（装载逐条隔离语义下无失败行）；
//   ② 词汇轴：wire 行声明的每个 seat = ctx.slots 已声明席位
//     （声明缺席 = 词汇漂移——对齐旧门 declaredNotRegistered 面）；
//   ③ 惰性轴：全装载终态 pendingInjects 为空（cr-798——slots.inject
//     挂起 = 声明方行缺席/未装载，非合法 deferred）。
// registeredNotDeclared 轴由构造保证（register 遇未声明席位即抛），不设断言。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bootUiClientV3 } from '../client/boot-v3.ts';
import { readChannelManifest } from 'ac-webui-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WireRow } from 'ac-webui-core';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const pkgRoot = path.join(repoRoot, 'packages');

/** 通道包 → wire 行（entry 值仅作 loadScript 寻址键，非真实 URL） */
function wireRows(): WireRow[] {
  const rows: WireRow[] = [];
  for (const e of fs.readdirSync(pkgRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('ac-client-ui-')) continue;
    const read = readChannelManifest(path.join(pkgRoot, e.name));
    if (read === null) continue; // 无 web 面（node-only 包）不进行
    rows.push({
      id: e.name,
      version: String(JSON.parse(fs.readFileSync(path.join(pkgRoot, e.name, 'package.json'), 'utf-8')).version ?? '0.0.0'),
      entry: '/ui-asset/' + e.name + '/r1/index.js',
      styles: [],
      seats: (read.manifest.seats ?? []).map((s) => s.seat),
      isolated: false,
    });
  }
  return rows;
}

describe('cr-937 · 30 通道全装运行时对账（v3 wire 面）', () => {
  it('全行 bootUiClientV3 真装载 → 三轴零漂移', async () => {
    setActivePinia(createPinia());
    const rows = wireRows();
    expect(rows.length).toBeGreaterThanOrEqual(29);

    // loadScript 替身：真实包动态 import → 注册 factory（等价 factory 注册
    // bundle 的到达语义——模块体副作用随物化，跨行 require 经种子/wire 行解析）
    const specOf = new Map(rows.map((r) => [r.entry, r.id + '/client']));
    const result = await bootUiClientV3({
      rpcWire: {
        call: async <T,>(_m: string) => null as T,
        onEvent: () => () => { /* 桩 */ },
        onOpen: () => () => { /* 桩 */ },
        onAck: () => () => { /* 桩 */ },
        onClose: () => () => { /* 桩 */ },
        connected: () => true,
      },
      fetchWire: async () => ({ rev: 'r1', rows, seeds: {}, warnings: [] }),
      loadScript: async (url) => {
        const id = specOf.get(url);
        if (id === undefined) throw new Error('测试行寻址失败：' + url);
        const mod = await import(/* @vite-ignore */ id);
        (globalThis as unknown as { __ModuleLoader__: { load(reg: unknown): void } }).__ModuleLoader__.load({
          id: id.slice(0, -'/client'.length),
          factory: () => mod,
        });
      },
    });

    // ① 装载轴
    const errs = [...result.channel.entries()].filter(([, v]) => v === 'err').map(([k]) => k);
    expect(errs, '装载失败条目: ' + errs.join(', ')).toEqual([]);

    // ② 词汇轴：wire 声明 seat ⊆ ctx.slots 已声明席位
    const declared = new Set(result.ctx.slots.snapshot().declarations.map((d) => d.key));
    const vocabDrift = rows.flatMap((r) => r.seats.filter((s) => !declared.has(s)).map((s) => r.id + ': ' + s));
    expect(vocabDrift, '席位词汇漂移（wire 声明但无人声明席位）:\n' + vocabDrift.join('\n')).toEqual([]);

    // ③ 惰性轴：终态无挂起 inject（声明方全装载——挂起即漂移）
    const pending = [...result.ctx.slots.pendingInjects().keys()];
    expect(pending, '挂起 inject（声明方缺席/未装载）: ' + pending.join(', ')).toEqual([]);
  }, 120_000);
});
