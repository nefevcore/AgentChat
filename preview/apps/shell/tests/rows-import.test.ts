// ============================================================
// M8.1 第一批 + 第二批行导入装配验收（cr-519/520）
//
// 验收面：① cordis 装配通道（Context + IMPORTED_ROWS + 垫片行）真拉起
// 主线沿用行；② 装配链效果可观测（persona/system-prompt 经 loop/before-run
// 注入 system）；③ dispose 收割零悬挂；④ 数据根行 options 显式注入
//（config/memory/skill root = preview/sandbox 独立目录）。
// 第二批追加：⑤ 模型编排 3 行服务真到位（ctx.llm / ctx.agentLoop）；
// ⑥ 工具面行工具真注册（fs_read/glob/math/web_search/adt_* 抽样）；
// ⑦ credentials 垫片数据根直读（加密往返 + resolve 链）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootShell } from '../boot.ts';
import { Context, FiberStates, type Plugin } from '@agentchat/cordis';
import { IMPORTED_ROWS, makeShimsRow } from 'ac-shell-rows';
import type { BenchRunOptions, BenchReport } from 'ac-bench';
import type {} from 'ac-agent-loop'; // loop/* 事件目录类型增强（type-only）
import type { LoopRunResult } from 'ac-agent-loop';

const ROOT = path.join('preview', 'sandbox', 'test-rows-' + process.pid);
const CATALOG = path.join('preview', 'apps', 'catalog', 'row-catalog.json');
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('M8.1 行集收敛第一批：cordis 装配通道', () => {
  it('boot 真装配沿用行（tools/persona/memory/goal…经 ctx.plugin 激活）+ dispose 零悬挂', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'),
      JSON.stringify({ id: 'alpha', model: 'mock' }), 'utf-8');
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'alpha', catalogFile: CATALOG },
      { emit: (s) => signals.push(s) },
    );
    try {
      expect(signals).toHaveLength(3);
      expect(signals[1]).toContain('boot.rows.ready');
      // 缺省行集 = 基础壳行集（非捆绑行全量）——第一批导入行在内
      expect(boot.rowset.rowIds).toContain('tools');
      expect(boot.rowset.rowIds).toContain('persona');
      // 真装配验证：ctx 上 tools 服务可用（主线 ToolsService 激活）
      //（boot.result 不直接暴露 ctx——经事件效果观测，见下一用例）
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('装配链效果：persona 块经 loop/before-run 注入 system（主线行真生效 + 垫片直读链全通）', async () => {
    const dir = path.join(ROOT, 'agents', 'beta');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      id: 'beta', model: 'mock',
      settings: { persona: { text: '你是测试人格' } },
    }), 'utf-8');
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'beta', catalogFile: CATALOG },
      { emit: () => {} },
    );
    try {
      // 垫片直读链：settingsOf 合成（全局层 ∪ 差异层）
      const agents = boot.ctx.get('agents') as { settingsOf(id: string, name: string): unknown } | undefined;
      expect(agents).toBeDefined();
      expect(agents!.settingsOf('beta', 'persona')).toMatchObject({ text: '你是测试人格' });
      // 主线 persona 行监听 loop/before-run（ctx.on waterfall）——收尾监听器读改写终值
      const captured: Array<{ system?: string }> = [];
      boot.ctx.on('loop/before-run', (call: { request: { system?: string } }, next: () => Promise<LoopRunResult>) => {
        captured.push({ system: call.request.system });
        return next();
      });
      await boot.ctx.waterfall('loop/before-run', {
        request: { agent: 'beta', model: 'mock', messages: [] },
      } as never, async () => ({ finish: 'stop' }) as LoopRunResult);
      expect(captured[0]?.system ?? '').toContain('<persona>');
      expect(captured[0]?.system ?? '').toContain('你是测试人格');
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('第二批：模型编排 3 行服务到位 + 工具面行真注册 + credentials 垫片直读', async () => {
    const dir = path.join(ROOT, 'agents', 'gamma');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: 'gamma', model: 'mock' }), 'utf-8');
    // credentials 垫片消费链预置：__global__ 级 github 条目（加密往返）
    const credDir = path.join(ROOT, 'credentials');
    fs.mkdirSync(credDir, { recursive: true });
    const { encryptValue, deriveKey, machineMaterial, credentialKey, GLOBAL_AGENT_ID } = await import('ac-credentials-core');
    fs.writeFileSync(path.join(credDir, credentialKey(GLOBAL_AGENT_ID, 'github') + '.enc'),
      encryptValue(deriveKey(machineMaterial()), 'ghp-test-token'), 'utf-8');
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'gamma', catalogFile: CATALOG },
      { emit: () => {} },
    );
    try {
      // ① 模型编排：ctx.llm 路由 + ctx.agentLoop 服务到位
      const llm = boot.ctx.get('llm', false);
      expect(llm).toBeDefined();
      const loop = boot.ctx.get('agentLoop', false);
      expect(loop).toBeDefined();
      // ② 工具面：基础行集内的 math / fs 族（bundle 行不在基础集——抽样非 bundle 面）
      const tools = boot.ctx.get('tools') as { list(): Array<{ name: string; requiredTags?: string[] }> };
      const names = tools.list().map((t) => t.name);
      expect(names).toContain('math'); // math 行（非 bundle 基础行）
      expect(names).toContain('web_search'); // web-tools 行
      expect(names).toContain('browser'); // browser 行（同包去重后仍双工具在册）
      expect(names).toContain('submit_issue'); // issue-tools 行
      // sap-adt apply 尾部 await init()（demo 引擎拉起）晚于行 ACTIVE——轮询有界等待
      const deadline = Date.now() + 10_000;
      while (!names.some((n) => n.startsWith('adt_')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        names.splice(0, names.length, ...tools.list().map((t) => t.name));
      }
      expect(names.some((n) => n.startsWith('adt_'))).toBe(true); // sap-adt 行（32 工具）
      // fs-tools/run-code 属 bundle（fs/infra）——不在缺省基础集，点名面下一用例验证
      // ③ credentials 垫片：resolve 链（Agent 级缺席 → 全局级回落）
      const creds = boot.ctx.get('credentials') as { resolve(id: string, p: string): string };
      expect(creds.resolve('gamma', 'github')).toBe('ghp-test-token');
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('第二批：bundle 点名面（fs/infra）装配 + 伴生行 + 主体指纹盖住新行集', async () => {
    const dir = path.join(ROOT, 'agents', 'delta');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      id: 'delta', model: 'mock',
      // 点 tools 基座 + fs/infra bundle（infra 含 shell-tools——jobs 行已随第三批
      // 落地，闭包自动补依赖，不再 PENDING 永续）
      tools: { include: ['tools', 'fs', 'infra'] },
    }), 'utf-8');
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'delta', catalogFile: CATALOG },
      { emit: () => {} },
    );
    try {
      const tools = boot.ctx.get('tools') as { list(): Array<{ name: string }> };
      const names = tools.list().map((t) => t.name);
      expect(names).toContain('read'); // fs-tools 行（工具真名 read/write/edit）
      expect(names).toContain('glob'); // fs-search 行
      expect(names).toContain('str_replace_editor'); // str-replace-editor 行（真名）
      // infra bundle 同批点名：run-code/shell-tools（含闭包并入的 jobs）
      expect(boot.rowset.rowIds).toContain('fs-tools');
      expect(boot.rowset.rowIds).toContain('shell-tools');
      expect(boot.rowset.rowIds).toContain('jobs'); // shell-tools requires 闭包并入
      expect(names).toContain('run_code');
      expect(boot.ctx.get('fileSnapshots', false)).toBeDefined(); // 伴生行（fs-tools 并入）
      // 主体指纹：行集派生内全部有 path 行入指纹（含 fs-tools 数组双包）
      const fpRows = boot.rowset.rowIds
        .map((id) => boot.rowset.catalogRows.find((r) => r.id === id && r.tree === 'shell'))
        .filter((r) => r?.path !== undefined);
      const fsRow = fpRows.find((r) => r!.id === 'fs-tools');
      expect(Array.isArray(fsRow!.path)).toBe(true); // 跨两包（fs-tools + file-snapshots）
      expect(boot.fingerprint.root).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await boot.close();
    }
  }, 20_000);
});

describe('M8.1 第三批：依赖链行装配（jobs/shell-tools/harness-tools；convSettings 归垫片）', () => {
  it('三行真装配 + 行集闭包自动补依赖（点名 shell-tools/harness-tools → tools/jobs 并入）', async () => {
    const dir = path.join(ROOT, 'agents', 'eps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      id: 'eps', model: 'mock', tools: { include: ['shell-tools', 'harness-tools'] },
    }), 'utf-8');
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'eps', catalogFile: CATALOG }, { emit: () => {} });
    try {
      // 闭包：依赖行自动并入（含 tools 基座）
      for (const id of ['tools', 'jobs', 'shell-tools', 'harness-tools']) {
        expect(boot.rowset.rowIds, id + ' 应经闭包/点名在集').toContain(id);
      }
      // conv-settings 已改树入宿主（cr-565）：壳侧服务由垫片提供（非行集行）
      expect(boot.rowset.rowIds).not.toContain('conv-settings');
      expect(boot.ctx.get('jobs', false)).toBeDefined();
      const cs = boot.ctx.get('convSettings', false) as { listKeys(): Array<{ key: string }> };
      expect(cs).toBeDefined();
      // harness-tools apply 真执行（registerKey 生效——依赖序经装配终检收敛）
      expect(cs.listKeys().map((k) => k.key)).toContain('harnessTier');
      // 工具面：平台命令工具 + job 管理 + harness 委托
      const tools = boot.ctx.get('tools') as { list(): Array<{ name: string }> };
      const names = tools.list().map((t) => t.name);
      expect(names).toContain('job');
      expect(names).toContain('run_harness');
      expect(names).toContain(process.platform === 'win32' ? 'pwsh' : 'bash');
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('cordis PENDING 唤醒契约：依赖行后装，先装行（乱序）排空后 ACTIVE', async () => {
    const ctx = new Context();
    const fibers = [] as Array<{ state: number; uid: number | null; dispose(): Promise<void> }>;
    try {
      // 乱序装配：harness-tools 先行（tools 缺——convSettings 由垫片就位）→
      // PENDING；依赖行到位后 cordis notify 唤醒——await 排空后全部 ACTIVE。
      const shims = ctx.plugin(makeShimsRow(ROOT) as unknown as Plugin);
      const h = ctx.plugin(IMPORTED_ROWS['harness-tools']!);
      const s = ctx.plugin(IMPORTED_ROWS['shell-tools']!);
      fibers.push(shims, h, s);
      await Promise.all([shims, h, s]);
      expect(h.state).toBe(FiberStates.PENDING); // await 不报错的静默面（终检的动因）
      const t = ctx.plugin(IMPORTED_ROWS['tools']!);
      const j = ctx.plugin(IMPORTED_ROWS['jobs']!);
      fibers.push(t, j);
      await Promise.all([h, s, t, j]);
      for (const f of [shims, h, s, j, t]) expect(f.state).toBe(FiberStates.ACTIVE);
      const csSvc = ctx.get('convSettings') as { listKeys(): Array<{ key: string }> };
      expect(csSvc.listKeys().map((k) => k.key)).toContain('harnessTier');
    } finally {
      for (const f of [...fibers].reverse()) {
        if (f.uid !== null) await f.dispose();
      }
    }
  }, 20_000);

  it('装配终检 fail-loud：显式排除依赖行（shell-tools exclude jobs）→ boot 拒绝', async () => {
    const dir = path.join(ROOT, 'agents', 'zet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      id: 'zet', model: 'mock',
      tools: { include: ['shell-tools'], exclude: ['jobs'] },
    }), 'utf-8');
    await expect(bootShell({ dataRoot: ROOT, agentId: 'zet', catalogFile: CATALOG }, { emit: () => {} }))
      .rejects.toThrow(/未激活|PENDING/);
  }, 20_000);
});

describe('M8.1 第四批：交互承重与评测行（durable-interaction / ask-questions / bench）', () => {
  it('durable-interaction + ask-questions 真装配：服务到位 + jsonl 落盘指错数据根 + ask_questions 工具发起-作答闭环', async () => {
    const dir = path.join(ROOT, 'agents', 'eta');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'),
      JSON.stringify({ id: 'eta', model: 'mock', tools: { include: ['ask-questions'] } }), 'utf-8');
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'eta', catalogFile: CATALOG }, { emit: () => {} });
    try {
      // 闭包并入：ask-questions requires tools + durable-interaction
      for (const id of ['tools', 'durable-interaction', 'ask-questions']) {
        expect(boot.rowset.rowIds, id + ' 应经闭包/点名在集').toContain(id);
      }
      const svc = boot.ctx.get('durableInteraction') as {
        open(i: { key: string; kind: string; payload: unknown; owner?: string }): { id: string; state: string };
        reply(id: string, answer: unknown): { status: string };
        get(id: string): { state: string } | undefined;
      };
      expect(svc).toBeDefined();
      // 落盘锚定 agent 域（A8 per-agent 数据化 cr-528——jsonl 后端懒建目录，open 后才可见）
      const rec = svc.open({ key: 'a~b', kind: 'ask_questions', payload: { questions: [] }, owner: 'eta' });
      expect(rec.state).toBe('pending');
      expect(fs.existsSync(path.join(ROOT, 'agents', 'eta', 'interactions.jsonl'))).toBe(true);
      expect(svc.reply(rec.id, { answers: ['A'] }).status).toBe('ok');
      expect(svc.get(rec.id)!.state).toBe('answered');
      // ask_questions 工具在册（发起体——会话/应答通道缺席组合可选，不阻断装配）
      const tools = boot.ctx.get('tools') as { list(): Array<{ name: string }> };
      expect(tools.list().map((t) => t.name)).toContain('ask_questions');
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('M8.6 idle-exit 探针：durable pending 阻止收割，答毕且四面空闲 → 可收割', async () => {
    const dir = path.join(ROOT, 'agents', 'eta');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'),
      JSON.stringify({ id: 'eta', model: 'mock', tools: { include: ['ask-questions'] } }), 'utf-8');
    const { shellIsIdle } = await import('../boot.ts');
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'eta', catalogFile: CATALOG, mockProvider: true }, { emit: () => {} });
    try {
      // 四面空闲（无 run / 无 inbox / 无在途交互 / 无活跃 job）
      expect(shellIsIdle(boot.ctx)).toBe(true);
      // 在途交互阻止（③——ask_questions 等待中）
      const svc = boot.ctx.get('durableInteraction') as {
        open(i: { key: string; kind: string; payload: unknown; owner?: string }): { id: string };
        reply(id: string, answer: unknown): { status: string };
      };
      const rec = svc.open({ key: 'idle~probe', kind: 'ask_questions', payload: { questions: [] }, owner: 'eta' });
      expect(shellIsIdle(boot.ctx)).toBe(false);
      expect(svc.reply(rec.id, { answers: ['A'] }).status).toBe('ok');
      // reply 触发 late-reply 唤醒 run（ask-questions 行语义——conversation
      // 行随会话基座恒在集后该链真实生效）；等 run 收束后再断言可收割。
      const idleDeadline = Date.now() + 10_000;
      while (!shellIsIdle(boot.ctx)) {
        if (Date.now() > idleDeadline) throw new Error('唤醒 run 未收束——壳恒忙');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(shellIsIdle(boot.ctx)).toBe(true);
    } finally {
      await boot.close();
    }
  }, 20_000);
  it('bench 真装配 + scripted 全链路（mock provider → loop → 临时工具 → 对拍 → 报告）', async () => {
    const dir = path.join(ROOT, 'agents', 'the');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'),
      JSON.stringify({ id: 'the', model: 'mock', tools: { include: ['bench'] } }), 'utf-8');
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'the', catalogFile: CATALOG }, { emit: () => {} });
    try {
      // 闭包并入：bench requires tools + agent-loop（llm 经 agent-loop requires 链再并入）
      for (const id of ['tools', 'agent-loop', 'llm', 'bench']) {
        expect(boot.rowset.rowIds, id + ' 应经闭包/点名在集').toContain(id);
      }
      expect(boot.ctx.get('bench', false)).toBeDefined();
      // mock 薄行动态挂（主线测试同款形态——scriptedBenchRow 非 catalog 行）
      const { scriptedBenchRow, MOCK_PROVIDER, MOCK_MODEL } = await import('ac-bench');
      const mockFiber = boot.ctx.plugin(scriptedBenchRow() as unknown as Plugin);
      await mockFiber;
      try {
        const bench = boot.ctx.get('bench') as {
          run(suiteName: string, options: BenchRunOptions): Promise<BenchReport>;
        };
        const report = await bench.run('bfcl', { model: MOCK_MODEL, provider: MOCK_PROVIDER, scripted: true, limit: 2 });
        expect(report.total).toBeGreaterThan(0);
        expect(report.cases.every((c) => c.pass), JSON.stringify(report.cases.map((c) => ({ id: c.id, error: c.error }))))
          .toBe(true);
      } finally {
        if (mockFiber.uid !== null) await mockFiber.dispose();
      }
    } finally {
      await boot.close();
    }
  }, 30_000);
});

describe('M8.3 run 内 spawn 工具面（subagent 行 + 影子嵌套账本）', () => {
  it('subagent 行装配：工具在册 + ctx.subagents 软取（含 tools 闭包）', async () => {
    const dir = path.join(ROOT, 'agents', 'lamda');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'),
      JSON.stringify({ id: 'lamda', model: 'mock', tools: { include: ['subagent'] } }), 'utf-8');
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'lamda', catalogFile: CATALOG }, { emit: () => {} });
    try {
      for (const id of ['tools', 'subagent']) {
        expect(boot.rowset.rowIds, id + ' 应经闭包/点名在集').toContain(id);
      }
      const tools = boot.ctx.get('tools') as { list(): Array<{ name: string }> };
      expect(tools.list().map((t) => t.name)).toContain('subagent');
      expect(boot.ctx.get('subagents', false)).toBeDefined();
    } finally { await boot.close(); }
  }, 20_000);

  it('影子壳嵌套账本域：子壳 ledger 写 agents/<parent>/children/<child>/sessions/（D4 空间不变式）', async () => {
    // 直接验证 LedgerService agentDirOverride 面（真子壳进程链归 e2e-subagent）
    const { makeLedgerRow } = await import('ac-ledger');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({
      dataRoot: ROOT, agentId: 'kid',
      agentDirOverride: path.join(ROOT, 'agents', 'lamda', 'children', 'kid'),
    }));
    await fiber;
    try {
      const ledger = ctx.get('ledger') as {
        deliverRow(uuid: string, participants: string[], kind: string, row: Record<string, unknown>): Promise<boolean>;
        historyFor(uuid: string): Array<{ role: string; content: string }>;
      };
      await ledger.deliverRow('lamda~kid', ['kid', 'lamda'], 'user', {
        role: 'agent', content: '嵌套域入站', agent_id: 'lamda', requestId: 'r1', uuid: 'lamda~kid',
      });
      expect(fs.existsSync(path.join(ROOT, 'agents', 'lamda', 'children', 'kid', 'sessions', 'lamda~kid', 'messages.jsonl'))).toBe(true);
      expect(ledger.historyFor('lamda~kid').length).toBe(1);
    } finally {
      if (fiber.uid !== null) await fiber.dispose();
    }
  });
});

describe('M8.2 全量 loop 接线（conversation 域 + collab-tools）', () => {
  it('collab-tools 真装配：send_agent 工具在册 + deliver 方言叶闭环（注入会话真身）', async () => {
    const dir = path.join(ROOT, 'agents', 'iota');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'),
      JSON.stringify({ id: 'iota', model: 'mock', tools: { include: ['collab-tools'] } }), 'utf-8');
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'iota', catalogFile: CATALOG }, { emit: () => {} });
    try {
      // 闭包并入：collab-tools requires tools + conversation（agent-loop/llm 经链）
      for (const id of ['tools', 'conversation', 'ledger', 'agent-loop', 'llm']) {
        expect(boot.rowset.rowIds, id + ' 应经闭包/点名在集').toContain(id);
      }
      const tools = boot.ctx.get('tools') as { list(): Array<{ name: string }> };
      const names = tools.list().map((t) => t.name);
      expect(names).toContain('send_agent');
      expect(names).toContain('list_agents');
      // deliver 方言叶闭环：preview conversation 服务注入真身（mock run 收束）
      const conv = boot.ctx.get('conversation', false) as unknown as {
        deliver(agentId: string, inbound: string, options?: { sender?: string }): Promise<{ kind: string }>;
        isBusy(): boolean;
      };
      expect(conv.isBusy()).toBe(false);
      const outcome = await conv.deliver('iota', '协作测试', { sender: 'kappa' });
      expect(outcome.kind).toBe('run');
      // 终稿经全量 loop 真身产出（mock provider 未注册——seed model 'mock' 但无 provider 行路由；
      // llm roster 报错 = error 收束入账，deliver 返回 run 形状即方言叶契约面成立）
      const ledgerRows = (await import('ac-ledger')).readLedger(
        path.join(ROOT, 'agents', 'iota', 'sessions', 'iota~kappa'),
      );
      expect(ledgerRows.rows.length).toBeGreaterThanOrEqual(2); // 入站 + 终稿（error 文本）
    } finally {
      await boot.close();
    }
  }, 30_000);
});

describe('cr-593：agents 垫片词形展开（AgentConfig.rows 行 id → 工具名）', () => {
  it('get()：行 id 按目录投影展开（保序去重）；对象形态 include/exclude 各自展开；无投影透传', async () => {
    const dir = path.join(ROOT, 'agents', 'vocab');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      id: 'vocab', model: 'mock',
      rows: ['fs-tools', 'subagent', 'math'],
    }), 'utf-8');
    const dir2 = path.join(ROOT, 'agents', 'vocab-obj');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({
      id: 'vocab-obj', model: 'mock',
      rows: { include: ['fs-tools'], exclude: ['shell-tools', 'pwsh'] },
    }), 'utf-8');
    const rowTools = { 'fs-tools': ['read', 'write', 'edit'], 'shell-tools': ['pwsh', 'job'] };
    const ctx = new Context();
    const fibers: Array<{ uid: number | null; dispose(): Promise<void> }> = [];
    try {
      const shim = ctx.plugin(makeShimsRow(ROOT, rowTools) as unknown as Plugin);
      fibers.push(shim);
      await shim;
      const agents = ctx.get('agents') as unknown as { get(id: string): { rows: unknown } };
      // 数组形态：行 id 展开 + 工具名透传（主线 list_tools 等按注册名过滤不再落空）
      expect(agents.get('vocab').rows).toEqual(['read', 'write', 'edit', 'subagent', 'math']);
      // 对象形态：include/exclude 各自展开（'pwsh' 直名与 shell-tools 展开去重）
      expect(agents.get('vocab-obj').rows).toEqual({ include: ['read', 'write', 'edit'], exclude: ['pwsh', 'job'] });
    } finally {
      for (const f of [...fibers].reverse()) if (f.uid !== null) await f.dispose();
    }
    // 无投影（旧调用面）：原样透传
    const ctx2 = new Context();
    const shim2 = ctx2.plugin(makeShimsRow(ROOT) as unknown as Plugin);
    await shim2;
    try {
      const agents2 = ctx2.get('agents') as unknown as { get(id: string): { rows: unknown } };
      expect(agents2.get('vocab').rows).toEqual(['fs-tools', 'subagent', 'math']);
    } finally {
      if (shim2.uid !== null) await shim2.dispose();
    }
  }, 20_000);
});
