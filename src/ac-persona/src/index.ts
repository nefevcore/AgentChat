// ============================================================
// ac-persona —— 人设注入插件（事件化扩展四件套之一）
//
// src 轨道映射：agent-persona 的 runStartHook（前置 persona 角色块）
// → preview 的 loop/before-run waterfall。
//
// 人设来源（settings[具名]，M14 形状升级 string → {enabled?, text?, file?}；
// M24 X1 词汇收口 hooks→settings + A1 经 settingsOf 合成全局默认层）：
//   · settings['persona'] = string              兼容旧形状（内联文本）
//   · settings['persona'] = { text?, file? }    file 优先（本地实体覆盖——
//     src AGENT.md 语义）、text 回退（内联）；enabled=false 软停用
//   file 解析：裸文件名（如 'AGENTS.md'）→ ctx.agentStore 的 Agent 文档
//   （可选能力：agentStore 未装则跳过该路径）；带分隔符路径 → 相对
//   cwd 的文件系统路径。persona 文档双名同义（2026-09-16 对齐生态事实
//   标准 AGENTS.md）：读时 AGENTS.md 优先、AGENT.md（存量名）回退，
//   写口归一写 AGENTS.md。读取后剥离 YAML frontmatter（src tryLoadFile
//   同规则）。均无 → 不注入。
//
// 解析词法（PersonaSettings/resolvePersonaText）住 ac-core-utils 纯库
// （2026-10-10 cr-321 下沉，normalizeToolSpecs 同构）：ac-singles 前缀
// 快照修订键须与本行逐字节同口径复算 persona 终态——词法单源防两处
// 漂移；本行值导入消费，agentStore 以最小结构形状传入（库零 cordis 依赖）。
//
// 经 request.agent 查 ctx.agents——人设是 Agent 数据，不进 LoopRunRequest
// 专属参数，也不进信封；本插件注入后 persona 直接成为 system prompt 的
// 一部分（<persona> 块前置，框架块/记忆块追加其后）。
// request.agent 缺省（直连 loop）不注入。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { resolvePersonaText } from 'ac-core-utils';
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）
import type {} from 'ac-agent-store'; // ctx.agentStore 可选能力类型（type-only）

// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— persona 分块拼接
// 确定性（输入不变则输出不变）。显式失效：人设文本/文件编辑 =
// invalidate-from-0（该 Agent 全部会话一次 system 重置）。

export const name = 'ac-persona';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'persona',
  label: '人设注入',
  description: 'AGENTS.md / persona 文本角色块前置注入 system prompt（file 优先 text 回退）',
  fields: [
    { name: 'text', type: 'text', description: '人设正文（与 file 二选一，file 优先）' },
    { name: 'file', type: 'file', description: '人设来源文件——裸名走 Agent 目录（如 AGENTS.md，AGENT.md 旧名兼容），路径走文件系统；frontmatter 自动剥离；可点「浏览…」选择' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [{ event: 'loop/before-run', role: '前置 <persona> 块', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
};

export const inject = ['agents'];

export function apply(ctx: Context) {
  ctx.on('loop/before-run', (call, next) => {
    const agentId = call.request.agent;
    // M24 A1：settingsOf 合成全局默认层 ∪ Agent 差异层
    const settings = agentId ? ctx.agents.settingsOf(agentId, 'persona') : {};
    const persona = resolvePersonaText(ctx.get('agentStore'), agentId, settings);
    if (persona) {
      const block = `<persona>\n${persona}\n</persona>`;
      call.request = {
        ...call.request,
        system: call.request.system ? `${block}\n\n${call.request.system}` : block,
      };
    }
    return next();
  }, { description: '<persona> 人设块前置注入' });
}
