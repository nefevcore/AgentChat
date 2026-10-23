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
import type { PostOffice, ReachabilityTable } from 'ac-post-office';
import { adoptShell } from './orchestrate.ts';
import { superviseShell, type SuperviseHandle, type SuperviseSpawnInput, type SuperviseAdopter } from './supervise.ts';

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
}

export interface OrchestratorHandle {
  /** 按需拉起（幂等——首次真拉起，后续复用句柄） */
  ensureAgent(agentId: string): Promise<SuperviseHandle>;
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
export function createOrchestrator(options: OrchestratorOptions): OrchestratorHandle {
  const handles = new Map<string, SuperviseHandle>();

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

  const ensureAgent = async (agentId: string): Promise<SuperviseHandle> => {
    const existing = handles.get(agentId);
    if (existing !== undefined) {
      await existing.restart(); // 幂等：死态重拉 / 活态复用
      return existing;
    }
    const handle = await superviseShell(spawnInputOf(agentId), {
      adopt: adopter,
      ...options.superviseOptions,
      ...{ onPluginLoadFailure: options.superviseOptions?.onPluginLoadFailure },
    });
    if (options.tap !== undefined) {
      handle.onAdopted((hint) => { void options.tap!(agentId, hint); });
      const hint = handle.superviseEvents.find((e) => e.type === 'adopted')?.transportHint;
      if (hint !== undefined) await options.tap(agentId, hint);
    }
    handles.set(agentId, handle);
    return handle;
  };

  const reach = options.reach ?? options.postOffice.reach;

  // 撞活锁救援（cr-612 D5 边 2 配套）：宿主被壳复活后可达表空白，旧壳
  // 持 activation.lock 使 adopt 必拒（单例语义）——救援 = 读锁探活 holder
  // pid，活着即按锁内 transportHint 回登记可达（消息路径立即恢复；监护面
  // 降级——idle-exit 收割旧壳后下次拉起回完整 adopt 链）。
  const rescueReachableFromLock = (agentId: string): boolean => {
    try {
      const info = JSON.parse(
        fs.readFileSync(path.join(options.dataRoot, 'agents', agentId, 'activation.lock'), 'utf-8'),
      ) as { pid: number; transportHint: string };
      if (typeof info.pid !== 'number' || typeof info.transportHint !== 'string') return false;
      process.kill(info.pid, 0); // ESRCH = holder 已死（陈锁）——不登记
      reach.markReachable(agentId, info.transportHint);
      return true;
    } catch {
      return false;
    }
  };

  const ensureHook = (target: string): void => {
    // 拉起拒绝（熔断/已停）不阻塞投递——信已落箱，恒 at-least-once；
    // 拒因上 stderr（宿主此前静默吞 = 「deliver ok 但壳永不起」零诊断面）。
    // 拒因含撞活锁时先走救援回登记，登记成功即刻转投滞留信。
    void ensureAgent(target).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[orchestrator] ensureAgent(${target}) 拉起拒绝——信封滞留发件箱待转投：${msg}\n`);
      if (msg.includes('activation 锁被进程') && rescueReachableFromLock(target)) {
        process.stderr.write(`[orchestrator] ${target} 撞活锁但 holder 活——按锁内 transportHint 回登记可达\n`);
        void options.postOffice.flushOutbox();
      }
    });
  };

  return {
    ensureAgent,
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
