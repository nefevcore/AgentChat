// ============================================================
// turn-key-merge-order.test.ts —— P1-3/P1-4 cr-1269：
//   P1-3 稳定 key 同刻消歧：同 agent 同轮首 ts 多轮场景 key 唯一
//   （turn-<agent>-<ts>-<n>），不同 ts 轮序数恒 0（key 稳定性不回归）。
//   P1-4 mergeHistoryPage 前插后稳定 ts 排序：直播中上翻续拉
//   （incoming 尾与 existing 头 ts 交叉）合并后局部有序——「拼接假设」
//   变构造保证；常规分页（无交叉）行为不变。
// ============================================================
import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { mergeHistoryPage } from '../client/feed.ts';
import { useTurnDisplayItems } from '../client/useTurnDisplayItems.ts';
import type { ChatMessage, Turn } from '../client/types.ts';

function turn(agent: string, ts: number, content: string): Turn {
  return {
    agent_id: agent,
    steps: [{ assistant: { id: `s-${ts}-${content}`, role: 'agent', content, timestamp: ts } as ChatMessage, tools: [], isStreaming: false }],
    final: null,
  };
}

describe('P1-3 稳定 key 同刻消歧', () => {
  const items = (turns: Turn[]) => useTurnDisplayItems(computed(() => turns)).value;

  it('同 agent 同 ts 多轮 → key 唯一（-0/-1/-2 序数消歧）', () => {
    const list = [turn('neko', 1000, '甲'), turn('neko', 1000, '乙'), turn('neko', 1000, '丙')];
    const keys = items(list).map((x) => x.key);
    expect(keys).toEqual(['turn-neko-1000', 'turn-neko-1000-1', 'turn-neko-1000-2']);
  });

  it('跨 ts 多轮（同 agent）→ 序数恒 0、key 形态不变（稳定性不回归）', () => {
    const list = [turn('neko', 1000, '甲'), turn('neko', 2000, '乙'), turn('neko', 3000, '丙')];
    const keys = items(list).map((x) => x.key);
    expect(keys).toEqual(['turn-neko-1000', 'turn-neko-2000', 'turn-neko-3000']);
  });

  it('同 ts 不同 agent → 各自独立消歧', () => {
    const list = [turn('neko', 1000, '甲'), turn('miko', 1000, '乙'), turn('neko', 1000, '丙')];
    const keys = items(list).map((x) => x.key);
    expect(keys).toEqual(['turn-neko-1000', 'turn-miko-1000', 'turn-neko-1000-1']);
  });
});

describe('P1-4 mergeHistoryPage 前插后稳定 ts 排序', () => {
  const m = (id: string, ts: number): ChatMessage => ({ id, role: 'user', agent_id: 'user', content: id, timestamp: ts } as ChatMessage);

  it('直播中上翻续拉（incoming 尾与 existing 头交叉）→ 合并后局部有序', () => {
    // 场景：existing（已上屏）ts = [3000, 5000]；上翻拉回的一页 incoming
    // ts = [1000, 2000, 4000]（4000 与 existing 交叉——拼接假设被打破）
    const incoming = [m('i-1000', 1000), m('i-2000', 2000), m('i-4000', 4000)];
    const existing = [m('e-3000', 3000), m('e-5000', 5000)];
    const { merged } = mergeHistoryPage(incoming, existing, false);
    expect(merged.map((x) => x.id)).toEqual(['i-1000', 'i-2000', 'e-3000', 'i-4000', 'e-5000']);
  });

  it('常规分页（无交叉）→ 行为不变（稳定排序幂等）', () => {
    const incoming = [m('i-1000', 1000), m('i-2000', 2000)];
    expect(mergeHistoryPage(incoming, [m('e-3000', 3000)], false).merged.map((x) => x.id)).toEqual(['i-1000', 'i-2000', 'e-3000']);
    // 首屏：整体替换（incoming 即全集）
    expect(mergeHistoryPage(incoming, [], true).merged.map((x) => x.id)).toEqual(['i-1000', 'i-2000']);
  });

  it('等时刻行保持输入序（历史在前、直播在后——cr-707 语义）', () => {
    const incoming = [m('i-T', 1000)];
    const existing = [m('e-T', 1000), m('e-2000', 2000)];
    expect(mergeHistoryPage(incoming, existing, false).merged.map((x) => x.id)).toEqual(['i-T', 'e-T', 'e-2000']);
  });

  it('双键去重不回归（persistedMsgId+id 双键同才判重）', () => {
    const p = (id: string, ts: number, pid: string): ChatMessage => ({ ...m(id, ts), persistedMsgId: pid } as ChatMessage);
    // 同锚同渲染 id（历史行与直播行重复投递）→ 判重丢弃
    const incoming = [p('i-1000', 1000, 'pm-1'), p('i-1000', 1000, 'pm-1')];
    const existing = [p('e-2000', 2000, 'pm-2')];
    expect(mergeHistoryPage(incoming, existing, false).merged.map((x) => x.id)).toEqual(['i-1000', 'e-2000']);
  });
});
