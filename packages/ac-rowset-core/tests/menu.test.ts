// ============================================================
// menu.test.ts —— 菜单合成引擎单测（cr-1022 批1 / menu-assembly.md §七）
//
// 锁定三护栏 + 双区解析：
//   1. 撞名：骨架 > patch > installed，低优先丢弃 + notice；
//   2. requires 完备性：缺失 = fail-loud 列名，不做自动注入；
//   3. 词汇白名单：patch/installed 定义入口白名单外字段拒绝；
//   4. 双区基座解析：分区校验 + 基座词汇立法（tools/packs/bundle 拒绝）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeMenu, MENU_ENTRY_KEYS } from '../src/menu.ts';
import { readBaseDoc, projectBaseEntry } from '../src/base-docs.ts';

const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe('三源并集 + 撞名护栏', () => {
  it('骨架 ∪ patch ∪ installed：无撞名时全并（排序稳定，config 原样携带）', () => {
    const menu = mergeMenu({
      skeleton: [entry('ledger', { name: 'link:packages/ac-ledger' })],
      patch: [entry('math', { name: 'link:packages/ac-math', config: { a: 1 } })],
      installed: [entry('third-party', { name: 'link:packages/x' })],
    });
    expect(menu.errors).toEqual([]);
    expect(menu.notices).toEqual([]);
    expect(menu.entries.map((e) => e.id)).toEqual(['ledger', 'math', 'third-party']);
    expect(menu.entries[1].config).toEqual({ a: 1 });
  });

  it('撞名优先级骨架 > patch > installed：低优先丢弃 + notice，定义不被合并', () => {
    const menu = mergeMenu({
      skeleton: [entry('tools', { name: 'link:skeleton' })],
      patch: [entry('tools', { name: 'link:patch' }), entry('math', { name: 'link:patch-math' })],
      installed: [entry('math', { name: 'link:installed-math' }), entry('extra', { name: 'link:i' })],
    });
    expect(menu.errors).toEqual([]);
    // 丢的是低优先定义：骨架 tools 胜 patch；patch math 胜 installed
    expect(menu.entries.find((e) => e.id === 'tools')?.name).toBe('link:skeleton');
    expect(menu.entries.find((e) => e.id === 'math')?.name).toBe('link:patch-math');
    expect(menu.entries.map((e) => e.id).sort()).toEqual(['extra', 'math', 'tools']);
    expect(menu.notices).toHaveLength(2);
    expect(menu.notices.join('\n')).toContain('patch 行 tools 被 skeleton 定义取代');
    expect(menu.notices.join('\n')).toContain('installed 行 math 被 patch 定义取代');
  });

  it('同源重复定义 = 合成矛盾（fail-loud）', () => {
    const menu = mergeMenu({
      skeleton: [entry('a')],
      patch: [entry('b'), entry('b')],
    });
    expect(menu.errors).toEqual(['patch 内行定义重复：b']);
  });
});

describe('requires 完备性校验（fail-loud，不做自动注入）', () => {
  it('requires 缺失 = 错误列名缺失行，且菜单不静默长行', () => {
    const menu = mergeMenu({
      skeleton: [entry('tools')],
      patch: [entry('memory', { requires: ['tools', 'ghost-row'] })],
    });
    expect(menu.errors).toEqual([
      '行 memory requires 缺失：ghost-row（requires ⊆ 菜单——不进即不装，patch 需显式携带）',
    ]);
    // 骨架级依赖在场即满足；缺失行不自动注入
    expect(menu.entries.map((e) => e.id)).toEqual(['memory', 'tools']);
  });

  it('requires 全在场 = 零错误（跨源依赖可满足——patch 行依赖骨架行）', () => {
    const menu = mergeMenu({
      skeleton: [entry('tools')],
      patch: [entry('memory', { requires: ['tools'] })],
    });
    expect(menu.errors).toEqual([]);
  });
});

describe('词汇白名单拒绝（cr-1025）', () => {
  it('白名单恰为 id/name/requires/config', () => {
    expect(MENU_ENTRY_KEYS).toEqual(['id', 'name', 'requires', 'config']);
  });

  it('patch/installed 条目出现白名单外字段（tools/packs/bundle）= 错误点名', () => {
    const menu = mergeMenu({
      skeleton: [entry('a')],
      patch: [entry('evil', { tools: ['x'] })],
      installed: [entry('evil2', { packs: ['p'], bundle: 'b' })],
    });
    expect(menu.errors).toEqual([
      'patch 行 evil 含白名单外字段：tools（行定义词汇 = id/name/requires/config）',
      'installed 行 evil2 含白名单外字段：packs（行定义词汇 = id/name/requires/config）',
      'installed 行 evil2 含白名单外字段：bundle（行定义词汇 = id/name/requires/config）',
    ]);
  });
});

describe('双区基座解析 + 分区校验', () => {
  const ROOT = path.join('sandbox', 'test-menu-base-' + process.pid);
  const write = (name: string, text: string): string => {
    fs.mkdirSync(ROOT, { recursive: true });
    const file = path.join(ROOT, name);
    fs.writeFileSync(file, text, 'utf-8');
    return file;
  };

  // cr-1033 B3：基座文档回单区数组（v5）——能力定义归包 ac.rows，双区
  // 解析面（readDualZoneBaseDoc/dualZoneEntries）随窗口关闭退役；包自述
  // 行的词汇白名单/撞名护栏在 package-rows.test.ts 锚定。
  it('单区读面：条目数组 + 版本戳 + 壳基座行投影派生 zone=skeleton', () => {
    const file = write('ok.yml', [
      '# ac-base-version: 5',
      '- id: ledger',
      '  name: link:packages/ac-ledger',
      '  description: 账本',
      '',
    ].join('\n'));
    const doc = readBaseDoc(file, 'shell');
    expect(doc.version).toBe(5);
    expect(projectBaseEntry(doc.entries[0]!, 'shell')).toEqual({
      id: 'ledger', tree: 'shell', zone: 'skeleton',
      description: '账本', path: 'packages/ac-ledger',
    });
    expect(projectBaseEntry({ id: 'h' }, 'host').zone).toBeUndefined(); // 宿主行无分区
  });

  it('顶层双区映射（v4 存量）→ throw 指路（cr-1033 B3 退役）', () => {
    const dualFile = write('dual.yml', '# ac-base-version: 4\nskeleton:\n  - id: a\ncapability: []\n');
    expect(() => readBaseDoc(dualFile, 'shell')).toThrow('顶层必须是条目数组');
    const noStamp = write('nostamp.yml', '- id: a\n');
    expect(() => readBaseDoc(noStamp, 'shell')).toThrow('缺版本戳');
    fs.rmSync(ROOT, { recursive: true, force: true });
  });
});
