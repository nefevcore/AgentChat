// ============================================================
// 壳 boot 骨架单测（M3.2 验收）：argv 解析 / rowset 断言 / 三节拍序列 /
// 锁互斥 / 缺装配器 fail-loud / 进程级冒烟
// 数据根纪律：恒 sandbox/ 独立目录
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  parseShellArgs, deriveAndAssertRowset, bootShell, assembleRows, seedPlaceholderAssemblers,
} from '../boot.ts';
import { subjectFingerprint } from 'ac-fingerprint-core';

const ROOT = path.join('sandbox', 'test-shell-' + process.pid);
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedAgent(agentId: string, tools?: string[]): void {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    id: agentId, model: 'test-model', ...(tools !== undefined ? { tools } : {}),
  }), 'utf-8');
}

describe('M6.5 影子 boot（--parent-id，P2③ 影子不撞锁）', () => {
  it('父壳与影子壳并存：各自 activation.lock 不同域互不干扰', async () => {
    seedAgent('w');
    const parent = await bootShell(
      { dataRoot: ROOT, agentId: 'w', catalogFile: CATALOG },
      { emit: () => {} },
    );
    // 影子物化（R-5）
    const childDir = path.join(ROOT, 'agents', 'w', 'children', 'w-s1');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, 'config.json'), JSON.stringify({ id: 'w-s1', model: 'mock' }), 'utf-8');
    const shadow = await bootShell(
      { dataRoot: ROOT, agentId: 'w-s1', catalogFile: CATALOG, parentId: 'w' },
      { emit: () => {} },
    );
    // 两锁并存不同路径
    expect(fs.existsSync(path.join(ROOT, 'agents', 'w', 'activation.lock'))).toBe(true);
    expect(fs.existsSync(childDir + path.sep + 'activation.lock')).toBe(true);
    // transportHint 不同（agent 级唯一——复合端点词）
    expect(shadow.transportHint).not.toBe(parent.transportHint);
    await Promise.all([parent.close(), shadow.close()]);
  });

  it('影子配置缺席（children 域无 config）→ fail-loud', async () => {
    seedAgent('w2');
    await expect(bootShell(
      { dataRoot: ROOT, agentId: 'ghost', catalogFile: CATALOG, parentId: 'w2' },
      { emit: () => {} },
    )).rejects.toThrow(/配置缺席/);
  });
});

describe('M6.2 主体指纹自报（R-7 两形态同源）', () => {
  it('bootShell 返回根 = 宿主侧同函数对拍同根（漂移 = fail-loud 信号）', async () => {
    seedAgent('fp1');
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'fp1', catalogFile: CATALOG },
      { emit: (s, ...fields) => signals.push([s, ...fields].join('\t')) },
    );
    await boot.close();
    const ready = signals.find((s) => s.startsWith('boot.ready'))!;
    expect(ready.split('\t')).toHaveLength(4); // signal + bootId + hint + root
    expect(ready.split('\t')[3]).toBe(boot.fingerprint.root);
    // 宿主侧 verify：同输入同函数（config + catalog + 有 path 的行）
    const hostSide = subjectFingerprint({
      configJson: fs.readFileSync(path.join(ROOT, 'agents', 'fp1', 'config.json'), 'utf-8'),
      catalogJson: fs.readFileSync(CATALOG, 'utf-8'),
      rows: boot.rowset.rowIds
        // 树限定：基座行跨树双计（host 版无 path），壳行集只认 shell 版——与 boot.ts 同口径
        .map((id) => boot.rowset.catalogRows.find((r) => r.id === id && r.tree === 'shell'))
        .filter((r) => r?.path !== undefined)
        // path 数组适配与 boot.ts 同口径（一行跨多包 = 多指纹项）
        .flatMap((r) => (Array.isArray(r!.path) ? r!.path : [r!.path!])
          .map((p, i) => ({ id: Array.isArray(r!.path) ? r!.id + '/' + i : r!.id, root: path.resolve(p) }))),
    });
    expect(hostSide.root).toBe(boot.fingerprint.root);
  });
});

describe('run 节拍 emit（cr-740 运维面）', () => {
  it('loop/run-started + loop/after-run → run.started/run.settled TSV', async () => {
    seedAgent('rb1');
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'rb1', catalogFile: CATALOG },
      { emit: (s, ...f) => signals.push([s, ...f].join('	')) },
    );
    try {
      boot.ctx.emit('loop/run-started', {
        runId: 'r1', conversationId: 'conv-1', source: 'user', model: 'mock', messages: [],
      });
      boot.ctx.emit('loop/after-run', {
        runId: 'r1', conversationId: 'conv-1', source: 'user', model: 'mock', messages: [],
      }, {
        finish: 'stop', text: '', steps: [],
        usage: { prompt: 10, completion: 5, promptAccumulated: 10, steps: 2, elapsedMs: 1200 },
      });
      const started = signals.find((s) => s.startsWith('run.started'));
      const settled = signals.find((s) => s.startsWith('run.settled'));
      expect(started).toBe('run.started	r1	conv-1	user	mock');
      // settled：runId/conv/finish/steps/tokens/elapsedMs（无 error 字段）
      expect(settled).toBe('run.settled	r1	conv-1	stop	2	10	1200');
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('error run → settled 尾带截断的 error 字段（\t/\n 剥除）', async () => {
    seedAgent('rb2');
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'rb2', catalogFile: CATALOG },
      { emit: (s, ...f) => signals.push([s, ...f].join('	')) },
    );
    try {
      boot.ctx.emit('loop/after-run', {
        conversationId: 'conv-2', model: 'mock', messages: [],
      }, {
        finish: 'error', error: 'boom\tnewline\nhere', text: '', steps: [],
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 1 },
      });
      const settled = signals.find((s) => s.startsWith('run.settled'))!;
      // 字段数 = 7 + error；error 内制表符/换行已压平
      expect(settled.split('	')).toHaveLength(8);
      expect(settled.endsWith('boom newline here')).toBe(true);
    } finally {
      await boot.close();
    }
  }, 20_000);
});

describe('argv 解析', () => {
  it('必选参数解析 + 可选 catalog', () => {
    const a = parseShellArgs(['--data-root', 'D:/r', '--agent-id', 'alpha', '--catalog', 'c.json']);
    expect(a).toEqual({ dataRoot: 'D:/r', agentId: 'alpha', catalogFile: 'c.json' });
  });
  it('缺参/未知键/缺值 fail-loud', () => {
    expect(() => parseShellArgs(['--data-root', 'x'])).toThrow();
    expect(() => parseShellArgs(['--agent-id', 'a', '--bogus', 'v'])).toThrow();
    expect(() => parseShellArgs(['--data-root'])).toThrow();
  });
});

describe('rowset 派生断言', () => {
  it('tools 缺省 → 基础壳行集；未命中条目 fail-loud', () => {
    seedAgent('a1');
    const r = deriveAndAssertRowset(ROOT, 'a1', CATALOG);
    expect(r.warnings).toEqual([]);
    expect(r.rowIds.length).toBeGreaterThan(0);
    seedAgent('a2', ['no-such-thing']);
    expect(() => deriveAndAssertRowset(ROOT, 'a2', CATALOG)).toThrow(/静态断言失败/);
  });
  it('agent 配置缺席 fail-loud', () => {
    expect(() => deriveAndAssertRowset(ROOT, 'ghost', CATALOG)).toThrow(/配置缺席/);
  });
  // cr-762：子壳恒无 subagent 行——缺省继承与显式点名两路同断（防子孙无限增长）
  it('子壳行集剔除 subagent 行（parentId 形态）', () => {
    seedAgent('w3');
    // 物化子 config：rows 缺省（继承父快照语义）+ 显式点名 subagent 两形态
    let named = false;
    for (const rows of [undefined, ['subagent', 'math']] as Array<string[] | undefined>) {
      named = rows !== undefined;
      const childDir = path.join(ROOT, 'agents', 'w3', 'children', 'w3-k');
      fs.mkdirSync(childDir, { recursive: true });
      fs.writeFileSync(path.join(childDir, 'config.json'), JSON.stringify({
        id: 'w3-k', model: 'mock', ...(rows !== undefined ? { rows } : {}),
      }), 'utf-8');
      const r = deriveAndAssertRowset(ROOT, 'w3-k', CATALOG, 'w3');
      expect(r.rowIds).not.toContain('subagent');
      if (named) expect(r.rowIds).toContain('math'); // 同批其他行不受波及
    }
    // 顶层形态不受影响：subagent 仍在基础壳行集
    const top = deriveAndAssertRowset(ROOT, 'w3', CATALOG);
    expect(top.rowIds).toContain('subagent');
  });
});

describe('boot 编排（emit spy）', () => {
  it('三节拍序列：lock.acquired → rows.ready → ready（bootId 贯穿）', async () => {
    seedAgent('b1');
    const signals: string[] = [];
    const exits: Array<() => void> = [];
    // 占位装配器：基础行集全部可装配
    const r = deriveAndAssertRowset(ROOT, 'b1', CATALOG);
    seedPlaceholderAssemblers(r.catalogRows);
    const res = await bootShell(
      { dataRoot: ROOT, agentId: 'b1', catalogFile: CATALOG },
      { emit: (s, ...f) => signals.push([s, ...f].join('\t')), onExit: (h) => exits.push(h) },
    );
    expect(signals[0].startsWith('boot.lock.acquired\t')).toBe(true);
    expect(signals[1].startsWith('boot.rows.ready\t')).toBe(true);
    expect(signals[2].startsWith('boot.ready\t')).toBe(true);
    const bootId = signals[0].split('\t')[1];
    expect(signals[1].split('\t')[1]).toBe(bootId);
    expect(signals[2].split('\t')[1]).toBe(bootId);
    expect(res.rowsReady).toBe(r.rowIds.length);
    // exit handler 释放锁
    for (const h of exits) h();
    expect(fs.existsSync(path.join(ROOT, 'agents', 'b1', 'activation.lock'))).toBe(false);
  }, 20_000);

  it('缺装配器 fail-loud（目录外行 id——seed 不覆盖）', async () => {
    seedAgent('b2', ['read']);
    const r = deriveAndAssertRowset(ROOT, 'b2', CATALOG);
    seedPlaceholderAssemblers(r.catalogRows);
    // 目录外 id 直测 fail-loud 分支（真实场景 = 行集清单引用了不存在的行——
    // 已被静态断言拦截；此处的防线 = 装配器注册表完备性自检）
    await expect(assembleRows(['no-such-row'], null)).rejects.toThrow(/无装配器/);
  });
});

describe('进程级冒烟（真起 boot.ts）', () => {
  it('node boot.ts 全链：退出码 0 + stdout 三节拍 + 锁文件释放', () => {
    seedAgent('c1');
    const out = execFileSync(process.execPath, [
      '--experimental-strip-types',
      fileURLToPath(new URL('../boot.ts', import.meta.url)),
      '--data-root', path.resolve(ROOT),
      '--agent-id', 'c1',
      '--catalog', CATALOG,
    ], { encoding: 'utf-8' });
    const lines = out.split('\n').filter((l) => l.startsWith('boot.'));
    expect(lines.map((l) => l.split('\t')[0])).toEqual([
      'boot.lock.acquired', 'boot.rows.ready', 'boot.ready',
    ]);
    // 进程退出 → 锁已释放（exit handler）
    expect(fs.existsSync(path.join(ROOT, 'agents', 'c1', 'activation.lock'))).toBe(false);
  }, 30_000);

  it('同 agent 双进程互斥：第二个进程退出码 1 + 拒绝消息', () => {
    seedAgent('c2');
    const bootFile = fileURLToPath(new URL('../boot.ts', import.meta.url));
    const base = [process.execPath, '--experimental-strip-types', bootFile,
      '--data-root', path.resolve(ROOT), '--agent-id', 'c2', '--catalog', CATALOG];
    // 需要一个持锁不退的进程——用 node -e 模拟：先手工放锁（pid = 活进程）
    const dir = path.join(ROOT, 'agents', 'c2');
    fs.writeFileSync(path.join(dir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'holder', acquiredAt: 'T', transportHint: '',
    }), 'utf-8');
    let stderr = '';
    let code = 0;
    try {
      execFileSync(base[0], base.slice(1), { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      code = (err as { status?: number }).status ?? 0;
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(code).toBe(1);
    expect(stderr).toContain('单例语义拒绝');
  }, 30_000);
});
