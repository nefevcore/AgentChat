// ============================================================
// M8.3 e2e：真子壳 spawn 全链 + evolve bench-gate 验收线。
//   spawn 线：父壳（boot 真进程）内 subagent 行 spawn → 真子壳进程
//   （--parent-id --persist）→ 信封 ipc 直投 → 子壳 mock run 收束 →
//   账本落 agents/<parent>/children/<child>/sessions/（嵌套域）→ 终稿
//   读取 → 多轮 send → stop/delete 收割、父壳全程无扰动。
//   bench 线：evolve 验收门换 bench-gate（控制帧全链）——报告全过 =
//   门过（R-8 快速通道替身：scripted mock 全链）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLedger } from 'ac-ledger';

const ROOT = path.join('sandbox', 'test-sub-e2e-' + process.pid);
const BOOT = fileURLToPath(new URL('../../shell/boot.ts', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
// 收割兜底（cr-513 纪律）：只按 spawn 句柄精确 pid
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function seedAgent(agentId: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: agentId, model: 'mock', ...extra }), 'utf-8');
}

/** 拉起父壳（真进程）并取 control 面（stdin 控制帧 + stdout TSV 回执） */
function startParent(agentId: string) {
  return new Promise<{ control: (frame: Record<string, unknown>) => Promise<unknown>; shutdown: () => Promise<void> }>((resolve, reject) => {
    const child = spawn(process.execPath,
      ['--experimental-strip-types', BOOT, '--data-root', path.resolve(ROOT), '--agent-id', agentId, '--catalog', CATALOG, '--mock-provider', '1', '--persist', 'true'],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    spawned.push(child);
    const lines: string[] = [];
    child.stdout.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) if (l.trim() !== '') lines.push(l); });
    const timer = setTimeout(() => reject(new Error('父壳 boot.ready 超时：' + lines.join(' | '))), 30_000);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('父壳早退 code=' + code)); });
    const iv = setInterval(() => {
      if (lines.some((l) => l.startsWith('boot.ready'))) {
        clearTimeout(timer); clearInterval(iv);
        resolve({
          control: (frame) => new Promise((res2, rej2) => {
            const base = lines.length; // 只扫新增段（旧 ctrl.done 不重放）
            const t2 = setTimeout(() => rej2(new Error('控制帧超时：' + lines.slice(-5).join(' | '))), 60_000);
            const iv2 = setInterval(() => {
              for (let i = lines.length - 1; i >= base; i--) {
                if (lines[i].startsWith('ctrl.done')) {
                  clearTimeout(t2); clearInterval(iv2);
                  try { res2(JSON.parse(lines[i].split('\t').slice(1).join('\t'))); } catch { res2(null); }
                  return;
                }
                if (lines[i].startsWith('ctrl.error')) {
                  clearTimeout(t2); clearInterval(iv2);
                  rej2(new Error(lines[i]));
                  return;
                }
              }
            }, 50);
            child.stdin.write(JSON.stringify(frame) + '\n');
          }),
          shutdown: () => new Promise<void>((res3) => {
            child.stdin.write('shutdown\n');
            child.on('exit', () => res3());
          }),
        });
      }
    }, 50);
  });
}

describe('M8.3 e2e：真子壳 spawn + bench 门', () => {
  it('spawn→投递→子壳 mock run→嵌套域账本→终稿→多轮→delete 收割', async () => {
    seedAgent('mama', { tools: { include: ['subagent'] } });
    const parent = await startParent('mama');
    try {
      // spawn + 同步等终稿（子壳真进程：boot→ipc 收信→conversation→loop mock→settle）
      const spawnOut = await parent.control({ ctrl: 'tool', name: 'subagent',
        args: { action: 'spawn', task: '探查 preview 轨状态', wait_time: 45 },
      }) as { ok: boolean; output?: { subagent_id: string; result?: { text: string } }; error?: string };
      expect(spawnOut.ok, spawnOut.error).toBe(true);
      const childId = spawnOut.output!.subagent_id!;
      // 子壳 mock 终稿 = 入站回声
      expect(spawnOut.output!.result?.text).toContain('[mock 回复 探查 preview 轨状态]');
      // 嵌套域账本（D4）：agents/mama/children/<id>/sessions/mama~<id>/messages.jsonl
      const dir = path.join(ROOT, 'agents', 'mama', 'children', childId, 'sessions', 'mama~' + childId);
      const rows = readLedger(dir).rows;
      expect(rows.length).toBeGreaterThanOrEqual(2); // 入站 + 终稿
      // 多轮 send（sync 第二轮新终稿）
      const send2 = await parent.control({ ctrl: 'tool', name: 'subagent', args: { action: 'send', subagent_id: childId, message: '第二轮追问', mode: 'sync' } }) as { ok: boolean; output?: { result?: { text: string } } };
      expect(send2.ok).toBe(true);
      expect(send2.output?.result?.text).toContain('第二轮追问');
      // list 在场
      const list = await parent.control({ ctrl: 'tool', name: 'subagent', args: { action: 'list' } }) as { ok: boolean; output?: { agents: Array<{ childId: string; status: string }> } };
      expect(list.output!.agents.some((a) => a.childId === childId)).toBe(true);
      // delete 收割（cr-712 归档）：子壳进程退出 + 归档标识在场 + 子域账本保留
      const del = await parent.control({ ctrl: 'tool', name: 'subagent', args: { action: 'delete', subagent_id: childId } }) as { ok: boolean };
      expect(del.ok).toBe(true);
      expect(fs.existsSync(path.join(ROOT, 'agents', 'mama', 'children', childId, 'archived.json'))).toBe(true);
      expect(readLedger(dir).rows.length).toBeGreaterThanOrEqual(2);
    } finally { await parent.shutdown(); }
  }, 120_000);

  it('stop：run 进行中 interrupt（mock run 快收——验证控制帧链路，不验时序）', async () => {
    seedAgent('papi', { tools: { include: ['subagent'] } });
    const parent = await startParent('papi');
    try {
      const spawnOut = await parent.control({ ctrl: 'tool', name: 'subagent', args: { action: 'spawn', task: 't' } }) as { ok: boolean; output?: { subagent_id: string } };
      expect(spawnOut.ok).toBe(true);
      const childId = spawnOut.output!.subagent_id!;
      const stop = await parent.control({ ctrl: 'tool', name: 'subagent', args: { action: 'stop', subagent_id: childId } }) as { ok: boolean; output?: { stopped: boolean } };
      expect(stop.ok).toBe(true);
      // stopped 布尔皆可（run 已收束 = false 属正常竞态——链路通即过）
      await parent.control({ ctrl: 'tool', name: 'subagent', args: { action: 'delete', subagent_id: childId } });
    } finally { await parent.shutdown(); }
  }, 120_000);
});

describe('M8.3 e2e：程序化会话 spawn → 子壳 LLM 工具面（cr-763）', () => {
  // 事故形态复现（cr-763）：发起会话 conv-settings toolMode=tc-programmatic +
  // spawn 点名工具子集（不含 run_code）——修复前 tc-* 词被快照进子 tags，
  // 子壳 narrowToolsByMode 把 LLM 工具面收窄为空集（子 Agent 拿不到任何工具，
  // 纯聊天单步收束）。断言面 = 子壳 admin tool-defs（conversation.toolDefs ——
  // 与真实 run 的 llmToolFace 单源），经子壳 transportHint socket manage 帧直读。
  it('子壳 LLM 工具面非空：tc-programmatic 会话 spawn 不再蒸发工具', async () => {
    seedAgent('coder', { rows: ['run-code', 'fs-tools', 'web-tools', 'subagent'], tags: ['tc-programmatic'] });
    // 发起会话覆盖（宿主直调形态的键——control 帧带 conversationId 即可命中）
    fs.mkdirSync(path.join(ROOT, 'conv-settings'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'conv-settings', 'user~coder.json'),
      JSON.stringify({ toolMode: 'tc-programmatic', elevation: 'full-access' }), 'utf-8');
    const parent = await startParent('coder');
    try {
      const spawnOut = await parent.control({ ctrl: 'tool', name: 'subagent', conversationId: 'user~coder',
        args: { action: 'spawn', task: '调工具任务' } }) as { ok: boolean; output?: { subagent_id: string }; error?: string };
      expect(spawnOut.ok, spawnOut.error).toBe(true);
      const childId = spawnOut.output!.subagent_id!;
      // 子 config：无 tc-* 词（形态跟随装配——子 rows 缺省继承父 rows 含
      // run-code 行 → 合成 tc-programmatic；这里验证缺省继承分支）
      const childCfg = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'agents', 'coder', 'children', childId, 'config.json'), 'utf-8'),
      ) as { tags?: string[]; rows?: string[] };
      expect(childCfg.rows).toContain('run-code');
      expect(childCfg.tags ?? []).toContain('tc-programmatic'); // 形态来自装配
      expect(childCfg.tags ?? []).toContain('full-access'); // 授权词继承面不受影响
      // 子壳 LLM 工具面（toolDefs —— 与真实 run 单源）：mode 集 = ['run_code']，
      // 非空且不再把授予工具全丢
      const defs = await childToolDefs(childId);
      expect(defs.names).toEqual(['run_code']);
      await parent.control({ ctrl: 'tool', name: 'subagent', args: { action: 'delete', subagent_id: childId } });
      // 对照组：spawn 点名工具子集（不含 run_code）——修复前的蒸发形态。
      // 无 tc-* 词 → resolved 面直出（web_search 等授予词在场）。
      const subsetOut = await parent.control({ ctrl: 'tool', name: 'subagent', conversationId: 'user~coder',
        args: { action: 'spawn', task: '子集', tools: ['web_search', 'read', 'write'] } }) as { ok: boolean; output?: { subagent_id: string }; error?: string };
      expect(subsetOut.ok, subsetOut.error).toBe(true);
      const subsetId = subsetOut.output!.subagent_id!;
      const subsetDefs = await childToolDefs(subsetId);
      // 工具名点名透传语义（resolveToolNames）：授予词原样生效（保点名序），
      // edit 未点名不在面。修复前此形态 = 空集（tc-* 继承把面收窄没了）。
      expect(subsetDefs.names).toEqual(['web_search', 'read', 'write']);
      const subsetCfg = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'agents', 'coder', 'children', subsetId, 'config.json'), 'utf-8'),
      ) as { tags?: string[] };
      expect(subsetCfg.tags ?? []).not.toContain('tc-programmatic');
      await parent.control({ ctrl: 'tool', name: 'subagent', args: { action: 'delete', subagent_id: subsetId } });
    } finally { await parent.shutdown(); }
  }, 120_000);

  /** 子壳 admin tool-defs：经 transportHint socket manage 帧直读（子壳 LLM 工具面单源） */
  async function childToolDefs(childId: string): Promise<{ names: string[]; defs: unknown[] }> {
    const { IpcClient } = await import('ac-envelope-core');
    const { makeManageRequest, isManageReply } = await import('ac-envelope-core');
    const lock = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'agents', 'coder', 'children', childId, 'activation.lock'), 'utf-8'),
    ) as { transportHint: string };
    const client = new IpcClient();
    try {
      await client.connect(lock.transportHint);
      const reply = await client.request(
        makeManageRequest('e2e-tooldefs-' + childId, { ctrl: 'admin', op: 'tool-defs', agentId: childId }),
        (frame: unknown) => isManageReply(frame, 'e2e-tooldefs-' + childId),
      ) as { manage: { ok: boolean; value?: { names?: string[]; defs?: unknown[] }; error?: string } };
      if (!reply.manage.ok) throw new Error('tool-defs 失败：' + reply.manage.error);
      return { names: reply.manage.value?.names ?? [], defs: reply.manage.value?.defs ?? [] };
    } finally {
      client.close();
    }
  }
});

describe('M8.3 e2e：evolve bench-gate 验收线', () => {
  it('bench 控制帧全链 → 门过（scripted 报告全过）', async () => {
    const { benchGateCheck } = await import('../bench-gate.ts');
    seedAgent('vetted', { tools: { include: ['bench'] } });
    const parent = await startParent('vetted');
    try {
      const verdict = await benchGateCheck((frame) => parent.control(frame), { limit: 2 });
      expect(verdict.ok, verdict.reason).toBe(true);
      expect(verdict.report?.passed).toBe(verdict.report?.total);
    } finally { await parent.shutdown(); }
  }, 120_000);
});
