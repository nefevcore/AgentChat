// ============================================================
// ac-host-face —— 宿主能力面行（cr-886 → cr-1121）
//
// ipc 端点 socketPathFor(dataRoot, 'host-face')：discover → 契约全量；
// execute → 远程工具执行（贡献行 executor 路由）；invalidate → 单向
// 失效通知（注册面变更时广播——壳收到后重拉 discover）。
//
// cr-1121 真动态化：契约 = HostFaceRegistry 注册面聚合——贡献行在宿主
// apply 内向 registry 自报 tools/sections/executor，host-face 行不再
// 持有工具清单（摘贡献行 = 该面从契约消失，双闸之宿主闸随行搬走）。
// 注册即归属：贡献行卸载由 cordis 自动回收，无需 dispose 代码。
//
// 契约缓存（meta/host-face-contract.json）：discover 处理器现算契约并
// 原子落盘——壳侧 boot 静态面数据源（首 boot 后零盲窗；壳侧对账语义
// 不变——缓存陈旧由 prepare 缝 discover 对账修正）。写失败不阻断
// discover（缓存 = 加速面，非一致性承重件）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { listenIpcConns, socketPathFor, encodeFrame } from 'ac-envelope-core';
import { corrIdOf, type HostFaceFrame, type HostFaceContract, type HostFaceSectionSpec, type HostFaceToolSpec, type HostToolExecutor } from 'ac-host-face-core';

export const name = 'ac-host-face';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'host-face',
  label: '宿主能力面',
  description: 'ipc 契约端点（discover/execute/invalidate）+ 宿主能力贡献注册面（cr-1121 真动态：契约 = 注册面聚合，宿主写契约缓存供壳 boot 静态面）',
  automatic: true,
};

export interface HostFaceRowOptions {
  dataRoot: string;
}

// —— 内置贡献行（cr-1121）：宿主侧能力行向注册面自报——第三方宿主行同 API ——
export { makeTimerFaceRow } from './timer-face.ts';
export { makeProfileFaceRow } from './profile-face.ts';

/** 贡献注册形状（宿主侧贡献行 → registry） */
export interface HostFaceContribution {
  tools: HostFaceToolSpec[];
  sections: HostFaceSectionSpec[];
  executor: HostToolExecutor;
}


/** 契约缓存落点（宿主写壳读——meta/ 第二层寄居） */
export function contractCachePath(dataRoot: string): string {
  return path.join(dataRoot, 'meta', 'host-face-contract.json');
}

/** 原子写 JSON（tmp + rename） */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * 宿主能力贡献注册面（服务键 'hostFaceRegistry'）。贡献行 apply 内
 * ctx.get('hostFaceRegistry') 拿面注册——注册即归属（disposer 由
 * fiber effect 归属贡献行 fiber），卸载自动回收；每次变更落契约缓存
 * + invalidate 广播。
 */
export class HostFaceRegistry extends Service {
  private entries = new Map<string, HostFaceContribution>();
  private cacheFile: string;
  private broadcast: () => void;

  /** @internal 行装配注入（invalidate 广播口） */
  bindBroadcast(broadcast: () => void): void {
    this.broadcast = broadcast;
  }

  constructor(ctx: Context, options: HostFaceRowOptions) {
    super(ctx, 'hostFaceRegistry');
    this.cacheFile = contractCachePath(options.dataRoot);
    this.broadcast = () => {};
  }

  /** 聚合契约（discover 数据源——always-live 现算，facts 恒宿主全集） */
  contract(): HostFaceContract {
    const tools: HostFaceToolSpec[] = [];
    const sections: HostFaceSectionSpec[] = [];
    for (const contribution of this.entries.values()) {
      tools.push(...contribution.tools);
      sections.push(...contribution.sections);
    }
    return { version: 1, tools, sections, facts: ['singles', 'group'] };
  }

  /** 按名路由执行（宿主闸 = 贡献行 executor 自带：admin 复查/服务在场判） */
  execute(ctx: Context, tool: string, args: Record<string, unknown>, identity: { agentId?: string; conversationId?: string }): { ok: boolean; result?: unknown; error?: string } | Promise<{ ok: boolean; result?: unknown; error?: string }> {
    for (const contribution of this.entries.values()) {
      if (contribution.tools.some((t) => t.name === tool)) {
        return contribution.executor(ctx, args, identity);
      }
    }
    return { ok: false, error: '未知远程工具: ' + tool };
  }

  /**
   * 贡献登记（宿主侧能力行 apply 内调用——注册即归属：cleanup 挂 caller
   * fiber effect，贡献行卸载自动回收 + 契约收敛，调用方零 dispose 代码）。
   * key 撞名 fail-loud。
   */
  contribute(caller: Context, key: string, contribution: HostFaceContribution): void {
    if (this.entries.has(key)) throw new Error('host-face 贡献撞名: ' + key);
    this.entries.set(key, contribution);
    this.sync();
    caller.fiber.effect(() => () => {
      this.entries.delete(key);
      this.sync();
    }, 'host-face-contribute:' + key);
  }

  /** 注册面快照（诊断/审计） */
  contributors(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 契约缓存落盘 + invalidate 广播。缓存 = 壳 boot 静态面数据源（新拉
   * 壳首 run 前可见全集）；写失败仅 warn（缓存缺席 = 壳 boot 静态面空，
   * prepare 缝对账照常收敛）。同步调用——贡献登记都在宿主 boot 期。
   */
  sync(): void {
    const contract = this.contract();
    try {
      writeJsonAtomic(this.cacheFile, contract);
    } catch (err) {
      this.ctx.logger.warn('[host-face] 契约缓存写失败（boot 面回落 discover 对账）: ' + String(err instanceof Error ? err.message : err));
    }
    this.broadcast();
  }
}

let service: HostFaceRegistry | null = null;

/** 测试/装配面：取当面注册面（诊断/invalidate 调用口） */
export function currentHostFace(): HostFaceRegistry | null {
  return service;
}

export function makeHostFaceRow(options: HostFaceRowOptions): Plugin {
  return {
    name: 'ac-host-face',
    inject: [],
    apply(ctx: Context) {
      const svc = new HostFaceRegistry(ctx, options);
      service = svc;
      const address = socketPathFor(options.dataRoot, 'host-face');
      const fiber = listenIpcConns(address, async (payload) => {
        if (payload === null || typeof payload !== 'object' || typeof (payload as { kind?: unknown }).kind !== 'string') {
          return undefined;
        }
        const frame = payload as HostFaceFrame;
        const corrId = corrIdOf(frame);
        if (frame.kind === 'ping') return { kind: 'pong', corrId };
        if (frame.kind === 'discover') {
          const contract = svc.contract();
          try {
            writeJsonAtomic(contractCachePath(options.dataRoot), contract);
          } catch { /* 同 sync()：缓存失败不阻断 discover */ }
          return { kind: 'contract', corrId, contract };
        }
        if (frame.kind === 'execute') {
          const r = await svc.execute(ctx, frame.tool, frame.args, {
            agentId: frame.agentId,
            conversationId: frame.conversationId,
          });
          return { kind: 'exec-result', corrId, ok: r.ok, ...(r.result !== undefined ? { result: r.result } : {}), ...(r.error !== undefined ? { error: r.error } : {}) };
        }
        // invalidate 是宿主→壳单向帧——壳→宿主方向无意义，忽略
        return undefined;
      });
      ctx.fiber.effect(() => {
        void fiber.then(({ server, conns }) => {
          // invalidate 广播口（宿主注册面 sync 时调用）
          svc.bindBroadcast(() => {
            for (const s of conns) {
              try {
                s.write(encodeFrame({ kind: 'invalidate' }));
              } catch {
                /* 断连由 close 事件回收 */
              }
            }
          });
          listening = server;
        });
        let listening: { close(): Promise<void> } | null = null;
        return () => {
          if (service === svc) service = null;
          void listening?.close();
        };
      }, 'host-face.listen');
    },
  } satisfies Plugin;
}
