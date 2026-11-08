// ============================================================
// ac-host-face-client —— 宿主能力面壳侧行（cr-886）
//
// 装配时序（懒装配——mcp 行同款）：连接与契约拉取在首个 run 前（before-run
// 回调有 fiber 域——异步链里 ctx.tools.register 会挂死，boot 期异步装配不可行，
// cr-886 实测教训）；invalidate/重连只置脏标记，下一 run 边界重建代理面。
// 宿主缺席/旧代：discover 失败 = 零注册零装配（软降级——现状行为不变）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { socketPathFor } from 'ac-envelope-core';
import { HostFaceClient, type HostFaceContract, type HostFaceSectionSpec } from 'ac-host-face-core';
import { sectionOrder, type SectionName } from 'ac-agent-loop';
import { widenToolsForGating } from 'ac-agents';

export const name = 'ac-host-face-client';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'host-face-client',
  label: '宿主能力面（壳侧）',
  description: 'discover 宿主契约：代理工具（timer/update_agent_profile）+ 远程段 + singles/group Shim；invalidate 置脏下一 run 重建；宿主缺席软降级',
  automatic: true,
  listeners: [{ event: 'loop/before-run', role: '懒装配 + 脏重建', description: '宿主能力面懒装配（首 run / invalidate 后重建）' }],
};

export interface HostFaceClientRowOptions {
  dataRoot: string;
};

/** singles 判定 Shim（ctx.get('singles') 消费口——数据根直读 .singles-registry.json） */
class SinglesShim extends Service {
  private dataRoot: string;
  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'singles');
    this.dataRoot = dataRoot;
  }
  get(conversationId: string): unknown {
    try {
      const raw = JSON.parse(fs.readFileSync(
        path.join(this.dataRoot, 'viewer', 'sessions', '.singles-registry.json'), 'utf-8'),
      ) as { entries?: Record<string, unknown> };
      return raw.entries !== undefined && conversationId in raw.entries ? { id: conversationId } : undefined;
    } catch {
      return undefined;
    }
  }
}

/** group 查询 Shim（ctx.get('group') 消费口——groups/<gid>/group.json 直读） */
class GroupShim extends Service {
  private dataRoot: string;
  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'group');
    this.dataRoot = dataRoot;
  }
  get(gid: string): { id: string; name: string; members: string[] } | undefined {
    // 元数据已迁第二层（meta/groups/<gid>/group.json）；兼容窗回落旧位置
    for (const file of [path.join(this.dataRoot, 'meta', 'groups', gid, 'group.json'),
      path.join(this.dataRoot, 'groups', gid, 'group.json')]) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
          id?: string; name?: string; members?: unknown;
        };
        if (typeof raw.name !== 'string' || !Array.isArray(raw.members)) return undefined;
        return { id: gid, name: raw.name, members: raw.members.filter((m): m is string => typeof m === 'string') };
      } catch { /* 试下一位置 */ }
    }
    return undefined;
  }
}

/** 段位名校验（未知名拒装——fail-loud 防宿主拼错位） */
function knownSectionName(name: string): SectionName | null {
  try {
    sectionOrder(name as SectionName);
    return name as SectionName;
  } catch {
    return null;
  }
}

/** 声明式门控展开：gate → provider（widenToolsForGating 展开面 + singles 判定） */
function sectionProvider(
  ctx: Context,
  spec: HostFaceSectionSpec,
): (request: { agent?: string; conversationId?: string; tools?: string[] }) => string {
  return (request) => {
    const gate = spec.gate;
    if (gate !== undefined) {
      if (gate.notSingle === true) {
        const singles = ctx.get('singles', false) as { get(id: string): unknown } | undefined;
        if (request.conversationId !== undefined && singles?.get(request.conversationId) !== undefined) return '';
      }
      if (gate.toolsAll !== undefined || gate.toolsAny !== undefined) {
        const names = new Set(widenToolsForGating(ctx, request.agent, request.conversationId, request.tools));
        if (gate.toolsAll !== undefined && !gate.toolsAll.every((t) => names.has(t))) return '';
        if (gate.toolsAny !== undefined && !gate.toolsAny.some((t) => names.has(t))) return '';
      }
    }
    return spec.text;
  };
}

export function makeHostFaceClientRow(options: HostFaceClientRowOptions): Plugin {
  return {
    name: 'ac-host-face-client',
    // tools 进 inject：代理注册面（apply/回调内 ctx.tools.register 要求 tools
    // 域在场——cr-886 实测：缺此声明 register 挂死）
    inject: ['agentLoop', 'tools'],
    apply(ctx: Context) {
      const client = new HostFaceClient();
      // facts Shim 无条件先建（apply 同步段——行自身 fiber 域）：Shim 是数据根
      // 直读，不依赖宿主进程在场；契约 facts 字段只是「宿主保证注册表可达」的声明。
      // 本地行已提供同名服务时跳过（本地优先）。
      if (ctx.get('singles', false) === undefined) new SinglesShim(ctx, options.dataRoot);
      if (ctx.get('group', false) === undefined) new GroupShim(ctx, options.dataRoot);
      let disposers: Array<() => void> = [];
      let dirty = true; // 未装配 = 需装配
      let assembling = false;
      let hostSeen = false; // 宿主缺席后不再每个 run 重试（下线检测见 onInvalidate）

      const applyContract = (contract: HostFaceContract): void => {
        for (const d of disposers.splice(0)) d();
        // tools → 代理注册（壳闸：requiredTags 门禁照常——宿主声明的门面值）
        for (const spec of contract.tools) {
          const d = ctx.tools.register({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
            ...(spec.requiredTags !== undefined ? { requiredTags: spec.requiredTags } : {}),
            ...(spec.needPermission === true ? { needPermission: true } : {}),
            async execute(args, call) {
              const r = await client.execute(spec.name, args as Record<string, unknown>, {
                agentId: call.agentId,
                conversationId: call.conversationId,
              });
              if (!r.ok) return { ok: false, error: r.error ?? '远程执行失败' };
              return { ok: true, output: r.result ?? {} };
            },
          });
          disposers.push(d);
          console.log('[face-diag] 代理已注册+dispose 收集', spec.name);
        }
        console.log('[face-diag] 工具段完成');
        // sections → 远程段（本地段优先：同名已注册跳过——宿主段是补位面）
        for (const spec of contract.sections) {
          const sectionName = knownSectionName(spec.name);
          if (sectionName === null) {
            ctx.logger.warn('[host-face-client] 契约段位未知，拒装: ' + spec.name);
            continue;
          }
          try {
            const d = ctx.agentLoop.registerPromptSection({
              name: sectionName,
              text: sectionProvider(ctx, spec),
            }, 'ac-host-face-client');
            disposers.push(d);
          } catch {
            // 同名本地段在场（owner 行已注册）——本地优先，宿主补位段跳过
          }
        }
      };

      // 两段式装配（cr-886 实测教训：promise.then 回调脱离 fiber 域——域外
      // ctx.tools.register 挂死。异步链只拉契约暂存 staged；注册在 before-run
      // 回调的同步段应用（fiber 域内）。
      let staged: HostFaceContract | null = null;
      let pending: Promise<void> | null = null;
      const ensureAssembled = (): void => {
        // 同步段：staged 就绪即应用（幂等——dirty 只在成功应用后清）
        if (staged !== null) {
          const contract = staged;
          staged = null;
          try {
            applyContract(contract);
            dirty = false;
          } catch (err) {
            ctx.logger.warn('[host-face-client] 契约应用失败: ' + String(err instanceof Error ? err.message : err));
          }
          return;
        }
        if (!dirty || pending !== null) return;
        const address = socketPathFor(options.dataRoot, 'host-face');
        pending = client.connect(address)
          .then(() => client.discover())
          .then((contract) => {
            staged = contract; // 只暂存——注册留给下一 run 的同步段
            hostSeen = true;
          })
          .catch((err) => {
            if (!hostSeen) {
              ctx.logger.info('[host-face-client] 宿主能力面缺席（软降级——代理面不装配）: ' + String(err instanceof Error ? err.message : err));
            } else {
              ctx.logger.warn('[host-face-client] discover 失败，代理面保持上态: ' + String(err instanceof Error ? err.message : err));
            }
          })
          .finally(() => { pending = null; });
      };

      // invalidate / 重连成功 → 置脏，下一 run 边界重建（不在通知链里注册——fiber 域外）
      client.onInvalidate = () => { dirty = true; };

      ctx.on('loop/before-run', (_call, next) => {
        // 同步段装配：staged 应用（fiber 域内注册）；契约未到时不阻断 run——
        // 下一 run 边界应用（首个 run 装配、次 run 起可见的时序取舍）
        ensureAssembled();
        return next();
      }, { description: '宿主能力面懒装配（首 run / invalidate 后重建）' });

      ctx.fiber.effect(() => {
        return () => {
          for (const d of disposers.splice(0)) d();
          client.close();
        };
      }, 'host-face-client.lifecycle');
    },
  } satisfies Plugin;
}