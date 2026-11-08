// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/view-parking.test.ts ——
// 视图停靠（session-cache-and-frame-ordering-plan A1）单测
//
// 场景：滚动锚捕获（视口顶部可见条目）+ 泊位 LRU + 思维链折叠位
// 登记/取回（缺席回落默认）。锚捕获用 jsdom 模拟 [data-item-key]
// 条目的 getBoundingClientRect（environment jsdom 已有——见
// transcript-remount / scroll-clamp 族）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parkView, takeParkedView, clearParkedView, captureViewAnchor,
  noteChainExpanded, chainExpandInit, __clearViewParkingForTest,
} from '../client/viewParking.ts';

beforeEach(() => {
  __clearViewParkingForTest();
});

describe('viewParking：滚动泊位（A1）', () => {
  it('park/take 不消费可重复取；clear 清位', () => {
    parkView('single:s1', { anchorKey: 'turn-a-1', scrollTop: 480, msgCount: 12 });
    expect(takeParkedView('single:s1')).toEqual({ anchorKey: 'turn-a-1', scrollTop: 480, msgCount: 12 });
    expect(takeParkedView('single:s1')).toEqual({ anchorKey: 'turn-a-1', scrollTop: 480, msgCount: 12 });
    expect(takeParkedView('single:s2')).toBeUndefined();
    clearParkedView('single:s1');
    expect(takeParkedView('single:s1')).toBeUndefined();
  });

  it('泊位上限 LRU：超限淘汰最旧', () => {
    for (let i = 0; i < 61; i++) parkView('d' + i, { anchorKey: 'k' + i, scrollTop: i, msgCount: 1 });
    expect(takeParkedView('d0')).toBeUndefined(); // 最旧被淘汰
    expect(takeParkedView('d60')?.anchorKey).toBe('k60');
  });

  it('captureViewAnchor：锚 = 首个底边越过视口顶的条目，scrollTop 原样带出', () => {
    const box = document.createElement('div');
    const mk = (key: string, top: number, bottom: number) => {
      const el = document.createElement('div');
      el.dataset.itemKey = key;
      el.getBoundingClientRect = () => ({ top, bottom } as DOMRect);
      box.appendChild(el);
    };
    mk('turn-a-0', -600, -400); // 完全滚出视口上方
    mk('turn-a-1', -30, 200);  // 顶部可见（底边越过视口顶）
    mk('turn-a-2', 210, 400);
    box.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect);
    Object.defineProperty(box, 'scrollTop', { value: 137, configurable: true });
    expect(captureViewAnchor(box)).toEqual({ anchorKey: 'turn-a-1', scrollTop: 137 });
  });

  it('captureViewAnchor：无可见条目返回 null', () => {
    const box = document.createElement('div');
    box.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect);
    expect(captureViewAnchor(box)).toBeNull();
  });
});

describe('viewParking：思维链折叠位（A1）', () => {
  it('登记后取回；缺席回落默认值', () => {
    expect(chainExpandInit('turn-a-1', true)).toBe(true); // 无登记 → 默认
    noteChainExpanded('turn-a-1', false);
    expect(chainExpandInit('turn-a-1', true)).toBe(false); // 用户手动折叠优先
    noteChainExpanded('turn-a-1', true);
    expect(chainExpandInit('turn-a-1', false)).toBe(true);
  });

  it('折叠登记上限淘汰最旧', () => {
    noteChainExpanded('old', false);
    for (let i = 0; i < 500; i++) noteChainExpanded('k' + i, true);
    expect(chainExpandInit('old', true)).toBe(true); // 被淘汰 → 回落默认
    expect(chainExpandInit('k499', false)).toBe(true);
  });
});
