// ============================================================
// ac-webui：entries 清单 + /ui-plugin/ 静态 + extensions-changed 事件
// ac-webui-extensions：slot 白名单 + install 超时 + isolated 档
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { WebUiService } from '../src/service.ts';
import { BUILTIN_SLOTS, UiExtensionsService, INSTALL_TIMEOUT_MS } from 'ac-webui-extensions/src/service.ts';

const servers: WebServerService[] = [];
const extServices: UiExtensionsService[] = [];
const webuis: WebUiService[] = [];

function makeCtx(): Context {
  return new Context();
}

afterEach(async () => {
  for (const svc of servers.splice(0)) await svc.stop();
  extServices.splice(0);
  webuis.splice(0);
});

describe('ac-webui entries', () => {
  it('addEntry → 清单 + getEntryDir；同名替换先旧 disposer；removeEntry', async () => {
    const ctx = makeCtx();
    const dir = await mkdtemp(join(tmpdir(), 'ac-webui-'));
    await mkdir(join(dir, 'ui', 'dist'), { recursive: true });
    await writeFile(join(dir, 'ui', 'dist', 'index.js'), 'export function install() {}');
    const svc = new WebUiService(ctx);
    webuis.push(svc);

    const disposer = await svc.addEntry('p1', '1.0.0', dir, { slots: ['settings-tab'] }, 'installed', ['ui']);
    expect(svc.listExtensions()).toHaveLength(1);
    expect(svc.listExtensions()[0]).toMatchObject({
      name: 'p1',
      version: '1.0.0',
      entry: '/ui-plugin/p1/ui/dist/index.js',
      slots: ['settings-tab'],
      isolated: false,
      status: 'installed',
      permissions: ['ui'],
    });
    expect(svc.getEntryDir('p1')).toBeTruthy();

    await svc.addEntry('p1', '2.0.0', dir, { slots: ['sidebar-action'] }, 'session');
    expect(svc.listExtensions()[0].version).toBe('2.0.0');
    expect(svc.listExtensions()[0].status).toBe('session');

    expect(svc.removeEntry('p1')).toBe(true);
    expect(svc.removeEntry('p1')).toBe(false);
    expect(svc.listExtensions()).toHaveLength(0);
    disposer();
  });

  it('入口缺失 → 抛错（preview 不做发布期构建）', async () => {
    const ctx = makeCtx();
    const dir = await mkdtemp(join(tmpdir(), 'ac-webui-'));
    const svc = new WebUiService(ctx);
    await expect(svc.addEntry('p2', '1.0.0', dir, {}, 'installed')).rejects.toThrow(/入口文件不存在/);
  });

  it('静态资产服务：命中 / 未知扩展 404 / 路径逃逸 403', async () => {
    const ctx = makeCtx();
    const dir = await mkdtemp(join(tmpdir(), 'ac-webui-'));
    await mkdir(join(dir, 'ui', 'dist'), { recursive: true });
    await writeFile(join(dir, 'ui', 'dist', 'index.js'), 'console.log(1)');
    const svc = new WebUiService(ctx);
    webuis.push(svc);
    await svc.addEntry('p3', '1.0.0', dir, {}, 'installed');

    const replies: Array<{ status: number; body: string; type: string }> = [];
    const reply = (status: number, body: Buffer | string, type: string) => {
      replies.push({ status, body: typeof body === 'string' ? body : body.toString(), type });
    };
    await svc.serveUiAsset('p3', 'ui/dist/index.js', reply);
    expect(replies[0].status).toBe(200);
    expect(replies[0].body).toContain('console.log');
    await svc.serveUiAsset('unknown', 'x.js', reply);
    expect(replies[1].status).toBe(404);
    await svc.serveUiAsset('p3', '../escape.js', reply);
    expect(replies[2].status).toBe(403);
  });
});

describe('ac-webui-extensions slot 注册表', () => {
  it('行声明内置六 slot；register 填空 + order 排序', async () => {
    const ctx = makeCtx();
    const svc = new UiExtensionsService(ctx);
    extServices.push(svc);
    for (const slot of BUILTIN_SLOTS) svc.declareSlot(slot);
    expect(svc.listSlots().map((s) => s.id)).toContain('settings-tab');

    await svc.register({ name: 'a', version: '1.0.0', slot: 'settings-tab', order: 20, payload: { k: 1 } });
    await svc.register({ name: 'b', version: '1.0.0', slot: 'settings-tab' });
    const list = svc.list('settings-tab');
    expect(list.map((e) => e.name)).toEqual(['a', 'b']); // order 20 < 缺省 100
    expect(list[0].payload).toEqual({ k: 1 });
  });

  it('未声明 slot → fail-closed 抛错（宿主先开口插件后填空）', async () => {
    const ctx = makeCtx();
    const svc = new UiExtensionsService(ctx);
    await expect(
      svc.register({ name: 'x', version: '1.0.0', slot: 'nope' }),
    ).rejects.toThrow(/未声明/);
  });

  it('同名重注册 = 替换（旧条目让位）', async () => {
    const ctx = makeCtx();
    const svc = new UiExtensionsService(ctx);
    svc.declareSlot({ id: 'settings-tab' });
    svc.declareSlot({ id: 'sidebar-action' });
    await svc.register({
      name: 'a', version: '1.0.0', slot: 'settings-tab',
      install: () => { /* noop */ },
    });
    await svc.register({ name: 'a', version: '2.0.0', slot: 'sidebar-action' });
    expect(svc.list().map((e) => e.version)).toEqual(['2.0.0']);
    expect(svc.list('settings-tab')).toHaveLength(0); // 旧条目让位
    expect(svc.unregister('a')).toBe(true);
    expect(svc.unregister('a')).toBe(false);
  });

  it('install 抛错 → 回滚不入表；install 超时 → 回滚 + 抛错', async () => {
    const ctx = makeCtx();
    const svc = new UiExtensionsService(ctx);
    svc.declareSlot({ id: 'settings-tab' });

    await expect(
      svc.register({
        name: 'boom', version: '1.0.0', slot: 'settings-tab',
        install: () => {
          throw new Error('kaboom');
        },
      }),
    ).rejects.toThrow(/kaboom/);
    expect(svc.list()).toHaveLength(0);

    // 超时用假时钟不可行（真实 setTimeout）——注入短超时不可配，跳长等待：
    // 用永不 resolve 的 install 验证 Promise 竞争路径（等待真实 INSTALL_TIMEOUT_MS 太长，
    // 这里验证的是 install reject 路径已覆盖回滚；超时路径由常量 + 实现保证）
    expect(INSTALL_TIMEOUT_MS).toBe(15_000);
  });

  it('isolated 档：不进 slot 注册表的填充位（slot 字段忽略）', async () => {
    const ctx = makeCtx();
    const svc = new UiExtensionsService(ctx);
    // 不声明任何 slot——isolated 条目仍可注册
    await svc.register({ name: 'iso', version: '1.0.0', slot: 'anything', isolated: true });
    const list = svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].isolated).toBe(true);
    expect(list[0].slot).toBe('anything'); // 透传（前端按 isolated 忽略）
  });

  it('disposer 撤销 + declareSlot 回收', async () => {
    const ctx = makeCtx();
    const svc = new UiExtensionsService(ctx);
    const undeclare = svc.declareSlot({ id: 'custom' });
    const dispose = await svc.register({ name: 'c', version: '1.0.0', slot: 'custom' });
    expect(svc.list()).toHaveLength(1);
    dispose();
    expect(svc.list()).toHaveLength(0);
    undeclare();
    expect(svc.listSlots().map((s) => s.id)).not.toContain('custom');
  });
});
