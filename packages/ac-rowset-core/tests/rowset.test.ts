// ============================================================
// ac-rowset-core 单测（M2.3 验收）：壳行集派生全词形 / 捆绑词消解 /
// exclude 减法 / 静态投影 / 宿主偏好派生 / 未命中警告
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  deriveShellRowset, deriveHostRowset, projectCatalog,
  type RowsetCatalog, type RowDescriptor,
} from '../src/rowset.ts';
import { readCatalog, readHostPreferences, defaultCatalogFile, hostPreferenceFile } from '../src/disk.ts';

const row = (id: string, tree: 'host' | 'shell', extra: Partial<RowDescriptor> = {}): RowDescriptor => ({
  id, tree, ...extra,
});

const catalog: RowsetCatalog = {
  rows: [
    row('ac-post-office', 'host', { description: '邮局' }),
    row('ac-guardian', 'host'),
    row("ac-ledger", "shell", { tools: [] }),
    row('ac-conversation', 'shell'),
    row('ac-tools', 'shell'),
    row("ac-fs-tools", "shell", { tools: ['fs_read', 'fs_write', 'fs_edit'], bundle: 'fs' }),
    row("ac-fs-search", "shell", { tools: ['fs_glob', 'fs_grep'], bundle: 'fs' }),
    row("ac-shell-tools", "shell", { tools: ['pwsh', 'bash'], bundle: 'infra' }),
    row("ac-run-code", "shell", { tools: ['run_code'], bundle: 'infra' }),
    row("ac-math", "shell", { tools: ['math'] }),
    row("ac-web-tools", "shell", { tools: ['web_search', 'browser'] }),
  ],
};

describe('壳行集派生', () => {
  it('tools 缺省 = 基础壳行集（非捆绑行）', () => {
    const r = deriveShellRowset({}, catalog);
    expect(r.rowIds).toEqual(['ac-conversation', 'ac-ledger', 'ac-math', 'ac-tools', 'ac-web-tools']);
    expect(r.warnings).toEqual([]);
  });

  it('行引用：点名行 id 装载该行全部工具', () => {
    const r = deriveShellRowset({ rows: ['ac-fs-tools'] }, catalog);
    expect(r.rowIds).toEqual(['ac-fs-tools']);
    expect(r.toolNames).toEqual(['fs_edit', 'fs_read', 'fs_write']);
  });

  it('工具点名：按工具词命中提供行（同表多工具单行装载）', () => {
    const r = deriveShellRowset({ rows: ['fs_read', 'fs_glob', 'math'] }, catalog);
    expect(r.rowIds).toEqual(['ac-fs-search', 'ac-fs-tools', 'ac-math']);
  });

  it('捆绑词消解：fs / infra 在派生内展开为组', () => {
    const r = deriveShellRowset({ rows: ['fs'] }, catalog);
    expect(r.rowIds).toEqual(['ac-fs-search', 'ac-fs-tools']);
    const r2 = deriveShellRowset({ rows: ['infra'] }, catalog);
    expect(r2.rowIds).toEqual(['ac-run-code', 'ac-shell-tools']);
  });

  it('include ∪ 展开 + exclude 减法（工具级 = 移除提供行）', () => {
    const r = deriveShellRowset({ rows: { include: ['fs'], exclude: ['fs_glob'] } }, catalog);
    expect(r.rowIds).toEqual(['ac-fs-tools']); // fs-search 行被工具级减法移除
    const r2 = deriveShellRowset({ rows: { include: ['fs', 'infra'], exclude: ['ac-run-code'] } }, catalog);
    expect(r2.rowIds).toEqual(['ac-fs-search', 'ac-fs-tools', 'ac-shell-tools']);
  });

  it('未命中条目 → warnings（boot 静态断言面）', () => {
    const r = deriveShellRowset({ rows: ['no-such-tool', 'fs'] }, catalog);
    expect(r.warnings).toEqual(['tools 条目未命中目录：no-such-tool']);
  });

  it('host 行不可被壳引用（树归属闸）', () => {
    const r = deriveShellRowset({ rows: ['ac-post-office'] }, catalog);
    expect(r.rowIds).toEqual([]);
    expect(r.warnings).toContain('tools 条目未命中目录：ac-post-office');
  });

  it('行集闭包（cr-521）：requires 依赖行自动并入；exclude 减法不被闭包复活', () => {
    const cat: RowsetCatalog = {
      rows: [
        row("x-tools", "shell", { tools: ['x'], requires: ['x-base'] }),
        row('x-base', 'shell'),
        row('x-deep', 'shell', { requires: ['x-tools'] }),
      ],
    };
    const r = deriveShellRowset({ rows: ['x'] }, cat);
    expect(r.rowIds).toEqual(['x-base', 'x-tools']); // 依赖自动并入
    const deep = deriveShellRowset({ rows: ['x-deep'] }, cat);
    expect(deep.rowIds).toEqual(['x-base', 'x-deep', 'x-tools']); // 传递闭包
    const ex = deriveShellRowset({ rows: { include: ['x'], exclude: ['x-base'] } }, cat);
    expect(ex.rowIds).toEqual(['x-tools']); // 排除 = 显式意志（装配终检兜底）
  });

  it('装配基座恒并（cr-548 收信面 + cr-602 提示装配行 + cr-610 池注册行）：点名形态不裁 conversation/persona/system-prompt/llm-pool', () => {
    const cat: RowsetCatalog = {
      rows: [
        row('conversation', 'shell'),
        row('persona', 'shell'),
        row('system-prompt', 'shell'),
        row('llm-pool', 'shell'),
        row("x-tools", "shell", { tools: ['x'] }),
      ],
    };
    // 点名只给工具 x：四行基座仍恒并（导入行集按工具标签推导，装配类行/
    // 池注册行不在标签面——缺席面 = 人格/指引块丢失〔cr-602〕或壳内零
    // provider 注册、一切 run NO_PROVIDER〔cr-610〕）
    const r = deriveShellRowset({ rows: ['x'] }, cat);
    expect(r.rowIds).toEqual(['conversation', 'llm-pool', 'persona', 'system-prompt', 'x-tools']);
    // 显式 exclude = 良定义降级（闭包后减法执行）
    const ex = deriveShellRowset({ rows: { include: ['x'], exclude: ['system-prompt'] } }, cat);
    expect(ex.rowIds).toEqual(['conversation', 'llm-pool', 'persona', 'x-tools']);
  });
});

describe('行目录静态投影（per-agent 化）', () => {
  it('只保留 picked 行与工具词', () => {
    const p = projectCatalog(catalog, new Set(['ac-fs-tools', 'ac-math']));
    expect(p.rows.map((r) => r.id)).toEqual(['ac-fs-tools', 'ac-math']);
    expect(p.rows[0].tools).toEqual(['fs_read', 'fs_write', 'fs_edit']);
  });
});

describe('宿主行集派生 + 盘直读', () => {
  const ROOT = path.join('sandbox', 'test-rowset-' + process.pid);
  beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('偏好只记差异：未提及行默认装载，disabled 出局', () => {
    const r = deriveHostRowset([{ id: 'ac-guardian', disabled: true }], catalog);
    expect(r.rowIds).toEqual(['ac-post-office']);
    expect(r.warnings).toEqual([]);
  });

  it('偏好引用非宿主行 → 警告', () => {
    const r = deriveHostRowset([{ id: 'ac-math', disabled: true }], catalog);
    expect(r.warnings).toEqual(['偏好条目非宿主行：ac-math']);
  });

  it('目录/偏好盘往返', () => {
    expect(readCatalog(defaultCatalogFile(ROOT))).toEqual({ rows: [] });
    fs.writeFileSync(defaultCatalogFile(ROOT), JSON.stringify(catalog), 'utf-8');
    expect(readCatalog(defaultCatalogFile(ROOT)).rows).toHaveLength(11);
    fs.writeFileSync(hostPreferenceFile(ROOT), JSON.stringify([{ id: 'ac-post-office', disabled: true }]), 'utf-8');
    expect(readHostPreferences(ROOT)).toEqual([{ id: 'ac-post-office', disabled: true }]);
  });
});
