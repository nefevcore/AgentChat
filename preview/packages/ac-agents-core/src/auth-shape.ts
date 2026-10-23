// ============================================================
// auth-shape.ts —— 授权层 JSON 形状（fixture 自包含垫片）
//
// 只复述 auth.json 的盘上形状（读写本体在 ac-auth-core——包间不拉依赖，
// cutover 时若需并源再议）。语义注释见 ac-auth-core/src/auth.ts。
// ============================================================

export interface GlobalAuthShape {
  version: 1;
  entries: Array<{
    id: string;
    asset: { kind: 'credential'; ref: string } | { kind: 'row-load'; rowId: string } | { kind: 'mcp-server'; name: string };
    grantedAt: string;
    grantSource: string;
    revokedAt?: string;
    note?: string;
  }>;
}

export interface AgentAuthShape {
  version: 1;
  agentId: string;
  parentId?: string;
  materializedAt?: string;
  grants: Array<{ globalId?: string; row?: string; mcp?: string; inline?: unknown }>;
  denials: Array<{ globalId?: string; row?: string; mcp?: string; inline?: unknown }>;
}
