// ============================================================
// ac-credentials-core 单测（M2.4 验收）：加解密往返 / 机器绑定语义 /
// 目录直读 / 路径防护
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  encryptValue, decryptValue, deriveKey, machineMaterial,
  credentialKey, GLOBAL_AGENT_ID, PBKDF2_ITERATIONS,
} from '../src/crypto.ts';
import {
  listCredentialNames, readCredential, writeCredential, credentialsDir,
} from '../src/store.ts';

// 测试用快 key（同算法不同材料——往返语义不变；真实派生单测一次）
const fastKey = crypto.pbkdf2Sync('test-material', 'salt', 1000, 32, 'sha512');

describe('加密算法半边', () => {
  it('加解密往返（v1 前缀格式）', () => {
    const enc = encryptValue(fastKey, 'secret-token-abc');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decryptValue(fastKey, enc)).toBe('secret-token-abc');
  });

  it('换 key 解密失败 → null（机器绑定语义）', () => {
    const otherKey = crypto.pbkdf2Sync('other', 'salt', 1000, 32, 'sha512');
    const enc = encryptValue(fastKey, 'x');
    expect(decryptValue(otherKey, enc)).toBeNull();
  });

  it('旧明文兼容（无 v1 前缀原样返回）', () => {
    expect(decryptValue(fastKey, 'plain-legacy')).toBe('plain-legacy');
  });

  it('真实派生：机器材料 + 600k 迭代（单次验证参数面）', () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    const k = deriveKey(machineMaterial());
    expect(k).toHaveLength(32);
    expect(decryptValue(k, encryptValue(k, 'roundtrip'))).toBe('roundtrip');
  }, 20_000);

  it('key 词形：<agentId>_<provider>_API_KEY 大写；全局前缀', () => {
    expect(credentialKey('alpha', 'github')).toBe('ALPHA_GITHUB_API_KEY');
    expect(GLOBAL_AGENT_ID).toBe('__global__');
  });
});

describe('credentials/ 目录直读', () => {
  const ROOT = path.join('sandbox', 'test-cred-' + process.pid);
  beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('写读往返 + 条目枚举（.enc 扩展名剥离）', () => {
    expect(listCredentialNames(ROOT)).toEqual([]);
    writeCredential(ROOT, fastKey, 'github-token', 'ghp_x');
    writeCredential(ROOT, fastKey, 'adt-pass', 'p@ss');
    expect(listCredentialNames(ROOT)).toEqual(['adt-pass', 'github-token']);
    expect(readCredential(ROOT, fastKey, 'github-token')).toBe('ghp_x');
  });

  it('条目缺席 → null；坏文件 → null（未设置语义）', () => {
    writeCredential(ROOT, fastKey, 'a', 'x');
    expect(readCredential(ROOT, fastKey, 'no-such')).toBeNull();
    fs.writeFileSync(path.join(credentialsDir(ROOT), 'bad.enc'), 'v1:!!!notbase64', 'utf-8');
    expect(readCredential(ROOT, fastKey, 'bad')).toBeNull();
  });

  it('fail-loud：条目名路径穿越拒绝', () => {
    expect(() => readCredential(ROOT, fastKey, 'a/b')).toThrow();
    expect(() => writeCredential(ROOT, fastKey, '..', 'x')).toThrow();
  });
});
