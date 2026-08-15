// ============================================================
// 全局配置保存热生效：viewerId 默认值不丢 + 已注册 Agent 立即解析新 LLM 池
// （回归：保存 LLM 后 chat~admin~undefined + Agent 仍用旧 provider）
// ============================================================
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap';
import { configService } from '@agentchat/server';

let tmp: string;
let prevWs: string | undefined;
let prevCreds: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-save-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  prevCreds = process.env.AGENTCHAT_CREDENTIALS_FILE;
  process.env.AGENTCHAT_WORKSPACE = tmp;
  process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
  fs.writeFileSync(path.join(tmp, '.initialized'), new Date().toISOString(), 'utf-8');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    llmProviders: {
      poolA: { provider: 'deepseek', model: 'm1', default: true },
      poolB: { provider: 'openai', model: 'm2' },
    },
  }, null, 2), 'utf-8');
  const adminDir = path.join(tmp, 'agents', 'admin');
  fs.mkdirSync(adminDir, { recursive: true });
  fs.writeFileSync(path.join(adminDir, 'config.json'), JSON.stringify({
    agent_id: 'admin', name: 'Admin', tags: ['admin'],
  }), 'utf-8');
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  if (prevCreds === undefined) delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  else process.env.AGENTCHAT_CREDENTIALS_FILE = prevCreds;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

describe('全局配置保存（POST /api/config）', () => {
  it('热重载后 Agent 立即切到新默认 LLM；viewerId 等默认值不丢', async () => {
    const port = await freePort();
    const result = await bootstrap({ enableWebUI: true, webuiPort: port });
    try {
      // 启动时解析到默认池 poolA
      expect(result.registry.get('admin')?.llm).toMatchObject({ provider: 'deepseek', model: 'm1' });

      const resp = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            llmProviders: {
              poolA: { provider: 'deepseek', model: 'm1' },
              poolB: { provider: 'openai', model: 'm2', default: true },
            },
          },
        }),
      });
      expect(resp.status).toBe(200);

      // 已注册 Agent 热重载，LLM 解析到新默认池 poolB
      expect(result.registry.get('admin')?.llm).toMatchObject({ provider: 'openai', model: 'm2' });
      // 默认值合并：viewerId 不丢（否则会生成 chat~admin~undefined 会话）
      expect(configService.getGlobalConfig().viewerId).toBe('user');
      expect(configService.getGlobalConfig().maxHops).toBe(5);
    } finally {
      await result.webui?.stop();
      result.timer?.stopAll();
    }
  });
});
