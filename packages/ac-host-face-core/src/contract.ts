// ============================================================
// ac-host-face-core/src/contract.ts —— 宿主能力面契约词汇（cr-886）
//
// 宿主声明能力（facts/tools/sections），壳 boot 时 discover 按契约装配
// 本地代理（MCP 同构：宿主 = server，壳 = client）。
//
// 帧协议复用 ac-envelope-core ipc（长度前缀 JSON），端点 = socketPathFor
// (dataRoot, 'host-face')。帧分四类（kind 判别）：
//   discover   壳→宿主：请求完整契约（响应同 corrId，kind=contract）
//   execute    壳→宿主：远程工具执行请求（响应同 corrId，kind=exec-result）
//   invalidate 宿主→壳：单向通知契约已变（壳收到后重拉 discover）
//   ping       壳→宿主：活性探测（响应 kind=pong）
// 多路复用：每帧携带 corrId（壳侧生成，单调递增 + 随机前缀防重启撞号），
// client 按 corrId 分发回帧——同连接可并发多在途请求（IpcClient 单飞语义
// 不满足工具 execute 并发面，故 client 直连 socket 自管分发）。
// ============================================================

/** 远程工具声明（壳侧注册代理的完整参数——与 ToolDefinition 注册面同形） */
export interface HostFaceToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiredTags?: string[];
  needPermission?: boolean;
}

/** 远程段贡献（cr-944 动态段位：核心惯例名可缺省 order 回落表值；动态段名+order 自报） */
export interface HostFaceSectionSpec {
  /** 段名（SECTION_ORDER 核心惯例名 → 壳侧回落表值；任意名须配 order——壳侧校验后拒装 fail-loud） */
  name: string;
  /** 段位（核心惯例名可缺省；动态段必填——[0,900)） */
  order?: number;
  /** 静态文本（段主体）；门控逻辑以 gate 声明式表达 */
  text: string;
  /** 声明式门控（AND 语义；缺省 = 恒注入） */
  gate?: {
    /** 全部在场才注入（widenToolsForGating 展开面判定——壳侧执行） */
    toolsAll?: string[];
    /** 任一在场才注入 */
    toolsAny?: string[];
    /** 独立会话不注入（多 Agent 会话知识类；壳侧 singles 判定） */
    notSingle?: boolean;
  };
}

/** 宿主能力契约（discover 响应载荷） */
export interface HostFaceContract {
  /** 契约版本（非法结构壳侧拒装并 warn） */
  version: 1;
  /** 远程工具（壳注册代理：schema 原样，execute 转发） */
  tools: HostFaceToolSpec[];
  /** 远程段（壳按具名位注册） */
  sections: HostFaceSectionSpec[];
  /** facts 能力声明：宿主提供 singles/group 注册表查询（壳装配 Shim） */
  facts: Array<'singles' | 'group'>;
}

// ---- 帧形状 ----

export type HostFaceFrame =
  | { kind: 'discover'; corrId: string }
  | { kind: 'execute'; corrId: string; tool: string; args: Record<string, unknown>; agentId?: string; conversationId?: string }
  | { kind: 'ping'; corrId: string }
  | { kind: 'invalidate' }
  | { kind: 'contract'; corrId: string; contract: HostFaceContract }
  | { kind: 'exec-result'; corrId: string; ok: boolean; result?: unknown; error?: string }
  | { kind: 'pong'; corrId: string };

/** 帧类别判定（协议面小词表——非法 kind 帧丢弃并计数） */
export function isHostFaceFrame(v: unknown): v is HostFaceFrame {
  if (v === null || typeof v !== 'object') return false;
  const k = (v as { kind?: unknown }).kind;
  return typeof k === 'string' && ['discover', 'execute', 'ping', 'invalidate', 'contract', 'exec-result', 'pong'].includes(k);
}

/** 回帧的 corrId 提取（invalidate 无 corrId——宿主侧回帧构造用） */
export function corrIdOf(frame: HostFaceFrame): string {
  return frame.kind === 'invalidate' ? '' : frame.corrId;
}