// ============================================================
// Credential Store —— 用户主目录，与工作区完全隔离
//
// 存储路径: ~/.agentchat/credentials.json
// Key 格式: <agentId>_<provider>_API_KEY
// 不通过环境变量，LLM 工厂直接从此文件读取。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CRED_DIR = path.join(os.homedir(), '.agentchat');
const CRED_FILE = path.join(CRED_DIR, 'credentials.json');

type Store = Record<string, string>;

function read(): Store {
  if (!fs.existsSync(CRED_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8')) as Store; }
  catch { return {}; }
}

function write(store: Store): void {
  if (!fs.existsSync(CRED_DIR)) fs.mkdirSync(CRED_DIR, { recursive: true });
  for (const k of Object.keys(store)) { if (!store[k]) delete store[k]; }
  fs.writeFileSync(CRED_FILE, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/** 构建凭据 key：<agentId>_<provider>_API_KEY */
export function credKey(agentId: string, provider: string): string {
  return `${agentId}_${provider}_API_KEY`.toUpperCase();
}

/** 获取指定 Agent 的 API Key */
export function getCredential(agentId: string, provider: string): string {
  return read()[credKey(agentId, provider)] || '';
}

/** 保存指定 Agent 的 API Key */
export function setCredential(agentId: string, provider: string, value: string): void {
  const store = read();
  store[credKey(agentId, provider)] = value;
  if (!value) delete store[credKey(agentId, provider)];
  write(store);
  console.log(`[CredStore] ${credKey(agentId, provider)} ${value ? '已保存' : '已删除'}`);
}
