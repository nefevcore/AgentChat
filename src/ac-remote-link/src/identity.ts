// ============================================================
// ac-remote-link/src/identity.ts —— 核心端静态身份密钥（remote/identity）
//
// 信任链的根（remote-client-relay-plan §4.2）：X25519 静态密钥对，
// 首次生成、永续使用（换身份 = 全量重配对所有设备）。
//
// 存储纪律（照 ac-credentials 的 B2 加固）：
//   · 文件权限 0600；目录 0700；
//   · 原子写（tmp + fsync + rename）——写盘中途崩溃不产生撕裂文件；
//   · JSON 形态 { version, publicKey, privateKey }（base64url）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateStaticIdentity, type StaticIdentity } from 'ac-noise-core';

export interface StoredIdentity extends StaticIdentity {
  /** 创建时间（epoch ms） */
  createdAt: number;
}

const IDENTITY_VERSION = 1;

/**
 * 加载身份密钥（无则生成并落盘）。目录/文件权限收紧到 0700/0600。
 */
export function loadOrCreateIdentity(remoteDir: string): StoredIdentity {
  fs.mkdirSync(remoteDir, { recursive: true });
  try { fs.chmodSync(remoteDir, 0o700); } catch { /* Windows 无效——尽力而为 */ }
  const file = path.join(remoteDir, 'identity');
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version: number; publicKey: string; privateKey: string; createdAt: number;
    };
    if (raw.version !== IDENTITY_VERSION) throw new Error(`identity: unsupported version ${raw.version}`);
    return {
      publicKey: Buffer.from(raw.publicKey, 'base64url'),
      privateKey: Buffer.from(raw.privateKey, 'base64url'),
      createdAt: raw.createdAt,
    };
  }
  const fresh = generateStaticIdentity();
  const stored: StoredIdentity = { ...fresh, createdAt: Date.now() };
  const payload = JSON.stringify({
    version: IDENTITY_VERSION,
    publicKey: stored.publicKey.toString('base64url'),
    privateKey: stored.privateKey.toString('base64url'),
    createdAt: stored.createdAt,
  });
  atomicWrite(file, payload);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 尽力而为 */ }
  return stored;
}

/** 原子写（ac-credentials B2 同款纪律） */
export function atomicWrite(file: string, content: string): void {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}