// ============================================================
// P5.5 策略单测：global-style 重写限制 + isolated request/event 白名单
// ============================================================
import { describe, expect, it } from 'vitest';
import {
  isAllowedIsolatedEvent,
  isAllowedIsolatedRequest,
  rewriteGlobalStyle,
} from '../src/core/extensions/p5.5-policy';

describe('global-style 前缀重写 + 消毒', () => {
  it('普通选择器加插件名作用域前缀；已有前缀不重复加', () => {
    const css = rewriteGlobalStyle('ui-hello', {
      css: '.card { color: red } .ui-hello .btn { color: blue }',
    });
    expect(css).toContain('.ui-plugin-ui-hello .card');
    expect(css).toContain('.ui-plugin-ui-hello .ui-hello .btn');
  });

  it('自定义 scope 与 :root CSS 变量块放行', () => {
    const css = rewriteGlobalStyle('ui-hello', {
      scope: 'hello-custom',
      css: ':root { --hello-color: #fff } .panel { padding: 4px }',
    });
    expect(css).toContain(':root');
    expect(css).toContain('.ui-plugin-hello-custom .panel');
  });

  it('禁止 url() 外链（含大小写变体）', () => {
    expect(() => rewriteGlobalStyle('p', { css: '.a { background: url(https://x/y.png) }' }))
      .toThrow(/被禁止/);
    expect(() => rewriteGlobalStyle('p', { css: '.a { background: URL(data:image/png;base64,xx) }' }))
      .toThrow(/被禁止/);
  });

  it('禁止 @import / at-rule / javascript: / style 标签', () => {
    expect(() => rewriteGlobalStyle('p', { css: '@import url(x)' })).toThrow(/被禁止/);
    expect(() => rewriteGlobalStyle('p', { css: '@media (max-width: 1px) { .a { color: red } }' }))
      .toThrow(/at-rule/);
    expect(() => rewriteGlobalStyle('p', { css: '.a { background: javascript:alert(1) }' }))
      .toThrow(/被禁止/);
    expect(() => rewriteGlobalStyle('p', { css: '.a { content: "</style><script>" }' }))
      .toThrow(/被禁止/);
  });

  it('非法 scope / 空 css / 括号错误拒绝', () => {
    expect(() => rewriteGlobalStyle('p', { scope: 'bad scope!', css: '.a {}' })).toThrow(/scope/);
    expect(() => rewriteGlobalStyle('p', { css: '  ' })).toThrow(/css/);
    expect(() => rewriteGlobalStyle('p', { css: '.a { color: red' })).toThrow(/未闭合/);
  });
});

describe('isolated request/event 白名单', () => {
  it('只读 UI/版本/插件目录端点放行；其他路径拒绝', () => {
    expect(isAllowedIsolatedRequest('GET', '/api/ui/extensions')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/ui/slots')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/config')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/version')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/plugins/catalog')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/plugins/permissions')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/plugins/library')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/plugins/assembly/admin')).toBe(true);

    expect(isAllowedIsolatedRequest('POST', '/api/plugins/library/stage')).toBe(false);
    expect(isAllowedIsolatedRequest('GET', '/api/workspace')).toBe(false);
    expect(isAllowedIsolatedRequest('GET', '/api/agents')).toBe(false);
    expect(isAllowedIsolatedRequest('GET', '/api/plugins/catalog/../workspace')).toBe(false);
  });

  it('事件只允许插件生命周期类型', () => {
    expect(isAllowedIsolatedEvent('ui.extensions.changed')).toBe(true);
    expect(isAllowedIsolatedEvent('plugin.catalog.changed')).toBe(true);
    expect(isAllowedIsolatedEvent('plugin.reload')).toBe(true);
    expect(isAllowedIsolatedEvent('agent.assembly.changed')).toBe(true);
    expect(isAllowedIsolatedEvent('chat.message.end')).toBe(false);
    expect(isAllowedIsolatedEvent('message.received')).toBe(false);
  });
});
