// ============================================================
// ac-client-ui-plugin-registry/tests/plugin-registry-data.test.ts
// —— 数据面（client/pluginApi）契约锁（cr-328 审计清单#12：21 导出
//    中 16 个零覆盖——五源合成/会话插件面已有 port-b 锁，此处补齐
//    目录直连〔不吞错〕/patch 三态/dep-graph·events 降级/staging
//    人审链/市场链/卸载链 + highRiskOf 未收录 id 回归）
//    纯数据映射层：mock rpc 即全隔离，不 boot 宿主。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as api from '../client/pluginApi.ts';

/** 记录调用的 mock rpc（未注册面抛错——逼测试显式声明期望面） */
function rec(results: Record<string, unknown>) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const rpc = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (!(method in results)) throw new Error(`no such face: ${method}`);
      return structuredClone(results[method]) as T;
    },
  };
  return { rpc, calls };
}

describe('pluginApi · 目录直连（plugin/catalog）', () => {
  it('透传 builtin/note/local/pending 四面', async () => {
    const { rpc } = rec({
      'plugin/catalog': {
        builtin: [{ name: 'ac-hello', assembled: true, fibers: 1 }],
        note: '行组合制内置能力',
        local: [{ name: 'p1', state: 'installed' }],
        pending: [{ pendingId: 'st-1', name: 'p2', version: '1.0', owner: 'host', requiredGrants: ['fs'], createdAt: '2026-01-01' }],
      },
    });
    const cat = await api.getPluginCatalog(rpc);
    expect(cat.builtin).toEqual([{ name: 'ac-hello', assembled: true, fibers: 1 }]);
    expect(cat.note).toBe('行组合制内置能力');
    expect(cat.local).toEqual([{ name: 'p1', state: 'installed' }]);
    expect(cat.pending[0]).toMatchObject({ pendingId: 'st-1', requiredGrants: ['fs'] });
  });

  it('不吞错（2026-08-30 事故契约：RPC 面下线上抛——降级态由宿主呈现，不再吞成空清单）', async () => {
    const { rpc } = rec({}); // plugin/catalog 未注册 → call 抛
    await expect(api.getPluginCatalog(rpc)).rejects.toThrow('no such face: plugin/catalog');
  });
});

describe('pluginApi · 行偏好层（cordis.patch.yml 三态）', () => {
  it('getPatchList 空态兜底（patches/file/warnings 各归空型）', async () => {
    const { rpc } = rec({ 'plugin/patch-list': {} });
    const r = await api.getPatchList(rpc);
    expect(r).toEqual({ patches: [], file: '', warnings: [] });
  });

  it('setPluginPatch：written 态透传 patches + restartRequired；未知 state 归 written', async () => {
    const { rpc, calls } = rec({
      'plugin/patch-set': { state: 'written', restartRequired: true, patches: [{ id: 'x', disabled: true }] },
    });
    const r = await api.setPluginPatch('x', true, rpc);
    expect(r).toEqual({ state: 'written', restartRequired: true, patches: [{ id: 'x', disabled: true }] });
    expect(calls[0].params).toEqual({ id: 'x', disabled: true });
    // 后端漏发 state → 归缺省 written（不把前端拖进未知态）
    const r2 = await api.setPluginPatch('y', false, rec({ 'plugin/patch-set': {} }).rpc);
    expect(r2.state).toBe('written');
    expect(r2.patches).toEqual([]);
  });

  it('setPluginPatch / resetPluginPatches：no-include-row 与 hot 透传', async () => {
    const a = await api.setPluginPatch('x', true, rec({ 'plugin/patch-set': { state: 'no-include-row' } }).rpc);
    expect(a.state).toBe('no-include-row');
    expect(a.restartRequired).toBeUndefined();
    const b = await api.resetPluginPatches('factory', rec({ 'plugin/patch-reset': { state: 'hot', patches: [] } }).rpc);
    expect(b.state).toBe('hot');
    const c = await api.resetPluginPatches('minimal', rec({ 'plugin/patch-reset': { state: 'written', restartRequired: true, patches: [] } }).rpc);
    expect(c).toEqual({ state: 'written', restartRequired: true, patches: [] });
  });
});

describe('pluginApi · 降级面（旧后端缺面 → 空集不阻断）', () => {
  it('getDepGraph / getEventDescriptions 缺面容忍为空', async () => {
    const { rpc, calls } = rec({});
    const dep = await api.getDepGraph(rpc);
    expect(dep).toEqual({ rows: [] });
    const desc = await api.getEventDescriptions(rpc);
    expect(desc).toEqual({ descriptions: [], chains: {} });
    expect(calls.map((c) => c.method)).toEqual(['plugin/dep-graph', 'events/descriptions']);
  });

  it('getEventListeners 空态兜底数组', async () => {
    const { rpc } = rec({ 'events/listeners': {} });
    expect(await api.getEventListeners(rpc)).toEqual({ events: [] });
  });
});

describe('pluginApi · staging 人审链（市场安装 → 暂存 → 批准/拒绝）', () => {
  it('marketSearch 结果透传 + 空结果兜底；marketStage 带 owner + 来源锚定', async () => {
    const { rpc, calls } = rec({
      'market/search': { results: [{ source: 'npm', name: 'p1', spec: 'p1@1.0' }] },
      'market/stage': { staging: { id: 'st-1', name: 'p1' }, source: { tarball: 'https://x/p1.tgz' } },
    });
    const s = await api.marketSearch('p', rpc);
    expect(s.results).toEqual([{ source: 'npm', name: 'p1', spec: 'p1@1.0' }]);
    const st = await api.marketStage('p1@1.0', 'host', rpc);
    expect(st.staging).toMatchObject({ id: 'st-1' });
    expect(st.source).toEqual({ tarball: 'https://x/p1.tgz' });
    expect(calls[1].params).toEqual({ spec: 'p1@1.0', owner: 'host' });
    const empty = await api.marketSearch('q', rec({ 'market/search': {} }).rpc);
    expect(empty).toEqual({ results: [] });
  });

  it('stagePlugin 本地发布 → approve/reject 参数面；getStagingTree/getStagingFile 人审读面', async () => {
    const { rpc, calls } = rec({
      'plugin/stage': { staging: { id: 'st-2' } },
      'plugin/approve': { installed: { name: 'p2' } },
      'plugin/reject': { ok: true },
      'plugin/staging-files': { files: [{ path: 'index.ts', size: 10 }] },
      'plugin/staging-file': { content: 'export {}' },
    });
    const st = await api.stagePlugin('C:/d/p2', 'host', rpc);
    expect(st.staging).toMatchObject({ id: 'st-2' });
    expect(calls[0].params).toEqual({ dir: 'C:/d/p2', owner: 'host' });
    const ap = await api.approvePlugin('st-2', ['fs'], rpc);
    expect(ap.installed).toMatchObject({ name: 'p2', source: 'installed' });
    expect(calls[1].params).toEqual({ id: 'st-2', grants: ['fs'] });
    expect(await api.rejectPlugin('st-2', rpc)).toEqual({ success: true });
    expect(calls[2].params).toEqual({ id: 'st-2' });
    const tree = await api.getStagingTree('st-2', rpc);
    expect(tree.files).toEqual([{ path: 'index.ts', size: 10 }]);
    const file = await api.getStagingFile('st-2', 'index.ts', rpc);
    expect(file).toEqual({ path: 'index.ts', content: 'export {}' });
    // 内容缺失兜底空串（人审只读面不因缺字段崩）
    const blank = await api.getStagingFile('st-2', 'x', rec({ 'plugin/staging-file': {} }).rpc);
    expect(blank.content).toBe('');
  });
});

describe('pluginApi · 卸载与会话链', () => {
  it('uninstallPlugin 透传统计 backupDir；unloadSessionPlugin 走 plugin/unload', async () => {
    const { rpc, calls } = rec({
      'plugin/uninstall': { uninstalled: { backupDir: 'C:/backup/p1' } },
      'plugin/unload': { ok: true },
    });
    const r = await api.uninstallPlugin('p1', rpc);
    expect(r).toEqual({ success: true, backupDir: 'C:/backup/p1' });
    expect(calls[0].params).toEqual({ name: 'p1' });
    expect(await api.unloadSessionPlugin('sess', rpc)).toEqual({ success: true });
    expect(calls[1].params).toEqual({ name: 'sess' });
    // 无备份目录 → 键缺省（不是空串占位）
    const nb = await api.uninstallPlugin('p2', rec({ 'plugin/uninstall': { uninstalled: {} } }).rpc);
    expect(nb).toEqual({ success: true });
    expect('backupDir' in nb).toBe(false);
  });
});

describe('pluginApi · getCatalog 高危/非隔离透传（highRiskOf 回归锁）', () => {
  it('manifest.ui.slots 含未收录 id 不崩（cr-328 可选链断根——五源合成不再被单个脏 manifest 拖崩）', async () => {
    const { rpc } = rec({
      'plugin/loaded': {
        loaded: [{ name: 'dirty', manifest: { name: 'dirty', ui: { isolated: false, slots: ['perspective', 'made-up-slot'] } } }],
      },
      'plugin/installed': { installed: [] },
      'tools/list': { tools: [] },
    });
    const cat = await api.getCatalog(rpc); // 修复前：此处 TypeError（读 undefined.highRisk）
    const p = cat.plugins.find((x) => x.name === 'dirty')!;
    expect(p.uiNonIsolated).toBe(true);
    expect(p.uiHighRiskSlots).toEqual(['perspective']); // 收录高危项保留，未收录 id 静默过滤
  });
});
