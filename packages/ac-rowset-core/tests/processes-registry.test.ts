// ============================================================
// processes-registry.test.ts —— 进程种类注册表（cr-910 批6 切片四）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeBaseDocs } from '../src/base-docs.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PROFILE = path.join(REPO, 'apps', 'catalog', 'profile');

describe('进程种类注册表（repo 声明式清单）', () => {
  it('注册表词面：出厂三词 host/shell/webui 各一条 + boot 入口在位', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(PROFILE, 'processes.json'), 'utf-8')) as { processes: Array<{ id: string; form?: string; bootEntry?: string; spawn?: string[] }> };
    const ids = doc.processes.map((p) => p.id);
    expect(ids).toEqual(['host', 'shell', 'webui']);
    for (const p of doc.processes) {
      if (p.form !== undefined) continue; // webui 前端产物无 boot 入口
      expect(typeof p.bootEntry).toBe('string');
      expect(Array.isArray(p.spawn)).toBe(true);
    }
  });

  it('部署链随行：materializeBaseDocs 物化 processes.json 进数据根', () => {
    const dataRoot = path.join('sandbox', 'test-procs-' + process.pid);
    try {
      materializeBaseDocs(PROFILE, dataRoot);
      const deployed = JSON.parse(fs.readFileSync(path.join(dataRoot, 'profile', 'processes.json'), 'utf-8'));
      expect(deployed.processes).toHaveLength(3);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
