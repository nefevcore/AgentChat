// ============================================================
// ac-host-face-client —— 宿主能力面壳侧行（cr-886 → cr-1114 批1）
//
// 承诺面模式（cr-1114）：boot 同步段（apply——行自身 fiber 域）注册静态
// 承诺面代理工具与远程段——spec 直取 core 下沉常量（零 I/O、零 ipc），
// execute 内惰性连接（宿主缺席 = 调用时报可读错误，boot 不被阻塞）。
// 注册即归属——随行卸载自动回收，无 boot 期异步链（cr-886 的 fiber 挂死
// 教训是 then 回调脱域，同步注册无此问题）。
// prepare 缝职责收窄为「对账重建」：discover 契约与在册承诺面 diff——
// 恒等时零操作；schema/段漂移或 invalidate 后重建对应面。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { socketPathFor } from 'ac-envelope-core';
import { HostFaceClient, HOST_FACE_TOOLS, HOST_FACE_PROMISE_SECTIONS, type HostFaceContract, type HostFaceSectionSpec } from 'ac-host-face-core';
import type { ToolSource, ToolSourceFace } from 'ac-tools';
import { SECTION_ORDER, validateSectionOrder } from 'ac-agent-loop';
import { widenToolsForGating } from 'ac-agents';

export const name = 'ac-host-face-client';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'host-face-client',
  label: '宿主能力面（壳侧）',
  description: 'boot 静态承诺面代理工具（timer/update_agent_profile）+ 远程段 + singles/group Shim；prepare 缝对账重建（schema 漂移/invalidate）；宿主缺席时调用报可读错误',
  automatic: true,
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
      // cr-973 迁 meta/sessions/（cr-998 修正：旧 viewer 位是迁移前残留，
      // 自 cr-973 起恒 miss——壳侧 singles 判定失效）
      const raw = JSON.parse(fs.readFileSync(
        path.join(this.dataRoot, 'meta', 'sessions', '.singles-registry.json'), 'utf-8'),
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

/** 段名校验+段位解析（cr-944 动态段位）：核心惯例名回落表值，动态段名读 spec.order；
 * 词形非法/越界/动态段缺 order → null 拒装（fail-loud 防宿主拼错位） */
function resolveSectionPlacement(name: string, order: number | undefined): number | null {
  const core: Record<string, number | undefined> = SECTION_ORDER;
  const resolved = core[name] ?? order;
  if (resolved === undefined) return null;
  try {
    return validateSectionOrder(resolved);
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

/** spec 等价判定（对账用——工具 schema / 段文本+门控逐字段比对） */
function toolSpecEquals(a: { name: string; description: string; parameters: Record<string, unknown> }, b: { name: string; description: string; parameters: Record<string, unknown> }): boolean {
  return a.name === b.name && a.description === b.description
    && JSON.stringify(a.parameters) === JSON.stringify(b.parameters);
}

function sectionSpecEquals(a: HostFaceSectionSpec, b: HostFaceSectionSpec): boolean {
  return a.name === b.name && a.text === b.text && a.order === b.order
    && JSON.stringify(a.gate) === JSON.stringify(b.gate);
}

/**
 * ToolSource 契约实现（cr-1114 批2 改动 10）：host-face 的声明面收口。
 * bootFace = core 下沉常量（零 I/O）；discover = ipc 拉宿主契约
 * （宿主缺席 reject，调用方降级为上态面）。行的 apply 内部走同一常量/
 * 同一 client 实例——本导出是契约面的官方入口（诊断/审计/对账消费），
 * 不引入第二套注册路径。
 */
export function hostFaceToolSource(dataRoot: string): ToolSource & { close(): void } {
  const client = new HostFaceClient();
  return {
    source: 'host-face',
    bootFace: (): ToolSourceFace[] => HOST_FACE_TOOLS.map((s) => ({
      name: s.name,
      description: s.description,
      parameters: s.parameters,
    })),
    discover: async (): Promise<ToolSourceFace[]> => {
      await client.connect(socketPathFor(dataRoot, 'host-face'));
      const contract = await client.discover();
      return contract.tools.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters }));
    },
    close: () => client.close(),
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
      // 在册工具 spec（对账基准面）——随 registerTool 维护（boot 静态承诺面起底）
      let liveToolSpecs: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
      // 在册段 spec（对账基准面）——boot 注册壳内无 owner 段
      let liveSectionSpecs: HostFaceSectionSpec[] = [];
      // 惰性连接（execute 时首连）：宿主缺席 = 调用报可读错误，不阻塞 boot
      const ensureConnected = (): Promise<void> => client.connect(socketPathFor(options.dataRoot, 'host-face'));

      const registerTool = (spec: { name: string; description: string; parameters: Record<string, unknown>; requiredTags?: string[]; needPermission?: boolean }): void => {
        const d = ctx.tools.register({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          ...(spec.requiredTags !== undefined ? { requiredTags: spec.requiredTags } : {}),
          ...(spec.needPermission === true ? { needPermission: true } : {}),
          async execute(args, call) {
            try {
              await ensureConnected();
            } catch (err) {
              return { ok: false, error: '宿主能力面不可达（宿主进程缺席或重启中）——' + String(err instanceof Error ? err.message : err) };
            }
            const r = await client.execute(spec.name, args as Record<string, unknown>, {
              agentId: call.agentId,
              conversationId: call.conversationId,
            });
            if (!r.ok) return { ok: false, error: r.error ?? '远程执行失败' };
            return { ok: true, output: r.result ?? {} };
          },
        });
        disposers.push(d);
        liveToolSpecs.push(spec);
      };

      const registerSection = (spec: HostFaceSectionSpec): void => {
        const order = resolveSectionPlacement(spec.name, spec.order);
        if (order === null) {
          ctx.logger.warn('[host-face-client] 契约段位无法解析（词形/越界/缺 order），拒装: ' + spec.name);
          return;
        }
        try {
          const d = ctx.agentLoop.registerPromptSection({
            name: spec.name,
            order,
            text: sectionProvider(ctx, spec),
          }, 'ac-host-face-client');
          disposers.push(d);
          liveSectionSpecs.push(spec);
        } catch {
          // 同名本地段在场（owner 行已注册）——本地优先，宿主补位段跳过
        }
      };

      // —— 静态承诺面（cr-1114 批1）：boot 同步注册——spec 直取 core 常量。
      for (const spec of HOST_FACE_TOOLS) registerTool(spec);
      // 段承诺面只含壳内恒无本地 owner 的段（GUIDELINES_TIMER）——本地 owner 段
      //（TERMINOLOGY/GUIDELINES_COLLAB——collab-tools）不进 boot 面：骨架行先装
      // 先占位会饿死本地 owner 的 fail-loud 注册（实测事故：collab-tools 装配抛
      // 段名已注册 → 整壳 boot 失败）。本地 owner 段的对账补位在 applyReconcile 承载
      //（行集不含 collab-tools 时 catch 静默跳过 = 兜底语义保持）。
      for (const spec of HOST_FACE_PROMISE_SECTIONS) registerSection(spec);

      // —— 对账重建（prepare 缝——run() 入口第一拍）：discover 拉取契约与在册
      // 承诺面 diff——恒等零操作；漂移（schema 变/invalidate/重连）重建对应面。
      let pending: Promise<void> | null = null;
      let hostSeen = false; // 从未见宿主 → 每 run 重试首连（connect ENOENT 开销极小）；
                              // 见过之后掉线 = 保持上态，重连成功走 onInvalidate 排队对账
      let reconcileQueued = false; // invalidate 置位——下一 run 边界重拉对账

      const applyReconcile = (contract: HostFaceContract): void => {
        // 工具对账 diff（cr-1114 批2：事件载荷——与 MCP 对账同构的
        // tools/source-changed，消费方无 per-source 分支）
        const diffOf = (before: Array<{ name: string; description: string; parameters: Record<string, unknown> }>):
          { added: string[]; removed: string[]; changed: string[] } => {
          const nextNames = new Set(contract.tools.map((t) => t.name));
          const beforeNames = new Set(before.map((t) => t.name));
          return {
            added: contract.tools.filter((t) => !beforeNames.has(t.name)).map((t) => t.name),
            removed: before.filter((t) => !nextNames.has(t.name)).map((t) => t.name),
            changed: contract.tools.filter((t) => {
              const oldOne = before.find((b) => b.name === t.name);
              return oldOne !== undefined && !toolSpecEquals(t, oldOne);
            }).map((t) => t.name),
          };
        };
        // tools 对账：按名对齐比对（契约集 ⊆/≠ 承诺面——增删/漂移都重建）
        const toolsChanged = contract.tools.length !== liveToolSpecs.length
          || contract.tools.some((c) => {
            const live = liveToolSpecs.find((s) => s.name === c.name);
            return live === undefined || !toolSpecEquals(c, live);
          });
        if (toolsChanged) {
          const diff = diffOf(liveToolSpecs);
          // 整体重建：dispose 在册代理（工具+段）→ 按契约重注册。两个基准面
          // 都必须先清（registerTool/registerSection 会回填——漏清即累积）。
          for (const d of disposers.splice(0)) d();
          liveToolSpecs = [];
          liveSectionSpecs = [];
          for (const spec of contract.tools) registerTool(spec);
          for (const spec of contract.sections) registerSection(spec);
          if (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) {
            ctx.emit('tools/source-changed', { source: 'host-face', ...diff });
          }
          return;
        }
        // sections 对账：承诺面外新段注册补位；既有段 spec 漂移重建
        for (const spec of contract.sections) {
          const live = liveSectionSpecs.find((s) => s.name === spec.name);
          if (live === undefined) {
            registerSection(spec);
          } else if (!sectionSpecEquals(spec, live)) {
            // 段 spec 漂移：整体重建（段注册面无定向 dispose 索引——工具
            // disposer 与段混在同一 disposers 列表，只能整体；工具面重建
            // 后与契约同构，diff 为空不 emit）
            for (const d of disposers.splice(0)) d();
            liveToolSpecs = [];
            liveSectionSpecs = [];
            for (const t of contract.tools) registerTool(t);
            for (const s of contract.sections) registerSection(s);
            return;
          }
        }
      };

      const reconcile = (): Promise<void> => {
        if (pending !== null) return pending;
        const address = socketPathFor(options.dataRoot, 'host-face');
        pending = client.connect(address)
          .then(() => client.discover())
          .then((contract) => {
            applyReconcile(contract);
            hostSeen = true;
            reconcileQueued = false;
          })
          .catch((err) => {
            if (!hostSeen) {
              ctx.logger.info('[host-face-client] 宿主能力面缺席（静态承诺面在册，调用时按需连接）: ' + String(err instanceof Error ? err.message : err));
            } else {
              ctx.logger.warn('[host-face-client] discover 失败，代理面保持上态: ' + String(err instanceof Error ? err.message : err));
            }
          })
          .finally(() => { pending = null; });
        return pending;
      };

      // invalidate / 重连成功 → 排队对账，下一 run 边界执行（不在通知链里注册——fiber 域外）
      client.onInvalidate = () => { reconcileQueued = true; };

      // cr-944 P2b：prepare 缝——run() 入口第一拍。首 run 触发首连对账（发现
      // 集与承诺面恒等时零操作）；invalidate 后重拉。宿主离线时 prepare 抛错由
      // agentLoop 放行（软降级）——静态承诺面已在册，工具调用时按需连接。
      ctx.agentLoop.registerSectionPrepare(async () => {
        if (reconcileQueued || !hostSeen) await reconcile();
      }, 'ac-host-face-client');

      ctx.fiber.effect(() => {
        return () => {
          for (const d of disposers.splice(0)) d();
          client.close();
        };
      }, 'host-face-client.lifecycle');
    },
  } satisfies Plugin;
}
