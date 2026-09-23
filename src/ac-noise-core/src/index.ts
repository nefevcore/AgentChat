// ============================================================
// ac-noise-core —— Noise 协议纯库（XK / KK 模式 + AEAD 帧封装）
//
// remote-client-relay-plan §4.2 的 M1 实现。零 cordis 依赖，全部原语
// 来自 node:crypto：x25519（RFC 7748）+ ChaCha20-Poly1305（RFC 8439）
// + HKDF-SHA256 / SHA-256（Noise spec §4 派生链）。
//
// 实现纪律（防自研密码学事故）：
//   · 严格照 Noise Protocol Framework spec rev34 消息模式表实现，不发明
//     任何自有步骤；每条消息 token 处理序 = WriteMessage/ReadMessage
//     固定序（e → s 加密 → ee → es/se → 载荷加密）；
//   · Split() 后传输 phase 只有 write/read + 单调 n，无额外密钥演化；
//   · DH 输出全零（低阶点）→ 立即终止（spec §7.1）。
//
// 角色约定（本产品拓扑固定）：
//   · initiator（发起方）= 手机端/远程设备；responder（响应方）= 核心端。
//   · XK（首次配对）：发起方已从二维码带外获知响应方静态公钥；
//   · KK（运行态重连）：双方已知对方静态公钥（双向认证）。
//
// 与上游方案的一处偏差：静态身份 = X25519（Noise DH 要求），非文档概称的
// Ed25519——二维码 pk / known_devices.pubkey 即 X25519 静态公钥（m1 方案
// §3 偏差记录）。
// ============================================================
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  createHash,
  type KeyObject,
} from 'node:crypto';

const HASH_LEN = 32;
const TAG_LEN = 16;
const NONCE_LEN = 12;
const DH_LEN = 32;

const PROTOCOL_XK = 'Noise_XK_25519_ChaChaPoly_SHA256';
const PROTOCOL_KK = 'Noise_KK_25519_ChaChaPoly_SHA256';

/** 传输 phase 单调计数上限（JS number 安全域——实际永远达不到） */
export const MAX_NONCE = Number.MAX_SAFE_INTEGER;

export type NoisePattern = 'XK' | 'KK';
export type NoiseRole = 'initiator' | 'responder';

export interface StaticIdentity {
  publicKey: Buffer; // 32B X25519
  privateKey: Buffer; // 32B raw
}

const EMPTY = Buffer.alloc(0);

// ---- 基础工具 ----

function concat(parts: Uint8Array[]): Buffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = Buffer.allocUnsafe(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** HKDF(salt=ck, ikm, info=empty, 2×32B) —— spec §4.3 */
function hkdf2(ck: Buffer, ikm: Uint8Array): [Buffer, Buffer] {
  const temp = Buffer.from(hkdfSync('sha256', ikm, ck, new Uint8Array(0), HASH_LEN * 2));
  return [temp.subarray(0, HASH_LEN), temp.subarray(HASH_LEN, HASH_LEN * 2)];
}

/** AEAD nonce：4 零字节 + n 小端 64-bit（spec §12.3 ChaChaPoly） */
function nonceOf(n: number): Buffer {
  const nonce = Buffer.alloc(NONCE_LEN);
  nonce.writeUInt32LE(n >>> 0, 4);
  nonce.writeUInt32LE(Math.floor(n / 2 ** 32), 8);
  return nonce;
}

function toBuf(u: Uint8Array): Buffer {
  return Buffer.from(u.buffer, u.byteOffset, u.byteLength);
}

function aeadEncrypt(k: Buffer, n: number, ad: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', k, nonceOf(n), { authTagLength: TAG_LEN });
  cipher.setAAD(toBuf(ad), { plaintextLength: ad.length });
  return concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aeadDecrypt(k: Buffer, n: number, ad: Uint8Array, ciphertext: Uint8Array): Buffer {
  if (ciphertext.length < TAG_LEN) throw new Error('noise: ciphertext too short');
  const ct = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
  const decipher = createDecipheriv('chacha20-poly1305', k, nonceOf(n), { authTagLength: TAG_LEN });
  decipher.setAAD(toBuf(ad), { plaintextLength: ad.length });
  decipher.setAuthTag(toBuf(tag));
  return concat([decipher.update(ct), decipher.final()]);
}

// ---- x25519 ----

function jwkPublic(pub: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub.toString('base64') }, format: 'jwk' });
}

/**
 * RFC 7748 §6.1 使用前 clamp：低 3 位清零、bit 254 置一、bit 255 清零。
 * node:crypto 生成的私钥已 clamp；外部输入的 raw 私钥（X25519 语义上
 * 任意 32B）照规范 clamp（幂等——已 clamp 的值不变）。
 */
function clampScalar(priv: Buffer): Buffer {
  const b = Buffer.from(priv);
  b[0] &= 248;
  b[31] &= 127;
  b[31] |= 64;
  return b;
}

/** PKCS8 DER 头（X25519 32B 私钥的固定包装）——JWK d-only 形态 node 拒收 */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function derPrivate(priv: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, clampScalar(priv)]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** 生成 x25519 静态身份密钥对（首次运行一次；亦作握手临时密钥生成器） */
export function generateStaticIdentity(): StaticIdentity {
  const pair = generateKeyPairSync('x25519');
  const pubJwk = pair.publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = pair.privateKey.export({ format: 'jwk' }) as { d: string };
  return {
    publicKey: Buffer.from(pubJwk.x, 'base64'),
    privateKey: Buffer.from(privJwk.d, 'base64'),
  };
}

/** DH(priv, pub) —— RFC 7748；全零输出（低阶点）抛错（spec §7.1） */
export function dh(priv: Buffer, pub: Buffer): Buffer {
  const out = diffieHellman({ privateKey: derPrivate(priv), publicKey: jwkPublic(pub) });
  if (out.length === DH_LEN && out.every((b) => b === 0)) {
    throw new Error('noise: DH all-zero output (low-order point)');
  }
  return out;
}

// ---- CipherState（spec §5.1）----

class CipherState {
  k: Buffer | null = null;
  private nonce = 0;

  initializeKey(key: Buffer): void {
    this.k = key;
    this.nonce = 0;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (this.k === null) return Buffer.from(plaintext);
    if (this.nonce > MAX_NONCE) throw new Error('noise: nonce exhausted');
    return aeadEncrypt(this.k, this.nonce++, ad, plaintext);
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (this.k === null) return Buffer.from(ciphertext);
    if (this.nonce > MAX_NONCE) throw new Error('noise: nonce exhausted');
    return aeadDecrypt(this.k, this.nonce++, ad, ciphertext);
  }
}

// ---- SymmetricState（spec §5.2）----

class SymmetricState {
  private h: Buffer;
  private ck: Buffer;
  readonly cipher = new CipherState();

  constructor(protocolName: string) {
    const name = Buffer.from(protocolName, 'utf8');
    this.h =
      name.length <= HASH_LEN
        ? concat([name, Buffer.alloc(HASH_LEN - name.length)])
        : createHash('sha256').update(name).digest();
    this.ck = Buffer.from(this.h);
  }

  mixHash(data: Uint8Array): void {
    this.h = createHash('sha256').update(this.h).update(data).digest();
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, temp] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cipher.initializeKey(temp);
  }

  encryptAndHash(plaintext: Uint8Array): Buffer {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  get handshakeHash(): Buffer {
    return Buffer.from(this.h);
  }

  /** Split()（spec §4.2）：ikm = HASH_LEN 零字节，输出两把传输密钥 */
  split(): [Buffer, Buffer] {
    return hkdf2(this.ck, Buffer.alloc(HASH_LEN));
  }
}

// ---- 消息模式（spec §7 子集）----

type Token = 'e' | 's' | 'ee' | 'es' | 'se';

const PATTERN_XK: Token[][] = [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']];
const PATTERN_KK: Token[][] = [['e', 'es'], ['e', 'ee']];

/** 单条握手消息（wire 形态：消息体 = token 串 + 加密载荷） */
export interface HandshakeMessage {
  body: Buffer; // token 段 + 密文载荷
}

/** 传输 phase 密码对（send/recv 已按角色定向） */
export interface TransportPair {
  send: TransportCipher;
  recv: TransportCipher;
  /** 握手哈希（SAS 派生 / 会话绑定） */
  handshakeHash: Buffer;
}

/**
 * Noise 握手状态机（XK/KK，单一类覆盖两角色）。
 *
 * 用法（XK 配对，手机=initiator）：
 *   const hs = new NoiseHandshake('XK', 'initiator', phoneIdentity, pcPubFromQr);
 *   const m1 = hs.writeMessage(payload1);            // → e
 *   const p2 = hs.readMessage(m2FromPc);             // ← e,ee,s,es（校验 rs）
 *   const m3 = hs.writeMessage(payload3);            // → s,se
 *   const pair = hs.split();
 *
 * 用法（KK 重连）：writeMessage → readMessage → split（两条消息）。
 */
export class NoiseHandshake {
  private readonly ss: SymmetricState;
  private readonly patterns: Token[][];
  private readonly myStatic: StaticIdentity;
  private readonly remoteStaticKnown: Buffer | null;
  private e: StaticIdentity | null = null;
  private re: Buffer | null = null;
  private rsSeen: Buffer | null = null;
  private step = 0;

  private readonly role: NoiseRole;

  constructor(pattern: NoisePattern, role: NoiseRole, identity: StaticIdentity, remoteStaticPub?: Buffer) {
    this.role = role;
    this.ss = new SymmetricState(pattern === 'XK' ? PROTOCOL_XK : PROTOCOL_KK);
    this.patterns = pattern === 'XK' ? PATTERN_XK : PATTERN_KK;
    this.myStatic = identity;
    this.remoteStaticKnown = remoteStaticPub ?? null;
  }

  get complete(): boolean {
    return this.step >= this.patterns.length;
  }

  get handshakeHash(): Buffer {
    return this.ss.handshakeHash;
  }

  /** 读到的对端静态公钥（XK 在处理完第 2 条消息后非空；KK 在第 1 条后非空） */
  get remoteStatic(): Buffer | null {
    return this.rsSeen;
  }

  /**
   * 对端静态公钥是否与已知值一致（XK 发起方校验二维码 pk；KK 双方校验
   * 注册表）。null = 尚未读到。
   */
  remoteStaticMatches(expected: Buffer): boolean {
    if (this.rsSeen === null) return false;
    return this.rsSeen.equals(expected);
  }

  /** 写下一条握手消息（token 段 + 加密载荷；载荷可为空） */
  writeMessage(payload: Uint8Array = EMPTY): Buffer {
    if (this.complete) throw new Error('noise: handshake already complete');
    const tokens = this.patterns[this.step];
    if (this.step % 2 !== (this.role === 'initiator' ? 0 : 1)) {
      throw new Error('noise: not our turn to write');
    }
    const parts: Buffer[] = [];
    for (const token of tokens) {
      switch (token) {
        case 'e': {
          this.e = generateStaticIdentity();
          parts.push(this.e.publicKey);
          this.ss.mixHash(this.e.publicKey);
          break;
        }
        case 's': {
          parts.push(this.ss.encryptAndHash(this.myStatic.publicKey));
          break;
        }
        case 'ee': {
          this.ss.mixKey(dh(this.requireLocalEphemeral(), this.requireRemoteEphemeral()));
          break;
        }
        case 'es': {
          if (this.role === 'initiator') {
            this.ss.mixKey(dh(this.requireLocalEphemeral(), this.requireKnownRemoteStatic()));
          } else {
            this.ss.mixKey(dh(this.requireLocalStaticPriv(), this.requireRemoteEphemeral()));
          }
          break;
        }
        case 'se': {
          if (this.role === 'initiator') {
            this.ss.mixKey(dh(this.requireLocalStaticPriv(), this.requireRemoteEphemeral()));
          } else {
            this.ss.mixKey(dh(this.requireLocalEphemeral(), this.requireKnownRemoteStatic()));
          }
          break;
        }
      }
    }
    parts.push(this.ss.encryptAndHash(payload));
    this.step += 1;
    return concat(parts);
  }

  /** 读对端握手消息（返回载荷明文；格式错/解密失败抛错） */
  readMessage(message: Uint8Array): Buffer {
    if (this.complete) throw new Error('noise: handshake already complete');
    const tokens = this.patterns[this.step];
    if (this.step % 2 !== (this.role === 'initiator' ? 1 : 0)) {
      throw new Error('noise: not our turn to read');
    }
    const buf = Buffer.from(message);
    let off = 0;
    for (const token of tokens) {
      switch (token) {
        case 'e': {
          if (buf.length - off < DH_LEN) throw new Error('noise: truncated e');
          this.re = buf.subarray(off, off + DH_LEN);
          off += DH_LEN;
          this.ss.mixHash(this.re);
          break;
        }
        case 's': {
          const sLen = this.ss.cipher.hasKey() ? DH_LEN + TAG_LEN : DH_LEN;
          if (buf.length - off < sLen) throw new Error('noise: truncated s');
          const sCt = buf.subarray(off, off + sLen);
          off += sLen;
          this.rsSeen = this.ss.decryptAndHash(sCt);
          break;
        }
        case 'ee': {
          this.ss.mixKey(dh(this.requireLocalEphemeral(), this.requireRemoteEphemeral()));
          break;
        }
        case 'es': {
          if (this.role === 'initiator') {
            this.ss.mixKey(dh(this.requireLocalEphemeral(), this.requireKnownRemoteStatic()));
          } else {
            this.ss.mixKey(dh(this.requireLocalStaticPriv(), this.requireRemoteEphemeral()));
          }
          break;
        }
        case 'se': {
          if (this.role === 'initiator') {
            this.ss.mixKey(dh(this.requireLocalStaticPriv(), this.requireRemoteEphemeral()));
          } else {
            // responder 读 XK m3：rs 在本消息 s 段刚解出（rsSeen），se = DH(e, rs)
            this.ss.mixKey(dh(this.requireLocalEphemeral(), this.requireSeenRemoteStatic()));
          }
          break;
        }
      }
    }
    const payload = this.ss.decryptAndHash(buf.subarray(off));
    this.step += 1;
    return payload;
  }

  /** Split()：传输密钥对（initiator 发 k1 收 k2；responder 反之——spec §5.2） */
  split(): TransportPair {
    if (!this.complete) throw new Error('noise: handshake not complete');
    const [k1, k2] = this.ss.split();
    const send = new TransportCipher(this.role === 'initiator' ? k1 : k2);
    const recv = new TransportCipher(this.role === 'initiator' ? k2 : k1);
    return { send, recv, handshakeHash: this.handshakeHash };
  }

  private requireLocalEphemeral(): Buffer {
    if (!this.e) throw new Error('noise: internal: local ephemeral missing');
    return this.e.privateKey;
  }

  private requireLocalStaticPriv(): Buffer {
    return this.myStatic.privateKey;
  }

  private requireRemoteEphemeral(): Buffer {
    if (!this.re) throw new Error('noise: internal: remote ephemeral missing');
    return this.re;
  }

  private requireKnownRemoteStatic(): Buffer {
    if (!this.remoteStaticKnown) {
      throw new Error('noise: internal: known remote static required for this token');
    }
    return this.remoteStaticKnown;
  }

  /** 读消息内 s 段刚解出的对端静态公钥（XK responder 处理 m3 的 se 时用） */
  private requireSeenRemoteStatic(): Buffer {
    if (!this.rsSeen) {
      throw new Error('noise: internal: seen remote static required for this token');
    }
    return this.rsSeen;
  }
}

/**
 * 传输 phase 帧密码（spec §5.1 transport phase 的本产品封装）。
 * wire 帧 = { n, ct }：n = 发送方单调计数；解密侧强制 n 严格递增
 * （上游方案 §4.2「帧内顺序计数防重放」——本产品无并发帧，严格递增即充分）。
 */
export class TransportCipher {
  readonly key: Buffer;
  private nonce = 0;
  private lastRecv = -1;

  constructor(key: Buffer) {
    this.key = key;
  }

  /** 加密一帧 → { n, ct } */
  write(payload: Uint8Array): { n: number; ct: Buffer } {
    if (this.nonce > MAX_NONCE) throw new Error('noise: nonce exhausted');
    const n = this.nonce++;
    return { n, ct: aeadEncrypt(this.key, n, EMPTY, payload) };
  }

  /** 解密一帧（重放/乱序拒绝） */
  read(n: number, ct: Uint8Array): Buffer {
    if (n <= this.lastRecv) throw new Error('noise: replay/out-of-order frame');
    const pt = aeadDecrypt(this.key, n, EMPTY, ct);
    this.lastRecv = n;
    return pt;
  }
}

/**
 * SAS 短认证串（上游方案 §4.2 第 5 步）：SHA256(handshake_hash) 前 4 字节
 * → 8 位数字，两端各自显示人工比对。
 */
export function sasFromHandshakeHash(handshakeHash: Buffer): string {
  const digest = createHash('sha256').update(handshakeHash).digest();
  const v = digest.readUInt32BE(0) % 100_000_000;
  return v.toString().padStart(8, '0');
}

/** 二进制 ↔ base64url（wire 序列化辅助，无 padding） */
export function b64u(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function unb64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}