// ============================================================
// plugin-request schema 单测（cr-553；cr-1175 批 3b 起去请求信封面）：
// payload 校验 + 回执信封工厂。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  makePluginReceiptEnvelope,
  validatePluginRequestPayload,
} from '../src/plugin-request.ts';

describe('插件装卸请求 payload schema（cr-553；服务帧形态）', () => {
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
    expect(env.sender).toBe('host');
  });
});
