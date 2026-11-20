// ============================================================
// title-request.ts —— 标题落盘请求 payload schema（cr-672；cr-1175 批 2
// 起经服务帧 title.set——request 档，落盘即推前端 live 帧〔D7〕）
//
// 标题写权归宿主 singles 行（meta/sessions/<sid>.json 单写者），标题生成
// 要 LLM——LLM 只住壳。故壳侧 auto-title 行生成后经服务帧通道发宿主：
// write-if-absent 落盘 + singles/updated 广播。信封构造器与判定器已随
// cr-1175 批 3b 退役。
// ============================================================

/** 标题请求 payload（壳 → host） */
export interface TitleRequestPayload {
  /** 会话键（= viewer/sessions/<sid> 目录名 = meta/sessions/<sid>.json 文件名） */
  conversationId: string;
  /** 生成的标题（已按 TITLE_MAX_LEN 清洗——宿主侧仍按上限再裁一次） */
  title: string;
  /** 发起 agent（= 请求信 sender；诊断/审计用） */
  agent: string;
}

/** payload 结构校验（纯函数 fail-closed：只收集不修复） */
export function validateTitleRequestPayload(payload: unknown): string[] {
  const issues: string[] = [];
  const p = payload as Partial<TitleRequestPayload> | null;
  if (p === null || typeof p !== 'object') return ['payload 非对象'];
  if (typeof p.conversationId !== 'string' || p.conversationId.length === 0) issues.push('conversationId 缺席');
  if (typeof p.title !== 'string' || p.title.trim().length === 0) issues.push('title 缺席或空白');
  if (typeof p.agent !== 'string' || p.agent.length === 0) issues.push('agent 缺席');
  return issues;
}
