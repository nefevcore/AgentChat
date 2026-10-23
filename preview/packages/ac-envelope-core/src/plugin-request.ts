// ============================================================
// plugin-request.ts —— 插件装卸请求信 payload schema（cr-553；creator
// 模板工具面的信封面——8.9 前置余件②）
//
// 形态依据（gr-540 遗留② + cr-543 插件治理面）：新架构装载 = 授权动作
//（A7/A10）——安装态唯一写者 = 宿主 plugin-registry 行，壳侧工具只有
// 上报意图（M11 语义化中断——ToolResult.interrupt）。install（定型驻留）
// 与 uninstall（永久卸载）走本信封：壳 → 邮局 → 宿主 HostInbox 受理
//（grant 同构）；register（会话级试跑）零宿主参与——壳进程内 ctx.plugin，
// 重启即失天然成立，不走信封。
//
// kind 语义：『域外唯一动作类』与 grant 同族——但动作本体是宿主文件域
// 写（安装/卸载），回执后需驱动 agent 下一轮（主线 receiptAndRetrigger
// 语义），故请求信 kind=message（进 inbox 排队面 + budget 驱动链跑），
// 回执信 kind=receipt（ledger-only——A4 不激活；回执文本与续跑信分立，
// 续跑由受理行直接投 message 信驱动，见宿主行受理面）。
// uuid 键 = 对话会话键原值（回执进发起会话经验流——邮局登记 participants
// 集合 {sender, host} 序无关一致，R-1）。
// ============================================================
import type { Envelope, EndpointId } from './envelope.ts';
import { makeEnvelope } from './envelope.ts';

/** 装卸动作（install = 定型驻留〔安装态 + 免审自动批准〕；uninstall = 永久
 * 卸载〔移出安装态 + 旧版本进 .backup〕） */
export type PluginRequestAction = 'install' | 'uninstall';

/** 插件装卸请求信 payload（免审面 = creator/admin 边界——主线 install_plugin 同语义） */
export interface PluginRequestPayload {
  /** 动作 */
  action: PluginRequestAction;
  /** install：插件源目录（相对调用方沙箱 files/<agentId>/ 或绝对路径） */
  dir?: string;
  /** uninstall：插件名（manifest.name） */
  name?: string;
  /** 发起会话键（回执 + 续跑投回原会话） */
  conversationId: string;
}

/** 受理回执 payload（kind=receipt；对账键 = 信封 requestId 原值） */
export interface PluginReceiptPayload {
  subject: 'plugin-installed' | 'plugin-uninstalled' | 'plugin-rejected';
  /** 发起 agent（= 请求信 sender） */
  agent: string;
  ok: boolean;
  /** install 成功线：name@version + 安装目录 */
  name?: string;
  version?: string;
  installedDir?: string;
  /** 幂等返回标记（同 name+version 且内容一致 → 不重装载） */
  idempotent?: boolean;
  /** uninstall 成功线：备份目录 */
  backupDir?: string;
  /** 拒收/失败线：原因 */
  reason?: string;
  /** 宿主侧行集刷新警告（插件行声明非法条目等） */
  warnings?: string[];
}

/** 构造插件装卸请求信封（壳 → host；kind=message 进宿主收信面） */
export function makePluginRequestEnvelope(input: {
  uuid: string;
  requestId: string;
  sender: EndpointId;
  payload: PluginRequestPayload;
}): Envelope {
  return makeEnvelope({
    uuid: input.uuid,
    requestId: input.requestId,
    sender: input.sender,
    to: 'host',
    kind: 'message',
    budget: 1, // 宿主动作完成后回执 + 续跑各一跳——1 跳预算内闭环
    payload: input.payload,
  });
}

/** 构造受理回执信封（host → agent；uuid/requestId = 请求信原值） */
export function makePluginReceiptEnvelope(input: {
  uuid: string;
  requestId: string;
  to: EndpointId;
  payload: PluginReceiptPayload;
}): Envelope {
  return makeEnvelope({
    uuid: input.uuid,
    requestId: input.requestId,
    sender: 'host',
    to: input.to,
    kind: 'receipt',
    budget: 0,
    payload: input.payload,
  });
}

/** 请求 payload 结构校验（纯函数 fail-closed） */
export function validatePluginRequestPayload(payload: unknown): string[] {
  const issues: string[] = [];
  const p = payload as Partial<PluginRequestPayload> | null;
  if (p === null || typeof p !== 'object') return ['payload 非对象'];
  if (p.action !== 'install' && p.action !== 'uninstall') {
    issues.push('action 非法（仅 install / uninstall）');
    return issues;
  }
  if (p.action === 'install') {
    if (typeof p.dir !== 'string' || p.dir.length === 0) issues.push('install 缺 dir（插件源目录）');
    if (typeof p.name === 'string' && p.name.length === 0) issues.push('name 非非空字符串');
  } else {
    if (typeof p.name !== 'string' || p.name.length === 0) issues.push('uninstall 缺 name（插件名）');
    if (typeof p.dir === 'string' && p.dir.length > 0 && !p.dir.includes('/') && !p.dir.includes('\\')) {
      issues.push('uninstall 不接受 dir（永久卸载按 name 寻址）');
    }
  }
  if (typeof p.conversationId !== 'string' || p.conversationId.length === 0) issues.push('conversationId 缺席');
  return issues;
}

/** 信封是否插件装卸请求（宿主收信面分流——payload.action 词汇判别） */
export function isPluginRequest(env: Envelope): boolean {
  return env.kind === 'message'
    && (env.payload as { action?: unknown; conversationId?: unknown } | null)?.conversationId !== undefined
    && ((env.payload as { action?: unknown } | null)?.action === 'install'
      || (env.payload as { action?: unknown } | null)?.action === 'uninstall');
}
