// ============================================================
// @agentchat/plugins 测试：WebUIService（add/list/remove/replace）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { WebUIService, getOrCreateWebUIService } from '../src/webui-service';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-service-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makePluginDir(name: string, version: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'ui', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ui', 'dist', 'index.js'), `export function install() { /* ${version} */ }\n`, 'utf-8');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { color: red; }\n', 'utf-8');
  return dir;
}

describe('WebUIService', () => {
  it('add → list/getEntryDir/remove 基本生命周期', () => {
    const ctx = new Context();
    const webui = new WebUIService(ctx);
    const dir = makePluginDir('my-plugin', '1.0.0');

    const dispose = webui.addEntry('my-plugin', '1.0.0', dir, {
      entry: 'ui/dist/index.js',
      styles: ['style.css'],
      slots: ['tool-result'],
      isolated: false,
    }, 'session', ['fs', 'network', 'ui']);

    const list = webui.listExtensions();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      name: 'my-plugin',
      version: '1.0.0',
      entry: '/ui-plugin/my-plugin/ui/dist/index.js',
      styles: ['/ui-plugin/my-plugin/style.css'],
      slots: ['tool-result'],
      isolated: false,
      status: 'session',
      grantedPermissions: ['fs', 'network', 'ui'],
    });
    expect(webui.getEntryDir('my-plugin')).toBe(path.resolve(dir));

    expect(webui.removeEntry('my-plugin')).toBe(true);
    expect(webui.listExtensions()).toHaveLength(0);
    expect(webui.getEntryDir('my-plugin')).toBeNull();
    expect(webui.removeEntry('my-plugin')).toBe(false);

    dispose(); // 幂等：重复调用不抛错
  });

  it('P5.5：isolated=true 透传到 /api/ui/extensions 描述符（浏览器据此走 iframe 档）', () => {
    const ctx = new Context();
    const webui = new WebUIService(ctx);
    const dir = makePluginDir('iso-plugin', '1.0.0');
    webui.addEntry('iso-plugin', '1.0.0', dir, {
      entry: 'ui/dist/index.js',
      slots: ['global-style'],
      isolated: true,
    }, 'installed', ['ui']);
    expect(webui.listExtensions()[0]).toMatchObject({
      name: 'iso-plugin',
      isolated: true,
      slots: ['global-style'],
      status: 'installed',
    });
  });

  it('同名 addEntry 替换旧 entry（调用旧 disposer）；旧 disposer 可手动移除', () => {
    const ctx = new Context();
    const webui = new WebUIService(ctx);
    const dirV1 = makePluginDir('my-plugin', '1.0.0');
    const dirV2 = makePluginDir('my-plugin', '2.0.0');

    const disposeV1 = webui.addEntry('my-plugin', '1.0.0', dirV1, { entry: 'ui/dist/index.js' }, 'session', ['ui']);
    webui.addEntry('my-plugin', '2.0.0', dirV2, { entry: 'ui/dist/index.js' }, 'installed', ['ui']);

    const list = webui.listExtensions();
    expect(list).toHaveLength(1);
    expect(list[0].version).toBe('2.0.0');
    expect(list[0].status).toBe('installed');
    expect(webui.getEntryDir('my-plugin')).toBe(path.resolve(dirV2));

    // 旧 disposer 现在只作用于旧 entry（已被替换移除），调用不影响新 entry
    disposeV1();
    expect(webui.listExtensions()).toHaveLength(1);
  });

  it('入口文件缺失 → addEntry 抛清晰错误；样式缺失同样抛错', () => {
    const ctx = new Context();
    const webui = new WebUIService(ctx);
    const dir = path.join(tmp, 'missing-entry');
    fs.mkdirSync(dir, { recursive: true });

    expect(() => webui.addEntry('my-plugin', '1.0.0', dir, { entry: 'ui/dist/index.js' }, 'session', ['ui']))
      .toThrow(/入口文件不存在/);

    fs.mkdirSync(path.join(dir, 'ui', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui', 'dist', 'index.js'), 'export {};\n', 'utf-8');
    expect(() => webui.addEntry('my-plugin', '1.0.0', dir, { entry: 'ui/dist/index.js', styles: ['missing.css'] }, 'session', ['ui']))
      .toThrow(/样式文件不存在/);
  });

  it('getOrCreateWebUIService：复用已注册实例；无则创建', () => {
    const ctx = new Context();
    const first = getOrCreateWebUIService(ctx);
    const dir = makePluginDir('shared', '1.0.0');
    first.addEntry('shared', '1.0.0', dir, { entry: 'ui/dist/index.js' }, 'session', ['ui']);

    // ctx.get('webui') 返回 cordis traceable 代理；helper 应复用同一底层实例
    const second = getOrCreateWebUIService(ctx);
    expect(second.listExtensions()).toHaveLength(1);
    expect(ctx.get('webui')).toBeTruthy();
  });
});
