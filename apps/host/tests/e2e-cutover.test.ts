// ============================================================
// e2e-cutover.test.ts —— 8.8 级联验收：恒等门 + 宿主 boot 回放对齐
//
// 双断言面（plan 8.8）：
//   ① 恒等门：fixture 旧根 → importRoot（--full 语义）→ 恒等门校验全过；
//   ② 宿主 boot 读新账本回放对齐：bootHost 挂导入产物数据根 →
//      agents/list 读到换轨身份 / singles/list 读到投影会话 /
//      session/history 回放与 agent 侧账本恒等（条数 + 内容）。
// 数据根恒 sandbox/（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';
import { importRoot } from 'ac-import';
import { readLedger } from 'ac-ledger';
import { bootHost, type HostBootResult } from '../boot.ts';
import { adoptShell } from '../orchestrate.ts';

const CATALOG = path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'row-catalog.json');
let tmp: string;
let legacyRoot: string;
let targetRoot: string;
let host: HostBootResult | null = null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-e2e-cutover-'));
  legacyRoot = path.join(tmp, 'legacy');
  targetRoot = path.join(tmp, 'target');
});
afterEach(async () => {
  if (host !== null) { await host.close(); host = null; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** fixture 旧根：1 agent（tags 装载词 + 扁平 entries + 身份文件）+ 2 singles 会话 */
function seedLegacy(): void {
  // agents 树（旧形态扁平混居）
  const agentDir = path.join(legacyRoot, 'agents', 'alpha');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({
    // model 'mock' = legacy 已配 mock 连接的 agent 形态（导入恒等保留——
    // 壳侧 mock provider 按此路由命中）
    id: 'alpha', name: '甲', model: 'mock',
    tags: ['shell', 'infra', 'full-access', 'observe'],
  }));
  fs.writeFileSync(path.join(agentDir, 'todo.json'), '{"items":[]}');
  fs.writeFileSync(path.join(agentDir, 'AGENT.md'), '# 甲');
  // singles 会话 ×2（shelf 形态）
  const mk = (sid: string, turns: Array<[string, string]>): void => {
    const dir = path.join(legacyRoot, 'sessions', 'singles', 'ungrouped', sid);
    fs.mkdirSync(dir, { recursive: true });
    const meta = path.join(legacyRoot, 'singles', sid);
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, 'session.json'), JSON.stringify({ id: sid, agentId: 'alpha' }));
    const lines = [JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-01-01T00:00:00Z' })];
    let n = 0;
    for (const [who, text] of turns) {
      n++;
      lines.push(JSON.stringify({ role: who, content: text, message_id: 'm' + n, timestamp: '2026-01-01T00:00:0' + n + 'Z', agent_id: who === 'user' ? 'user' : 'alpha' }));
    }
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.join('\n') + '\n');
  };
  // majority 归属需要 alpha 行占多数（majorityAgentId 无 exclude——user 行同计入）
  mk('s-one', [['user', '问一'], ['assistant', '答一'], ['assistant', '补充'], ['user', '追问'], ['assistant', '终答']]);
  mk('s-two', [['user', '单问'], ['assistant', '单答'], ['assistant', '再答']]);
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    ws.once('open', () => {
      ws.once('message', (data) => {
        try {
          const m = JSON.parse(String(data)) as { type?: string };
          if (m.type === WS_READY) resolve(ws);
          else reject(new Error('首帧非 ws/ready'));
        } catch (e) { reject(e); }
      });
    });
    ws.once('error', reject);
  });
}

let rpcSeq = 0;
function rpc<T>(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<T> {
  const requestId = 'c-' + (++rpcSeq);
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

describe('8.8 级联验收：恒等门 + 宿主 boot 回放对齐', () => {
  // 壳半边收割登记（cr-548）：adoptShell 拉起的真子进程壳按精确 pid 收割，
  // 绝不扫进程表（2026-10-17 事故防复发）。
  const adoptedShells: Array<{ pid: number; kill(): void; shutdown(): Promise<number | null> }> = [];
  afterEach(async () => {
    for (const s of adoptedShells.splice(0)) {
      try { await s.shutdown(); } catch { try { s.kill(); } catch { /* 已退出 */ } }
    }
  });
  it('恒等门：全量导入零问题 + agents 树迁移 + user 投影', async () => {
    seedLegacy();
    const report = await importRoot(legacyRoot, targetRoot, path.join(tmp, 'staging'), { agentsTree: true, userProjection: true });
    // 会话恒等门：importSession 内联校验失败即 throw——到达这里 = 全过
    expect(report.results.map((r) => r.uuid).sort()).toEqual(['s-one', 's-two']);
    expect(report.skipped).toEqual([]);
    // agents 树：config 换轨 + entries 归拢 + 身份文件
    expect(report.agentsTreeResults).toEqual([{ agentId: 'alpha', configConverted: true, entriesMoved: 1, identityFilesCopied: 1 }]);
    const cfg = JSON.parse(fs.readFileSync(path.join(targetRoot, 'agents/alpha/config.json'), 'utf-8')) as { rows?: string[]; tags?: string[] };
    expect(cfg.rows).toEqual(expect.arrayContaining(['shell-tools', 'math', 'todo', 'datetime']));
    expect(cfg.tags).toEqual(['full-access']);
    expect(fs.existsSync(path.join(targetRoot, 'agents/alpha/entries/todo.json'))).toBe(true);
    // user 投影：两 singles 会话各落 user 账本
    expect(report.userProjectionStats?.sessions).toBe(2);
  });

  it('宿主 boot 读新账本回放对齐（agents/list + singles/list + session/history）', async () => {
    seedLegacy();
    await importRoot(legacyRoot, targetRoot, path.join(tmp, 'staging'), { agentsTree: true, userProjection: true });
    host = await bootHost({ dataRoot: targetRoot, catalogFile: CATALOG });
    const ws = await connect(host.web.port);

    // ① agents/list：换轨身份可读（name 直读；preset 无 = 进名册）
    const list = await rpc<{ agents: Array<{ id: string; name?: string }> }>(ws, 'agents/list', {});
    expect(list.agents.map((a) => a.id)).toContain('alpha');
    expect(list.agents.find((a) => a.id === 'alpha')?.name).toBe('甲');

    // ② singles/list：user 投影账本可见
    const singles = await rpc<{ singles: Array<{ id: string; agentId: string; title?: string }> }>(ws, 'singles/list', {});
    expect(singles.singles.map((s) => s.id).sort()).toEqual(['s-one', 's-two']);

    // ③ session/history：user 视角回放 == agent 侧账本终稿（条数 + 内容恒等）
    const history = await rpc<{ records: Array<{ role: string; content: string }>; total: number }>(ws, 'session/history', { conversationId: 's-one' });
    const agentRows = readLedger(path.join(targetRoot, 'agents', 'alpha', 'sessions', 's-one')).rows
      .filter((r) => r.role === 'agent');
    expect(history.total).toBe(agentRows.length);
    expect(history.records.map((r) => r.content)).toEqual(agentRows.map((r) => r.content));
    expect(history.records.map((r) => r.role)).toEqual(agentRows.map((r) => (r.agent_id === 'user' ? 'user' : 'assistant')));

    // ④ 导入后新会话可续（user 桩 deliver 到既有投影会话——续聊同 uuid）
    const outcome = await rpc<{ kind: string; uuid: string }>(ws, 'conversation/deliver', {
      agentId: 'alpha', message: '导入后新问', conversationId: 's-one', requestId: 'rq-c1',
    });
    expect(outcome.uuid).toBe('s-one');
    const after = await rpc<{ total: number }>(ws, 'session/history', { conversationId: 's-one' });
    expect(after.total).toBe(agentRows.length + 1);

    ws.close();
  });

  it('壳半边全链：adoptShell 真子进程 mock 壳 → user deliver → run 终稿 → 双账本回链（8.8 级联收口）', async () => {
    seedLegacy();
    await importRoot(legacyRoot, targetRoot, path.join(tmp, 'staging'), { agentsTree: true, userProjection: true });
    host = await bootHost({ dataRoot: targetRoot, catalogFile: CATALOG });
    // 拉起导入身份的真子进程壳（mock provider + 邮局接线——argv 经 adoptShell 透传）
    const adopted = await adoptShell({
      agentId: 'alpha',
      dataRoot: targetRoot,
      catalogFile: CATALOG,
      bootFile: fileURLToPath(new URL('../../shell/boot.ts', import.meta.url)),
      reach: host.po.reach,
      postOffice: host.po,
      mockProvider: true,
      timeoutMs: 20_000,
    });
    adoptedShells.push(adopted);
    const ws = await connect(host.web.port);
    try {
      // user 发言经宿主全链（web RPC → user 桩签发 → 邮局 dispatch → 壳 ipc 直投 → conversation 全链）
      const outcome = await rpc<{ kind: string; uuid: string }>(ws, 'conversation/deliver', {
        agentId: 'alpha', message: '壳半边全链问',
      });
      expect(outcome.uuid).toMatch(/-7/); // 新会话 R-1 签发
      // 等 mock run 终稿落账 + 回链 user 账本（writeThrough 终稿写穿）
      const udir = path.join(targetRoot, 'viewer', 'sessions', outcome.uuid);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const rows = readLedger(udir).rows;
        if (rows.length >= 2) {
          // 双账本对拍（D4 视角主义）：user 终稿层 == agent 侧账本
          expect(rows.map((r) => r.content)).toEqual(['壳半边全链问', '[mock 回复 壳半边全链问]']);
          // agent 侧账本 = user 终稿层 + cr-697 物化段行（steps 载体）——对拍过滤
          const arows = readLedger(path.join(targetRoot, 'agents', 'alpha', 'sessions', outcome.uuid)).rows
            .filter((r) => r.source !== 'segment' && r.source !== 'inject');
          expect(arows.map((r) => r.content)).toEqual(rows.map((r) => r.content));
          break;
        }
        if (Date.now() > deadline) throw new Error('终稿未回链：' + JSON.stringify(readLedger(udir).rows));
        await new Promise((r) => setTimeout(r, 100));
      }
      // web 读面回放（webui 消费面同链）：session/history 与账本对齐
      const history = await rpc<{ records: Array<{ role: string; content: string }>; total: number }>(ws, 'session/history', { conversationId: outcome.uuid });
      expect(history.total).toBe(2);
      expect(history.records.map((r) => r.content)).toEqual(['壳半边全链问', '[mock 回复 壳半边全链问]']);
    } finally {
      ws.close();
    }
  }, 60_000);
});