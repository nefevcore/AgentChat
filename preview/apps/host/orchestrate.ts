// ============================================================
// orchestrate.ts —— 宿主编排面（M5.3）
//
// 拉起链：spawn boot.ts（argv 注数据根/agentId/catalog）→ 逐行消费
// stdout TSV → ShellWarden 三节拍 → adopted 时可达表登记（hint =
// boot.ready 携带值）→ 邮局路由可直投。进程 IO 注入（spawn 接口），
// 编排逻辑纯域可测。
// ============================================================
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { socketPathFor } from 'ac-envelope-core';
import { ShellWarden, type GuardianEvent } from 'ac-guardian';
import type { PostOffice, ReachabilityTable } from 'ac-post-office';

/** spawn 注入面（测试替身） */
export interface SpawnFn {
  (cmd: string, args: string[]): {
    pid: number;
    stdout: AsyncIterable<string>;
    /** 控制帧通道（shutdown 优雅退出——stdin 可写；测试替身可空实现） */
    write(line: string): void;
    on(event: 'exit', cb: (code: number | null) => void): void;
    kill(): void;
  };
}

/** 预设身份词形（__<template_key>__ = 内置模板键） */
const PRESET_ID = /^__([a-z0-9-]+)__$/;

/** 内置模板目录（ac-host-rows 包内静态配置集——编排面按本文件相对定位，不引依赖） */
const TEMPLATE_DIR = fileURLToPath(new URL('../../packages/ac-host-rows/templates', import.meta.url));

/**
 * 预设身份物化配置（cr-615）：模板 config 剥 preset 与模板自身 id 后改写
 * id（同 agents 行 transientConfigOf 口径）——预设身份与出厂模板同源，不走
 * 裸 {id} 兜底（裸兜底 = 基础壳行集 90 工具词，非模板行全集）。非预设身份
 * 或模板缺席 = undefined。
 */
function presetConfigOf(agentId: string): Record<string, unknown> | undefined {
  const key = PRESET_ID.exec(agentId)?.[1];
  if (key === undefined) return undefined;
  try {
    const template = JSON.parse(
      fs.readFileSync(path.join(TEMPLATE_DIR, key, 'config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const { preset: _preset, id: _templateId, ...body } = template;
    return { ...body, id: agentId };
  } catch {
    return undefined;
  }
}

/** 品牌壳 exe（cr-620：bin/AgentChatShell.exe——make-node-identity 产物，任务管理器可辨；缺席回落 node 本体）。
 * 测试环境恒回落 node（cr-621）：沙箱对未知镜像 exe 拒写 %TEMP%（EPERM 建激活锁），
 * vitest 数据根多在 tmpdir——品牌面只归产品宿主。 */
const SHELL_EXE = (() => {
  const p = fileURLToPath(new URL('../../../bin/AgentChatShell.exe', import.meta.url));
  return fs.existsSync(p) && process.env.VITEST === undefined ? p : process.execPath;
})();

export const defaultSpawn: SpawnFn = (cmd, args) => {
  const child: ChildProcess = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const lines: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const w = waiters.shift();
      if (w !== undefined) w(line);
      else lines.push(line);
    }
  });
  return {
    pid: child.pid ?? -1,
    stdout: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const queued = lines.shift();
          if (queued !== undefined) {
            yield queued;
            continue;
          }
          const line = await new Promise<string>((resolve) => waiters.push(resolve));
          yield line;
        }
      },
    },
    write: (line: string) => { child.stdin?.write(line + '\n'); },
    on: (event, cb) => { child.on(event, cb); },
    kill: () => { child.kill(); },
  };
};

export interface AdoptResult {
  agentId: string;
  bootId: string;
  transportHint: string;
  warden: ShellWarden;
  events: GuardianEvent[];
  /** 壳进程 pid（精确收割锚点——绝不扫进程表） */
  pid: number;
  /** 优雅退出（stdin 控制帧）——resolve 退码 0 + 锁释放 */
  shutdown(): Promise<number | null>;
  /** 强杀兜底（SIGKILL） */
  kill(): void;
  /** stdout 行订阅（boot.ready 后继续到达——guardian.ping / run 节拍 / plugin.load-failed；
   * 常驻监护面〔supervise.ts〕的数据源。单订阅面——后注册覆盖） */
  onLine(cb: (line: string) => void): void;
  /** 进程退出订阅（adopt 后有效；单订阅面——后注册覆盖） */
  onExit(cb: (code: number | null) => void): void;
  /**
   * 控制帧往返（cr-552 跨进程 dry-run 通道）：stdin JSON 行 → 壳 control()
   * → stdout TSV ctrl.done/ctrl.error 回执。并发安全（帧间串行化——控制
   * 帧是管理面低频操作，排队语义足够）。壳死亡时 pending reject。
   */
  control(frame: Record<string, unknown>): Promise<unknown>;
}

/**
 * 拉起壳直到 adopt（boot.ready）或失败（进程退出先于 ready）。
 * adopted 即登记可达表——邮局随即可直投该 agent。
 */
export async function adoptShell(
  input: {
    agentId: string;
    dataRoot: string;
    catalogFile: string;
    bootFile: string;
    reach: ReachabilityTable;
    /** 邮局（可选——在场时 adopted 即转投 outbox 滞留信〔协议 D2 节拍 2〕+
     * 壳 argv 注入 --post-office 地址：壳侧回信/usage 事件信有投递面） */
    postOffice?: PostOffice;
    /** 确定性 mock provider（e2e / 无凭据环境——model 'mock' 路由） */
    mockProvider?: boolean;
    /** 宿主 boot 入口 + 端口（D5 边 2 cr-612：壳 argv 注入 --host-boot/--host-port，
     * 邮局失联时壳侧复活宿主——与 --post-office 成对） */
    hostBoot?: string;
    hostPort?: number;
    spawnFn?: SpawnFn;
    timeoutMs?: number;
  },
): Promise<AdoptResult> {
  const spawnFn = input.spawnFn ?? defaultSpawn;
  const warden = new ShellWarden(input.agentId);
  const events: GuardianEvent[] = [];
  const proc = spawnFn(SHELL_EXE, [
    '--experimental-strip-types',
    input.bootFile,
    '--data-root', path.resolve(input.dataRoot),
    '--agent-id', input.agentId,
    '--catalog', path.resolve(input.catalogFile),
    ...(input.mockProvider === true ? ['--mock-provider', '1'] : []),
    ...(input.postOffice !== undefined ? ['--post-office', input.postOffice.listeningAddress] : []),
    ...(input.hostBoot !== undefined ? ['--host-boot', input.hostBoot] : []),
    ...(input.hostPort !== undefined ? ['--host-port', String(input.hostPort)] : []),
  ]);
  const timeout = input.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeout;
  // agent 配置预置（壳 boot 读 AgentConfig）——编排面确保在场
  const agentDir = path.join(input.dataRoot, 'agents', input.agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  const configFile = path.join(agentDir, 'config.json');
  if (!fs.existsSync(configFile)) {
    // 预设身份（__<template_key>__）→ 出厂模板物化（tools/description 等
    // 全量写入，preset 剥除）；其余身份只写 id：model 缺省由壳侧按全局池
    // 默认连接回落（cr-561——此前写死 'mock' 让新 agent 一定跑在 mock
    // 模型上，正式宿主无该 provider）
    fs.writeFileSync(configFile, JSON.stringify(presetConfigOf(input.agentId) ?? { id: input.agentId }), 'utf-8');
  }
  // 持续订阅面（cr-550 常驻监护）：adopted 后 stdout 行继续分发（心跳/
  // run 节拍/插件装载失败回报），exit 转发订阅方。单订阅——后注册覆盖。
  let lineCb: ((line: string) => void) | null = null;
  let exitCb: ((code: number | null) => void) | null = null;
  // 控制帧往返面（cr-552）：ctrl.done/ctrl.error TSV 行拦截 → pending 队列
  // FIFO 配对（壳侧串行回执——boot.control 逐帧执行后写回执）。行拦截
  // 优先于 lineCb（控制流量不进监护面）。
  const ctrlPending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  const ctrlDispatch = (line: string): boolean => {
    if (!line.startsWith('ctrl.done') && !line.startsWith('ctrl.error')) return false;
    const waiter = ctrlPending.shift();
    if (waiter === undefined) return false; // 无等待者（迟到回执）——吞
    clearTimeout(waiter.timer);
    if (line.startsWith('ctrl.done')) {
      try { waiter.resolve(JSON.parse(line.split('\t').slice(1).join('\t') || 'null')); }
      catch { waiter.resolve(null); }
    } else {
      waiter.reject(new Error(line.split('\t').slice(1).join('\t') || '控制帧执行失败'));
    }
    return true;
  };
  return new Promise<AdoptResult>((resolve, reject) => {
    let settled = false;
    proc.on('exit', (code) => {
      if (!settled) {
        reject(new Error('壳进程早退（code=' + code + '）——未达 boot.ready'));
        return;
      }
      for (const w of ctrlPending.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error('壳进程退出——控制帧无回执'));
      }
      exitCb?.(code);
    });
    void (async () => {
      for await (const line of proc.stdout) {
        // adopt deadline 只辖拉起窗（cr-580 根因修复：此前 adopted 后仍检查，
        // 15s 后下一行 stdout 即退出本循环——ctrl.done/心跳行永无人分发，
        // 控制帧恒 60s 超时、监护面失流。adopted 后循环必须常驻。）
        if (!settled && Date.now() > deadline) {
          reject(new Error('adopt 超时（' + timeout + 'ms）'));
          return;
        }
        if (settled) {
          // adopted 后：控制回执行优先拦截（cr-552——管理面往返，不进监护面）
          if (ctrlDispatch(line)) continue;
          // adopted 后：行直达订阅方（warden 喂养归 supervise 面——adopt 三节拍
          // 消费已完成，避免双计）
          lineCb?.(line);
          continue;
        }
        warden.feedLine(line, Date.now());
        const evts = warden.emitted();
        const adopted = evts.find((e) => e.type === 'adopted');
        if (adopted !== undefined) {
          input.reach.markReachable(input.agentId, adopted.transportHint);
          // adopted = 通道恢复（协议 D2 节拍 2）：滞留信转投（at-least-once）
          if (input.postOffice !== undefined) {
            void input.postOffice.flushOutbox().catch(() => { /* 转投失败留箱重试 */ });
          }
          settled = true;
          resolve({
            agentId: input.agentId,
            bootId: adopted.bootId,
            transportHint: adopted.transportHint,
            warden,
            events: evts,
            pid: proc.pid,
            shutdown: () => new Promise((res) => {
              proc.on('exit', (code) => res(code));
              proc.write('shutdown');
            }),
            kill: () => { proc.kill(); },
            onLine: (cb) => { lineCb = cb; },
            onExit: (cb) => { exitCb = cb; },
            control: (frame) => new Promise((resolve, reject) => {
              // 超时兜底：干跑/评测长任务也不该无限挂（缺省 60s）
              const timer = setTimeout(() => {
                const i = ctrlPending.findIndex((w) => w.timer === timer);
                if (i >= 0) ctrlPending.splice(i, 1);
                reject(new Error('控制帧回执超时'));
              }, 60_000);
              ctrlPending.push({ resolve, reject, timer });
              proc.write(JSON.stringify(frame));
            }),
          });
          continue; // 行流不终止——常驻监护数据源
        }
      }
    })().catch(reject);
  });
}
