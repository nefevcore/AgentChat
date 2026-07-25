// ============================================================
// 类型定义 —— 单 Agent 多 Session 聊天应用
// ============================================================

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system';

/** 单条消息 */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** 深度思考内容（DeepSeek reasoning_content） */
  reasoning?: string;
  timestamp: number;
  /** 是否正在流式输出中 */
  isStreaming?: boolean;
}

/** 会话 */
export interface Session {
  id: string;
  name: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** DeepSeek API 配置 */
export interface ApiSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 思考模式 */
  thinking: boolean;
  /** 思考强度 */
  reasoningEffort: 'high' | 'max';
  temperature?: number;
  maxTokens?: number;
}

/** 默认 API 配置 */
export const DEFAULT_SETTINGS: ApiSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  thinking: true,
  reasoningEffort: 'high',
};

/** 生成唯一 ID */
export function uid(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
