// ============================================================
// ac-system-events/tests —— 纯库单测（cr-1182 批1）
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendSystemEvent, readSystemEventsSince, renderSystemEvents, maxSeqOfEvents,
  lastHostBootRowsetFp, rowsetFingerprintOf, rowsetDiffSummary, systemEventsFile, filterEventsFor,
} from '../src/index.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sysev-'));
});

describe('append / read 往返', () => {
  it('缺席文件读 = 空数组（fail-open）', () => {
    expect(readSystemEventsSince(root, 0)).toEqual([]);
  });

  it('append → seq 单调 +1，delta 按 since 过滤', () => {
    appendSystemEvent(root, 'host-boot', { pid: 1 });
    appendSystemEvent(root, 'shell-start', { agentId: 'a', pid: 2 });
    appendSystemEvent(root, 'rowset-changed', { summary: '新增行 x' });
    const all = readSystemEventsSince(root, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.map((e) => e.kind)).toEqual(['host-boot', 'shell-start', 'rowset-changed']);
    expect(readSystemEventsSince(root, 1).map((e) => e.seq)).toEqual([2, 3]);
    expect(readSystemEventsSince(root, 3)).toEqual([]);
  });

  it('坏行跳过、好行仍可读（append-only 容错）', () => {
    const file = systemEventsFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-json\n' + JSON.stringify({ seq: 1, ts: 123, kind: 'host-boot' }) + '\n', 'utf-8');
    const out = readSystemEventsSince(root, 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.seq).toBe(1);
  });

  it('载荷缺席 = 无 payload 键；非 object payload 不投影', () => {
    appendSystemEvent(root, 'host-boot');
    const [ev] = readSystemEventsSince(root, 0);
    expect(ev!.payload).toBeUndefined();
  });
});

describe('作用域（per-agent vs 全局）', () => {
  it('agentId 落盘往返；filterEventsFor 只保留全局 + 本 Agent 事件', () => {
    appendSystemEvent(root, 'host-boot', { pid: 1 }); // 全局
    appendSystemEvent(root, 'shell-start', {}, 'alice'); // per-agent
    appendSystemEvent(root, 'shell-start', {}, 'bob'); // per-agent（他方）
    const all = readSystemEventsSince(root, 0);
    expect(all.map((e) => e.agentId)).toEqual([undefined, 'alice', 'bob']);
    expect(filterEventsFor(all, 'alice').map((e) => e.seq)).toEqual([1, 2]);
    expect(filterEventsFor(all, 'bob').map((e) => e.seq)).toEqual([1, 3]);
    expect(filterEventsFor(all).map((e) => e.seq)).toEqual([1, 2, 3]); // 无 viewer = 不过滤
  });

  it('读旧写新兼容窗：存量行 payload.agentId 提升为归属位（同样按 per-agent 过滤）', () => {
    const file = systemEventsFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // cr-1182 修补前的存量形态：agentId 在 payload 里
    fs.writeFileSync(file, [
      JSON.stringify({ seq: 1, ts: 1000, kind: 'host-boot', payload: { pid: 1 } }),
      JSON.stringify({ seq: 2, ts: 2000, kind: 'shell-start', payload: { agentId: 'alice' } }),
      JSON.stringify({ seq: 3, ts: 3000, kind: 'shell-start', payload: { agentId: 'bob' } }),
    ].join('\n') + '\n', 'utf-8');
    const all = readSystemEventsSince(root, 0);
    expect(all.map((e) => e.agentId)).toEqual([undefined, 'alice', 'bob']);
    expect(filterEventsFor(all, 'alice').map((e) => e.seq)).toEqual([1, 2]);
    // 旁观者只看到全局 host-boot，看不到任何人的壳重启
    expect(filterEventsFor(all, 'carol').map((e) => e.seq)).toEqual([1]);
    expect(renderSystemEvents(all, 'carol')).not.toContain('壳重启');
  });

  it('renderSystemEvents(viewer)：他方 per-agent 事件不渲染；全滤空 = undefined', () => {
    appendSystemEvent(root, 'shell-start', { pid: 9 }, 'bob');
    expect(renderSystemEvents(readSystemEventsSince(root, 0), 'alice')).toBeUndefined();
    const t = renderSystemEvents(readSystemEventsSince(root, 0), 'bob')!;
    expect(t).toContain('你的 Agent 壳重启');
    expect(t).not.toContain('bob');
  });
});

describe('渲染', () => {
  it('renderSystemEvents：空 = undefined；多条 = 列表句', () => {
    expect(renderSystemEvents([])).toBeUndefined();
    appendSystemEvent(root, 'shell-start', { pid: 42 }, 'nana');
    const text = renderSystemEvents(readSystemEventsSince(root, 0))!;
    expect(text).toContain('[系统状态]');
    expect(text).toContain('你的 Agent 壳重启');
  });

  it('未知 kind 容错渲染（开放词汇）', () => {
    appendSystemEvent(root, 'plugin-installed', { name: 'x' });
    const text = renderSystemEvents(readSystemEventsSince(root, 0))!;
    expect(text).toContain('plugin-installed');
  });
});

describe('水位与指纹', () => {
  it('maxSeqOfEvents：空 = 0；非空 = 尾 seq', () => {
    expect(maxSeqOfEvents([])).toBe(0);
    appendSystemEvent(root, 'a');
    appendSystemEvent(root, 'b');
    expect(maxSeqOfEvents(readSystemEventsSince(root, 0))).toBe(2);
  });

  it('lastHostBootRowsetFp：取最后一条 host-boot 的指纹；缺席 = undefined', () => {
    expect(lastHostBootRowsetFp(root)).toBeUndefined();
    appendSystemEvent(root, 'host-boot', { pid: 1, rowsetFp: 'aaa' });
    appendSystemEvent(root, 'shell-start', { agentId: 'a' });
    expect(lastHostBootRowsetFp(root)).toBe('aaa');
  });

  it('rowsetFingerprintOf：序无关同集同指纹', () => {
    expect(rowsetFingerprintOf(['b', 'a'])).toBe(rowsetFingerprintOf(['a', 'b']));
    expect(rowsetFingerprintOf(['a', 'b'])).not.toBe(rowsetFingerprintOf(['a', 'c']));
  });

  it('rowsetDiffSummary：增删摘要；同集 = undefined', () => {
    expect(rowsetDiffSummary(['a'], ['a'])).toBeUndefined();
    expect(rowsetDiffSummary(['a', 'b'], ['b', 'c'])).toBe('新增行 c；移除行 a');
  });
});
