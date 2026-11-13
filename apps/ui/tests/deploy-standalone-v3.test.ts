// ============================================================
// deploy-standalone-v3.test.ts —— 独立部署冒烟（cr-930 切片②；webui-v3 §4.7）
//
// 独立部署 = 部署选项非模式：同一份静态壳 + 宿主地址单来源配置 +
// 宿主 CORS/WS origin 放行。冒烟面：跨源 GET wire / 资产（预检 + 实际
// 请求放行）；未放行源拒绝。无发现协议、无握手、无版本协商
//（CORS 预检即版本面——裁决六）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { makeWebuiRowV3, type WebuiRowV3Handle } from '../src/webui-row-v3.ts';

const servers: WebServerService[] = [];
let profileDir = '';

afterEach(async () => {
  for (const svc of servers.splice(0)) await svc.stop();
  if (profileDir) { await rm(profileDir, { recursive: true, force: true }); profileDir = ''; }
});

async function bootHost(allowedOrigins: string[]): Promise<number> {
  profileDir = await mkdtemp(join(tmpdir(), 'ac-deploy-v3-'));
  await writeFile(join(profileDir, 'webui.yml'), '[]\n'); // 空基座（冒烟只要 wire 面）
  const ctx = new Context();
  const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0, allowedOrigins } as never);
  servers.push(svc);
  const port = await svc.ready();
  const handle: WebuiRowV3Handle = {};
  ctx.plugin(makeWebuiRowV3({ baseUrl: pathToFileURL(profileDir).href + '/', profileDir, handle }));
  return port;
}


describe('webui-v3 独立部署冒烟（静态壳 + 远程宿主）', () => {
  it('放行源：跨源 GET wire 预检与实际请求通过；未放行源拒绝', async () => {
    const shellOrigin = 'http://chat.example'; // 静态壳独立部署位（回环 Origin 走同源语义——CORS 面用非回环域验证）
    const port = await bootHost([shellOrigin]);
    const host = `http://127.0.0.1:${port}`;

    // 预检（CORS 预检即版本面）
    const pre = await fetch(host + '/api/ui/wire', {
      method: 'OPTIONS',
      headers: { origin: shellOrigin, 'access-control-request-method': 'GET' },
    });
    expect(pre.status).toBeLessThan(400);

    // 实际跨源请求
    const wire = await fetch(host + '/api/ui/wire', { headers: { origin: shellOrigin } });
    expect(wire.status).toBe(200);
    expect(JSON.stringify(await wire.json())).toContain('rows');

    // 未放行源：浏览器面拒绝（403）
    const stranger = await fetch(host + '/api/ui/wire', { headers: { origin: 'http://evil.example' } });
    expect(stranger.status).toBe(403);
  });
});
