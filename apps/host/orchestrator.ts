// ============================================================
// orchestrator.ts —— 宿主 app 编排面（cr-551，8.9 前置第二批）
//
// 按需拉起触发链（协议 B1/D2 语义的编排落地）：
//   邮局投递遇不可达端点（ensureHook）→ 落箱照常 → fire-and-forget
//   拉起该 agent 的壳（superviseShell——幂等）→ adopted 即转投 outbox
//   滞留信（D2 节拍 2，adoptShell 链内既有）→ 旁带流 re-tap（新壳
//   新连接——B3 壳死即丢语义的回收面）。
//
// superviseShell 句柄池 = 编排面唯一壳持有面：宿主 boot 起壳先经此处
//（ensureAgent），后续心跳判死/崩溃重拉/熔断全由句柄自持。
//
// 纯域可测：拉起链全注入（SuperviseAdopter / dataRoot 路径拼装注入）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IpcClient, type PostOffice, type ReachabilityTable } from 'ac-post-office';
import { isManageReply, makeManageRequest, type ManageReply } from 'ac-envelope-core';
import { adoptShell, appendRollingLine } from './orchestrate.ts';
import { hostLog } from './host-log.ts';
import { superviseShell, type SuperviseHandle, type SuperviseSpawnInput, type SuperviseAdopter, type RunbeatSink } from './supervise.ts';

/** 编排面装配入参 */
export interface OrchestratorOptions {
  /** 可达表（缺省 = postOffice.reach——同表共治） */
  reach?: ReachabilityTable;
  dataRoot: string;
  catalogFile: string;
  bootFile: string;
  postOffice: PostOffice;
  /** 旁带流 re-tap 面（web 环在场时注入——host-web tapAgent） */
  tap?: (agentId: string, transportHint: string) => Promise<void>;
  /** mock provider（dev/无凭据环境——壳 argv 注入；缺省 false 生产档） */
  mockProvider?: boolean;
  /** 宿主 boot 入口 + 端口（D5 边 2 cr-612：壳 argv 注入——复活职责武装） */
  hostBoot?: string;
  hostPort?: number;
  /** 拉起链注入（测试替身）；缺省 = adoptShell 真链 */
  adopt?: SuperviseAdopter;
  /** supervise 面板注入（测试——退避档/心跳） */
  superviseOptions?: Omit<Partial<import('./supervise.ts').SuperviseOptions>, 'adopt'>;
  /** socket manage 探活超时（缺省 4s——老壳不认 manage 帧时快速降级拉起链） */
  manageProbeMs?: number;
  /** boot 窗口等待（缺省 15s——锁已持有而 ipc 未 listen 的 connect 失败在此窗内重试，cr-681） */
  manageBootWaitMs?: number;
  /** socket manage 控制帧超时（缺省 60s——与 adoptShell.control 同档） */
  manageFrameMs?: number;
  /**
   * run 节拍落盘面（cr-740 运维日志；缺省 = 滚动落
   * dataRoot/.runtime/logs/runbeat-<agent>.log，cap 512KB——shell-<agent>.log
   * 同机制）。时间戳宿主侧盖（壳 TSV 无时标——行到达即写）。
   */
  runbeatSinkOf?: (agentId: string) => RunbeatSink;
  /**
   * 状态对账下沉口（cr-748）：活壳 run-state 对拍驱动的宿主侧动作面——
   * 缺席 = 对账静默（诊断面缺席不反噬）。观察型（emit 语义）：拉起/respawn
   * 归监护链，本面只投递。
   */
  onReconciled?: (event: ReconcileEvent) => void;
}

/** cr-748 状态对账事件（宿主侧动作面） */
export type ReconcileEvent =
  | { type: 'run-settled'; agentId: string; runId: string; conversationId: string; finish: 'ok' | 'interrupted' | 'error'; finishedAt: number }
  | { type: 'shell-emerged'; agentId: string }; // 盘上出现活锁壳而可达表缺席（多见于宿主换代后的孤壳）

export interface OrchestratorHandle {
  /** 按需拉起（幂等——首次真拉起，后续复用句柄） */
  ensureAgent(agentId: string): Promise<SuperviseHandle>;
  /** 宿主换代后活壳收复（cr-659）：可达登记 + 旁带流 re-tap，返回收复数 */
  rescueLiveShells(): number;
  /**
   * 控制帧往返（控制面统一入口）：句柄池活壳 → 盘上活锁壳（socket manage 通道）
   * → 按需拉起。控制面不绑拉起所有权——宿主换代后活壳（stdin 管道已随旧宿主
   * 消失）仍可受控，不再靠「再 spawn 一只壳」（必被单例锁拒）。
   */
  control(agentId: string, frame: Record<string, unknown>): Promise<unknown>;
  /** 盘上活壳清单（持 activation.lock 且 holder 活着——含换代前拉起的孤壳） */
  liveShellIds(): string[];
  /**
   * 只读状态探测（cr-748）：盘上活锁壳逐个经 socket manage 通道取 run-state
   * 快照。**绝不拉起**——探针失败（锁缺席/holder 死/连不上/超时）= 本拍无
   * 数据，spawn 恒归信件驱动的拉起链。返回 per-agent 快照（探测失败的壳
   * 缺席——调用方据此判「壳不在」而非「壳闲」）。
   */
  peek(): Promise<Map<string, RunStateSnapshot>>;
  /** 壳句柄池视图（诊断） */
  handles(): Map<string, SuperviseHandle>;
  /** 邮局 ensure 钩子（boot 接线面——直接作为 setEnsureHook 入参） */
  ensureHook: (target: string) => void;
  /** 收束全部监护（宿主 close 面） */
  close(): void;
}

/**
 * 宿主 app 编排面：句柄池 + 按需拉起 + re-tap + 邮局钩子。
 */
/** 活壳 run-state 快照（壳侧 conversation.runState 投影——cr-748 对账面数据源） */
export interface RunStateSnapshot {
  bootId: string;
  busy: boolean;
  runs: Array<{ conversationId: string; runId: string | null; startedAt: number }>;
  recentSettled: Array<{ runId: string; conversationId: string; finishedAt: number; finish: string }>;
}

export function createOrchestrator(options: OrchestratorOptions): OrchestratorHandle {
  const handles = new Map<string, SuperviseHandle>();

  // run 节拍缺省落盘（cr-740 运维日志）：runbeat-<agent>.log 滚动文件——
  // 活动量/失败面一眼可读。appendRollingLine 自吞失败（诊断面不反噬监护链）。
  const runbeatSinkOf = options.runbeatSinkOf ?? ((agentId: string): RunbeatSink => {
    const file = path.join(options.dataRoot, '.runtime', 'logs', 'runbeat-' + agentId + '.log');
    return (line: string) => appendRollingLine(file, new Date().toISOString() + ' ' + line, 512 * 1024);
  });

  const spawnInputOf = (agentId: string): SuperviseSpawnInput => ({
    agentId,
    dataRoot: options.dataRoot,
    catalogFile: options.catalogFile,
    bootFile: options.bootFile,
    reach: options.reach ?? options.postOffice.reach,
    postOffice: options.postOffice,
    ...(options.hostBoot !== undefined ? { hostBoot: options.hostBoot } : {}),
    ...(options.hostPort !== undefined ? { hostPort: options.hostPort } : {}),
    mockProvider: options.mockProvider ?? false,
  });

  const adopter: SuperviseAdopter = options.adopt ?? ((input) => adoptShell(input));

  // 在飞去重（cr-663 单一仲裁）：并发触发面（ensureHook / restart_shell 信封
  // 钩子 / boot 标记扫）共享同一次拉起——句柄池在 adopt 完成才登记，此前同
  // agent 的并发 ensureAgent 会各自 superviseShell → 双 spawn（R3 anomaly 线索）。
  const inflight = new Map<string, Promise<SuperviseHandle>>();
  const ensureAgent = async (agentId: string): Promise<SuperviseHandle> => {
    const existing = handles.get(agentId);
    if (existing !== undefined) {
      await existing.restart(); // 幂等：死态重拉 / 活态复用
      return existing;
    }
    const pending = inflight.get(agentId);
    if (pending !== undefined) return pending;
    const start = (async () => {
      const handle = await superviseShell(spawnInputOf(agentId), {
        adopt: adopter,
        ...options.superviseOptions,
        ...{ onPluginLoadFailure: options.superviseOptions?.onPluginLoadFailure },
        ...{ onRunbeat: options.superviseOptions?.onRunbeat ?? runbeatSinkOf(agentId) },
      });
      if (options.tap !== undefined) {
        handle.onAdopted((hint) => { void options.tap!(agentId, hint); });
        const hint = handle.superviseEvents.find((e) => e.type === 'adopted')?.transportHint;
        if (hint !== undefined) await options.tap(agentId, hint);
      }
      handles.set(agentId, handle);
      return handle;
    })();
    inflight.set(agentId, start);
    try {
      return await start;
    } finally {
      inflight.delete(agentId);
    }
  };

  const reach = options.reach ?? options.postOffice.reach;

  // 撞活锁探活（cr-612 D5 边 2 / cr-659 共用依据）：读 activation.lock，
  // holder 活着返回其 transportHint；死锁/缺席 = null。
  const liveShellLockOf = (agentId: string): { bootId: string; hint: string } | null => {
    try {
      const info = JSON.parse(
        fs.readFileSync(path.join(options.dataRoot, 'agents', agentId, 'activation.lock'), 'utf-8'),
      ) as { pid: number; bootId?: unknown; transportHint: string };
      if (typeof info.pid !== 'number' || typeof info.transportHint !== 'string') return null;
      process.kill(info.pid, 0); // ESRCH = holder 已死（陈锁）
      return { bootId: typeof info.bootId === 'string' ? info.bootId : String(info.pid), hint: info.transportHint };
    } catch {
      return null;
    }
  };
  const liveShellHintOf = (agentId: string): string | null => liveShellLockOf(agentId)?.hint ?? null;

  // 撞活锁救援（cr-612 D5 边 2 配套）：宿主被壳复活后可达表空白，旧壳
  // 持 activation.lock 使 adopt 必拒（单例语义）——救援 = 探活 holder
  // pid，活着即按锁内 transportHint 回登记可达（消息路径立即恢复；监护面
  // 降级——idle-exit 收割旧壳后下次拉起回完整 adopt 链）。
  const rescueReachableFromLock = (agentId: string): boolean => {
    const hint = liveShellHintOf(agentId);
    if (hint === null) return false;
    reach.markReachable(agentId, hint);
    return true;
  };

  // 宿主换代后活壳收复（cr-659）：restart_host 后新宿主可达表/旁带流
  // 订阅双空白——re-tap 只挂在 adopted 事件上，活壳（持锁、无 adopt）永不
  // 触发 → webui 断连重连后直播帧（llm delta / run-settled / queue）恒断供，
  // 直到该壳恰好重启。boot 扫 agents/*/activation.lock 探活：活壳回登记
  // 可达 + 旁带流 re-tap（帧面在换代后立即恢复，不依赖下一封信触发
  // ensureHook）。监护面维持降级语义（完整 adopt 链归下次拉起）。
  const rescueLiveShells = (): number => {
    let agentIds: string[] = [];
    try { agentIds = fs.readdirSync(path.join(options.dataRoot, 'agents')); } catch { return 0; }
    let rescued = 0;
    for (const agentId of agentIds) {
      const hint = liveShellHintOf(agentId);
      if (hint === null) continue;
      reach.markReachable(agentId, hint);
      if (options.tap !== undefined) {
        void options.tap(agentId, hint).catch((err: unknown) => {
          hostLog('E', 'orchestrator', '活壳 re-tap 失败（' + agentId + '）：' + String(err));
        });
      }
      rescued += 1;
    }
    return rescued;
  };

  // —— 控制面（cr-675）：socket manage 通道 ——
  // 控制帧此前只经 spawn 管道（stdin/stdout）——通道绑在「谁拉的壳」上，宿主
  // 换代后活壳的管道已随旧宿主消失，管理面只能靠再 spawn（单例锁必拒，用户
  // 面 = 「壳进程早退 code=1」）。壳侧把同一个 control() 开在 transportHint 上
  // （ac-envelope-core/manage.ts），本面按「池内句柄 → 盘上活锁壳 → 按需拉起」
  // 三级取通道。
  const manageProbeMs = options.manageProbeMs ?? 4_000;
  const manageFrameMs = options.manageFrameMs ?? 60_000;
  // 壳 boot 窗口（cr-681）：activation 锁在壳 boot 早期取得，ipc listen 在
  // 整段行集装载之后——两事件之间的探针 connect 必 ENOENT。这是窗口内
  // 常态而非「老壳不认帧」：传输层失败按 holder 探活重试等窗口（cr-675
  // 的黑名单 + spawn 降级只保留给「连上了但不应答」的真老壳——锁还在时
  // spawn 必被单例语义拒绝，只会刷屏 + 管理面全挂）。
  const manageBootWaitMs = options.manageBootWaitMs ?? 15_000;
  // 老壳（改动前装载的进程）不认 manage 帧——入站分流无此分支，帧被静默丢。
  // 探针失败按 bootId 记一次：该壳生命周期内后续调用直接走拉起链，不吃二次超时。
  const manageUnsupported = new Set<string>();

  /** 窗口耗尽（holder 活着但 ipc 一直没起来）——不黑名单（boot 慢≠不支持）、不 spawn（锁在必拒） */
  class ManageChannelUnreachable extends Error {}

  const isTransportError = (err: unknown): boolean => typeof (err as { code?: unknown }).code === 'string';
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const withDeadline = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(what + '超时（' + ms + 'ms）')), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /** socket manage 往返（每次独立连接——cr-656 缓存连接被换代带走的教训） */
  const manageCall = async (hint: string, frame: Record<string, unknown>, ms: number): Promise<unknown> => {
    const client = new IpcClient();
    const id = 'manage-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    await client.connect(hint);
    try {
      const reply = await withDeadline(
        client.request(makeManageRequest(id, frame), (f) => isManageReply(f, id)),
        ms, 'manage 回执',
      ) as ManageReply;
      if (reply.manage.ok !== true) throw new Error(reply.manage.error ?? 'manage 帧执行失败');
      return reply.manage.value;
    } finally {
      client.close();
    }
  };

  const liveShellIds = (): string[] => {
    let ids: string[] = [];
    try { ids = fs.readdirSync(path.join(options.dataRoot, 'agents')); } catch { return []; }
    return ids.filter((id) => liveShellLockOf(id) !== null);
  };

  /** 活壳探针（cr-681 含 boot 窗口重试）。返回 alive=false = 探针期间 holder 已死（拉起链正当）；回执超时原样上抛（真老壳——cr-675 黑名单路径）；窗口耗尽抛 ManageChannelUnreachable。 */
  const probeLiveShell = async (agentId: string, lock0: { bootId: string; hint: string }): Promise<{ alive: boolean; hint: string }> => {
    let lock = lock0;
    const deadline = Date.now() + manageBootWaitMs;
    for (;;) {
      try {
        // 探针（run-state 只读）：区分「壳不认 manage 帧」与「壳在退出」——
        // 探针通过后控制帧自身的错误原样上抛（壳侧真实拒因，重试无意义）。
        await manageCall(lock.hint, { ctrl: 'admin', op: 'run-state' }, manageProbeMs);
        return { alive: true, hint: lock.hint };
      } catch (err) {
        if (!isTransportError(err)) throw err; // 回执超时/壳侧错误 → 老壳路径
        const fresh = liveShellLockOf(agentId);
        if (fresh === null) return { alive: false, hint: lock.hint }; // holder 已死/锁消失
        if (fresh.bootId !== lock.bootId) { lock = fresh; continue; } // 壳换代——追新锁
        if (Date.now() + 300 > deadline) {
          throw new ManageChannelUnreachable('活壳 ' + agentId + '（bootId=' + lock.bootId + '，pid 活）的 manage 通道 ' + manageBootWaitMs + 'ms 内不可达——ipc 迟未 listen（boot 卡住或 ipc 起不来）');
        }
        await sleep(300);
      }
    }
  };

  // —— 只读状态探测（cr-748 状态对账批） ——
  // 与 control() 的分野：control 尾部语义 = 探不到就拉起（ensureAgent）——那是
  // 「管理面可用性」的契约；peek 是「状态观测」的契约：任何失败 = 本拍无数据，
  // 下拍再来。boot 窗口（锁已持有而 ipc 未 listen）在轮询模型下天然消化
  //（cr-681 的 15s 阻塞重试窗不需要——poller 间隔即重试）。
  const peek = async (): Promise<Map<string, RunStateSnapshot>> => {
    const out = new Map<string, RunStateSnapshot>();
    for (const agentId of liveShellIds()) {
      const lock = liveShellLockOf(agentId);
      if (lock === null) continue;
      // 可达维持（cr-748）：孤壳（宿主换代后不在可达表）回登记——消息路径
      // 不依赖下一封信触发 ensureHook。活态判定宿主侧无感知，投对账事件。
      if (reach.hintFor(agentId) !== lock.hint) {
        reach.markReachable(agentId, lock.hint);
        options.onReconciled?.({ type: 'shell-emerged', agentId });
      }
      try {
        const st = await manageCall(lock.hint, { ctrl: 'admin', op: 'run-state' }, manageProbeMs) as
          | { busy?: unknown; runs?: unknown; recentSettled?: unknown }
          | null
          | undefined;
        out.set(agentId, {
          bootId: lock.bootId,
          busy: st?.busy === true,
          runs: Array.isArray(st?.runs)
            ? (st.runs as Array<Record<string, unknown>>)
                .filter((r) => typeof r.conversationId === 'string' && r.conversationId !== '')
                .map((r) => ({
                  conversationId: r.conversationId as string,
                  runId: typeof r.runId === 'string' && r.runId !== '' ? r.runId : null,
                  startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
                }))
            : [],
          recentSettled: Array.isArray(st?.recentSettled)
            ? (st.recentSettled as Array<Record<string, unknown>>)
                .filter((r) => typeof r.runId === 'string' && typeof r.conversationId === 'string')
                .map((r) => ({
                  runId: r.runId as string,
                  conversationId: r.conversationId as string,
                  finishedAt: typeof r.finishedAt === 'number' ? r.finishedAt : 0,
                  finish: typeof r.finish === 'string' ? r.finish : 'ok',
                }))
            : [],
        });
      } catch {
        // 探测失败（boot 窗口/老壳/退出中）——本拍无数据，不拉起
      }
    }
    return out;
  };

  const control = async (agentId: string, frame: Record<string, unknown>): Promise<unknown> => {
    const existing = handles.get(agentId);
    if (existing !== undefined) return existing.control(frame);
    const lock = liveShellLockOf(agentId);
    if (lock !== null && !manageUnsupported.has(lock.bootId)) {
      try {
        const probe = await probeLiveShell(agentId, lock);
        if (probe.alive) return await manageCall(probe.hint, frame, manageFrameMs);
        // holder 探针期间死了——锁已放，拉起链正当（落到下方共尾）。
      } catch (err) {
        if (err instanceof ManageChannelUnreachable) throw err; // 不黑名单（boot 慢≠不支持）、不 spawn（锁在必拒）
        manageUnsupported.add(lock.bootId);
        hostLog('W', 'orchestrator', '活壳 manage 通道不可用（' + agentId + '，bootId=' + lock.bootId + '）：' + String(err));
        // 降级拉起（壳可能恰在此刻退出——那时新壳拿锁正当）。拉不起 = 锁 holder
        // 还在跑却不应答控制帧（多为改动前装载的老壳）——把诊断说清楚，别让
        // 用户看到「壳进程早退 code=1」以为平台坏了。
        try {
          const handle = await ensureAgent(agentId);
          return handle.control(frame);
        } catch (spawnErr) {
          const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
          throw new Error('活壳 ' + agentId + ' 不认控制帧（多为改动前装载的壳）且新壳被单例锁拒：' + msg + ' —— 重启该壳后恢复（cr-675）');
        }
      }
    }
    const handle = await ensureAgent(agentId);
    return handle.control(frame);
  };
  const ensureHook = (target: string): void => {
    // 活壳持锁优先（cr-647）：宿主换代后可达表空白，活壳仍持 activation.lock
    // ——先读锁探活回登记并转投滞留信（命中即返，不 spawn 必被单例拒的子壳）。
    // 此前救援只挂在 adopt 失败分支且按错误文本「activation 锁被进程」匹配，
    // 而真链 adoptShell 只产「壳进程早退（code=…）」（壳内拒绝理由不回流），
    // 救援恒不触发 → 宿主重启后活壳消息全部滞留 outbox（cr-647 现场 Phase B）。
    if (rescueReachableFromLock(target)) {
      void options.postOffice.flushOutbox();
      return;
    }
    // 拉起拒绝（熔断/已停）不阻塞投递——信已落箱，恒 at-least-once；
    // 拒因上 stderr（宿主此前静默吞 = 「deliver ok 但壳永不起」零诊断面）。
    void ensureAgent(target).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      hostLog('E', 'orchestrator', `ensureAgent(${target}) 拉起拒绝——信封滞留发件箱待转投：${msg}`);
    });
  };

  return {
    ensureAgent,
    control,
    liveShellIds,
    peek,
    rescueLiveShells,
    handles: () => handles,
    ensureHook,
    close() {
      for (const h of handles.values()) h.stop();
      handles.clear();
    },
  };
}

/** CLI 直跑辅助（boot.ts 编排接线用）：编排面常量拼装 */
export function orchestratorPaths(here: string): { dataRoot: string; catalogFile: string; bootFile: string } {
  return {
    dataRoot: path.resolve(here),
    catalogFile: path.resolve(here, '../catalog/row-catalog.json'),
    bootFile: path.resolve(here, '../shell/boot.ts'),
  };
}
