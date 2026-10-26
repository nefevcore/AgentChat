// ============================================================
// plugin-request schema 单测（cr-553）：payload 校验 / 信封工厂 /
// isPluginRequest 分流谓词。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  makePluginRequestEnvelope,
  makePluginReceiptEnvelope,
  validatePluginRequestPayload,
  isPluginRequest,
} from '../src/plugin-request.ts';
import type { Envelope } from '../src/envelope.ts';

describe('插件装卸请求信 schema（cr-553）', () => {
  it('install 信工厂：to=host / kind=message / budget=1 / payload 原样', () => {
    const env = makePluginRequestEnvelope({
      uuid: 'user~creator-1',
      requestId: 'plugin-r1',
      sender: 'creator-1',
      payload: { action: 'install', dir: 'dev-hello', conversationId: 'user~creator-1' },
    });
    expect(env.to).toBe('host');
    expect(env.kind).toBe('message');
    expect(env.budget).toBe(1);
    expect(env.sender).toBe('creator-1');
    expect(isPluginRequest(env)).toBe(true);
  });

  it('回执信工厂：kind=receipt / budget=0 / uuid+requestId 原值对账', () => {
    const env = makePluginReceiptEnvelope({
      uuid: 'user~creator-1',
      requestId: 'plugin-r1',
      to: 'creator-1',
      payload: { subject: 'plugin-installed', agent: 'creator-1', ok: true, name: 'dev-hello', version: '1.0.0' },
    });
    expect(env.kind).toBe('receipt');
    expect(env.budget).toBe(0);
    expect(env.uuid).toBe('user~creator-1');
    expect(env.requestId).toBe('plugin-r1');
    expect(isPluginRequest(env)).toBe(false); // receipt 不误判
  });

  it('validate：install 缺 dir / uninstall 缺 name / conversationId 缺席均拒收', () => {
    expect(validatePluginRequestPayload({ action: 'install', dir: '', conversationId: 'c' })[0]).toContain('install 缺 dir');
    expect(validatePluginRequestPayload({ action: 'uninstall', conversationId: 'c' })[0]).toContain('uninstall 缺 name');
    expect(validatePluginRequestPayload({ action: 'install', dir: 'd' }).at(-1)).toContain('conversationId 缺席');
    expect(validatePluginRequestPayload('not-an-object' as unknown)).toEqual(['payload 非对象']);
    expect(validatePluginRequestPayload({ action: 'reload', dir: 'd', conversationId: 'c' })[0]).toContain('action 非法');
  });

  it('validate：合法两形态零 issues', () => {
    expect(validatePluginRequestPayload({ action: 'install', dir: 'dev-hello', conversationId: 'c' })).toEqual([]);
    expect(validatePluginRequestPayload({ action: 'uninstall', name: 'dev-hello', conversationId: 'c' })).toEqual([]);
  });

  it('isPluginRequest 分流：普通 message 信 / usage 信不误判', () => {
    const plain: Envelope = {
      uuid: 'a~b', requestId: 'r', sender: 'a', to: 'b', kind: 'message', budget: 3,
      payload: { text: 'hi' },
    };
    expect(isPluginRequest(plain)).toBe(false);
    const usageLike: Envelope = {
      uuid: 'usage-a', requestId: 'r2', sender: 'a', to: 'host', kind: 'receipt', budget: 0,
      payload: { subject: 'usage-run' },
    };
    expect(isPluginRequest(usageLike)).toBe(false);
  });
});
