// ============================================================
// service-verbs.ts —— 服务动词词汇表（cr-1175 §4.2 owner 声明——纯数据）
//
// 六类迁移动词的档位与 payload 语义单源。payload 结构沿用各域既有
// 纯库 schema（UsageReportPayload / TitleRequestPayload /
// PluginRequestPayload / GrantPayload——ac-envelope-core 原样，零重复）。
// 受理面 HostServiceDesk 住 ac-host-rows（§4.3），经 boot 注入邮局。
// ============================================================

export type ServiceTier = 'request' | 'report';

export interface ServiceVerbDef {
  tier: ServiceTier;
  /** payload 语义要点（文档面——不承载校验） */
  payloadNote: string;
}

export const SERVICE_VERBS: Readonly<Record<string, ServiceVerbDef>> = {
  'host.restart': { tier: 'request', payloadNote: '{ agentId, conversationId }——送达确认 { accepted: true }；完成通知仍走机制信' },
  'host.respawn-shell': { tier: 'report', payloadNote: '{ agentId }——marker 落盘已兜底' },
  'usage.report': { tier: 'report', payloadNote: 'UsageReportPayload / UsageStepPayload 原样（subject 二态）' },
  'title.set': { tier: 'request', payloadNote: 'TitleRequestPayload 原样——落盘即推前端 live 帧（D7）' },
  'plugin.request': { tier: 'request', payloadNote: 'PluginRequestPayload 原样 + agent 发起方（action=install/uninstall）' },
  'grant.apply': { tier: 'request', payloadNote: 'GrantPayload 原样 + agent/conversationId——回执仍经邮局投 agent 经验流' },
};

/**
 * 服务台受理面（cr-1175）：邮局 listen 对 svc 帧的分派目标——
 * HostServiceDesk（ac-host-rows）的结构子集，boot 装配注入。
 */
export interface ServiceDeskLike {
  handle(frame: { svc: string; reqId?: string; payload: unknown }, senderSocket: unknown): Promise<unknown>;
}
