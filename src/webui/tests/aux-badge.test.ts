// @vitest-environment jsdom
// ============================================================
// webui/tests/aux-badge.test.ts —— 辅助活动栏 rail 徽章验收
//
// 徽章契约（AuxSidebarPanelDef.rail.badge）：域行供数、壳渲染——
// 数字 >99 封顶「99+」、0/null 不渲染、badge() 抛错不击穿栏
//（安全求值，同 available 谓词姿势）。数据源语义（runview 徽章随
// runs 快照更新）见 clients-runview.test.ts。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import AuxActivityBar from 'ac-client-ui-layout/client/AuxActivityBar.vue';
import type { AuxSidebarPanelDef } from 'ac-client-ui-layout/client/auxSidebarViews.ts';

/** 最小 def 形状（active/component 满足类型；AuxActivityBar 只消费 rail） */
function makeDef(id: string, badge?: () => number | string | null): AuxSidebarPanelDef {
  return {
    id,
    order: 10,
    active: () => false,
    component: { render: () => null },
    rail: { icon: 'activity', title: id, ...(badge ? { badge } : {}) },
  };
}

async function mountBar(defs: AuxSidebarPanelDef[]): Promise<{ root: HTMLElement; unmount: () => void }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render: () => h(AuxActivityBar, { defs, activeId: null }) });
  app.mount(root);
  await nextTick();
  return { root, unmount: () => { app.unmount(); root.remove(); } };
}

function badges(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.aux-ab-badge')].map((el) => el.textContent ?? '');
}

describe('辅助活动栏 rail 徽章（rail.badge 契约）', () => {
  it('数字徽章渲染：>0 显示、0/null 隐藏、>99 封顶「99+」、文本透传', async () => {
    const { root, unmount } = await mountBar([
      makeDef('run', () => 3),
      makeDef('zero', () => 0),
      makeDef('nullish', () => null),
      makeDef('cap', () => 127),
      makeDef('text', () => '√'),
      makeDef('none'), // 无 badge 声明
    ]);
    const btns = [...root.querySelectorAll('.aux-ab-btn')];
    expect(btns).toHaveLength(6);
    // 徽章只在 >0 数字 / 非 null 文本的按钮上：run=3、cap=99+、text=√
    expect(badges(root)).toEqual(['3', '99+', '√']);
    unmount();
  });

  it('安全求值：badge() 抛错 = 该按钮无徽章，栏与兄弟按钮不击穿', async () => {
    const { root, unmount } = await mountBar([
      makeDef('boom', () => { throw new Error('bad source'); }),
      makeDef('ok', () => 2),
    ]);
    expect(badges(root)).toEqual(['2']); // boom 无徽章、ok 正常
    expect(root.querySelectorAll('.aux-ab-btn')).toHaveLength(2);
    unmount();
  });
});
