// ============================================================
// cutover-credentials.test.ts —— 凭据换轨单测（8.9 cr-556）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateCredentials } from '../cutover-credentials.ts';
import { deriveKey, machineMaterial, encryptValue, writeCredential, readCredential } from 'ac-credentials-core';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-cred-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('8.9 · 凭据换轨', () => {
  it('逐 key 解密重写：credentials.json 平面映射 → 条目文件（key 原样、明文可读回）', () => {
    const key = deriveKey(machineMaterial());
    const old = path.join(tmp, 'old');
    fs.mkdirSync(old);
    // 造旧文件：含池域 key（冒号）与普通 key——模拟真数据根形态
    fs.writeFileSync(path.join(old, 'credentials.json'), JSON.stringify({
      '__GLOBAL___POOL:DEEPSEEK_API_KEY': encryptValue(key, 'sk-pool-deepseek'),
      '__GLOBAL___GLM_API_KEY': encryptValue(key, 'sk-glm'),
      'HELPER_ZAI-CODING-CN_API_KEY': encryptValue(key, 'sk-zai'),
    }));
    const fresh = path.join(tmp, 'fresh');
    fs.mkdirSync(fresh);
    const report = migrateCredentials(old, fresh);
    expect(report).toEqual({ total: 3, migrated: 3, failed: 0, failures: [] });
    expect(readCredential(fresh, key, '__GLOBAL___POOL:DEEPSEEK_API_KEY')).toBe('sk-pool-deepseek');
    expect(readCredential(fresh, key, '__GLOBAL___GLM_API_KEY')).toBe('sk-glm');
    expect(readCredential(fresh, key, 'HELPER_ZAI-CODING-CN_API_KEY')).toBe('sk-zai');
    // 旧文件原样（R-10）
    expect(fs.existsSync(path.join(old, 'credentials.json'))).toBe(true);
  });

  it('旧文件缺席 = 空报告；坏值条目记 failures 不炸全局', () => {
    const fresh = path.join(tmp, 'fresh');
    fs.mkdirSync(fresh);
    expect(migrateCredentials(path.join(tmp, 'none'), fresh)).toEqual({ total: 0, migrated: 0, failed: 0, failures: [] });
    const old = path.join(tmp, 'old2');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'credentials.json'), JSON.stringify({
      'A_X_API_KEY': encryptValue(keyOf(), 'ok-value'),
      'B_Y_API_KEY': 'v1:<<<<not-base64>>>>',
    }));
    const report = migrateCredentials(old, fresh);
    expect(report.total).toBe(2);
    expect(report.migrated).toBe(1);
    expect(report.failures.length).toBe(1);
  });

  it('幂等：重跑既有条目文件被同值覆盖（原子写不双条）', () => {
    const key = deriveKey(machineMaterial());
    const old = path.join(tmp, 'old3');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'credentials.json'), JSON.stringify({ K_Z_API_KEY: encryptValue(key, 'v1') }));
    const fresh = path.join(tmp, 'fresh3');
    fs.mkdirSync(fresh);
    migrateCredentials(old, fresh);
    migrateCredentials(old, fresh);
    expect(fs.readdirSync(path.join(fresh, 'credentials')).length).toBe(1);
  });
});

function keyOf(): Buffer { return deriveKey(machineMaterial()); }