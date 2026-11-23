// ============================================================
// 壳 boot 骨架单测（M3.2 验收）：argv 解析 / rowset 断言 / 三节拍序列 /
// 锁互斥 / 缺装配器 fail-loud / 进程级冒烟
// 数据根纪律：恒 sandbox/ 独立目录
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { waitForShellReady, socketPathFor, manageRoundTrip, readActivationLock, readBootProgress } from 'ac-envelope-core';
import {
  parseShellArgs, deriveAndAssertRowset, bootShell, assembleRows, seedPlaceholderAssemblers, workspaceClosureRoots,
  replayAnsweredAfterInbox, restartedNoteDelivery,
} from '../boot.ts';
import { subjectFingerprint } from 'ac-fingerprint-core';
import { readAgentConfig, writeAgentConfig, writeAgentProfileAt, writeAgentPatchV3At, rowsToMenuDefs } from 'ac-agents-core';
import { readCatalog } from 'ac-rowset-core';
import { COMPANION_ROW_ROOTS } from 'ac-shell-rows';

const ROOT = path.join('sandbox', 'test-shell-' + process.pid);
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  // v3 播种经 writeAgentConfig（定义拷贝面读数据根 row-catalog.json）
  fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** v3 播种（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud） */
function seedAgent(agentId: string, rows?: string[]): void {
  writeAgentConfig(ROOT, { id: agentId, model: 'test-model', ...(rows !== undefined ? { rows } : {}) });
}

/** children 域 v3 播种（writeAgentConfig 只写顶层 agents/<id>/——子域手装） */
function seedChild(parentId: string, childId: string, rows?: string[]): void {
  const dir = path.join(ROOT, 'agents', parentId, 'children', childId);
  fs.mkdirSync(dir, { recursive: true });
  const capability = readCatalog(path.join(ROOT, 'row-catalog.json')).rows
    .filter((r) => r.tree === 'shell' && r.zone !== 'skeleton')
    .map((r) => ({ id: r.id, ...(r.path !== undefined ? { name: 'link:' + r.path } : {}), ...(r.requires !== undefined ? { requires: r.requires } : {}) }));
  writeAgentProfileAt(dir, { model: 'mock' });
  const { defs, fingerprints } = rowsToMenuDefs(rows, capability);
  writeAgentPatchV3At(dir, defs, fingerprints);
}

describe('M6.5 影子 boot（--parent-id，P2③ 影子不撞锁）', () => {
  it('父壳与影子壳并存：各自 activation.lock 不同域互不干扰', async () => {
    seedAgent('w');
    const parent = await bootShell(
      { dataRoot: ROOT, agentId: 'w', catalogFile: CATALOG },
    );
    // 影子物化（R-5）
    const childDir = path.join(ROOT, 'agents', 'w', 'children', 'w-s1');
    seedChild('w', 'w-s1');
    const shadow = await bootShell(
      { dataRoot: ROOT, agentId: 'w-s1', catalogFile: CATALOG, parentId: 'w' },
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
    )).rejects.toThrow(/配置缺席/);
  });
});

describe('M6.2 主体指纹自报（R-7 两形态同源）', () => {
  it('bootShell 返回根 = 宿主侧同函数对拍同根（漂移 = fail-loud 信号）', async () => {
    seedAgent('fp1');
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'fp1', catalogFile: CATALOG },
    );
    await boot.close();
    // cr-1129 批 4：fingerprint 自报面 = boot-progress.json（stdout 信号退役）
    const progress = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'fp1', 'boot-progress.json'), 'utf-8'));
    expect(progress.bootId).toBe(boot.lockInfo.bootId);
    expect(progress.fingerprintRoot).toBe(boot.fingerprint.root);
    // 宿主侧 verify：同输入同函数（config + catalog + 菜单行包根 × 依赖闭包）
    const hostSide = subjectFingerprint({
      configJson: JSON.stringify(readAgentConfig(ROOT, 'fp1')), // cr-918：与 boot.ts 同读面（patch 赢）
      catalogJson: fs.readFileSync(CATALOG, 'utf-8'),
      // cr-1022 批3 与 boot.ts 同口径：包根 × workspace 依赖闭包 + 伴生根
      rows: boot.rowset.rows
        .filter((row) => row.path !== undefined)
        .flatMap((row) => {
          const roots = [...workspaceClosureRoots(path.resolve(row.path!))];
          const companion = COMPANION_ROW_ROOTS[row.id] as string | undefined;
          if (companion !== undefined) roots.push(...workspaceClosureRoots(path.resolve(companion)));
          return roots.map((root, i) => ({ id: i === 0 ? row.id : row.id + '/' + path.basename(root), root }));
        }),
    });
    expect(hostSide.root).toBe(boot.fingerprint.root);
  });
});

describe('boot 恢复链 R4 串行锁（cr-1015 S1 断根）', () => {
  it('replayAnsweredAfterInbox：R4 重放起跑晚于 inboxRecovery 兑现（不双投）', async () => {
    const events: string[] = [];
    let releaseInbox: (() => void) | undefined;
    const inboxRecovery = new Promise<void>((resolve) => { releaseInbox = resolve; });
    const replayStarted = new Promise<void>((resolve) => {
      const svc = {
        replayAnsweredInteractions: () => new Promise<number>((resolveReplay) => {
          events.push('replay-start');
          resolve();
          resolveReplay(1);
        }),
      };
      replayAnsweredAfterInbox(svc, inboxRecovery, () => {});
    });
    await Promise.resolve(); // 微任务排空一轮——直调并行形态会在此后即已起跑
    expect(events).toEqual([]); // R4 未随 boot 同步起跑（旧形态此处已 push）
    releaseInbox!();
    await replayStarted;
    expect(events).toEqual(['replay-start']); // R4 只在 inbox 恢复兑现后起跑一次
  });

  it('重放计数 > 0 → interaction.replayed 信号；异常落 stderr 不外抛', async () => {
    const signals: string[] = [];
    const errWrite = process.stderr.write;
    const chunks: string[] = [];
    process.stderr.write = ((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      replayAnsweredAfterInbox(
        { replayAnsweredInteractions: async () => 1 },
        Promise.resolve(),
        (s, ...f) => signals.push([s, ...f].join('\t')),
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(signals).toEqual(['interaction.replayed\t1']);
      replayAnsweredAfterInbox(
        { replayAnsweredInteractions: async () => { throw new Error('boom'); } },
        Promise.resolve(),
        () => {},
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(chunks.join('')).toContain('answered 交互重放失败');
    } finally {
      process.stderr.write = errWrite;
    }
  });
});

describe('run 节拍壳侧直写（cr-740 → cr-1127/cr-1129 批4：TSV 信号退役）', () => {
  it('loop/run-started + loop/after-run → runbeat-<agent>.log 两行', async () => {
    seedAgent('rb1');
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'rb1', catalogFile: CATALOG },
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
      const log = fs.readFileSync(path.join(ROOT, '.runtime', 'logs', 'runbeat-rb1.log'), 'utf-8');
      const rows = log.trim().split('\n');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatch(/ run\.started\tr1\tconv-1\tuser\tmock$/);
      expect(rows[1]).toMatch(/ run\.settled\tr1\tconv-1\tstop\t2\t10\t1200$/);
    } finally {
      await boot.close();
    }
  }, 20_000);

  it('error run → settled 尾带截断的 error 字段（制表/换行剥除）', async () => {
    seedAgent('rb2');
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'rb2', catalogFile: CATALOG },
    );
    try {
      boot.ctx.emit('loop/after-run', {
        conversationId: 'conv-2', model: 'mock', messages: [],
      }, {
        finish: 'error', error: 'boom\tnewline\nhere', text: '', steps: [],
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 1 },
      });
      const log = fs.readFileSync(path.join(ROOT, '.runtime', 'logs', 'runbeat-rb2.log'), 'utf-8');
      const settled = log.trim().split('\n')[0];
      expect(settled.split('\t')).toHaveLength(8);
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
  it('rows 缺省 → 全能力菜单；requires 缺失条目 fail-loud（不进即不装）', () => {
    seedAgent('a1');
    const r = deriveAndAssertRowset(ROOT, 'a1', CATALOG);
    expect(r.errors).toEqual([]);
    expect(r.rowIds.length).toBeGreaterThan(0);
    // 死点名在写侧定义拷贝即静默丢——boot 侧 fail-loud 面 = 菜单 requires
    // 完备性校验（缺依赖列名，不做自动注入）
    const dir = path.join(ROOT, 'agents', 'a2');
    fs.mkdirSync(dir, { recursive: true });
    writeAgentProfileAt(dir, { model: 'mock' });
    writeAgentPatchV3At(dir, [{ id: 'math', requires: ['ghost-row'] }], {});
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
      fs.rmSync(path.join(ROOT, 'agents', 'w3', 'children', 'w3-k'), { recursive: true, force: true });
      seedChild('w3', 'w3-k', rows);
      const r = deriveAndAssertRowset(ROOT, 'w3-k', CATALOG, 'w3');
      expect(r.rowIds).not.toContain('subagent');
      if (named) expect(r.rowIds).toContain('math'); // 同批其他行不受波及
    }
    // 顶层形态不受影响：subagent 仍在基础壳行集
    const top = deriveAndAssertRowset(ROOT, 'w3', CATALOG);
    expect(top.rowIds).toContain('subagent');
  });
});

describe('boot 编排（cr-1129 批4：节拍面 = 锁 + boot-progress.json）', () => {
  it('三节拍落盘形态：锁在场 → progress（rows + fingerprint，bootId 贯穿）', async () => {
    seedAgent('b1');
    const exits: Array<() => void> = [];
    // 占位装配器：基础行集全部可装配
    const r = deriveAndAssertRowset(ROOT, 'b1', CATALOG);
    seedPlaceholderAssemblers(r.rows);
    const res = await bootShell(
      { dataRoot: ROOT, agentId: 'b1', catalogFile: CATALOG },
      { onExit: (h) => exits.push(h) },
    );
    // 节拍 1：锁在场（O_EXCL 即节拍——宿主 readActivationLock 面）
    expect(fs.existsSync(path.join(ROOT, 'agents', 'b1', 'activation.lock'))).toBe(true);
    // 节拍 2+3：progress 文件（rows + fingerprint，bootId 与锁同源）
    const progress = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'b1', 'boot-progress.json'), 'utf-8'));
    expect(progress.bootId).toBe(res.lockInfo.bootId);
    expect(progress.rows).toBe(r.rowIds.length);
    expect(progress.fingerprintRoot).toBe(res.fingerprint.root);
    // exit handler 释放锁
    for (const h of exits) h();
    expect(fs.existsSync(path.join(ROOT, 'agents', 'b1', 'activation.lock'))).toBe(false);
  }, 20_000);

  it('缺装配器 fail-loud（目录外行 id——seed 不覆盖）', async () => {
    seedAgent('b2', ['math']); // 行 id（工具名词形随 byTool 退役）
    const r = deriveAndAssertRowset(ROOT, 'b2', CATALOG);
    seedPlaceholderAssemblers(r.rows);
    // 目录外 id 直测 fail-loud 分支（真实场景 = 行集清单引用了不存在的行——
    // 已被静态断言拦截；此处的防线 = 装配器注册表完备性自检）
    await expect(assembleRows(['no-such-row'], null)).rejects.toThrow(/无装配器/);
  });
});

describe('进程级冒烟（真起 boot.ts）', () => {
  it('node boot.ts 全链：锁/progress 落盘 + SIGTERM 优雅退 0 + 锁释放（cr-1129 批4）', async () => {
    seedAgent('c1');
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      fileURLToPath(new URL('../boot.ts', import.meta.url)),
      '--data-root', path.resolve(ROOT),
      '--agent-id', 'c1',
      '--catalog', CATALOG,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    // 就绪判据 = 锁 + probeIpc 实连（stdout 信号退役）
    const lock = await waitForShellReady(path.join(ROOT, 'agents', 'c1'), 25_000);
    expect(lock.transportHint).toBe(socketPathFor(path.resolve(ROOT), 'c1'));
    const progress = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'c1', 'boot-progress.json'), 'utf-8'));
    expect(progress.bootId).toBe(lock.bootId);
    expect(typeof progress.rows).toBe('number');
    // 关停走 manage system/shutdown 帧（Windows SIGTERM 不跑 JS handler——
    // stdin shutdown 行已退役，cr-1129 批4）
    await manageRoundTrip(lock.transportHint, { ctrl: 'system', op: 'shutdown' }, 5_000);
    const code = await new Promise<number>((resolve) => {
      child.on('exit', (c) => resolve(c ?? -1));
    });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(ROOT, 'agents', 'c1', 'activation.lock'))).toBe(false);
  }, 35_000);

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

  it('pid 复用现场（cr-1255）：前代锁 pid 活 + 租约超限 → 接管启动 + 凭据落盘', async () => {
    seedAgent('c3');
    const dir = path.join(ROOT, 'agents', 'c3');
    fs.writeFileSync(path.join(dir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'reused-gen', acquiredAt: 'T', transportHint: '',
    }), 'utf-8');
    const old = new Date(Date.now() - (4 * 30_000 + 60_000));
    fs.utimesSync(path.join(dir, 'activation.lock'), old, old); // 前代心跳已停
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'c3', catalogFile: CATALOG });
    try {
      expect(readActivationLock(dir)?.bootId).toBe(boot.lockInfo.bootId); // 新代持锁
      const progress = readBootProgress(dir);
      expect(progress?.bootId).toBe(boot.lockInfo.bootId);
      expect(progress?.lockTakeover).toContain('租约超限');
    } finally {
      await boot.close();
    }
  }, 35_000);
});

describe('编译产物快照（cr-910 批6 切片四：审计视图）', () => {
  it('boot 后 agents/<id>/boot-graph.json 落盘（行集 + 目录行摘要）', async () => {
    writeAgentConfig(ROOT, { id: 'snap1', model: 'mock' });
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'snap1', catalogFile: CATALOG });
    const snapPath = path.join(ROOT, 'agents', 'snap1', 'boot-graph.json');
    expect(fs.existsSync(snapPath)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    expect(snap.agentId).toBe('snap1');
    expect(Array.isArray(snap.rows)).toBe(true);
    expect(snap.rows.length).toBeGreaterThan(0);
    expect(snap.rows).toContain('tools'); // 骨架行恒在集
    expect(Array.isArray(snap.tools)).toBe(true); // 注册面 dump（cr-1022 批2 形状：rows/tools/rowTools）
    await boot.close();
  });
});

describe('「已重启」注入取消契约（cr-1163：退出 take 未投键）', () => {
  it('恢复面兑现前 take：未投键全量取走，投递循环不再消费', async () => {
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    const received: string[] = [];
    const delivery = restartedNoteDelivery(
      ['conv-a', 'conv-b'],
      gate, // inboxRecovery 永不兑现（模拟恢复面长队——注入仍在等待）
      async (uuid) => { received.push(uuid); },
      () => {},
    );
    expect(delivery.take()).toEqual(['conv-a', 'conv-b']); // take = 全量取走
    resolveGate(); // 退出后恢复面才兑现——投递循环发现已无待投
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toEqual([]); // 无注入起跑点——关闭窗竞态根除
  });

  it('部分投递后 take：只取走剩余未投键（已投不重复）', async () => {
    const received: string[] = [];
    let inFlight: string | null = null;
    const delivery = restartedNoteDelivery(
      ['conv-a', 'conv-b'],
      Promise.resolve(), // 恢复面立即兑现
      async (uuid) => {
        inFlight = uuid; // 投递中（挂起——receive 尚未 resolve）
        await new Promise((r) => setTimeout(r, 50));
        received.push(uuid);
        inFlight = null;
      },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 20)); // conv-a 投递在途（未完成）
    expect(inFlight).toBe('conv-a');
    expect(received).toEqual([]); // 尚无已完成投递
    expect(delivery.take()).toEqual(['conv-b']); // take 只取走未开始的（在途的 conv-a 归本代完成）
    await new Promise((r) => setTimeout(r, 80));
    expect(received).toEqual(['conv-a']); // conv-a 照常完成、conv-b 不再投
  });

  it('空键集：take 恒空（无注入面形态）', () => {
    const delivery = restartedNoteDelivery([], Promise.resolve(), async () => {}, () => {});
    expect(delivery.take()).toEqual([]);
  });
});
