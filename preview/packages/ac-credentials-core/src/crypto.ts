// ============================================================
// crypto.ts —— 凭据加密算法半边（R-11 ③：物理单副本两侧共用）
//
// 方案原样平移（现状踩坑沉淀）：AES-256-GCM + PBKDF2-SHA512 600k 迭代
// 派生密钥；密钥材料绑定本机（hostname:username）；存储格式
// "v1:<base64(iv|tag|ciphertext)>"；旧明文读取兼容、首次写盘自动升级。
// 差异：key 经参数注入（纯函数——两侧同算法同密钥可测；模块级缓存
// 归宿主/壳进程各自的调用方管理）。
// ============================================================

import * as crypto from 'node:crypto';
import * as os from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
export const SALT = 'AgentChatCredentialStore:v1';
export const PBKDF2_ITERATIONS = 600_000;
const ENCRYPTED_PREFIX = 'v1:';

/** 机器绑定密钥材料（hostname:username——换机解密失败归空） */
export function machineMaterial(): string {
  return `${os.hostname()}:${os.userInfo().username}`;
}

/** 密钥派生（~100ms——调用方自行缓存） */
export function deriveKey(material: string): Buffer {
  return crypto.pbkdf2Sync(material, SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

/** 加密 → "v1:<base64(iv|tag|ciphertext)>" */
export function encryptValue(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const combined = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  return ENCRYPTED_PREFIX + combined.toString('base64');
}

/** 解密；v1 前缀缺失 = 旧明文兼容；失败（换机/损坏）→ null */
export function decryptValue(key: Buffer, encoded: string): string | null {
  if (!encoded.startsWith(ENCRYPTED_PREFIX)) return encoded;
  try {
    const combined = Buffer.from(encoded.slice(ENCRYPTED_PREFIX.length), 'base64');
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

/** Agent 级凭据 key：<agentId>_<provider>_API_KEY（大写）；全局级 __global__ */
export function credentialKey(agentId: string, provider: string): string {
  return `${agentId}_${provider}_API_KEY`.toUpperCase();
}

export const GLOBAL_AGENT_ID = '__global__';
