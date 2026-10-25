// ============================================================
// admin-preview.ts —— agent-admin 跨进程 dry-run 支撑面（cr-552）
//
// 装配链住壳进程（R0a 判据 1——preview/bench 干跑只能发生在壳内），
// 宿主 agent-admin 行经编排面句柄做控制帧往返：
//   control（编排面统一入口：句柄池 → 活锁壳 socket manage → 按需拉起）
//   → 壳内三档链干跑 / 工具目录投影 → 回执（cr-675：控制面不绑拉起所有权）。
// 注入面：OrchestratorHandle（boot 接线时传入）——纯域可测。
// ============================================================

/** 编排面最小面（OrchestratorHandle 的结构子集——避免 apps/host 循环依赖） */
export interface AdminPreviewOrchestrator {
  ensureAgent(agentId: string): Promise<{ control(frame: Record<string, unknown>): Promise<unknown> }>;
  /** 控制面统一入口（cr-675：池外活壳经 socket manage 通道受控——在则优先） */
  control?(agentId: string, frame: Record<string, unknown>): Promise<unknown>;
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
  // 控制面统一入口优先（cr-675）：池外活壳（宿主换代后的孤壳）经它自己的
  // transportHint 答帧；缺此入口才退回「按需拉起 → 句柄控制」（壳在则必被单例锁拒）。
  const call = async <T>(agentId: string, frame: Record<string, unknown>): Promise<T> => {
    if (options.orch.control !== undefined) return await options.orch.control(agentId, frame) as T;
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