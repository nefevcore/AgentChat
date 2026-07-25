// ============================================================
// localStorage 会话管理
// ============================================================

import type { Session, ChatMessage, ApiSettings, MessageRole } from '../types';
import { uid, DEFAULT_SETTINGS } from '../types';

const SESSIONS_KEY = 'deepseek-chat-sessions';
const SETTINGS_KEY = 'deepseek-chat-settings';
const ACTIVE_SESSION_KEY = 'deepseek-chat-active-session';

// ── 会话 CRUD ──

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions: Session[]): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function createSession(name?: string): Session {
  const sessions = loadSessions();
  const session: Session = {
    id: uid(),
    name: name || `会话 ${sessions.length + 1}`,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions.unshift(session);
  saveSessions(sessions);
  setActiveSessionId(session.id);
  return session;
}

export function deleteSession(id: string): void {
  let sessions = loadSessions();
  sessions = sessions.filter(s => s.id !== id);
  saveSessions(sessions);
  if (getActiveSessionId() === id) {
    const next = sessions[0]?.id || '';
    setActiveSessionId(next);
  }
}

export function updateSessionName(id: string, name: string): void {
  const sessions = loadSessions();
  const s = sessions.find(s => s.id === id);
  if (s) {
    s.name = name;
    s.updatedAt = Date.now();
    saveSessions(sessions);
  }
}

export function addMessage(sessionId: string, msg: ChatMessage): void {
  const sessions = loadSessions();
  const s = sessions.find(s => s.id === sessionId);
  if (s) {
    s.messages.push(msg);
    s.updatedAt = Date.now();
    saveSessions(sessions);
  }
}

export function updateMessage(sessionId: string, msgId: string, updates: Partial<ChatMessage>): void {
  const sessions = loadSessions();
  const s = sessions.find(s => s.id === sessionId);
  if (s) {
    const m = s.messages.find(m => m.id === msgId);
    if (m) {
      Object.assign(m, updates);
      s.updatedAt = Date.now();
      saveSessions(sessions);
    }
  }
}

/** 清空会话消息 */
export function clearSessionMessages(sessionId: string): void {
  const sessions = loadSessions();
  const s = sessions.find(s => s.id === sessionId);
  if (s) {
    s.messages = [];
    s.updatedAt = Date.now();
    saveSessions(sessions);
  }
}

// ── 活跃会话 ID ──

export function getActiveSessionId(): string {
  return localStorage.getItem(ACTIVE_SESSION_KEY) || '';
}

export function setActiveSessionId(id: string): void {
  localStorage.setItem(ACTIVE_SESSION_KEY, id);
}

// ── API 设置 ──

export function loadSettings(): ApiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: ApiSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
