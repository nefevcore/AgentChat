// ============================================================
// cutover-credentials.ts —— 凭据换轨（8.9 cr-556）：主线单文件
// credentials.json {key: "v1:…"} → 新架构 credentials/<name>.enc 条目文件
//
// 算法同源（AES-256-GCM + PBKDF2-SHA512 600k + 同 SALT + 机器绑定材料
// hostname:username——ac-credentials-core 自主线原样平移），同机解密重写；
// key 词汇零转换（credentialKey 单源同形：__GLOBAL___POOL:DEEPSEEK_API_KEY
// 等池域 key 原样成条目名——冒号在 Windows 文件名合法，路径闸只拦 / \）。
// 单向换轨：只读旧文件、只写新目录，不触碰旧文件（R-10 原样保留）。
// ============================================================
import { readFileSync, existsSync } from 'node:fs';
import { deriveKey, machineMaterial, decryptValue, writeCredential } from 'ac-credentials-core';

export interface CredentialMigrationReport {
  total: number;
  migrated: number;
  failed: number;
  failures: Array<{ name: string; reason: string }>;
}

/**
 * 逐 key 解密重写。旧文件缺席 = 空报告（无凭据环境）。解密失败（换机/
 * 密钥变更）的条目记 failures——调用方决定 fail-fast 或继续（换轨语义：
 * 失败条目缺失即「未设置」，新架构 readCredential 归 null 同义）。
 */
export function migrateCredentials(oldDataRoot: string, newDataRoot: string): CredentialMigrationReport {
  const oldFile = oldDataRoot + '/credentials.json';
  if (!existsSync(oldFile)) return { total: 0, migrated: 0, failed: 0, failures: [] };
  const raw = JSON.parse(readFileSync(oldFile, 'utf-8')) as Record<string, string>;
  const key = deriveKey(machineMaterial());
  const report: CredentialMigrationReport = { total: 0, migrated: 0, failed: 0, failures: [] };
  for (const [name, encoded] of Object.entries(raw)) {
    report.total += 1;
    const plaintext = decryptValue(key, encoded);
    if (plaintext === null) {
      report.failed += 1;
      report.failures.push({ name, reason: '解密失败（换机/密钥变更？）' });
      continue;
    }
    writeCredential(newDataRoot, key, name, plaintext);
    report.migrated += 1;
  }
  return report;
}