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
//   file 解析：裸文件名（如 'AGENT.md'）→ ctx.agentStore 的 Agent 文档
//   （可选能力：agentStore 未装则跳过该路径）；带分隔符路径 → 相对
//   cwd 的文件系统路径。读取后剥离 YAML frontmatter（src tryLoadFile
//   同规则）。均无 → 不注入。
//
// 经 request.agent 查 ctx.agents——人设是 Agent 数据，不进 LoopRunRequest
// 专属参数，也不进信封；本插件注入后 persona 直接成为 system prompt 的
// 一部分（<persona> 块前置，框架块/记忆块追加其后）。
// request.agent 缺省（直连 loop）不注入。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）
import type {} from 'ac-agent-store'; // ctx.agentStore 可选能力类型（type-only）

/** settings['persona'] 对象形状（per-Agent；形状由本插件自定义） */
export interface PersonaSettings {
  /** 缺省 true；false = 本 Agent 软停用（ADR-4） */
  enabled?: boolean;
  /** 内联人设文本 */
  text?: string;
  /** 人设文件：裸名 → agentStore 文档（AGENT.md）；带路径 → 文件系统 */
  file?: string;
}

/** 剥离 YAML frontmatter + trim（src tryLoadFile 同规则） */
function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '').trim();
}

/** 读取文件系统路径（缺失/不可读 → null） */
function readFsFile(file: string): string | null {
  try {
    const content = fs.readFileSync(path.resolve(file), 'utf-8');
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/**
 * 解析人设文本：file 优先（目录实体本地覆盖）→ text 回退（内联）。
 * 返回 undefined = 无人设（不注入）。
 */
export function resolvePersonaText(
  ctx: Context,
  agentId: string | undefined,
  cfg: unknown,
): string | undefined {
  if (typeof cfg === 'string') return cfg.trim() || undefined;
  if (cfg === null || cfg === undefined || typeof cfg !== 'object') return undefined;
  const settings = cfg as PersonaSettings;
  if (settings.enabled === false) return undefined;

  if (typeof settings.file === 'string' && settings.file.trim()) {
    const file = settings.file.trim();
    // 裸文档名（无路径分隔/无遍历）→ agentStore 的 Agent 文档（可选能力）
    const bare = !file.includes('/') && !file.includes('\\') && !file.includes('..');
    let content: string | null = null;
    if (bare && agentId) {
      const store = ctx.get('agentStore');
      const doc = store ? store.readDoc(agentId, file) : undefined;
      content = doc && doc.trim() ? doc : null;
    }
    if (content === null) content = readFsFile(file);
    if (content !== null && stripFrontmatter(content)) return stripFrontmatter(content);
  }
  if (typeof settings.text === 'string' && settings.text.trim()) return settings.text.trim();
  return undefined;
}

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
  description: 'AGENT.md / persona 文本角色块前置注入 system prompt（file 优先 text 回退）',
  fields: [
    { name: 'text', description: '人设正文（与 file 二选一，file 优先）' },
    { name: 'file', description: '人设来源文件——裸名走 Agent 目录（如 AGENT.md），路径走文件系统；frontmatter 自动剥离' },
    { name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [{ event: 'loop/before-run', role: '前置 <persona> 块', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
};

export const inject = ['agents'];

export function apply(ctx: Context) {
  ctx.on('loop/before-run', (call, next) => {
    const agentId = call.request.agent;
    // M24 A1：settingsOf 合成全局默认层 ∪ Agent 差异层
    const settings = agentId ? ctx.agents.settingsOf(agentId, 'persona') : {};
    const persona = resolvePersonaText(ctx, agentId, settings);
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
