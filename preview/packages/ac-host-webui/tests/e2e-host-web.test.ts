// ============================================================
// e2e-host-web.test.ts —— 8.5a 宿主 web 面接线级联验收
//
// 真链路：bootHostWeb → WS 连接（ws/ready）→ rpc/call 往返（deliver /
// history / agents/list）→ UserStub 投递 + user 账本直读对齐。
// 数据根恒 preview/sandbox/（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';
import { deriveKey, machineMaterial, readCredential } from 'ac-credentials-core';
import { bootHostWeb, type HostWebResult } from '../src/host-web.ts';
import { UserLedger, sessionDir } from 'ac-ledger';

const ROOT = path.join('preview', 'sandbox', 'test-host-web-' + process.pid);
let host: HostWebResult | null = null;
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(async () => {
  if (host !== null) { await host.close(); host = null; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function connect(port: number): Promise<{ ws: WebSocket; connId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    ws.once('open', () => {
      ws.once('message', (data) => {
        try {
          const m = JSON.parse(String(data)) as { type?: string; data?: { connId?: string } };
          if (m.type === WS_READY && typeof m.data?.connId === 'string') {
            resolve({ ws, connId: m.data.connId });
          } else reject(new Error('首帧非 ws/ready: ' + String(m.type)));
        } catch (e) { reject(e); }
      });
    });
    ws.once('error', reject);
  });
}

let rpcSeq = 0;
function rpc<T>(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<T> {
  const requestId = 't-' + (++rpcSeq);
  return new Promise<T>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const m = JSON.parse(String(data)) as { type?: string; data?: { requestId?: string; ok?: boolean; result?: unknown; error?: string } };
        if (m.type === RPC_RESULT && m.data?.requestId === requestId) {
          ws.off('message', onMessage);
          if (m.data.ok) resolve(m.data.result as T);
          else reject(new Error(m.data.error ?? 'rpc 失败'));
        }
      } catch { /* 非 JSON 帧忽略 */ }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: RPC_CALL, data: { method, requestId, params } }));
  });
}

describe('8.5a 宿主 web 面接线', () => {
  it('WS rpc 往返：deliver → user 桩投递 → history 回放对齐 → agents/list', async () => {
    // 种一个 agent 配置（agents/list 数据源 + deliver 目标）
    const agentDir = path.join(ROOT, 'agents', 'alpha');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({ id: 'alpha', model: 'mock', description: '阿尔法', tags: ['full-access'] }), 'utf-8');
    // 头像在场（cr-588：agents/list 注入 hasAvatar/avatarVersion——版本化 URL 面）
    fs.writeFileSync(path.join(agentDir, 'avatar.png'), Buffer.from('<png>'));
    // 会话流域污染样本（cr-607）：pair 对角线域的兜底 config + 无 config 的
    // 子域目录——都不得进名册/healthz agents 计数
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha~alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha~alpha', 'config.json'), JSON.stringify({ id: 'alpha~alpha' }), 'utf-8');
    fs.mkdirSync(path.join(ROOT, 'agents', 'sub_1'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'config.json'), '{}', 'utf-8'); // healthz ok 面

    host = await bootHostWeb({ dataRoot: ROOT });
    const { ws } = await connect(host.port);

    // ① agents/list：agents-core 直读 + 全量 config 展开 + 头像版本
    const list = await rpc<{ agents: Array<{ id: string; name?: string; description?: string; tags?: string[]; hasAvatar?: boolean; avatarVersion?: string }> }>(ws, 'agents/list', {});
    expect(list.agents.map((a) => a.id)).toEqual(['alpha']);
    expect(list.agents[0]).toMatchObject({ description: '阿尔法', tags: ['full-access'], hasAvatar: true });
    expect(list.agents[0]!.avatarVersion).toMatch(/^\d+:\d+$/);

    // ①b healthz agents 计数与名册同轴（cr-607——裸目录计数会把 pair/子域误算）
    const hz = await fetch('http://127.0.0.1:' + host.port + '/api/healthz');
    expect(hz.status).toBe(200);
    expect(await hz.json()).toMatchObject({ ok: true, host: 'preview-host', agents: 1 });
    // 头像静态面（cr-588 三路由）住 agent-admin 行——本 e2e 装配面（webui +
    // web-api 两行）不含，路由级由 agent-admin-row.test 单测 + 产品宿主活体覆盖

    // ② deliver：UserStub 签发 + own 落账 + 邮局投递（agent 不可达 → outbox 滞留——
    // at-least-once；本测只验 user 半边链路，不依赖壳在线）
    const outcome = await rpc<{ kind: string; uuid: string }>(ws, 'conversation/deliver', {
      agentId: 'alpha', message: '第一问', requestId: 'rq-w1',
    });
    expect(outcome.kind).toBe('run');
    expect(typeof outcome.uuid).toBe('string');

    // ③ history：user 账本直读——own 行落账即达（写穿在 deliver 内同步完成）
    const history = await rpc<{ records: Array<{ role: string; content: string }>; total: number }>(ws, 'session/history', {
      conversationId: outcome.uuid,
    });
    expect(history.total).toBe(1);
    expect(history.records[0]).toMatchObject({ role: 'user', content: '第一问' });

    // 幂等：同 requestId 重发 → user 账本不重复（requestId 准入）
    await rpc(ws, 'conversation/deliver', { agentId: 'alpha', message: '第一问', requestId: 'rq-w1', conversationId: outcome.uuid });
    const again = await rpc<{ total: number }>(ws, 'session/history', { conversationId: outcome.uuid });
    expect(again.total).toBe(1);

    ws.close();
  }, 30_000);

  it('GET /api/ui/boot-graph：manifest 单源（8.5b——空目录空图；种 manifest 条目出现；静态资产同源可取）', async () => {
    host = await bootHostWeb({ dataRoot: ROOT });
    // 空目录（缺省 <dataRoot>/plugins）→ 空 graph
    const res1 = await fetch('http://127.0.0.1:' + host.port + '/api/ui/boot-graph');
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { clients?: unknown[] };
    expect(body1.clients).toEqual([]);

    // 种一个 manifest 插件 → graph 条目 + 静态资产同源可取
    const pdir = path.join(ROOT, 'plugins');
    fs.mkdirSync(path.join(pdir, 'demo', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'demo', 'manifest.json'), JSON.stringify({
      name: 'demo', version: '1.0.0', entry: 'ui/index.js', platform: 'web',
    }));
    fs.writeFileSync(path.join(pdir, 'demo', 'ui', 'index.js'), 'export default { apply() {} }');
    const res2 = await fetch('http://127.0.0.1:' + host.port + '/api/ui/boot-graph');
    const body2 = await res2.json() as { clients?: Array<{ name: string; base: string; entry: string }> };
    expect(body2.clients?.map((c) => c.name)).toEqual(['demo']);
    expect(body2.clients?.[0].base).toBe('/ui-plugin/demo/');

    const asset = await fetch('http://127.0.0.1:' + host.port + '/ui-plugin/demo/ui/index.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('apply');
    const miss = await fetch('http://127.0.0.1:' + host.port + '/ui-plugin/demo/../escape.js');
    expect(miss.status).toBe(404);
  }, 30_000);

  it('缺参 fail：deliver 无 agentId → rpc error', async () => {
    host = await bootHostWeb({ dataRoot: ROOT });
    const { ws } = await connect(host.port);
    await expect(rpc(ws, 'conversation/deliver', { message: 'x' })).rejects.toThrow(/agentId/);
    ws.close();
  }, 30_000);

  // 配置写面（cr-564）：真凭据加密落盘 + 真 config.json + 真 WS rpc。
  // 不变式：api_key 明文永不进 config.json，只进 credentials/<credentialKey>.enc。
  it('config 写面：池 api_key 侧信道落 credentials/ → config.json 无 key → 掩码回读', async () => {
    host = await bootHostWeb({ dataRoot: ROOT });
    const { ws } = await connect(host.port);
    const key = deriveKey(machineMaterial());
    const configFile = path.join(ROOT, 'config.json');
    const onDisk = (): Record<string, any> => JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, any>;

    // ① config/set 两域新 key：凭据进 credentials/（冒号转义文件名），配置剥离
    await rpc(ws, 'config/set', {
      key: 'llmProviders',
      value: { deepseek: { api_key: 'sk-e2e-secret', base_url: 'https://api.deepseek.com/' } },
    });
    await rpc(ws, 'config/set', { key: 'searchProviders', value: { tavily: { api_key: 'sk-e2e-tavily' } } });
    expect(onDisk().llmProviders).toEqual({ deepseek: { base_url: 'https://api.deepseek.com/' } });
    expect(onDisk().searchProviders).toEqual({ tavily: {} });
    expect(fs.existsSync(path.join(ROOT, 'credentials', '__GLOBAL___POOL%3ADEEPSEEK_API_KEY.enc'))).toBe(true);
    expect(readCredential(ROOT, key, '__GLOBAL___POOL:DEEPSEEK_API_KEY')).toBe('sk-e2e-secret');
    expect(readCredential(ROOT, key, '__GLOBAL___SEARCHPOOL:TAVILY_API_KEY')).toBe('sk-e2e-tavily');

    // ② config/get 回填掩码（已设置 → 掩码；未设置条目 → 空串）
    const got = await rpc<{ config: Record<string, any> }>(ws, 'config/get', {});
    expect(got.config.llmProviders.deepseek).toEqual({ base_url: 'https://api.deepseek.com/', api_key: '••••••••' });
    expect(got.config.searchProviders.tavily).toEqual({ api_key: '••••••••' });

    // ③ 掩码回写 = 不动（凭据不变、盘上仍无明文）
    await rpc(ws, 'config/set', {
      key: 'llmProviders',
      value: { deepseek: { api_key: '••••••••', base_url: 'https://api.deepseek.com/' } },
    });
    expect(readCredential(ROOT, key, '__GLOBAL___POOL:DEEPSEEK_API_KEY')).toBe('sk-e2e-secret');
    expect(fs.readFileSync(configFile, 'utf-8')).not.toContain('sk-e2e-secret');

    // ④ config/save 白名单域 replace：给的键覆盖、缺的键删除
    await rpc(ws, 'config/save', { config: { llmProviders: { glm: { api_key: 'sk-e2e-glm' } } } });
    expect(onDisk().llmProviders).toEqual({ glm: {} });
    expect(onDisk().searchProviders).toBeUndefined();
    expect(readCredential(ROOT, key, '__GLOBAL___POOL:GLM_API_KEY')).toBe('sk-e2e-glm');

    // ⑤ config/delete：白名单外 fail-closed；白名单内删键
    await expect(rpc(ws, 'config/delete', { key: 'sessions' })).rejects.toThrow(/白名单/);
    await rpc(ws, 'config/delete', { key: 'llmProviders' });
    expect(onDisk().llmProviders).toBeUndefined();

    // ⑥ llm/pool-credential：删连接清凭据（残留会让种子名发现回写复活条目）
    await rpc(ws, 'llm/pool-credential', { name: 'glm', value: '' });
    expect(readCredential(ROOT, key, '__GLOBAL___POOL:GLM_API_KEY')).toBeNull();

    ws.close();
  }, 30_000);

  // 会话覆盖面（cr-565）：输入框模型菜单的写读 → deliver 合并点 → 信封载体 →
  // singles 列表回显。1v1 直答键 = pairKey(viewer, agent)（前端不传会话键）。
  it('会话覆盖面：conv-settings 写读 + deliver 合并 + singles/update 同源', async () => {
    host = await bootHostWeb({ dataRoot: ROOT });
    const { ws } = await connect(host.port);
    const conv = 'alpha~user';

    // ① conv-settings 写读往返（宿主行原生键域校验）+ 盘上单源
    const set = await rpc<{ settings: Record<string, string> }>(ws, 'conv-settings/set', {
      conversationId: conv, patch: { model: 'deepseek@deepseek-flash' },
    });
    expect(set.settings).toEqual({ model: 'deepseek@deepseek-flash' });
    const readBack = await rpc<{ settings: Record<string, string> }>(ws, 'conv-settings/get', { conversationId: conv });
    expect(readBack.settings.model).toBe('deepseek@deepseek-flash');
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'conv-settings', conv + '.json'), 'utf-8')))
      .toEqual({ model: 'deepseek@deepseek-flash' });
    // 非法会话键 fail-closed（词法闸在 owning service）
    await expect(rpc(ws, 'conv-settings/get', { conversationId: '../escape' })).rejects.toThrow(/非法/);
    // 键目录只回实验组（cr-613：主线同款 group 过滤——model/elevation/
    // toolMode 纯消费键不得混入输入框实验性菜单）
    const keys = await rpc<{ keys: Array<{ key: string; group?: string }> }>(ws, 'conv-settings/keys', {});
    expect(keys.keys.map((k) => k.key).sort()).toEqual(['browserTier', 'issueSubmit']);

    // ② deliver 合并点：1v1 直答不传 conversationId/model → 按 pairKey 读存盘覆盖
    const delivered = await rpc<{ uuid: string }>(ws, 'conversation/deliver', { agentId: 'alpha', message: '带覆盖一问' });
    const envelopeOf = (text: string): { payload?: { text?: string }; model?: string; elevation?: string } | null => {
      const dir = path.join(ROOT, 'outbox');
      if (!fs.existsSync(dir)) return null;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as {
          envelope?: { payload?: { text?: string }; model?: string; elevation?: string };
        };
        if (entry.envelope?.payload?.text === text) return entry.envelope;
      }
      return null;
    };
    expect(envelopeOf('带覆盖一问')?.model).toBe('deepseek@deepseek-flash');

    // ③ 显式入参优先（临时换模随信投递、不回写存盘）
    await rpc(ws, 'conversation/deliver', { agentId: 'alpha', message: '临时换模一问', model: 'zai@glm-5.3' });
    expect(envelopeOf('临时换模一问')?.model).toBe('zai@glm-5.3');

    // ⑤ 提权档位随信投递（cr-626）：合法词入信封、非法词丢弃
    await rpc(ws, 'conversation/deliver', { agentId: 'alpha', message: '提权一问', elevation: 'full-access' });
    expect(envelopeOf('提权一问')?.elevation).toBe('full-access');
    await rpc(ws, 'conversation/deliver', { agentId: 'alpha', message: '坏档位一问', elevation: 'root' });
    expect(envelopeOf('坏档位一问')?.elevation).toBeUndefined();
    const unchanged = await rpc<{ settings: Record<string, string> }>(ws, 'conv-settings/get', { conversationId: conv });
    expect(unchanged.settings.model).toBe('deepseek@deepseek-flash');

    // ④ singles/update：模型覆盖同源（singles/list 回显）+ 清除即删键删文件
    const updated = await rpc<{ single: { id: string; model?: string } }>(ws, 'singles/update', {
      id: delivered.uuid, model: 'deepseek@deepseek-v4-pro',
    });
    expect(updated.single.model).toBe('deepseek@deepseek-v4-pro');
    const list = await rpc<{ singles: Array<{ id: string; model?: string }> }>(ws, 'singles/list', {});
    expect(list.singles.find((s) => s.id === delivered.uuid)?.model).toBe('deepseek@deepseek-v4-pro');
    const cleared = await rpc<{ single: { model?: string } }>(ws, 'singles/update', { id: delivered.uuid, model: null });
    expect(cleared.single.model).toBeUndefined();
    expect(fs.existsSync(path.join(ROOT, 'conv-settings', delivered.uuid + '.json'))).toBe(false);
    // 元数据面（cr-566）：改名走 session.json——与模型覆盖分文件、同时生效
    const renamed = await rpc<{ single: { title?: string } }>(ws, 'singles/update', { id: delivered.uuid, title: '改名' });
    expect(renamed.single.title).toBe('改名');
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'viewer', 'sessions', delivered.uuid, 'session.json'), 'utf-8')).title)
      .toBe('改名');

    ws.close();
  }, 30_000);

  // 独立会话全族（cr-566）：create（含 reuse）→ update → fork → archive → delete；
  // 每次变更都广播 singles/updated（前端 singleBoard 增量合并的单源）。
  it('singles 全族：create/reuse → update → fork → archive → delete + 事件帧', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'), JSON.stringify({ id: 'alpha', model: 'mock' }), 'utf-8');
    host = await bootHostWeb({ dataRoot: ROOT });
    const { ws } = await connect(host.port);
    const events: unknown[][] = [];
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(String(data)) as { type?: string; data?: { args?: unknown[] } };
        if (m.type === 'singles/updated') events.push(m.data?.args ?? []);
      } catch { /* 非 JSON 帧忽略 */ }
    });

    const created = await rpc<{ single: { id: string; agentId: string; status: string; lastActivity?: string } }>(ws, 'singles/create', { agentId: 'alpha' });
    expect(created.single.agentId).toBe('alpha');
    expect(created.single.status).toBe('active');
    // 空会话不带 lastActivity（主线 ac-singles 同义——前端 isSingleFresh
    // 据此呈现新会话开场居中态，cr-601）
    expect(created.single.lastActivity).toBeUndefined();
    // reuse：同 Agent 的空会话被复用（「新增」不刷屏）
    const reused = await rpc<{ single: { id: string }; reused?: boolean }>(ws, 'singles/create', { agentId: 'alpha', reuse: true });
    expect(reused.reused).toBe(true);
    expect(reused.single.id).toBe(created.single.id);

    // 两条消息（deliver 落 user 终稿账本）
    await rpc(ws, 'conversation/deliver', { agentId: 'alpha', message: '第一问', conversationId: created.single.id });
    await rpc(ws, 'conversation/deliver', { agentId: 'alpha', message: '第二问', conversationId: created.single.id });
    const ledgerFile = path.join(ROOT, 'viewer', 'sessions', created.single.id, 'messages.jsonl');
    const messages = (): Array<Record<string, unknown>> => fs.readFileSync(ledgerFile, 'utf-8')
      .split('\n').filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.type !== 'session-header');
    expect(messages()).toHaveLength(2);

    // update：改名 + 模型覆盖（模型仍落 conv-settings——D12 单源）
    const updated = await rpc<{ single: { title?: string; model?: string } }>(ws, 'singles/update', {
      id: created.single.id, title: '改过的标题', model: 'deepseek@deepseek-flash',
    });
    expect(updated.single.title).toBe('改过的标题');
    expect(updated.single.model).toBe('deepseek@deepseek-flash');
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'conv-settings', created.single.id + '.json'), 'utf-8')).model)
      .toBe('deepseek@deepseek-flash');
    // 已有消息时不许换/清 Agent（上下文语义）
    await expect(rpc(ws, 'singles/update', { id: created.single.id, agentId: '' })).rejects.toThrow(/已有消息/);

    // fork：以第一条消息为锚点 → 新会话复制 1 条、元数据继承
    const anchor = String(messages()[0].message_id);
    const forked = await rpc<{ single: { id: string; title?: string } }>(ws, 'singles/fork', { id: created.single.id, anchorMessageId: anchor });
    expect(forked.single.id).not.toBe(created.single.id);
    expect(forked.single.title).toBe('改过的标题');
    const forkRows = fs.readFileSync(path.join(ROOT, 'viewer', 'sessions', forked.single.id, 'messages.jsonl'), 'utf-8')
      .split('\n').filter((l) => l.trim() !== '');
    expect(forkRows.filter((l) => !l.includes('session-header'))).toHaveLength(1);

    // archive：软删（列表只剩 active）
    await rpc(ws, 'singles/archive', { id: forked.single.id });
    const listed = await rpc<{ singles: Array<{ id: string }> }>(ws, 'singles/list', {});
    expect(listed.singles.map((s) => s.id)).toContain(created.single.id);
    expect(listed.singles.map((s) => s.id)).not.toContain(forked.single.id);

    // delete：硬删（目录 + 覆盖文件一并清）
    await rpc(ws, 'singles/delete', { id: created.single.id });
    expect(fs.existsSync(path.join(ROOT, 'viewer', 'sessions', created.single.id))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'conv-settings', created.single.id + '.json'))).toBe(false);

    // 事件帧：四种 kind 各至少一次（前端列表增量合并的输入）
    const kinds = events.map((args) => args[1]);
    for (const kind of ['created', 'updated', 'archived', 'removed']) expect(kinds).toContain(kind);
    ws.close();
  }, 30_000);

  // 消息面（cr-566）：删一条 / 截断其后——两侧账本同时改写
  it('session/delete-message + session/truncate：账本原子改写（会话全账本生效）', async () => {
    host = await bootHostWeb({ dataRoot: ROOT });
    const { ws } = await connect(host.port);
    const conv = 'trunc-conv-1';
    for (const text of ['一', '二', '三']) {
      await rpc(ws, 'conversation/deliver', { agentId: 'alpha', message: text, conversationId: conv });
    }
    const file = path.join(ROOT, 'viewer', 'sessions', conv, 'messages.jsonl');
    const read = (): Array<Record<string, unknown>> => fs.readFileSync(file, 'utf-8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
    const messages = (): Array<Record<string, unknown>> => read().filter((r) => r.type !== 'session-header');
    expect(messages()).toHaveLength(3);

    const middle = String(messages()[1].message_id);
    const del = await rpc<{ deleted: boolean }>(ws, 'session/delete-message', { conversationId: conv, messageId: middle });
    expect(del.deleted).toBe(true);
    expect(messages().map((r) => r.content)).toEqual(['一', '三']);
    expect(read()[0].type).toBe('session-header'); // 表头保留

    const first = String(messages()[0].message_id);
    const trunc = await rpc<{ removed: number }>(ws, 'session/truncate', { conversationId: conv, messageId: first });
    expect(trunc.removed).toBe(2); // 删掉「一」「三」
    expect(messages()).toHaveLength(0);
    const miss = await rpc<{ removed: number }>(ws, 'session/truncate', { conversationId: conv, messageId: 'no-such-msg' });
    expect(miss.removed).toBe(0);
    ws.close();
  }, 30_000);

  // history 工具卡带出（cr-587）：user 终稿行按 run 键关联 agent 账本 journal
  // → steps 投影（思考/工具卡刷新不丢）；未收束 run 标 partial。
  it('session/history：peer 行 run 键带出 steps（result 内联 + partial 判定）', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'), JSON.stringify({ id: 'alpha', model: 'mock' }), 'utf-8');
    host = await bootHostWeb({ dataRoot: ROOT });
    const { ws } = await connect(host.port);
    const conv = 'hist-steps-1';

    // user 终稿行：peer 带 run 键（writeThrough——source: run:<run>）
    const userLedger = new UserLedger(ROOT, conv, ['user']);
    await userLedger.writeThrough({ agentId: 'alpha', content: '终稿回复', uuid: conv, run: 'run-ok', requestId: 'rq-h1' });
    await userLedger.writeThrough({ agentId: 'alpha', content: '中断回复', uuid: conv, run: 'run-cut', requestId: 'rq-h2' });

    // agent 域 journal：run-ok 收束（工具卡全字段）；run-cut 无 settled 行
    const journalFile = path.join(sessionDir(ROOT, 'alpha', conv), 'journal', 'partials.jsonl');
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.writeFileSync(journalFile, [
      JSON.stringify({ type: 'journal-step', run: 'run-ok', step: 1, content: '想', reasoning: '思考', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], toolResults: [{ ok: true, output: '文件内容' }] }),
      JSON.stringify({ type: 'journal-settled', run: 'run-ok', finish: 'ok' }),
      JSON.stringify({ type: 'journal-step', run: 'run-cut', step: 1, content: '', toolCalls: [{ id: 'c2', name: 'write', arguments: '{}' }] }),
    ].join('\n') + '\n', 'utf-8');

    const history = await rpc<{
      total: number;
      records: Array<{ role: string; content: string; steps?: Array<{ reasoning?: string; toolCalls?: Array<{ id: string; result: unknown }> }>; partial?: boolean }>;
    }>(ws, 'session/history', { conversationId: conv });
    expect(history.total).toBe(2);
    const [ok, cut] = history.records;
    expect(ok).toMatchObject({ role: 'assistant', content: '终稿回复' });
    expect(ok!.steps).toEqual([{ content: '想', reasoning: '思考', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}', result: { ok: true, output: '文件内容' } }] }]);
    expect(ok!.partial).toBeUndefined();
    expect(cut).toMatchObject({ role: 'assistant', content: '中断回复' });
    expect(cut!.partial).toBe(true);
    expect(cut!.steps![0]!.toolCalls![0]).toMatchObject({ id: 'c2', result: null });
    ws.close();
  }, 30_000);

  // cr-611 迁移直答 pair：viewer 投影在对桶键上，journal 住尾段域
  //（agents/user/sessions/<a~user>）——history 双端带出。
  it('session/history 对桶键：peer 行 journal 从尾段域带出 steps', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'user'), { recursive: true });
    const conv = 'alpha~user';
    const userLedger = new UserLedger(ROOT, conv, ['user']);
    await userLedger.writeThrough({ agentId: 'alpha', content: '直答回复', uuid: conv, run: 'run-p1', requestId: 'rq-p1' });
    const journalFile = path.join(sessionDir(ROOT, 'user', conv), 'journal', 'partials.jsonl');
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.writeFileSync(journalFile, [
      JSON.stringify({ type: 'journal-step', run: 'run-p1', step: 1, content: '', reasoning: '对桶思考' }),
      JSON.stringify({ type: 'journal-settled', run: 'run-p1', finish: 'ok' }),
    ].join('\n') + '\n', 'utf-8');
    host = await bootHostWeb({ dataRoot: ROOT });
    const { ws } = await connect(host.port);
    const history = await rpc<{ total: number; records: Array<{ steps?: Array<{ reasoning?: string }>; partial?: boolean }> }>(ws, 'session/history', { conversationId: conv });
    expect(history.total).toBe(1);
    expect(history.records[0]).toMatchObject({ role: 'assistant', content: '直答回复' });
    expect(history.records[0]!.steps![0]).toMatchObject({ reasoning: '对桶思考' });
    expect(history.records[0]!.partial).toBeUndefined();
    ws.close();
  }, 30_000);

  // cr-598 双链：conversation/stats 接真活壳聚集（此前硬编码空壳——resume
  // 恢复与流式静默探针全断）+ history journal 活投影（run 中刷新按步带回
  // 已落盘步；running 门控 = 孤儿 journal 不投）。
  it('conversation/stats 真源 + history journal 活投影（running 门控）', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'), JSON.stringify({ id: 'alpha', model: 'mock' }), 'utf-8');
    const conv = 'hist-live-1';
    // agent 域 journal：run-live 两步未收束 + run-orphan 崩溃孤儿（同未收束）
    const NL = String.fromCharCode(10);
    const journalFile = path.join(sessionDir(ROOT, 'alpha', conv), 'journal', 'partials.jsonl');
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.writeFileSync(journalFile, [
      JSON.stringify({ type: 'journal-step', run: 'run-live', step: 0, content: '', reasoning: '第一步思考' }),
      JSON.stringify({ type: 'journal-step', run: 'run-live', step: 1, content: '', toolCalls: [{ id: 'c9', name: 'pwsh', arguments: '{}' }] }),
      JSON.stringify({ type: 'journal-step', run: 'run-orphan', step: 0, content: '', reasoning: '孤儿残留' }),
    ].join(NL) + NL, 'utf-8');
    // 活壳桩：run-state 报 busy + conversationId（collectRunning 命中）
    let busy = true;
    const alphaHandle = {
      control: async (req: { op?: string }): Promise<{ busy?: boolean; conversationId?: string; runId?: string } | null> =>
        req.op === 'run-state' ? { busy, conversationId: busy ? conv : '', runId: busy ? 'run-live' : '' } : null,
    };
    const shellPort = () => ({
      handles: () => new Map<string, typeof alphaHandle>([['alpha', alphaHandle]]),
    });
    host = await bootHostWeb({ dataRoot: ROOT, shellPort: shellPort as never });
    const { ws } = await connect(host.port);
    try {
      // stats：running 非空（此前恒空壳）
      const stats = await rpc<{ running: Array<{ agentId: string; conversationId: string }> }>(ws, 'conversation/stats', {});
      expect(stats.running).toEqual([{ agentId: 'alpha', conversationId: conv }]);
      // history 活投影：run-live 两步各一行 partial；孤儿 run-orphan 不投
      const h1 = await rpc<{ total: number; records: Array<{ run?: string; content: string; partial?: boolean; steps?: Array<{ reasoning?: string; toolCalls?: unknown[] }> }> }>(ws, 'session/history', { conversationId: conv });
      expect(h1.records).toHaveLength(2);
      expect(h1.records[0]).toMatchObject({ role: 'assistant', run: 'run-live', content: '', partial: true });
      expect(h1.records[0]!.steps![0]).toMatchObject({ reasoning: '第一步思考' });
      expect(h1.records[1]!.steps![0]!.toolCalls).toHaveLength(1);
      expect(h1.records.every((r) => r.run !== 'run-orphan')).toBe(true);
      // run 收束（壳转闲）→ 活投影消失（活投影只为在途 run 服务）
      busy = false;
      const h2 = await rpc<{ records: unknown[] }>(ws, 'session/history', { conversationId: conv });
      expect(h2.records).toHaveLength(0);
      const stats2 = await rpc<{ running: unknown[] }>(ws, 'conversation/stats', {});
      expect(stats2.running).toEqual([]);
    } finally {
      ws.close();
    }
  }, 30_000);
});

