// ============================================================
// package-rows.test.ts —— 包自述能力行聚合锁（cr-1033 B1）
//
// 双源等价锁（B1-B2 窗口期）已随 B3 删能力区退役——聚合单源后的
// 新鲜度锁（JSON 能力区 == 聚合投影）在 base-docs.test.ts。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregatePackageRows } from '../src/package-rows.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const byId = (rows: Array<{ id: string }>) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

describe('cr-1033 包自述能力行聚合', () => {
  it('聚合面：26 行覆盖全部能力行（id 全集锚定——cr-1118 archive 归基座）', () => {
    const aggregated = byId(aggregatePackageRows(REPO_ROOT));
    expect(aggregated).toHaveLength(26);
    expect(aggregated.map((r) => r.id)).toEqual([
      'artifacts', 'ask-questions', 'auto-title', 'bench', 'browser', 'collab-tools',
      'datetime', 'fs-search', 'fs-tools', 'goal', 'harness-tools', 'issue-tools', 'math', 'mcp',
      'memory', 'plugin-dev', 'restart', 'run-code', 'sap-adt', 'session-query', 'shell-tools',
      'skill', 'str-replace-editor', 'subagent', 'todo', 'web-tools',
    ]);
  });

  it('name 派生单源：link: + 包目录（多行包同 name）', () => {
    const rows = aggregatePackageRows(REPO_ROOT);
    const shellRowsPkg = rows.filter((r) => r.name === 'link:packages/ac-shell-rows');
    expect(shellRowsPkg.map((r) => r.id).sort()).toEqual(['auto-title', 'plugin-dev', 'restart', 'session-query']); // cr-1118：archive 归基座骨架
    expect(rows.filter((r) => r.name === 'link:packages/ac-web-tools').map((r) => r.id).sort()).toEqual(['browser', 'web-tools']);
  });

  it('词汇白名单 / 撞名 / 缺 id fail-loud', () => {
    const ROOT = path.join('sandbox', 'test-package-rows-' + process.pid);
    const write = (dir: string, ac: unknown) => {
      fs.mkdirSync(path.join(ROOT, 'packages', dir), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'packages', dir, 'package.json'),
        JSON.stringify({ name: dir, ac }), 'utf-8');
    };
    try {
      write('pkg-a', { rows: [{ id: 'x', name: 'link:packages/pkg-a' }] });
      expect(() => aggregatePackageRows(ROOT)).toThrow('白名单外字段');
      // configKeys（cr-1037 批3b）：键面自述聚合——字符串数组透传、非字符串拒
      write('pkg-a', { rows: [{ id: 'x', configKeys: ['level', 'headless'] }] });
      expect(aggregatePackageRows(ROOT)[0]?.configKeys).toEqual(['level', 'headless']);
      write('pkg-a', { rows: [{ id: 'x', configKeys: ['ok', 3] }] });
      expect(aggregatePackageRows(ROOT)[0]?.configKeys).toBeUndefined(); // 非全字符串 = 视同未声明
      write('pkg-a', { rows: [{ id: 'x' }, { id: 'x' }] });
      expect(() => aggregatePackageRows(ROOT)).toThrow('撞名');
      write('pkg-a', { rows: [{ description: '无 id' }] });
      expect(() => aggregatePackageRows(ROOT)).toThrow('缺 id');
    } finally {
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  });
});
