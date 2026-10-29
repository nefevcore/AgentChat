// ============================================================
// 历史排序回归（cr-716）：toHistoryMessages 稳定排序的缺时刻行处理。
// 事故形态：服务端读投影丢 timestamp → Date.parse("")||0 = 0 → user 行
// 整体沉到列表头（刷新后 user/user/assistant/assistant 乱序）。修复后
// 缺时刻行继承前驱时刻，保持在输入序的真实落盘位。
// ============================================================
import { describe, it, expect } from 'vitest';
import { toHistoryMessages } from '../client/historyApi.ts';

const T0 = Date.UTC(2026, 9, 27, 7, 57, 49); // 2026-10-27T07:57:49Z
const iso = (t: number): string => new Date(t).toISOString();

describe('toHistoryMessages 稳定时间排序（cr-716）', () => {
  it('交替多轮：user/assistant 行按时间戳恢复真实交替序', () => {
    const out = toHistoryMessages([
      { role: 'user', content: '问一', message_id: 'm1', timestamp: iso(T0) },
      { role: 'assistant', content: '', agent_id: 'a', message_id: 'm2', timestamp: iso(T0 + 600_000),
        steps: [{ content: '答一正文', ts: T0 + 5_000 }] },
      { role: 'user', content: '问二', message_id: 'm3', timestamp: iso(T0 + 1_200_000) },
      { role: 'assistant', content: '', agent_id: 'a', message_id: 'm4', timestamp: iso(T0 + 1_500_000),
        steps: [{ content: '答二正文', ts: T0 + 1_210_000 }] },
    ], 'conv');
    expect(out.map((m) => String(m.content))).toEqual(['问一', '答一正文', '问二', '答二正文']);
  });

  it('缺时刻行不沉底：继承前驱时刻保持在输入序（乱序事故回归锁）', () => {
    // 事故形状：user 行与无 steps 的 peer 终稿行 timestamp 均缺席
    //（PSessionRecord 声明必填——事故是服务端投影漏带，用宽形状直入）
    const out = toHistoryMessages([
      { role: 'user', content: '问一', message_id: 'm1' },
      { role: 'assistant', content: '答一终稿', agent_id: 'a', message_id: 'm2' },
      { role: 'user', content: '问二', message_id: 'm3' },
      { role: 'assistant', content: '', agent_id: 'a', message_id: 'm4',
        steps: [{ content: '答二步', ts: T0 + 1_210_000 }] },
    ] as never, 'conv');
    // 修复前：前三行 t=0 沉到步行之前并按稳定序重排成 user/user/assistant
    // 交错——修复后缺时刻行整体保持输入序，带真实 ts 的步行落末尾。
    expect(out.map((m) => String(m.content))).toEqual(['问一', '答一终稿', '问二', '答二步']);
  });

  it('头部缺时刻行继承后继：不凭空获得 0 时刻', () => {
    const out = toHistoryMessages([
      { role: 'user', content: '缺时刻首行', message_id: 'm1' },
      { role: 'assistant', content: '', agent_id: 'a', message_id: 'm2', timestamp: iso(T0 + 60_000),
        steps: [{ content: '带时刻步', ts: T0 }] },
    ] as never, 'conv');
    expect(out.map((m) => String(m.content))).toEqual(['缺时刻首行', '带时刻步']);
  });
});
