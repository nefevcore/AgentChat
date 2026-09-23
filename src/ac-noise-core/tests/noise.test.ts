// ============================================================
// ac-noise-core 单元测试：
//   · RFC 7748 §6.1 x25519 测试向量（node:crypto 正确性的抽样锚定）
//   · XK/KK 往返一致（密钥派生对称、载荷可达、remoteStatic 校验）
//   · 篡改拒绝（AEAD tag）/ 重放与乱序拒绝（n 严格递增）
//   · SAS 形态与两端一致
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  NoiseHandshake,
  TransportCipher,
  dh,
  generateStaticIdentity,
  sasFromHandshakeHash,
  b64u,
  unb64u,
} from '../src/index.ts';

describe('x25519 基础（node:crypto 锚定）', () => {
  it('RFC 7748 §6.1 测试向量 1：DH 对称且等于向量共享密钥', () => {
    const aPriv = Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex');
    const bPriv = Buffer.from('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb', 'hex');
    const bPub = Buffer.from('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f', 'hex');
    const aPub = Buffer.from('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', 'hex');
    const shared = Buffer.from('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742', 'hex');
    expect(dh(aPriv, bPub).equals(shared)).toBe(true);
    expect(dh(bPriv, aPub).equals(shared)).toBe(true);
  });
});

describe('XK 握手（配对）', () => {
  it('三消息往返：载荷可达、split 密钥对称、remoteStatic 互验', () => {
    const phone = generateStaticIdentity();
    const pc = generateStaticIdentity();
    const init = new NoiseHandshake('XK', 'initiator', phone, pc.publicKey);
    const resp = new NoiseHandshake('XK', 'responder', pc);

    const m1 = init.writeMessage(Buffer.from('hello-from-phone'));
    const p1 = resp.readMessage(m1);
    expect(p1.toString()).toBe('hello-from-phone');

    const m2 = resp.writeMessage(Buffer.from('pc-ack'));
    const p2 = init.readMessage(m2);
    expect(p2.toString()).toBe('pc-ack');
    expect(init.remoteStaticMatches(pc.publicKey)).toBe(true);

    const m3 = init.writeMessage(Buffer.from('pixel-8'));
    const p3 = resp.readMessage(m3);
    expect(p3.toString()).toBe('pixel-8');
    expect(resp.remoteStatic !== null && resp.remoteStatic.equals(phone.publicKey)).toBe(true);

    expect(init.complete).toBe(true);
    expect(resp.complete).toBe(true);

    const ip = init.split();
    const rp = resp.split();
    const a = ip.send.write(Buffer.from('ping'));
    expect(rp.recv.read(a.n, a.ct).toString()).toBe('ping');
    const b = rp.send.write(Buffer.from('pong'));
    expect(ip.recv.read(b.n, b.ct).toString()).toBe('pong');
  });

  it('XK 发起方对伪冒响应方（错静态公钥）拒绝', () => {
    const phone = generateStaticIdentity();
    const pc = generateStaticIdentity();
    const attacker = generateStaticIdentity();
    // 发起方带外知道真 pc 公钥，但实际连到 attacker：es 步骤 DH 出的密钥
    // 与 attacker 侧不同 → initiator 解 m2 的 s 段/载荷时 AEAD 失败 = 拒绝。
    // （responder 的 s 段加密密钥由 DH(e_phone, rs=pc_pub) 派生——attacker
    // 没有对应私钥，无法产生能被 initiator 解开的 m2。）
    const init = new NoiseHandshake('XK', 'initiator', phone, pc.publicKey);
    const mitm = new NoiseHandshake('XK', 'responder', attacker);
    const m1 = init.writeMessage();
    mitm.readMessage(m1);
    const m2 = mitm.writeMessage();
    expect(() => init.readMessage(m2)).toThrow();
  });
});

describe('KK 握手（重连）', () => {
  it('两消息往返 + 双向身份已知', () => {
    const phone = generateStaticIdentity();
    const pc = generateStaticIdentity();
    const init = new NoiseHandshake('KK', 'initiator', phone, pc.publicKey);
    const resp = new NoiseHandshake('KK', 'responder', pc, phone.publicKey);

    const m1 = init.writeMessage(Buffer.from('reconnect'));
    const p1 = resp.readMessage(m1);
    expect(p1.toString()).toBe('reconnect');

    const m2 = resp.writeMessage();
    const p2 = init.readMessage(m2);
    expect(p2.length).toBe(0);

    const ip = init.split();
    const rp = resp.split();
    const f = ip.send.write(Buffer.from('data'));
    expect(rp.recv.read(f.n, f.ct).toString()).toBe('data');
  });

  it('KK 载荷随末条消息携带', () => {
    const phone = generateStaticIdentity();
    const pc = generateStaticIdentity();
    const init = new NoiseHandshake('KK', 'initiator', phone, pc.publicKey);
    const resp = new NoiseHandshake('KK', 'responder', pc, phone.publicKey);
    const m1 = init.writeMessage(Buffer.from('greeting'));
    resp.readMessage(m1);
    const m2 = resp.writeMessage(Buffer.from('welcome'));
    expect(init.readMessage(m2).toString()).toBe('welcome');
  });
});

describe('传输 phase 安全性质', () => {
  it('篡改拒绝（AEAD tag）', () => {
    const c = new TransportCipher(Buffer.alloc(32, 7));
    const f = c.write(Buffer.from('secret'));
    const tampered = Buffer.from(f.ct);
    tampered[0] ^= 1;
    expect(() => c.read(f.n, tampered)).toThrow();
  });

  it('重放与乱序拒绝（n 严格递增）', () => {
    const a = new TransportCipher(Buffer.alloc(32, 7));
    const b = new TransportCipher(Buffer.alloc(32, 7));
    const f1 = a.write(Buffer.from('one'));
    const f2 = a.write(Buffer.from('two'));
    expect(b.read(f1.n, f1.ct).toString()).toBe('one');
    expect(() => b.read(f1.n, f1.ct)).toThrow();
    expect(b.read(f2.n, f2.ct).toString()).toBe('two');
    expect(() => b.read(0, f1.ct)).toThrow();
  });
});

describe('SAS', () => {
  it('形态 8 位数字；同哈希一致', () => {
    const h = Buffer.alloc(32, 1);
    expect(sasFromHandshakeHash(h)).toMatch(/^\d{8}$/);
    expect(sasFromHandshakeHash(h)).toBe(sasFromHandshakeHash(Buffer.alloc(32, 1)));
    const s2 = sasFromHandshakeHash(Buffer.alloc(32, 2));
    expect(s2).toMatch(/^\d{8}$/);
  });
});

describe('wire 序列化辅助', () => {
  it('base64url 往返', () => {
    const buf = Buffer.from('noise-wire-test');
    expect(unb64u(b64u(buf)).equals(buf)).toBe(true);
  });
});