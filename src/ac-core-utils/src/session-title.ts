// ============================================================
// session-title.ts —— 会话标题词法（上限 / 提示词 / 输出清洗 / 截断回落）
//
// 跨行共享（cr-672）：标题是会话列表的可读性面，生成侧有两条落地——
// 主线 ac-singles 单进程直写 session.json；preview 壳侧 auto-title 行
// 生成后经信封请求宿主 singles 行落盘。长度上限、引号清洗、CRLF 首行、
// 材料行筛选（路径/引用行不是发言）与代理对安全截断都是迭代出来的经验值，
// 各写一份必然走散（走散实例：preview 派生面 40 字上限 vs 生成面 24 字；
// 派生面直接截首行 → 192 个存量会话标题全是同一条 C:\\Users\\… 路径）。
// ============================================================
import { safeTruncate } from 'ac-text-budget';

/** 会话标题长度上限（字符）——生成输出与截断回落同口径 */
export const TITLE_MAX_LEN = 24;

/** 标题材料单段进提示词的字符上限 */
const TITLE_MATERIAL_MAX_LEN = 600;

/** 日期快照行签名（ac-datetime 行前缀——不是用户发言，命名与派生都要跳过） */
export const DATE_SNAPSHOT_PREFIX = '[当前时间] ';

/** 首个非空行（按 CRLF/LF 切且逐行 trim——`split('\\n')[0]` 会把 `\\r` 留在标题里） */
function firstLineOf(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/**
 * 标题生成提示词（可结合 Agent 首步思考/正文——概括「这段对话在谈什么」，
 * 工具轮里用户消息常常只是「继续」）。材料按 TITLE_MATERIAL_MAX_LEN 截断
 * 且不切代理对（cr-415：lone surrogate 会毒化 LLM 请求体）。
 */
export function titlePrompt(userText: string, agentFirstOutput?: string): string {
  return '根据下面的对话材料，为这段对话生成一个简短的中文标题（不超过' + TITLE_MAX_LEN + '字）。\n'
    + '要求：直接输出标题本身；不要引号、句号、解释或前后缀；概括意图而非复述原文。\n\n'
    + '用户消息：\n' + safeTruncate(userText, TITLE_MATERIAL_MAX_LEN)
    + (agentFirstOutput !== undefined && agentFirstOutput.trim() !== ''
      ? '\n\nAgent 的初步思考/回应（理解参考）：\n' + safeTruncate(agentFirstOutput, TITLE_MATERIAL_MAX_LEN)
      : '');
}

/** 清洗模型输出：取首个非空行、去包裹引号、超长按上限截断（不补省略号——
 *  截断值仍是模型原文前缀，补省略号会破上限口径） */
export function cleanTitle(raw: string): string {
  const text = firstLineOf(raw).replace(/^["'「『《]+|["'」』》]+$/g, '').trim();
  return text.length > TITLE_MAX_LEN ? safeTruncate(text, TITLE_MAX_LEN) : text;
}

/** 「不像发言」的行首（附件路径 / @ 引用 / URL）：用户常把文件路径粘在消息
 *  开头（实测 192 个存量会话的派生标题因此全是同一条 C:\\Users\\… 路径） */
const NON_SPEECH_PREFIX = /^([A-Za-z]:[\\/]|\\\\|\/|@|https?:\/\/)/;

/**
 * 标题材料行（派生面与回落面共用）：首个「像发言」的非空行——跳过空行、
 * 日期快照行与路径/引用行；全是路径/引用行时回落首个非空行（消息本身只有
 * 路径 = 标题就给路径，比空标题强）。
 */
export function titleMaterialOf(text: string): string {
  let fallback = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(DATE_SNAPSHOT_PREFIX)) continue;
    if (fallback === '') fallback = trimmed;
    if (NON_SPEECH_PREFIX.test(trimmed)) continue;
    return trimmed;
  }
  return fallback;
}

/** 截断回落标题（LLM 缺席/失败/空回复，或派生面首行兜底）——材料行超长补省略号 */
export function fallbackTitle(userText: string): string {
  const material = titleMaterialOf(userText);
  return material.length > TITLE_MAX_LEN ? safeTruncate(material, TITLE_MAX_LEN) + '…' : material;
}
