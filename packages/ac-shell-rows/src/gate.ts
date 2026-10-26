// ============================================================
// gate.ts —— 壳 tools 授权门（M8.6 第一批 cr-527；manifest R2 tools 行
//「授权门 = ac-auth-core 投影，每 run 前重读」——吸收 security-exec，
// 裁决簿〈行资格判例〉3：「门 = 工具调用 waterfall，tools 行注册即得；
// 无门禁壳非合法降级」。物理形态 = tools 行伴生件（COMPANION_ROWS 同
// file-snapshots 先例——行集装配 tools 即得门）。
//
// 语义（授权草稿 C 节 + A14 + tag 解体五职能 ⑤）：
//   · 每 run 前重读两层 auth → projectEffective 现算投影（缓存 run 级——
//     在线吊销最坏延迟 = run 收束 + 下次重读，协议规格 E 最终一致）；
//   · 裁断面 v1（授权资产轴）：MCP 工具执行硬闸——所属服务器 ∈ 投影
//     mcp-server 放行集才放行（fail-closed：投影空 = 全拒）；
//   · 第一方行工具无第二闸——「装了即可见」（requiredTags 已随 tag 机制
//     解体退役；声明面 = 行集引用即授权，A7「装载 = 授权动作」）；
//   · credential 资产不经门（resolve 链在 credentials 垫片，条目缺席 = 空）；
//   · children 物化快照（R-5）：投影读自己域 auth.json，不重算父。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context, Plugin } from '@agentchat/cordis';
import type { LoopRunCall, LoopRunResult } from 'ac-agent-loop';
import type { ToolExecution, ToolResult } from 'ac-tools';
import { readGlobalAuth, readAgentAuth, projectEffective } from 'ac-auth-core';

/** 门配置（boot 装配参数） */
export interface ToolsGateOptions {
  dataRoot: string;
  agentId: string;
  /** agent 域目录覆盖（影子形态 = agents/<parent>/children/<child>/——
   * 授权投影读物化快照域，与 ledger agentDirOverride 同源） */
  agentDirOverride?: string;
  /** 本壳行集（投影 ∩ 行集的行集半边——装配期派生清单） */
  rowset: ReadonlySet<string>;
}

/** 投影的 run 级缓存条目 */
interface ProjectionCache {
  /** mcp-server 放行集（服务器名） */
  mcpAllowed: Set<string>;
}

export function makeToolsGateRow(options: ToolsGateOptions): Plugin {
  return {
    name: 'shell-tools-gate',
    inject: ['tools'],
    apply(ctx: Context) {
      // per-agent auth 路径：影子 = 物化域内 auth.json（children 域非合法
      // agentId，不走 disk.ts agentAuthFile 的 assertAgentId 路径）；顶层
      // = agents/<id>/auth.json
      const agentAuthFile = options.agentDirOverride !== undefined
        ? path.join(options.agentDirOverride, 'auth.json')
        : path.join(options.dataRoot, 'agents', options.agentId, 'auth.json');
      let cache: ProjectionCache | null = null;

      /** 现算投影（每 run 前重读——A14；缓存仅 run 级，run 收束即失效）。
       * readAgentAuth 已封装缺席/损坏 = null（fail-closed 方向：无授权）。 */
      function project(): ProjectionCache {
        if (cache !== null) return cache;
        const global = readGlobalAuth(options.dataRoot);
        const agent = options.agentDirOverride !== undefined
          ? readAgentAuthAt(agentAuthFile)
          : readAgentAuth(options.dataRoot, options.agentId);
        const assets = projectEffective({ global, agent: agent ?? undefined, rowset: options.rowset });
        const mcpAllowed = new Set<string>();
        for (const a of assets) {
          if (a.via === 'global' && a.entry.asset.kind === 'mcp-server') {
            mcpAllowed.add(a.entry.asset.name);
          }
        }
        cache = { mcpAllowed };
        return cache;
      }

      // 每 run 前重读：run 边界清缓存（下一工具调用现算——生效时点语义）
      ctx.on('loop/before-run', (_call: LoopRunCall, next: () => Promise<LoopRunResult>) => {
        cache = null;
        return next();
      }, { description: 'tools 授权门：run 边界投影缓存失效（每 run 前重读）' });

      // MCP 工具执行硬闸：所属服务器 ∈ 投影放行集（fail-closed）
      ctx.on('tool/before-execute', (execution: ToolExecution, next: () => Promise<ToolResult>) => {
        const mcp = ctx.get('mcp', false) as { serverOfTool(n: string): string | undefined } | undefined;
        if (mcp === undefined) return next(); // mcp 行不在集 = 无 MCP 工具
        const server = mcp.serverOfTool(execution.call.name);
        if (server === undefined) return next(); // 非 MCP 工具：装了即可见
        if (!project().mcpAllowed.has(server)) {
          return {
            ok: false as const,
            error: `工具 ${execution.call.name} 所属 MCP 服务器 "${server}" 不在本 agent 授权投影内（denials/未授予/行集不含 mcp 行）——门禁拒绝（fail-closed）。`,
          };
        }
        return next();
      }, { description: 'tools 授权门：MCP 服务器资产投影硬闸' });
    },
  };
}

/** 影子域 auth.json 直读（缺席/损坏 = null——与 disk.ts readAgentAuth 同
 * 语义；children 域路径特化） */
function readAgentAuthAt(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}