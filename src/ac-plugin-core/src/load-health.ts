// ============================================================
// ac-plugin-core/src/load-health.ts —— 动态插件装载熔断存档（M23 P5：E4/F4/G8/G9）
//
// <root>/plugins/.load-health.json：
//   failures: { [name]: { count, lastError, lastAt } }   连续失败计数
//   disabled: { [name]: { count, reason, at } }          熔断集（≥阈值）
//
// 生命周期（F4）：
//   · 失败计数来源 = loadInstalled 首扫 + install 期装载失败（同源立即计数）
//   · 成功装载 → 清零；install（含 bump version 重装）/ uninstall → 强制清记录
//     （防"修复后永远装不上"死锁）
//   · 同 hash 幂等重装不触发装载（G8）→ 自然不计数
//   · 进入 disabled 后 loadInstalled 跳过并透出 skipped[]（G9 三态徽章第四态）
// 首期只覆盖动态插件（loadInstalled 人群）；yml 行熔断后置 P7。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile, withRootLock } from './fsx.ts';
import { pluginsRoot } from './store.ts';

/** 熔断阈值（连续失败 ≥ 此值进入 disabled） */
export const LOAD_FAILURE_THRESHOLD = 3;

interface LoadFailureRecord {
  count: number;
  lastError?: string;
  lastAt: string;
}

interface LoadDisabledRecord {
  count: number;
  reason: string;
  at: string;
}

interface LoadHealthDoc {
  version: 1;
  failures: Record<string, LoadFailureRecord>;
  disabled: Record<string, LoadDisabledRecord>;
}

function healthFile(root: string): string {
  return path.join(pluginsRoot(root), '.load-health.json');
}

export function readLoadHealth(root: string): LoadHealthDoc {
  const file = healthFile(root);
  if (!fs.existsSync(file)) return { version: 1, failures: {}, disabled: {} };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<LoadHealthDoc>;
    if (doc.version !== 1) return { version: 1, failures: {}, disabled: {} };
    return {
      version: 1,
      failures: doc.failures && typeof doc.failures === 'object' ? doc.failures : {},
      disabled: doc.disabled && typeof doc.disabled === 'object' ? doc.disabled : {},
    };
  } catch {
    // 损坏 = 视作空档（fail-soft：熔断是防线不是承重墙）
    return { version: 1, failures: {}, disabled: {} };
  }
}

function writeLoadHealth(root: string, doc: LoadHealthDoc): void {
  const file = healthFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * 记一次装载失败（串行队列内）。达到阈值 → 进入 disabled（熔断）。
 * @returns 更新后的该 name 状态（调用方透出/告警用）
 */
export function recordLoadFailure(
  root: string,
  name: string,
  error: string,
): Promise<LoadFailureRecord | LoadDisabledRecord> {
  return withRootLock(root, () => {
    const doc = readLoadHealth(root);
    const prev = doc.failures[name];
    const count = (prev?.count ?? 0) + 1;
    const record: LoadFailureRecord = {
      count,
      ...(error ? { lastError: error } : {}),
      lastAt: new Date().toISOString(),
    };
    doc.failures[name] = record;
    if (count >= LOAD_FAILURE_THRESHOLD) {
      const disabled: LoadDisabledRecord = {
        count,
        reason: error,
        at: record.lastAt,
      };
      doc.disabled[name] = disabled;
      writeLoadHealth(root, doc);
      return disabled;
    }
    writeLoadHealth(root, doc);
    return record;
  });
}

/**
 * 清除该 name 的熔断记录（成功装载清零 / install / uninstall / 手动复位）。
 * 幂等：无记录时 no-op。
 */
export function clearLoadHealth(root: string, name: string): Promise<void> {
  return withRootLock(root, () => {
    const doc = readLoadHealth(root);
    if (!(name in doc.failures) && !(name in doc.disabled)) return;
    delete doc.failures[name];
    delete doc.disabled[name];
    writeLoadHealth(root, doc);
  });
}

/** 该 name 是否已熔断（disabled 集） */
export function isLoadDisabled(root: string, name: string): boolean {
  return readLoadHealth(root).disabled[name] !== undefined;
}
