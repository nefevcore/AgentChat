// ============================================================
// @agentchat/agent-config 测试：P5 manifest.ui 校验
// ============================================================
import { describe, expect, it } from 'vitest';
import { UI_SLOT_IDS, validatePluginManifest } from '../src/manifest';

describe('manifest.ui 校验（P5）', () => {
  it('UI_SLOT_IDS 包含 8 个 slot 白名单', () => {
    expect(UI_SLOT_IDS).toEqual([
      'perspective',
      'tool-result',
      'message-view',
      'ws-event',
      'settings-tab:global',
      'settings-tab:agent',
      'sidebar-action',
      'global-style',
    ]);
  });

  it('合法 ui 声明 + permissions 含 ui → 通过并规范化', () => {
    const check = validatePluginManifest({
      name: 'ui-demo',
      version: '1.0.0',
      entry: 'index.mjs',
      permissions: ['ui'],
      ui: {
        entry: 'ui/dist/index.js',
        styles: ['ui/dist/style.css', 'ui/dist/style.css'],
        slots: ['tool-result', 'settings-tab:agent'],
        isolated: true,
      },
    });
    expect(check.ok).toBe(true);
    expect(check.manifest?.ui).toEqual({
      entry: 'ui/dist/index.js',
      styles: ['ui/dist/style.css'],
      slots: ['tool-result', 'settings-tab:agent'],
      isolated: true,
    });
  });

  it('ui 存在但 permissions 缺少 ui → 报错；补齐后通过', () => {
    const bad = validatePluginManifest({
      name: 'ui-demo',
      version: '1.0.0',
      permissions: ['fs', 'network'],
      ui: { entry: 'ui/dist/index.js' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('；')).toContain('permissions 必须包含 "ui"');

    const ok = validatePluginManifest({
      name: 'ui-demo',
      version: '1.0.0',
      permissions: ['fs', 'network', 'ui'],
      ui: { entry: 'ui/dist/index.js' },
    });
    expect(ok.ok).toBe(true);
  });

  it('ui.slots 仅允许白名单；未知 slot 报错', () => {
    const bad = validatePluginManifest({
      name: 'ui-demo',
      version: '1.0.0',
      permissions: ['ui'],
      ui: { slots: ['tool-result', 'chat-input-command'] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('；')).toContain('未知 slot');
  });

  it('ui.entry/styles 路径守卫：拒绝 .. 与绝对路径', () => {
    const cases = [
      { ui: { entry: '../evil.js' } },
      { ui: { entry: '/etc/passwd' } },
      { ui: { entry: 'C:\\evil.js' } },
      { ui: { styles: ['a/../../evil.css'] } },
      { ui: { styles: ['/abs.css'] } },
      { ui: { entry: '' } },
      { ui: { styles: [''] } },
    ];
    for (const extra of cases) {
      const check = validatePluginManifest({
        name: 'ui-demo',
        version: '1.0.0',
        permissions: ['ui'],
        ...extra,
      });
      expect(check.ok).toBe(false);
    }
  });

  it('ui.isolated 必须为 boolean', () => {
    const bad = validatePluginManifest({
      name: 'ui-demo',
      version: '1.0.0',
      permissions: ['ui'],
      ui: { isolated: 'yes' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('；')).toContain('ui.isolated');
  });

  it('空 ui 对象也视为 ui 声明（默认 entry ui/dist/index.js，需 ui 权限）', () => {
    const bad = validatePluginManifest({ name: 'ui-demo', version: '1.0.0', ui: {} });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('；')).toContain('permissions 必须包含 "ui"');

    const ok = validatePluginManifest({ name: 'ui-demo', version: '1.0.0', permissions: ['ui'], ui: {} });
    expect(ok.ok).toBe(true);
    expect(ok.manifest?.ui).toEqual({});
  });
});
