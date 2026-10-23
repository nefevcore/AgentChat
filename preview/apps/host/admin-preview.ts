// ============================================================
// admin-preview.ts —— agent-admin 跨进程 dry-run 支撑面（cr-552）
//
// 装配链住壳进程（R0a 判据 1——preview/bench 干跑只能发生在壳内），
// 宿主 agent-admin 行经编排面句柄做控制帧往返：
//   ensureAgent（幂等拉起）→ handle.control({ctrl:'preview',...}) →
//   壳内三档链干跑 / 工具目录投影 → 回执。
// 注入面：OrchestratorHandle（boot 接线时传入）——纯域可测。
// ============================================================

/** 编排面最小面（OrchestratorHandle 的结构子集——避免 apps/host 循环依赖） */
export interface AdminPreviewOrchestrator {
  ensureAgent(agentId: string): Promise<{ control(frame: Record<string, unknown>): Promise<unknown> }>;
}

export interface AdminPreviewOptions {
  orch: AdminPreviewOrchestrator;
}

/** 超时兜底在 adoptShell.control（60s）——本面纯转发编排 */
export function createAdminPreview(options: AdminPreviewOptions): {
  /** system-prompt 装配预览（三档链干跑——壳内真装配链） */
  systemPrompt(agentId: string, conversationId?: string): Promise<string>;
  /** 装配工具目录（已注册目录〔含 owner 分组锚点，cr-582〕+ 行集投影生效集） */
  assemblyTools(agentId: string): Promise<{
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; owner: string; requiredTags?: string[]; needPermission?: boolean }>;
    enabled: string[];
  }>
} {
  const call = async <T>(agentId: string, frame: Record<string, unknown>): Promise<T> => {
    const handle = await options.orch.ensureAgent(agentId);
    return handle.control(frame) as Promise<T>;
  };
  return {
    systemPrompt: (agentId, conversationId) =>
      call<{ systemPrompt: string }>(agentId, { ctrl: 'preview', what: 'system-prompt', ...(conversationId !== undefined ? { conversationId } : {}) })
        .then((r) => r.systemPrompt),
    assemblyTools: (agentId) => call(agentId, { ctrl: 'preview', what: 'assembly-tools' }),
  };
}