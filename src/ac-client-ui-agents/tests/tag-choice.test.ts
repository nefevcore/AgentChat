// @vitest-environment jsdom
// ============================================================
// ac-client-ui-agents/tests/tag-choice.test.ts —— 抉择胶囊交互验收
//
// TagChoice.vue（三段胶囊 [tag-name | tag-label | 下拉]：左中段合体
// 启停 + 右段换档弹层）：
//   · 开合：右半 chevron 开弹层 → 选项两行渲染（短名 + 描述）+ 选中 check
//   · 点外关闭：document pointerdown 在组件外 → 弹层关（捕获阶段实现——
//     祖先 @click.stop【设置面板壳 sp-panel 同款】不得阻断关闭；
//     组件内点击不打扰）
//   · 落词：选项点击 → onChoose(tag) + 弹层关；左半启停 → onChoose(none/恢复)
// 真 vue 渲染（项目惯例 createApp 直 mount——@vue/test-utils 不可用）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import TagChoice from '../client/TagChoice.vue';
import { collectExclusiveGroups, type ExclusiveCatalogItem } from '../client/tagExclusive.ts';

const CATALOG: ExclusiveCatalogItem[] = [
  { tag: 'base-access', description: '基础档（缺省）', order: 1, exclusive: 'access-tier', exclusiveNone: true },
  { tag: 'sandbox-access', description: '沙箱档', order: 2, exclusive: 'access-tier' },
  { tag: 'full-access', description: '完全访问档', order: 3, exclusive: 'access-tier' },
];

const GROUP = collectExclusiveGroups(CATALOG).find((g) => g.key === 'access-tier')!;

const mounted: Array<() => void> = [];
afterEach(() => { for (const off of mounted.splice(0)) off(); });

interface Mounted {
  root: HTMLElement;
  choices: () => Array<string | null>;
}

async function mountChoice(over: { value?: string } = {}, opts: { ancestorStop?: boolean } = {}): Promise<Mounted> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const chosen: Array<string | null> = [];
  // 可选拦截冒泡的祖先层（复刻设置面板壳 sp-panel @click.stop 的阻断形态）
  const wrap = document.createElement('div');
  if (opts.ancestorStop) {
    wrap.addEventListener('click', (e) => e.stopPropagation());
    root.appendChild(wrap);
  }
  const host = opts.ancestorStop ? wrap : root;
  const app = createApp({
    render: () => h(TagChoice as never, {
      group: GROUP,
      labelOf: (tag: string) => ({ 'base-access': '基础档', 'sandbox-access': '沙箱档', 'full-access': '完全访问档' })[tag] ?? tag,
      titleOf: (tag: string) => ({ 'base-access': '基础档（缺省）：写类操作走审批', 'sandbox-access': '沙箱档：工作区白名单内自由', 'full-access': '完全访问档：不受沙箱限制' })[tag] ?? tag,
      value: over.value ?? '',
      onChoose: (next: string | null) => { chosen.push(next); },
    }),
  });
  app.mount(host);
  for (let i = 0; i < 4; i++) await nextTick();
  mounted.push(() => { app.unmount(); root.remove(); });
  return { root, choices: () => [...chosen] };
}

function triggerEl(root: HTMLElement, cls: string): HTMLElement {
  const el = root.querySelector(cls);
  if (!el) throw new Error('missing ' + cls);
  return el as HTMLElement;
}

function outsidePointerDown() {
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
}

/** Transition 离场（menu-fade）的节点移除走 rAF 链——jsdom 的 rAF 是
 * setTimeout 语义且 transitionend 永不触发（无 CSSOM），Vue 以 rAF×2 + 兜底
 * 完成离场：实测 8 轮 nextTick 不够、50ms 真实时间够；全量并发满负载下
 * 曾在 60ms 偶发抖动——取 120ms 双倍余量（本文件 9 例共 ~1s，可接受） */
async function settled(): Promise<void> {
  await nextTick();
  await nextTick();
  await new Promise((done) => setTimeout(done, 120));
  await nextTick();
}

describe('TagChoice 弹层开合', () => {
  it('右半 chevron 开弹层：选项两行渲染 + 选中 check；再点关', async () => {
    const { root } = await mountChoice({ value: 'sandbox-access' });
    expect(root.querySelector('.tc-menu')).toBeNull(); // 初始关
    triggerEl(root, '.tc-trigger').click();
    await settled();
    const menu = root.querySelector('.tc-menu');
    expect(menu).toBeTruthy();
    const opts = Array.from(root.querySelectorAll('.tc-option'));
    expect(opts).toHaveLength(3);
    expect(opts[1]?.querySelector('.tc-option-desc')?.textContent).toContain('沙箱档'); // 选中项描述在场
    expect(opts[1]?.classList.contains('selected')).toBe(true); // sandbox 选中
    expect(opts[1]?.querySelector('.tc-option-check')).toBeTruthy();
    triggerEl(root, '.tc-trigger').click(); // 再点同钮 = 关
    await settled();
    expect(root.querySelector('.tc-menu')).toBeNull();
  });

  it('选项点击 → onChoose(tag) + 弹层关', async () => {
    const { root, choices } = await mountChoice({ value: 'sandbox-access' });
    triggerEl(root, '.tc-trigger').click();
    await nextTick();
    (Array.from(root.querySelectorAll('.tc-option'))[2] as HTMLElement).click();
    await settled();
    expect(choices()).toEqual(['full-access']);
    expect(root.querySelector('.tc-menu')).toBeNull();
  });

  it('左半启停：on → onChoose(none 词)；off → onChoose(恢复首档)', async () => {
    const on = await mountChoice({ value: 'full-access' });
    triggerEl(on.root, '.tc-toggle').click();
    expect(on.choices()).toEqual(['base-access']);
    const off = await mountChoice({ value: '' });
    triggerEl(off.root, '.tc-toggle').click();
    expect(off.choices()).toEqual(['sandbox-access']); // pickRestoreTag 首档
  });
});

describe('TagChoice 关闭态描述（置灰已表状态——文案直接写描述）', () => {
  it('无缺省词组关闭态：胶囊文案 = 组 offDesc；弹层顶部「关闭」选项带后果描述', async () => {
    const BT: ExclusiveCatalogItem[] = [
      { tag: 'observe', description: '观察层', order: 1, tier: true, exclusive: 'browser-tier', exclusiveOffDesc: '停用后 browser 工具不可见' },
      { tag: 'manipulate', description: '交互层', order: 2, tier: true, exclusive: 'browser-tier', exclusiveOffDesc: '停用后 browser 工具不可见' },
    ];
    const btGroup = collectExclusiveGroups(BT).find((g) => g.key === 'browser-tier')!;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp({
      render: () => h(TagChoice as never, {
        group: btGroup, labelOf: (t: string) => t, titleOf: (t: string) => ({ observe: '只读族', manipulate: '交互族' })[t] ?? t,
        value: '', onChoose: () => {},
      }),
    });
    app.mount(root);
    await settled();
    mounted.push(() => { app.unmount(); root.remove(); });
    // 三段形式：名段 = 组键（无值无缺省词的身份兜底）+ 文案段 = 组 offDesc
    expect(root.querySelector('.tc-chip-desc')).toBeNull();
    expect(triggerEl(root, '.tc-name').textContent).toBe('browser-tier');
    expect(triggerEl(root, '.tc-label').textContent).toBe('停用后 browser 工具不可见');
    // 弹层顶部「关闭」选项 + 描述
    triggerEl(root, '.tc-trigger').click();
    await settled();
    const off = root.querySelector('.tc-option--off');
    expect(off?.textContent).toContain('关闭（都不选）');
    expect(off?.textContent).toContain('停用后 browser 工具不可见');
  });

  it('有缺省词组关闭态：胶囊文案 = 缺省词 description（目录单源，非 offDesc）', async () => {
    const { root } = await mountChoice({ value: '' }); // access-tier 组（有 base-access）
    expect(root.querySelector('.tc-chip-desc')).toBeNull();
    expect(triggerEl(root, '.tc-name').textContent).toBe('base-access');
    expect(triggerEl(root, '.tc-label').textContent).toBe('基础档（缺省）：写类操作走审批');
    // 弹层无独立「关闭」选项（缺省词即关闭态——选项已含）
    triggerEl(root, '.tc-trigger').click();
    await settled();
    expect(root.querySelector('.tc-option--off')).toBeNull();
  });

  it('启用态：胶囊文案 = 当前档短名（描述在弹层选项里）', async () => {
    const { root } = await mountChoice({ value: 'sandbox-access' });
    expect(root.querySelector('.tc-chip-desc')).toBeNull();
    expect(triggerEl(root, '.tc-name').textContent).toBe('sandbox-access');
    expect(triggerEl(root, '.tc-label').textContent).toBe('沙箱档');
  });
});

describe('TagChoice 点外关闭（捕获阶段——祖先 @click.stop 不阻断）', () => {
  it('弹层开 → 组件外 pointerdown → 关', async () => {
    const { root } = await mountChoice({ value: 'sandbox-access' });
    triggerEl(root, '.tc-trigger').click();
    await nextTick();
    expect(root.querySelector('.tc-menu')).toBeTruthy();
    outsidePointerDown();
    await settled();
    expect(root.querySelector('.tc-menu')).toBeNull();
  });

  it('祖先 @click.stop（设置面板壳形态）不阻断点外关闭', async () => {
    const { root } = await mountChoice({ value: 'sandbox-access' }, { ancestorStop: true });
    triggerEl(root, '.tc-trigger').click();
    await nextTick();
    expect(root.querySelector('.tc-menu')).toBeTruthy();
    outsidePointerDown(); // body 上的 pointerdown：捕获阶段直达，冒泡拦截无效
    await settled();
    expect(root.querySelector('.tc-menu')).toBeNull();
  });

  it('组件内 pointerdown（胶囊自身）不误关弹层', async () => {
    const { root } = await mountChoice({ value: 'sandbox-access' });
    triggerEl(root, '.tc-trigger').click();
    await nextTick();
    triggerEl(root, '.tc-pill').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await nextTick();
    expect(root.querySelector('.tc-menu')).toBeTruthy(); // 仍开
  });
});
