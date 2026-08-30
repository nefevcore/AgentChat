// ============================================================
// @agentchat/contracts/src/source-tag.ts —— 来源标签钩子工厂
//
// 事件触发消息（timer/group/restart 等）统一以 role='user' + source
// 元数据入境；source 不进 LLM 请求（chat API 无此字段，provider 只
// 序列化 role+content），模型仅凭裸正文无法区分事件触发与真实用户
// 输入。约定（对齐 DSH"结构化元数据给 harness、固定句式给模型"的
// 双轨做法）：正文首行方括号标签 = 来源信号，无标签 = 用户本人。
//
// 机制与内容分离（2026-08-24 v4 定稿，无中心注册表）：
//   · 本文件只有两个纯帮助函数工厂（机械部分），可共享、无服务、
//     无状态——任何插件挂不掉别的插件；
//   · 各域插件（timer/subagent/agent-tools/…）自带 SourceTagContract
//     （标签工厂 + 协议小节），在自己的 plugin.ts 里用 ctx.hooks
//     注册两个 ownerless automatic 钩子（同 singles.auto-title 模式：
//     不受 config.hooks 清单与 owner preset 过滤，装载行即生效）；
//   · 卸载域行 = 其标签与协议小节一并消失，互不干扰；
//   · 打标发生在 stepStart（LLM 请求之前），provider 无关——任何
//     协议适配器（OpenAI/GLM/DeepSeek/未来 Anthropic）零重复实现。
//
// 纯净性：messages 与 loopMessages（落盘依据）共享对象引用，钩子
// 绝不原地改写——为待打标消息创建浅拷贝替换 messages 槽位；落盘/
// UI/history 看到的始终是原文。
// 幂等性：钩子每个 ReAct step 重跑完整数组；已打标拷贝记入 WeakSet
// （闭包持有，factory 每次 collect 产生新实例 = per-run 生命周期），
// 跨 step 不重复打标（拷贝携带同一 source，内容判断会误判）。
// ============================================================
import type { MessageSource, MessageSourceKind } from '@agentchat/types';
import type { CurrentContext, RunStartHook, StepStartHook } from './context';
import type { LLMRequestMessage } from '@agentchat/types';

/**
 * 一个域的来源标签契约：该域 kind 的模型可见形态。
 * 各域插件自带常量（标签与协议文本归域，插拔独立）。
 */
export interface SourceTagContract {
  /** 本契约适用的来源 kind（钩子只处理此 kind 的消息） */
  kind: MessageSourceKind;
  /** 标签工厂（agentId 为消息 agent_id：agent 来源的发送者） */
  tag: (source: MessageSource, agentId?: string) => string;
  /**
   * 协议小节（markdown，runStart 追加到 systemPrompt 尾部）。
   * 自含成段（含小节标题），不依赖其他域的小节——各域小节并列，
   * 无中心拼块者，无顺序依赖。
   */
  contractSection: string;
}

/**
 * 构造打标钩子（stepStart）：正文前拼本域来源标签。
 * 只处理 contract.kind 的消息；其他 kind 归其域插件，互不重叠
 * （跨视角群聊发言由 loadGroupHistory 的 <msg from=...> 包装负责）。
 */
export function makeSourceTagStepStartHook(contract: SourceTagContract): StepStartHook {
  const tagged = new WeakSet<object>();
  return async (_ctx: CurrentContext, messages: LLMRequestMessage[]): Promise<void> => {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (tagged.has(m)) continue;
      if (m.role !== 'user') continue;
      if (m.source?.kind !== contract.kind) continue;
      const tag = contract.tag(m.source, m.agent_id);
      if (!tag) continue;
      const copy: LLMRequestMessage = { ...m, content: `${tag}\n${m.content ?? ''}` };
      tagged.add(copy);
      messages[i] = copy;
    }
  };
}

/**
 * 构造协议钩子（runStart）：把本域协议小节追加到 ctx.systemPrompt 尾部
 * （每 run 一次；run 内多 step 复用同一 system prompt，KV cache 稳定）。
 */
export function makeSourceContractRunStartHook(contract: SourceTagContract): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    if (!contract.contractSection) return;
    ctx.systemPrompt = ctx.systemPrompt
      ? `${ctx.systemPrompt}\n\n${contract.contractSection}`
      : contract.contractSection;
  };
}
