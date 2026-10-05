// @vitest-environment jsdom
// ============================================================
// webui/tests/kit-datepicker.test.ts —— kit DatePicker 标准件（cr-254）
//
// 覆盖：值面（YYYY-MM-DD 等价原生件）、月历网格（周一起始 + 邻月补位
// 禁选）、翻月、选中事件、弹层 Teleport + z 序自适应（cr-184 模式）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { DatePicker } from '@agentchat/webui-kit';

async function mount(host: HTMLElement, modelValue = '') {
  let val = modelValue;
  const app = createApp({
    render: () => h(DatePicker, {
      modelValue: val,
      'onUpdate:modelValue': (v: string) => { val = v; },
    }),
  });
  const mp = document.createElement('div');
  host.appendChild(mp);
  app.mount(mp);
  await nextTick();
  return {
    app,
    get val() { return val; },
    trigger: () => host.querySelector('.ui-dp-trigger') as HTMLButtonElement,
    menu: () => document.querySelector('.ui-dp-menu') as HTMLElement | null,
  };
}

describe('kit DatePicker（cr-254）', () => {
  it('初始值 → 触发器展示 + 打开弹层落在同月视图', async () => {
    const ui = await mount(document.body, '2026-03-08');
    expect(ui.trigger().textContent).toContain('2026-03-08');
    ui.trigger().click();
    await nextTick(); await nextTick();
    const menu = ui.menu();
    expect(menu).toBeTruthy();
    expect(menu!.textContent).toContain('2026 年 3 月');
    ui.app.unmount();
  });

  it('周一起始网格 + 邻月补位禁选', async () => {
    const ui = await mount(document.body, '2026-03-08');
    ui.trigger().click();
    await nextTick(); await nextTick();
    const cells = Array.from(document.querySelectorAll('.ui-dp-cell')) as HTMLButtonElement[];
    expect(cells).toHaveLength(42);
    // 2026-03-01 是周日 → 第一行前 6 格是二月补位（禁用）
    expect(cells[0].textContent).toBe('23'); // 2026-02-23（周一）
    for (let i = 0; i < 6; i += 1) expect(cells[i].disabled).toBe(true);
    expect(cells[6].textContent).toBe('1'); // 3 月 1 日（周日）可点
    expect(cells[6].disabled).toBe(false);
    ui.app.unmount();
  });

  it('点击日期 → emit YYYY-MM-DD 并关层', async () => {
    const ui = await mount(document.body, '');
    ui.trigger().click();
    await nextTick(); await nextTick();
    const cell = Array.from(document.querySelectorAll('.ui-dp-cell')).find(c => c.textContent === '15' && !c.className.includes('is-out')) as HTMLButtonElement;
    cell.click();
    await nextTick();
    expect(ui.val).toMatch(/^\d{4}-\d{2}-15$/);
    expect(ui.menu()).toBeNull();
    ui.app.unmount();
  });

  it('翻月（chevron）→ 视图切换且网格重建', async () => {
    const ui = await mount(document.body, '2026-01-31');
    ui.trigger().click();
    await nextTick(); await nextTick();
    const next = Array.from(document.querySelectorAll('.ui-dp-head button')).pop() as HTMLButtonElement;
    next.click();
    await nextTick();
    expect(ui.menu()!.textContent).toContain('2026 年 2 月');
    ui.app.unmount();
  });

  it('标题上钻年视图（cr-260）：点标题 → 12 月格；选月 → 回月视图', async () => {
    const ui = await mount(document.body, '2026-03-08');
    ui.trigger().click();
    await nextTick(); await nextTick();
    (document.querySelector('.ui-dp-title') as HTMLButtonElement).click();
    await nextTick();
    const mcells = Array.from(document.querySelectorAll('.ui-dp-mcell')) as HTMLButtonElement[];
    expect(mcells).toHaveLength(12);
    // 选中月 = 2026-03 → tint 底（is-msel）；点「7 月」→ 回月视图 2026 年 7 月
    const sel = mcells.find(c => c.className.includes('is-msel'));
    expect(sel?.textContent).toBe('3月');
    (mcells.find(c => c.textContent === '7月') as HTMLButtonElement).click();
    await nextTick();
    expect(ui.menu()!.textContent).toContain('2026 年 7 月');
    ui.app.unmount();
  });

  it('弹窗内打开 → 弹层 z 高于宿主层（cr-184 模式）', async () => {
    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.zIndex = '1200';
    document.body.appendChild(modal);
    const ui = await mount(modal, '');
    ui.trigger().click();
    await nextTick(); await nextTick();
    expect(Number(ui.menu()!.style.zIndex)).toBeGreaterThan(1200);
    document.body.removeChild(modal);
  });
});
