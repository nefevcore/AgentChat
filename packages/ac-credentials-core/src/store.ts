// ============================================================
// store.ts —— credentials/ 目录直读（授权草稿 A 节：物理单副本，
// 引用不复制——auth.json 只存条目名）
//
// 布局：数据根/credentials/<name>.enc（每条目一文件——授权条目 ref =
// 文件名；写入面 = 宿主侧（auth-registry 行〔M4〕授权条目 / web-api 行
// 池 api_key 侧信道〔cr-564〕），壳恒只读直取）。
// 单文件多 key 形态（现状 credentials.json）不迁移——物理单副本指数据
// 根内唯一，不指文件形状；分条目文件与引用制对齐。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { decryptValue, encryptValue } from './crypto.ts';

export const CREDENTIALS_DIR = 'credentials';
const ENC_EXT = '.enc';

/** 条目三态（读面/删除守卫词汇——主线 CredentialsService.state 同义） */
export type CredentialState = 'set' | 'locked' | 'none';

/**
 * 条目名 → 文件名（Windows 非法字符 : * ? " < > | 及控制符 → %XX 转义，
 * 双向可还原——ac-import pathSegment 同款先例。池域 key 形如
 * __GLOBAL___POOL:DEEPSEEK_API_KEY 的冒号是首个实消费者，cr-556。）
 */
function fileNameFor(name: string): string {
  return name.replace(/[:*?"<>|\x00-\x1f]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function nameFrom(fileName: string): string {
  return fileName.replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** credentials/ 目录（数据根下） */
export function credentialsDir(dataRoot: string): string {
  return path.join(dataRoot, CREDENTIALS_DIR);
}

/** 列全部条目名（无扩展名；目录缺席 = 空清单） */
export function listCredentialNames(dataRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(credentialsDir(dataRoot), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(ENC_EXT))
    .map((e) => nameFrom(e.name.slice(0, -ENC_EXT.length)))
    .sort();
}

/** 条目名闸（含路径组件 = 越出 credentials/，读写删一律拒绝） */
function assertEntryName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`凭据条目名含路径组件（${name}）——拒绝`);
  }
}

/**
 * 直取条目明文（每 run 前重读语义——不缓存）。条目缺席/解密失败
 * （换机/密钥变更）→ null（调用方以「未设置」处理）。
 */
export function readCredential(dataRoot: string, key: Buffer, name: string): string | null {
  assertEntryName(name);
  const file = path.join(credentialsDir(dataRoot), fileNameFor(name) + ENC_EXT);
  let encoded: string;
  try {
    encoded = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  return decryptValue(key, encoded);
}

/**
 * 写条目（宿主 auth-registry 写者面专用；原子写 tmp+rename——撕裂防护）。
 * 壳侧禁止调用（写者面单源）。
 */
export function writeCredential(dataRoot: string, key: Buffer, name: string, plaintext: string): void {
  assertEntryName(name);
  const dir = credentialsDir(dataRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileNameFor(name) + ENC_EXT);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, encryptValue(key, plaintext), 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * 删条目（空串删除语义的落盘端；幂等——条目缺席即已达成目标）。
 * 写者面同源（宿主侧）：config 写面的「空串 = 删」经此落地。
 */
export function removeCredential(dataRoot: string, name: string): void {
  assertEntryName(name);
  const file = path.join(credentialsDir(dataRoot), fileNameFor(name) + ENC_EXT);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * 条目三态（主线 CredentialsService.state 同义）：'set' 在盘可解密 /
 * 'locked' 在盘但解密失败（换机/密钥变更——密文仍可恢复）/ 'none' 无条目。
 * 「读不了」≠「不存在」：空串删除指令不得销毁 locked 密文（cr-310 守卫）。
 */
export function credentialState(dataRoot: string, key: Buffer, name: string): CredentialState {
  if (!listCredentialNames(dataRoot).includes(name)) return 'none';
  return readCredential(dataRoot, key, name) === null ? 'locked' : 'set';
}
