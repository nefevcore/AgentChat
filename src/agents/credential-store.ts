// ============================================================
// src/agents/credential-store.ts —— API Key 加密存取（← infra 移入）
//
// 存储路径: ~/.agentchat/credentials.json（可用环境变量覆盖，供测试隔离）
// Key 格式: <agentId>_<provider>_API_KEY
// 全局凭据: __GLOBAL___<provider>_API_KEY
//
// 加密方案:
//   · AES-256-GCM + PBKDF2 密钥派生
//   · 密钥材料: os.hostname() + os.userInfo().username（绑定本机）
//   · 存储格式: "v1:<base64>" 前缀标记加密值，纯文本为兼容旧数据
//   · 首次写入时自动将旧明文升级为加密存储
//
// 依赖方向：仅依赖 src/core 的 logger（相对导入）；fs/path/os/crypto 为 Node 内置。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createLogger } from '@core/logger';

const log = createLogger('[agents:credstore]');

const GLOBAL_AGENT_ID = '__global__';

/** 凭据文件路径（测试可用 AGENTCHAT_CREDENTIALS_FILE 覆盖，隔离真实用户目录） */
function credFile(): string {
  return process.env.AGENTCHAT_CREDENTIALS_FILE
    ?? path.join(os.homedir(), '.agentchat', 'credentials.json');
}

// ── 加密参数 ──
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;   // 256 bits
const IV_LENGTH = 16;    // 128 bits (GCM 推荐)
const TAG_LENGTH = 16;   // 128 bits
const SALT = 'AgentChatCredentialStore:v1';
const PBKDF2_ITERATIONS = 600_000;
const ENCRYPTED_PREFIX = 'v1:';

type Store = Record<string, string>;

// ── 机器绑定的加密密钥 ──

let _cryptoKey: Buffer | null = null;

/** 派生出绑定本机的 AES 密钥（hostname + username → PBKDF2） */
function deriveKey(): Buffer {
  if (_cryptoKey) return _cryptoKey;

  const machineId = `${os.hostname()}:${os.userInfo().username}`;
  _cryptoKey = crypto.pbkdf2Sync(
    machineId,
    SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512',
  );
  return _cryptoKey;
}

/** 获取或派生密钥（延迟初始化，keytar fallback 等未来可插拔） */
function getKey(): Buffer {
  return deriveKey();
}

// ── 加解密 ──

function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // 格式: iv + tag + ciphertext → base64
  const combined = Buffer.concat([iv, tag, encrypted]);
  return ENCRYPTED_PREFIX + combined.toString('base64');
}

function decrypt(encoded: string): string | null {
  if (!encoded.startsWith(ENCRYPTED_PREFIX)) {
    // 兼容旧明文数据
    return encoded;
  }

  try {
    const key = getKey();
    const combined = Buffer.from(encoded.slice(ENCRYPTED_PREFIX.length), 'base64');

    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf-8');
  } catch {
    // 解密失败（密钥不匹配、数据损坏等）→ 返回 null
    log.warn('[CredStore] 解密凭据失败——可能是迁移到了另一台机器，请重新设置 API Key');
    return null;
  }
}

// ── 文件读写 ──

function read(): Store {
  const file = credFile();
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Store;
    // 解密所有值（加密的值以 v1: 开头，明文的值直接返回）
    const store: Store = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string') continue;
      const decrypted = decrypt(value);
      if (decrypted !== null) {
        store[key] = decrypted;
      }
      // 解密失败的值直接丢弃
    }
    return store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  const file = credFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // 自动迁移: 将明文值升级为加密
  const encrypted: Store = {};
  for (const [key, value] of Object.entries(store)) {
    if (!value) continue;
    encrypted[key] = value.startsWith(ENCRYPTED_PREFIX) ? value : encrypt(value);
  }

  fs.writeFileSync(file, JSON.stringify(encrypted, null, 2) + '\n', 'utf-8');
}

// ── 公开 API ──

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
  log.info(`[CredStore] ${credKey(agentId, provider)} ${value ? '已保存' : '已删除'}`);
}

/** 获取全局默认 API Key（当 Agent 无独立凭据时作为 fallback） */
export function getGlobalCredential(provider: string): string {
  return getCredential(GLOBAL_AGENT_ID, provider);
}

/** 保存全局默认 API Key */
export function setGlobalCredential(provider: string, value: string): void {
  setCredential(GLOBAL_AGENT_ID, provider, value);
}

/**
 * 枚举全部明文凭据值（供输出脱敏 / 审计用；空值剔除）。
 * 返回值仅用于脱敏清单，不暴露 key 名（避免侧信道）。
 */
export function listCredentialValues(): string[] {
  return Object.values(read()).filter((v): v is string => typeof v === 'string' && v.length > 0);
}
