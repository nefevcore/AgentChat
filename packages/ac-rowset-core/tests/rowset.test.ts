// ============================================================
// ac-rowset-core 单测（M2.3 验收 / cr-1004 求值引擎）：两段式合成全
// 词形 / 捆绑词消解 / 减法与闭包次序 / 席位护栏 / 用户层停用与豁免 /
// 实例层 fail-loud / 存量 rows 桥 / 宿主偏好派生
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  deriveHostRowset, evaluateAssembly, evaluateLegacyShellRows,
  expandAssemblyTokens, legacyRowsToAgentPatch, SEAT_ROW_IDS,
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
    row("ac-run-code", "shell", { tools: ['run_code'] }),
    row("ac-math", "shell", { tools: ['math'] }),
    row("ac-web-tools", "shell", { tools: ['web_search', 'browser'] }),
  ],
};
const shellRows = catalog.rows.filter((r) => r.tree === 'shell');
const ev = (patch: Partial<Parameters<typeof evaluateAssembly>[0]>) => evaluateAssembly({ base: shellRows, ...patch });

describe('统一求值：存在合成 + 差量合成', () => {
  it('零差量 = 基础集（非捆绑行）', () => {
    const r = ev({});
    // run-code 非捆绑（cr-1021：进基础集——tc-programmatic 收窄单源依赖 mode 工具在场）
    expect(r.rowIds).toEqual(['ac-conversation', 'ac-ledger', 'ac-math', 'ac-run-code', 'ac-tools', 'ac-web-tools']);
    expect(r.warnings).toEqual([]);
  });

  it('加法词形：行引用 / 工具点名 / 捆绑词（行名优先消歧）', () => {
    expect(ev({ agentPatch: [{ id: 'ac-fs-tools' }] }).rowIds).toEqual([
      'ac-conversation', 'ac-fs-tools', 'ac-ledger', 'ac-math', 'ac-run-code', 'ac-tools', 'ac-web-tools',
    ]);
    expect(ev({ agentPatch: [{ id: 'fs_read' }, { id: 'fs_glob' }] }).rowIds).toContain('ac-fs-search');
    expect(ev({ agentPatch: [{ id: 'fs' }] }).rowIds).toContain('ac-fs-search');
    expect(ev({ agentPatch: [{ id: 'infra' }] }).rowIds).toEqual(
      expect.arrayContaining(['ac-shell-tools']),
    );
  });

  it('减法（disabled）与闭包次序：减法不被闭包复活', () => {
    // 捆绑行不进基础集——加法/闭包/减法语义可独立观测
    const base: RowDescriptor[] = [
      row("x-tools", "shell", { tools: ['x'], requires: ['x-base'], bundle: 'xb' }),
      row('x-base', 'shell'),
      row('x-deep', 'shell', { requires: ['x-tools'], bundle: 'xb' }),
    ];
    const r = evaluateAssembly({ base, agentPatch: [{ id: 'x' }] });
    expect(r.rowIds).toEqual(['x-base', 'x-tools']); // 依赖自动并入
    const deep = evaluateAssembly({ base, agentPatch: [{ id: 'x-deep' }] });
    expect(deep.rowIds).toEqual(['x-base', 'x-deep', 'x-tools']); // 传递闭包
    const ex = evaluateAssembly({ base, agentPatch: [{ id: 'x' }, { id: 'x-base', disabled: true }] });
    expect(ex.rowIds).toEqual(['x-tools']); // 排除 = 显式意志（装配终检兜底）
  });

  it('用户层停用（全局减法）与 except 豁免（锚 = agentId）', () => {
    const r = ev({ userPatch: [{ id: 'ac-math', disabled: true }] });
    expect(r.rowIds).not.toContain('ac-math');
    const exempt = ev({ userPatch: [{ id: 'ac-math', disabled: true, except: ['me'] }], agentId: 'me' });
    expect(exempt.rowIds).toContain('ac-math');
    const other = ev({ userPatch: [{ id: 'ac-math', disabled: true, except: ['me'] }], agentId: 'someone' });
    expect(other.rowIds).not.toContain('ac-math');
  });

  it('席位护栏：恒并基座席位停用拒绝生效（管控策略注入）', () => {
    const cat: RowsetCatalog = { rows: [row('conversation', 'shell'), row('ac-math', 'shell', { tools: ['math'] })] };
    const r = evaluateAssembly({ base: cat.rows, userPatch: [{ id: 'conversation', disabled: true }], seatIds: SEAT_ROW_IDS });
    expect(r.rowIds).toContain('conversation');
    expect(r.notices.join()).toContain('恒并基座席位不可停用');
  });

  it('实例层点名被用户层停用且无豁免 = 求值 fail-loud（errors）', () => {
    const r = ev({ userPatch: [{ id: 'ac-fs-tools', disabled: true }], agentPatch: [{ id: 'ac-fs-tools' }] });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('ac-fs-tools');
    // 豁免后放行
    const ok = ev({
      userPatch: [{ id: 'ac-fs-tools', disabled: true, except: ['me'] }],
      agentPatch: [{ id: 'ac-fs-tools' }],
      agentId: 'me',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.rowIds).toContain('ac-fs-tools');
  });

  it('行内 config：条目 config 落 rowConfigs（外层覆盖内层）', () => {
    const r = ev({
      userPatch: [{ id: 'ac-shell-tools', config: { profile: 'base' } }],
      agentPatch: [{ id: 'ac-shell-tools', config: { profile: 'full' } }],
    });
    expect(r.rowConfigs['ac-shell-tools']).toEqual({ profile: 'full' });
  });

  it('未命中条目 → warnings（boot 静态断言面）；host 行不可被壳引用', () => {
    const r = ev({ agentPatch: [{ id: 'no-such-tool' }] });
    expect(r.warnings.join()).toContain('no-such-tool');
    const h = ev({ agentPatch: [{ id: 'ac-post-office' }] });
    expect(h.rowIds).not.toContain('ac-post-office');
    expect(h.warnings.join()).toContain('ac-post-office');
  });

  it('installed 并入存在合成：撞基座名丢弃（保留字护栏）', () => {
    const r = ev({ installed: [{ id: 'ac-math', tree: 'shell' }, { id: 'x-row', tree: 'shell' }] });
    expect(r.rowIds).toContain('x-row');
    expect(r.notices.join()).toContain('撞名');
    // installed 捆绑行不进基础集（按差量加法点名）
    const b = ev({ installed: [{ id: 'x-bundled', tree: 'shell', bundle: 'fs' }] });
    expect(b.rowIds).not.toContain('x-bundled');
    expect(ev({ installed: [{ id: 'x-bundled', tree: 'shell', bundle: 'fs' }], agentPatch: [{ id: 'x-bundled' }] }).rowIds).toContain('x-bundled');
  });
});

describe('存量 rows 桥（cr-1004 §七 确定性转换）', () => {
  it('点名清单 → 加法（T−B）+ 减法（B−T）；席位恒并不被裁', () => {
    // fixture 补真实席位行（persona）——席位护栏词汇单源 SEAT_ROW_IDS
    const base = [...shellRows, row('persona', 'shell')];
    const entries = legacyRowsToAgentPatch(['ac-fs-tools'], base, [], SEAT_ROW_IDS);
    expect(entries).toContainEqual({ id: 'ac-fs-tools' }); // 加法 = T − B
    // 减法 = B − T：未被点名覆盖的基础集行成 disabled 条目（席位除外——恒并）
    const disabledIds = entries.filter((e) => e.disabled === true).map((e) => e.id);
    expect(disabledIds).toContain('ac-math');
    expect(disabledIds).not.toContain('persona'); // 席位在 target 恒含
    // 点名只有 fs-tools：其余基础集行出局、fs-tools 与席位保留
    const r = evaluateLegacyShellRows(['ac-fs-tools'], base, [], SEAT_ROW_IDS);
    expect(r.rowIds).toEqual(expect.arrayContaining(['ac-fs-tools', 'persona']));
    expect(r.rowIds).not.toContain('ac-math');
  });

  it('include/exclude 形态：include 白名单（含 B−T 减法）+ exclude 减法；undefined = 无差量', () => {
    expect(legacyRowsToAgentPatch(undefined, shellRows, [])).toEqual([]);
    const entries = legacyRowsToAgentPatch({ include: ['fs'], exclude: ['ac-run-code'] }, shellRows, []);
    expect(entries).toContainEqual({ id: 'fs' });
    expect(entries).toContainEqual({ id: 'ac-run-code', disabled: true });
    // include 白名单：未被覆盖的基础集行成 B−T 减法（含 include/exclude 差集语义）
    const r = evaluateLegacyShellRows({ include: ['fs'], exclude: ['ac-run-code'] }, shellRows, [], SEAT_ROW_IDS);
    expect(r.rowIds).toEqual(expect.arrayContaining(['ac-fs-tools', 'ac-fs-search']));
    expect(r.rowIds).not.toContain('ac-run-code');
    expect(r.rowIds).not.toContain('ac-math');
  });

  it('词展开纯函数：闭包随行 + 未命中警告', () => {
    expect(expandAssemblyTokens(['fs'], shellRows).rowIds).toEqual(['ac-fs-search', 'ac-fs-tools']);
    const miss = expandAssemblyTokens(['ghost'], shellRows);
    expect(miss.rowIds).toEqual([]);
    expect(miss.warnings.length).toBe(1);
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
