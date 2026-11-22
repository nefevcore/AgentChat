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
import { readAgentConfig, writeAgentConfig } from 'ac-agents-core';
import { materializeBaseDocs, profileDirOf } from 'ac-rowset-core';
import { readLedger, projectUserReplay, LedgerWriter, sessionDir } from 'ac-ledger';
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
    tags: ['shell', 'infra', 'full-access', 'observe'], // 存量旧词形（导入换轨面）
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
  mk('01999aaa-0000-7000-8000-000000000001', [['user', '问一'], ['assistant', '答一'], ['assistant', '补充'], ['user', '追问'], ['assistant', '终答']]);
  mk('01999aaa-0000-7000-8000-000000000002', [['user', '单问'], ['assistant', '单答'], ['assistant', '再答']]);
}

/** cr-1022 批3 → cr-1036 批3：importRoot 产物已是 v3 形态（ac-import 写面
 * 换轨），宿主/壳消费前只补物化基座 + 幂等重写（cr-1067 基线戳退役，
 * 无戳面需对齐）。 */
function migrateTargetAgent(): void {
  materializeBaseDocs(profileDirOf(CATALOG), targetRoot);
  const cfg = readAgentConfig(targetRoot, 'alpha');
  if (cfg !== null) writeAgentConfig(targetRoot, cfg);
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
  it('恒等门：全量导入零问题 + agents 树迁移 + agent 域投影', async () => {
    seedLegacy();
    const report = await importRoot(legacyRoot, targetRoot, path.join(tmp, 'staging'), { agentsTree: true });
    // 会话恒等门：importSession 内联校验失败即 throw——到达这里 = 全过
    expect(report.results.map((r) => r.uuid).sort()).toEqual(['01999aaa-0000-7000-8000-000000000001', '01999aaa-0000-7000-8000-000000000002']);
    expect(report.skipped).toEqual([]);
    // agents 树：config 换轨 + entries 归拢 + 身份文件
    expect(report.agentsTreeResults).toEqual([{ agentId: 'alpha', configConverted: true, entriesMoved: 1, identityFilesCopied: 1 }]);
    // cr-1036 批3：导入产物 = v3（agent.json 档案 + agent.patch.yml 菜单片段——
    // config.json 产线退役）。换轨语义验收走组合读投影。
    const cfg = readAgentConfig(targetRoot, 'alpha')!;
    expect(cfg.rows).toBeDefined();
    expect(cfg.access).toBeUndefined(); // cr-1082：access 轴退役——tags 档位词导入即丢弃
    // levels.browser 归位需 rows 点名 browser 行（cr-1004 批2b 不进即不装——
    // 导入白名单无 browser，档位不落为既定语义）
    expect(cfg.levels?.browser).toBeUndefined();
    expect(fs.existsSync(path.join(targetRoot, 'agents/alpha/entries/todo.json'))).toBe(true);
    // cr-973：viewer 物化退役（userProjection 选项删除）——终稿层 =
    // agent 域账本读时投影；两 singles 会话各自可投影出全量行
    expect(projectUserReplay(targetRoot, '01999aaa-0000-7000-8000-000000000001').map((r) => [r.role, r.content])).toEqual([
      ['user', '问一'], ['peer', '答一'], ['peer', '补充'], ['user', '追问'], ['peer', '终答'],
    ]);
    expect(projectUserReplay(targetRoot, '01999aaa-0000-7000-8000-000000000002')).toHaveLength(3);
  });

  it('宿主 boot 读新账本回放对齐（agents/list + singles/list + session/history）', async () => {
    seedLegacy();
    await importRoot(legacyRoot, targetRoot, path.join(tmp, 'staging'), { agentsTree: true });
    migrateTargetAgent();
    // cr-973：viewer 物化退役——singles 身份元数据（引用/覆盖配置，非消息
    // 派生物）由 importRoot 自 legacy singles/<sid>/session.json 迁
    // meta/sessions/<sid>.json（清单身份源；消息流与回放走 agent 域读时投影）
    for (const sid of ['01999aaa-0000-7000-8000-000000000001', '01999aaa-0000-7000-8000-000000000002']) {
      const migrated = JSON.parse(fs.readFileSync(path.join(targetRoot, 'meta', 'sessions', sid + '.json'), 'utf-8')) as { id: string; agentId: string };
      const legacy = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'singles', sid, 'session.json'), 'utf-8')) as { id: string; agentId: string };
      expect(migrated.id).toBe(legacy.id);
      expect(migrated.agentId).toBe(legacy.agentId);
    }
    host = await bootHost({ dataRoot: targetRoot, catalogFile: CATALOG });
    const ws = await connect(host.web.port);

    // ① agents/list：换轨身份可读（name 直读；普通词形 = 进名册）
    const list = await rpc<{ agents: Array<{ id: string; name?: string }> }>(ws, 'agents/list', {});
    expect(list.agents.map((a) => a.id)).toContain('alpha');
    expect(list.agents.find((a) => a.id === 'alpha')?.name).toBe('甲');

    // ② singles/list：身份元数据（meta/sessions）+ agent 域账本可见
    const singles = await rpc<{ singles: Array<{ id: string; agentId: string; title?: string }> }>(ws, 'singles/list', {});
    expect(singles.singles.map((s) => s.id).sort()).toEqual(['01999aaa-0000-7000-8000-000000000001', '01999aaa-0000-7000-8000-000000000002']);

    // ③ session/history：user 视角回放 == agent 侧账本终稿（条数 + 内容恒等）
    const history = await rpc<{ records: Array<{ role: string; content: string }>; total: number }>(ws, 'session/history', { conversationId: '01999aaa-0000-7000-8000-000000000001' });
    const agentRows = readLedger(path.join(targetRoot, 'agents', 'alpha', 'sessions', '01999aaa-0000-7000-8000-000000000001')).rows
      .filter((r) => r.role === 'agent');
    expect(history.total).toBe(agentRows.length);
    expect(history.records.map((r) => r.content)).toEqual(agentRows.map((r) => r.content));
    expect(history.records.map((r) => r.role)).toEqual(agentRows.map((r) => (r.agent_id === 'user' ? 'user' : 'assistant')));

    // ④ 导入后新会话可续（user 桩 deliver 到既有投影会话——续聊同 uuid）。
    // cr-973：deliver 只投递——入站行按壳侧形态落 agent 域（fixture；同键
    // 壳侧重落被投影去重）
    const outcome = await rpc<{ kind: string; uuid: string }>(ws, 'conversation/deliver', {
      agentId: 'alpha', message: '导入后新问', conversationId: '01999aaa-0000-7000-8000-000000000001', requestId: 'rq-c1',
    });
    expect(outcome.uuid).toBe('01999aaa-0000-7000-8000-000000000001');
    const lw = new LedgerWriter(sessionDir(targetRoot, 'alpha', '01999aaa-0000-7000-8000-000000000001'), { participants: ['alpha', 'user'], kind: 'user' });
    await lw.deliver({ role: 'agent', content: '导入后新问', agent_id: 'user', requestId: 'rq-c1', uuid: '01999aaa-0000-7000-8000-000000000001' });
    const after = await rpc<{ total: number }>(ws, 'session/history', { conversationId: '01999aaa-0000-7000-8000-000000000001' });
    expect(after.total).toBe(agentRows.length + 1);

    ws.close();
  });

  it('壳半边全链：adoptShell 真子进程 mock 壳 → user deliver → run 终稿 → 双账本回链（8.8 级联收口）', async () => {
    seedLegacy();
    await importRoot(legacyRoot, targetRoot, path.join(tmp, 'staging'), { agentsTree: true });
    migrateTargetAgent();
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
      // cr-1059：无显式 conversationId 的直答归一对桶键（此前新签发 uuid——
      // 直答会话碎化的根因；断言从「/-7/ 新签发」改为对桶键语义）
      expect(outcome.uuid).toBe('alpha~user');
      // 等 mock run 终稿落账（cr-973：终稿行落 agent 域——终稿层读时投影）
      const deadline = Date.now() + 15_000;
      for (;;) {
        const rows = projectUserReplay(targetRoot, outcome.uuid);
        if (rows.length >= 2) {
          // 双账本对拍（D4 视角主义）：终稿层读时投影 == agent 侧账本
          // cr-1251：datetime 精简树注入照常（防重归锚文件）——mock 回显日期锚
          expect(rows.map((r) => r.content)).toEqual(['壳半边全链问', expect.stringMatching(/^\[mock 回复 <system-reminder>\[当前时间\] \d{4}-\d{2}-\d{2} 周[日一二三四五六]<\/system-reminder>\]$/)]);
          // agent 侧账本 = 终稿层投影 + cr-697 物化段行（steps 载体）——对拍过滤
          const arows = readLedger(path.join(targetRoot, 'agents', 'alpha', 'sessions', outcome.uuid)).rows
            // cr-974 v2：相位/run-end 行无 role——终稿层只看发言行
      .filter((r) => r.role !== undefined && r.source !== 'segment' && r.source !== 'inject');
          expect(arows.map((r) => r.content)).toEqual(rows.map((r) => r.content));
          break;
        }
        if (Date.now() > deadline) throw new Error('终稿未回链：' + JSON.stringify(projectUserReplay(targetRoot, outcome.uuid)));
        await new Promise((r) => setTimeout(r, 100));
      }
      // web 读面回放（webui 消费面同链）：session/history 与账本对齐
      //（cr-1182 批2：datetime 日期锚 context 行计入 records——内容断言过滤锚行）
      const history = await rpc<{ records: Array<{ role: string; content: string }>; total: number }>(ws, 'session/history', { conversationId: outcome.uuid });
      // cr-1182 批2：datetime 日期锚 context 行入账（时序与用户消息入账竞态——不锁位，锁存在性）
      const contents = history.records.map((r) => r.content);
      expect(contents).toContain('壳半边全链问');
      expect(contents.some((c: string) => /\[mock 回复 <system-reminder>\[当前时间\] \d{4}-\d{2}-\d{2} 周[日一二三四五六]<\/system-reminder>\]/.test(c))).toBe(true); // cr-1251：回显日期锚
      expect(contents.filter((c) => c.startsWith('[当前时间] '))).toHaveLength(1);
      expect(history.total).toBe(3);
    } finally {
      ws.close();
    }
  }, 60_000);
});