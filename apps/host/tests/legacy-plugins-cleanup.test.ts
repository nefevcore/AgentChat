// ============================================================
// legacy-plugins-cleanup.test.ts —— cr-935：出厂拷贝清理契约锁
// （名册内删 · 名册外零触碰 · 无痕迹无操作 · 损坏名册只删名册）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupLegacyFactoryPlugins } from '../legacy-plugins-cleanup.ts';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-legacy-plugins-'));
}

/** 旧链名册形态：{ sig: JSON.stringify({ names: [...] }) } */
function stamp(names: string[]): string {
  return JSON.stringify({ sig: JSON.stringify({ names }) });
}

describe('cr-935 · 数据根出厂副本物理清理', () => {
  it('名册内目录 + 名册删除；名册外（用户自装存量）零触碰', () => {
    const root = makeRoot();
    const plugins = path.join(root, 'plugins');
    fs.mkdirSync(path.join(plugins, 'ac-client-ui-todo'), { recursive: true });
    fs.mkdirSync(path.join(plugins, 'ac-client-ui-jobs'), { recursive: true });
    fs.mkdirSync(path.join(plugins, 'my-own-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugins, '.factory-stamp.json'), stamp(['ac-client-ui-todo', 'ac-client-ui-jobs']));

    const removed = cleanupLegacyFactoryPlugins(root);

    expect(removed.sort()).toEqual(['ac-client-ui-jobs', 'ac-client-ui-todo']);
    expect(fs.existsSync(path.join(plugins, 'ac-client-ui-todo'))).toBe(false);
    expect(fs.existsSync(path.join(plugins, 'ac-client-ui-jobs'))).toBe(false);
    expect(fs.existsSync(path.join(plugins, '.factory-stamp.json'))).toBe(false);
    expect(fs.existsSync(path.join(plugins, 'my-own-plugin'))).toBe(true); // 名册外不动
  });

  it('无痕迹（新数据根/已清）= 无操作，返回空', () => {
    const root = makeRoot();
    expect(cleanupLegacyFactoryPlugins(root)).toEqual([]);
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    expect(cleanupLegacyFactoryPlugins(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'plugins'))).toBe(true);
  });

  it('损坏名册：不猜目录，只删名册本身', () => {
    const root = makeRoot();
    const plugins = path.join(root, 'plugins');
    fs.mkdirSync(path.join(plugins, 'ac-client-ui-todo'), { recursive: true });
    fs.writeFileSync(path.join(plugins, '.factory-stamp.json'), '{oops');

    expect(cleanupLegacyFactoryPlugins(root)).toEqual([]);
    expect(fs.existsSync(path.join(plugins, 'ac-client-ui-todo'))).toBe(true);
    expect(fs.existsSync(path.join(plugins, '.factory-stamp.json'))).toBe(false);
  });
});
