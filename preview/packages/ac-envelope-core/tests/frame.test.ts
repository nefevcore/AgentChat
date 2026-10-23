// ============================================================
// 帧层与 socket 命名规则单测（M1.2）：encode/decode 往返 / 粘包半包 /
// 上限防护 / 跨平台命名映射
// ============================================================
import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, FRAME_HEADER_BYTES, MAX_FRAME_BYTES } from '../src/frame.ts';
import { socketPathFor, assertEndpointComponent } from '../src/socket.ts';

describe('frame：长度前缀帧 encode/decode', () => {
  it('单帧往返：[4B 长度头][JSON] 结构原样还原', () => {
    const payload = { uuid: 'u1', requestId: 'r1', budget: 3 };
    const frame = encodeFrame(payload);
    const d = new FrameDecoder();
    expect(d.push(frame)).toEqual([payload]);
  });

  it('帧头 = 4 字节大端载荷长度', () => {
    const frame = encodeFrame({ a: 1 });
    expect(frame.subarray(0, 4).readUInt32BE(0)).toBe(frame.length - FRAME_HEADER_BYTES);
  });

  it('粘包：两帧一次喂入切出两条', () => {
    const d = new FrameDecoder();
    const wired = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]);
    expect(d.push(wired)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('半包：逐字节喂入只在完整帧出现时吐出', () => {
    const d = new FrameDecoder();
    const frame = encodeFrame('hello');
    let out: unknown[] = [];
    for (const b of frame) out = [...out, ...d.push(Buffer.from([b]))];
    expect(out).toEqual(['hello']);
  });

  it('混合切块：任意分割点下序列等价', () => {
    const payloads = [{ x: 1 }, 'str', [1, 2, 3], null, true];
    const wired = Buffer.concat(payloads.map((p) => encodeFrame(p)));
    // 覆盖全部字节的任意切块（2B 窗口滑动推进，含尾字节）
    const d = new FrameDecoder();
    let out: unknown[] = [];
    for (let i = 0; i < wired.length; i += 2) {
      const piece = wired.subarray(i, Math.min(i + 2, wired.length));
      out = [...out, ...d.push(piece)];
    }
    expect(out).toEqual(payloads);
  });

  it('超限防护：载荷超 8MB 抛错（fail-loud 而非缓冲膨胀）', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame(big)).toThrow();
    // 帧头声明超限同样断连
    const evil = Buffer.alloc(FRAME_HEADER_BYTES);
    evil.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const d = new FrameDecoder();
    expect(() => d.push(evil)).toThrow();
  });

  it('空对象/空串等退化载荷合法（载荷语义归上层）', () => {
    const d = new FrameDecoder();
    expect(d.push(encodeFrame({}))).toEqual([{}]);
    expect(d.push(encodeFrame(''))).toEqual(['']);
  });
});

describe('socket：命名规则（M1.2 同批钉）', () => {
  it('posix 规范形态：<dataRoot>/ipc/<agentId>.sock', () => {
    expect(socketPathFor('/srv/agentchat', 'agent-a', 'linux')).toBe('/srv/agentchat/ipc/agent-a.sock');
    expect(socketPathFor('C:\\data\\root', 'bob', 'linux')).toBe('C:/data/root/ipc/bob.sock');
  });

  it('win32 映射 named pipe：数据根整体入名（多数据根不撞名）', () => {
    const p = socketPathFor('C:\\Users\\x\\root', 'agent-a', 'win32');
    expect(p.startsWith('\\\\.\\pipe\\agentchat-')).toBe(true);
    expect(p).toContain('agent-a-sock');
    // 不同数据根 → 不同管道名
    const p2 = socketPathFor('D:\\other\\root', 'agent-a', 'win32');
    expect(p2).not.toBe(p);
  });

  it('fail-loud：相对 dataRoot / 空 agentId / 路径穿越组件拒绝', () => {
    expect(() => socketPathFor('rel/path', 'a', 'linux')).toThrow();
    expect(() => socketPathFor('/root', '', 'linux')).toThrow();
    expect(() => socketPathFor('/root', 'a/b', 'linux')).toThrow();
    expect(() => socketPathFor('/root', '..', 'linux')).toThrow();
    expect(() => assertEndpointComponent('a\\\\b', 'agentId')).toThrow();
  });
});
