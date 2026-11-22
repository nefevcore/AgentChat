// ============================================================
// config-domains.test.ts —— 包级配置域聚合（cr-1199）
// 链路：package.json ac.configDomains → aggregateConfigDomains
// → row-catalog.json 顶层 configDomains（gen 携带）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { aggregateConfigDomains } from '../src/config-domains.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-domains-'));
const writePkg = (name: string, ac: unknown): void => {
  const dir = path.join(ROOT, 'packages', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ac }), 'utf-8');
};

beforeEach(() => { fs.rmSync(path.join(ROOT, 'packages'), { recursive: true, force: true }); });
afterEach(() => { /* ROOT 复用，仅清子目录 */ });
describe('aggregateConfigDomains（cr-1199）', () => {
  it('并集聚合 + 排序稳定 + 首包溯源锚', () => {
    writePkg('pkg-b', { configDomains: ['settings', 'source'] });
    writePkg('pkg-a', { configDomains: ['llmProviders'] });
    writePkg('pkg-none', { rows: [{ id: 'x' }] }); // 不声明 → 不参与
    expect(aggregateConfigDomains(ROOT)).toEqual({ llmProviders: 'pkg-a', settings: 'pkg-b', source: 'pkg-b' });
  });

  it('同域多包重复声明合法（并集，首包锚定）', () => {
    writePkg('pkg-a', { configDomains: ['settings'] });
    writePkg('pkg-b', { configDomains: ['settings', 'timer'] });
    expect(aggregateConfigDomains(ROOT)).toEqual({ settings: 'pkg-a', timer: 'pkg-b' });
  });

  it('非字符串数组 fail-loud', () => {
    writePkg('pkg-bad', { configDomains: ['ok', 3] });
    expect(() => aggregateConfigDomains(ROOT)).toThrow(/字符串数组/);
  });

  it('非法域名词形 fail-loud（点路径 / 大写开头 / 空串）', () => {
    writePkg('pkg-dot', { configDomains: ['source.fs'] });
    expect(() => aggregateConfigDomains(ROOT)).toThrow(/域名非法/);
    writePkg('pkg-upper', { configDomains: ['Source'] });
    expect(() => aggregateConfigDomains(ROOT)).toThrow(/域名非法/);
    writePkg('pkg-empty', { configDomains: [''] });
    expect(() => aggregateConfigDomains(ROOT)).toThrow(/域名非法/);
  });

  it('坏 JSON fail-loud', () => {
    const dir = path.join(ROOT, 'packages', 'pkg-json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{oops', 'utf-8');
    expect(() => aggregateConfigDomains(ROOT)).toThrow(/坏 JSON/);
  });
});
