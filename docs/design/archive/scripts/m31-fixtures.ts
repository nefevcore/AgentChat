// M3.1 跨端一致性 fixture 生成（跑一次，值嵌入 Kotlin 测试；.dsh/tmp 同名残留可删）
import { createCipheriv, hkdfSync } from 'node:crypto';
import { sasFromHandshakeHash } from '../src/ac-noise-core/src/index.ts';

const enc = (k: Buffer, n: Buffer, ad: Buffer, pt: Buffer) => {
  const c = createCipheriv('chacha20-poly1305', k, n, { authTagLength: 16 });
  c.setAAD(ad, { plaintextLength: ad.length });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
};

const key = Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f', 'hex');
const nonce = Buffer.from('070000004041424344454647', 'hex');
const aad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex');
const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.", 'utf8');
console.log('AEAD_RFC8439=' + enc(key, nonce, aad, pt).toString('hex'));

const salt = Buffer.from([...Array(32).keys()]);
const ikm = Buffer.alloc(32, 0x0b);
console.log('HKDF32=' + Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.alloc(0), 64)).toString('hex'));

console.log('SAS_1=' + sasFromHandshakeHash(Buffer.alloc(32, 1)));
console.log('SAS_2=' + sasFromHandshakeHash(Buffer.alloc(32, 2)));
