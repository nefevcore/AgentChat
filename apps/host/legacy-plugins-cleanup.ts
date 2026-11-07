// ============================================================
// legacy-plugins-cleanup.ts —— 旧链数据根出厂副本物理清理（cr-935；
// webui-v3 §4.9「数据根出厂副本」收口——cr-918 手法）
//
// v3 装载锚 = 宿主活装配态（wire = 活 fiber 投影），<dataRoot>/plugins
// 恒不读写。旧链出厂播种的痕迹 = .factory-stamp.json 名册内的目录
//（纯出厂拷贝）；名册外目录（用户自装 v1 存量）零触碰——用户数据优先。
// 一次性迁移面：无痕迹（新数据根/已清）= 无操作。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 名册文件名（旧链 seedFactoryPlugins 写入形态：{ sig: JSON 字串 }，sig 内 { names }） */
const STAMP_FILE = '.factory-stamp.json';

/**
 * 清理旧链 <dataRoot>/plugins 出厂拷贝：名册内目录 + 名册本身物理删除。
 * 返回被删目录名清单（无痕迹 = 空数组——调用方日志面用）。
 */
export function cleanupLegacyFactoryPlugins(dataRoot: string): string[] {
  const legacyPlugins = path.join(dataRoot, 'plugins');
  const stampFile = path.join(legacyPlugins, STAMP_FILE);
  let stampRaw: string;
  try {
    stampRaw = fs.readFileSync(stampFile, 'utf-8');
  } catch {
    return []; // 无出厂痕迹（新数据根/已清）——无操作
  }
  let names: unknown;
  try {
    const sig = (JSON.parse(stampRaw) as { sig?: unknown }).sig;
    names = typeof sig === 'string' ? (JSON.parse(sig) as { names?: unknown }).names : null;
  } catch {
    names = null; // 名册损坏：只删名册本身，不猜目录
  }
  const removed: string[] = [];
  if (Array.isArray(names)) {
    for (const name of names) {
      if (typeof name !== 'string') continue;
      fs.rmSync(path.join(legacyPlugins, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  fs.rmSync(stampFile, { force: true });
  return removed;
}
