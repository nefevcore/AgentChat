// ============================================================
// ac-credentials/src/service.ts —— 凭据服务（cordis Service）
//
// 原样继承 src agents/credential-store.ts 的加密方案（踩坑沉淀）：
//   · AES-256-GCM + PBKDF2-SHA512 600k 迭代派生密钥
//   · 密钥材料绑定本机（hostname:username）——换机解密失败 → 丢弃并回 ''
//   · 存储格式 "v1:<base64(iv|tag|ciphertext)>"；旧明文读取兼容、
//     首次写盘自动升级加密
//   · Key 格式 <agentId>_<provider>_API_KEY（大写）；全局级 __global__ 前缀
//   · listValues() 枚举全部明文值（只供输出脱敏清单，不暴露 key 名——防侧信道）
//
// owns 凭据文件的读写（ADR-5）：其他域禁止直写；消费方（M11 web_search
// 三源 key 解析链、脱敏行）一律走本服务方法。
//
// B2 加固（2026-08-31 审计）：
//   · 全量重写走 tmp+fsync+rename 原子写——写盘中途崩溃/断电不再产生
//     撕裂文件（撕裂 → 下次 boot 解析失败归空 → 用户随手一设 → 空态
//     落盘 → 旧凭据不可恢复）；
//   · 解密失败条目（换机/密钥变更）不再被静默丢弃——密文原样保留落盘，
//     换回原机或修复密钥后自动恢复；
//   · 存储文件解析失败（既有撕裂/手编坏）先转存 <file>.corrupt 再从
//     空档开始——绝不静默覆盖可能是唯一凭据副本的坏文件。
// ============================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Service, type Context } from '@agentchat/cordis';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits（GCM 推荐）
const TAG_LENGTH = 16; // 128 bits
const SALT = 'AgentChatCredentialStore:v1';
const PBKDF2_ITERATIONS = 600_000;
const ENCRYPTED_PREFIX = 'v1:';
const GLOBAL_AGENT_ID = '__global__';

type Store = Record<string, string>;

/** 模块级密钥缓存（PBKDF2 600k 迭代 ~100ms+，同进程只派生一次） */
let derivedKey: Buffer | null = null;

function machineKey(): Buffer {
  if (derivedKey) return derivedKey;
  const material = `${os.hostname()}:${os.userInfo().username}`;
  derivedKey = crypto.pbkdf2Sync(material, SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  return derivedKey;
}

/** 加密 → "v1:<base64(iv|tag|ciphertext)>" */
export function encryptValue(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, machineKey(), iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const combined = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  return ENCRYPTED_PREFIX + combined.toString('base64');
}

/** 解密；v1 前缀缺失 = 旧明文兼容；解密失败（换机/损坏）→ null */
export function decryptValue(encoded: string): string | null {
  if (!encoded.startsWith(ENCRYPTED_PREFIX)) return encoded; // 旧明文
  try {
    const combined = Buffer.from(encoded.slice(ENCRYPTED_PREFIX.length), 'base64');
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, machineKey(), iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  } catch {
    return null; // 换机/损坏：调用方以"未设置"处理
  }
}

/** 行配置 */
export interface CredentialsRowOptions {
  /** 凭据文件（缺省 <root>/credentials.json；root 缺省 './data'，相对 cwd） */
  file?: string;
  root?: string;
}

export class CredentialsService extends Service {
  private file: string;

  constructor(ctx: Context, options: CredentialsRowOptions = {}) {
    super(ctx, 'credentials');
    this.file =
      options.file ?? path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'credentials.json');
  }

  /** 凭据文件路径（诊断用） */
  get path(): string {
    return this.file;
  }

  /** Agent 级凭据 key：<agentId>_<provider>_API_KEY */
  static key(agentId: string, provider: string): string {
    return `${agentId}_${provider}_API_KEY`.toUpperCase();
  }

  /** 取 Agent 凭据（无 → 空串） */
  get(agentId: string, provider: string): string {
    return this.readStore()[CredentialsService.key(agentId, provider)] ?? '';
  }

  /** 存 Agent 凭据（value 空串 = 删除） */
  set(agentId: string, provider: string, value: string): void {
    this.writeKey(CredentialsService.key(agentId, provider), value);
  }

  /** 全局默认凭据（Agent 无独立凭据时的 fallback） */
  getGlobal(provider: string): string {
    return this.get(GLOBAL_AGENT_ID, provider);
  }

  /** 存全局默认凭据 */
  setGlobal(provider: string, value: string): void {
    this.set(GLOBAL_AGENT_ID, provider, value);
  }

  /**
   * Agent 级 → 全局级解析链（boot 凭据回注语义：Agent 覆盖全局）。
   * @returns 空串 = 两级均未设置
   */
  resolve(agentId: string, provider: string): string {
    return this.get(agentId, provider) || this.getGlobal(provider);
  }

  /**
   * 枚举全部明文凭据值（供输出脱敏/审计；空值剔除）。
   * 只返回值不返回 key 名——避免"按 key 名猜用途"的侧信道。
   */
  listValues(): string[] {
    return Object.values(this.readStore()).filter((v) => typeof v === 'string' && v.length > 0);
  }

  /** 全部 key 名（管理面列举用；不含值） */
  keys(): string[] {
    return Object.keys(this.readStore());
  }

  // ---- 文件层 ----

  /** 解密视图（get/keys/listValues 用）：解密失败条目按未设置处理（原密文仍在盘上） */
  private readStore(): Store {
    const out: Store = {};
    for (const [key, value] of Object.entries(this.readRawStore())) {
      if (typeof value !== 'string') continue;
      const decrypted = decryptValue(value);
      if (decrypted !== null && decrypted !== '') out[key] = decrypted;
    }
    return out;
  }

  /**
   * 原始密文态读取（writeKey 合并用）。解析失败 → 坏文件转存
   * `<file>.corrupt`（唯一副本不覆盖）后从空档开始；写日志可追。
   */
  private readRawStore(): Store {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch {
      return {}; // 不存在 = 空档
    }
    try {
      const parsed = JSON.parse(raw) as Store;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('非对象');
      return parsed;
    } catch (err) {
      const backup = `${this.file}.corrupt`;
      try {
        fs.renameSync(this.file, backup);
        this.ctx.logger.warn(
          `[credentials] 凭据文件损坏（${err instanceof Error ? err.message : String(err)}）——已转存 ${backup}，从空档重新开始`,
        );
      } catch (moveErr) {
        this.ctx.logger.error(
          `[credentials] 凭据文件损坏且转存失败（${moveErr instanceof Error ? moveErr.message : String(moveErr)}）——本次按空档处理，原文件未动`,
        );
      }
      return {};
    }
  }

  private writeKey(key: string, value: string): void {
    // 密文态合并：既有 v1 条目原样保留（含解密失败条目——换机场景不销毁），
    // 本次变更加密后覆盖/删除，全量原子落盘（tmp+fsync+rename）
    const raw = this.readRawStore();
    if (value) raw[key] = encryptValue(value);
    else delete raw[key];
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v && !v.startsWith(ENCRYPTED_PREFIX)) raw[k] = encryptValue(v); // 旧明文升级
    }
    const body = `${JSON.stringify(raw, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, body, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 凭据服务（ac-credentials 提供）：AES-GCM 加密存取 + Agent→全局解析链 */
    credentials: CredentialsService;
  }
}
