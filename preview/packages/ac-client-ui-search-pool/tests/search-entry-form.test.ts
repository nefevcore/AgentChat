// ============================================================
// ac-client-ui-search-pool/tests/search-entry-form.test.ts ——
// 池编排词汇级验收（cr-477 深审补测试）。组件编排面此前全仓零覆盖
//（webui 只锁席位贡献、包内只锁宿主半边 boot graph）。真 vue 渲染
//（项目惯例 createApp 直 mount——@vue/test-utils 不可用）。
// ============================================================
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import SearchEntryForm from '../client/SearchEntryForm.vue';
import SearchPoolManager from '../client/SearchPoolManager.vue';

const mounted: Array<() => void> = [];
afterEach(() => { for (const off of mounted.splice(0)) off(); });

async function tick(n = 4) { for (let i = 0; i < n; i++) await nextTick(); }

/** 挂载并返回「触发组件内部编排」的驱动口（expose 无编排函数——经组件
 *  props/emits 面驱动；Manager 的 onFormSave 只接表单 save 事件） */
function mountForm(pools: Record<string, unknown>, schemas: Record<string, unknown>, editingName: string | null) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const saved: Array<{ name: string; entry: Record<string, unknown> }> = [];
  const app = createApp({
    render: () => h(SearchEntryForm as never, {
      pools, schemas, editingName,
      onSave: (name: string, entry: Record<string, unknown>) => { saved.push({ name, entry }); },
    }),
  });
  app.mount(root);
  mounted.push(() => { app.unmount(); root.remove(); });
  return { root, saved };
}

describe('cr-477 · schema 合成守卫（回归锁）', () => {
  it('池观测 provider 缺席 schemas → 基线 + 观测字段合成，渲染不崩（旧码 undefined.length）', async () => {
    // 2026-09-08 收敛摘除三家 provider 后的存量条目场景：provider 只在池
    // 观测、不在真 schema 表——旧码 out[p].length 在首渲染即 TypeError
    const pools = { legacy: { provider: 'brave', api_key: '••••••••' } };
    const schemas = { tavily: [{ key: 'api_key', label: 'API Key', type: 'password', sensitive: true }] };
    const { root } = mountForm(pools, schemas, 'legacy');
    await tick();
    // 名称 placeholder = 编辑目标名（HTML 属性，不进 textContent）
    expect(root.querySelector('input')?.getAttribute('placeholder')).toBe('legacy');
    expect(root.textContent).toContain('API Key');
    expect(root.textContent).toContain('默认结果数'); // SEARCH_FIELDS 基线（cr-486：model/maxUses 已随 deepseek 专用端点退役）
  });

  it('真 schema 在场优先于基线——基线字段不重复出现', async () => {
    const pools = { tav: { provider: 'tavily' } };
    const schemas = { tavily: [{ key: 'api_key', label: 'API Key', type: 'password', sensitive: true }, { key: 'defaultDepth', label: '默认深度', type: 'text' }] };
    const { root } = mountForm(pools, schemas, null);
    await tick();
    expect(root.textContent).toContain('API Key');
    expect(root.textContent).toContain('默认深度');
    expect(root.textContent).not.toContain('默认结果数'); // 真表在场 → 基线整组让位
  });

  it('观测字段推断：池条目携带基线外字段 → 按值类型呈现（label = 键名）', async () => {
    const pools = { tav: { provider: 'tavily', customFlag: true } };
    const { root } = mountForm(pools, { tavily: [] }, null);
    await tick();
    expect(root.textContent).toContain('customFlag');
  });
});

describe('cr-477 · 池合并编排（SearchPoolManager）', () => {
  it('空池首条保存 → 自动 default:true + 池内单条目（onFormSave 链）', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const updated: Array<Record<string, unknown>> = [];
    let savedCount = 0;
    const app = createApp({
      render: () => h(SearchPoolManager as never, {
        pools: {},
        schemas: {},
        onSaved: () => { savedCount++; },
        'onUpdate:pools': (v: Record<string, unknown>) => { updated.push(v); },
      }),
    });
    app.mount(root);
    mounted.push(() => { app.unmount(); root.remove(); });
    await tick();
    // 驱动内部编排：点「添加」开弹窗 → 表单 save 事件 → onFormSave 合并
    const addBtn = Array.from(root.querySelectorAll('button')).find(b => b.textContent?.includes('添加'));
    addBtn?.click();
    await tick();
    // 表单在 Modal 内（kit Modal teleport 到 body——元素查 body 而非 root）
    const nameInput = document.body.querySelector<HTMLInputElement>('input[placeholder="输入条目名称"]');
    if (nameInput) {
      nameInput.value = 'first-engine';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
    }
    const saveBtn = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.trim() === '保存');
    saveBtn?.click();
    await tick(6);
    expect(updated).toHaveLength(1);
    expect((updated[0]['first-engine'] as Record<string, unknown>).default).toBe(true);
    expect(savedCount).toBe(1);
  });
});
