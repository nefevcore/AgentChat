// ============================================================
// ac-host-face —— 宿主能力面行（cr-886）
//
// ipc 端点 socketPathFor(dataRoot, 'host-face')：discover → 契约全量；
// execute → 远程工具执行（宿主闸复查）；invalidate → 单向失效通知
// （timers/groups/singles 注册表变更时广播——壳收到后重拉 discover）。
// 依赖软取：timers（服务在场判——行集无 timers 行则 timer 工具报不可用，
// 不阻断行激活）。
// ============================================================
import type { Context, Plugin } from '@agentchat/cordis';
import { listenIpcConns, socketPathFor, encodeFrame } from 'ac-envelope-core';
import { corrIdOf, HOST_FACE_TOOLS, HOST_FACE_SECTIONS, type HostFaceFrame } from 'ac-host-face-core';
import { executeHostTool } from './tools.ts';

export const name = 'ac-host-face';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'host-face',
  label: '宿主能力面',
  description: 'ipc 契约端点（discover/execute/invalidate）：timer + update_agent_profile 远程工具、远程段、facts 声明',
  automatic: true,
};

export interface HostFaceRowOptions {
  dataRoot: string;
}

/** 已连接壳列表（invalidate 广播面） */
export class HostFaceService {
  private conns: Set<import("node:net").Socket> = new Set();

  /** @internal 连接登记（行装配时注入） */
  bind(conns: Set<import("node:net").Socket>): void {
    this.conns = conns;
  }

  /** 契约变更通知：向全部在连壳推 invalidate（壳重拉 discover） */
  invalidate(): void {
    for (const s of this.conns) {
      try {
        s.write(encodeFrame({ kind: 'invalidate' }));
      } catch {
        /* 断连由 close 事件回收 */
      }
    }
  }
}

let service: HostFaceService | null = null;

/** 测试/装配面：取当面服务（invalidate 调用口——timers/groups 行变更时用） */
export function currentHostFace(): HostFaceService | null {
  return service;
}

export function makeHostFaceRow(options: HostFaceRowOptions): Plugin {
  return {
    name: 'ac-host-face',
    inject: [],
    apply(ctx: Context) {
      const svc = new HostFaceService();
      service = svc;
      const address = socketPathFor(options.dataRoot, 'host-face');
      const fiber = listenIpcConns(address, (payload) => {
        if (payload === null || typeof payload !== 'object' || typeof (payload as { kind?: unknown }).kind !== 'string') {
          return undefined;
        }
        const frame = payload as HostFaceFrame;
        const corrId = corrIdOf(frame);
        if (frame.kind === 'ping') return { kind: 'pong', corrId };
        if (frame.kind === 'discover') {
          return {
            kind: 'contract',
            corrId,
            contract: {
              version: 1,
              tools: HOST_FACE_TOOLS,
              sections: HOST_FACE_SECTIONS,
              facts: ['singles', 'group'],
            },
          };
        }
        if (frame.kind === 'execute') {
          const r = executeHostTool(ctx, options.dataRoot, frame.tool, frame.args, {
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
          svc.bind(conns);
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