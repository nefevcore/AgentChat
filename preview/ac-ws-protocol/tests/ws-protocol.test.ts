import { describe, it, expect } from 'vitest';
import {
  parseFrame,
  buildFrame,
  parseRpcCall,
  isBackgroundSender,
  RPC_CALL,
  type WsFrame,
} from '../src/index.ts';

describe('ac-ws-protocol 帧编解码', () => {
  it('build → parse 往返', () => {
    const raw = buildFrame('loop/after-step', { agent: 'a', step: { index: 0 } });
    expect(parseFrame(raw)).toEqual({
      type: 'loop/after-step',
      data: { agent: 'a', step: { index: 0 } },
    });
  });

  it('data 缺省归一为空对象（前端免判空）', () => {
    expect(parseFrame(buildFrame('config/changed'))).toEqual({ type: 'config/changed', data: {} });
  });

  it('非法输入返回 null：坏 JSON / 非对象 / 缺 type / 空 type', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('42')).toBeNull();
    expect(parseFrame('{"data":1}')).toBeNull();
    expect(parseFrame('{"type":""}')).toBeNull();
    expect(parseFrame('null')).toBeNull();
  });

  it('业务帧 type = 事件名直转（协议目录即事件目录）', () => {
    for (const type of ['llm/delta', 'group/message-posted', 'plugin/catalog-changed', 'ws/ack']) {
      const frame = parseFrame(buildFrame(type, { x: 1 }));
      expect(frame?.type).toBe(type);
    }
  });
});

describe('ac-ws-protocol rpc/call', () => {
  it('合法载荷解析', () => {
    const frame: WsFrame = {
      type: RPC_CALL,
      data: { method: 'chat.send', requestId: 'r1', params: { to: 'a', text: 'hi' } },
    };
    expect(parseRpcCall(frame)).toEqual({
      method: 'chat.send',
      requestId: 'r1',
      params: { to: 'a', text: 'hi' },
    });
  });

  it('缺 method / requestId / 非 rpc 帧 → null', () => {
    expect(parseRpcCall({ type: RPC_CALL, data: { requestId: 'r1' } })).toBeNull();
    expect(parseRpcCall({ type: RPC_CALL, data: { method: 'm' } })).toBeNull();
    expect(parseRpcCall({ type: 'other', data: { method: 'm', requestId: 'r' } })).toBeNull();
  });
});

describe('ac-ws-protocol 后台源判定', () => {
  it("sender='event' 为后台；user/agent/缺省为前台", () => {
    expect(isBackgroundSender('event')).toBe(true);
    expect(isBackgroundSender('user')).toBe(false);
    expect(isBackgroundSender('agent')).toBe(false);
    expect(isBackgroundSender(undefined)).toBe(false);
  });
});
