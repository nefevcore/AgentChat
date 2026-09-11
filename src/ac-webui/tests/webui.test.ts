// ============================================================
// ac-webui：entries 清单 + /ui-plugin/ 静态 + extensions-changed 事件
//（M30 D7：服务端 slot 注册表测试块随 ctx.uiExtensions 退役移除——
//  现行防线 = 浏览器侧 host.ts install 15s 超时 + bridge
//  assertDeclarableSlot 账本派生校验，各有测试锁定）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { WebUiService } from '../src/service.ts';

const servers: WebServerService[] = [];
const webuis: WebUiService[] = [];

function makeCtx(): Context {
  return new Context();
}

afterEach(async () => {
  for (const svc of servers.splice(0)) await svc.stop();
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
