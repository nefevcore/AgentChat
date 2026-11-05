// ============================================================
// custom-layer.ts —— <proc>-custom.patch.yml 用户偏好层（cr-908 批6
// 切片三 / cr-901 §4.3：基座的手写偏好——本切片落「基座行停用」面；
// override/点名随设置 UI 需求扩展。写者 = 设置 UI/用户（repo 不部署
// 本文件——custom 是数据根用户域；顶层 cordis.patch.yml 无剩余职责，
// 新架构不复活）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

/** custom 层条目（消费面子集——disable 面） */
interface CustomEntry {
  id: string;
  disabled?: boolean;
}

export interface CustomLayer {
  /** 停用行 id 集（基座内定位） */
  disabled: Set<string>;
  /** 点名不在基座菜单 = 警告 + 跳过（降级语义） */
  warnings: string[];
}

/** 读 <proc>-custom.patch.yml（缺席 = 空层；损坏 = 空层 + 警告——用户域
 * 文件不阻断 boot，设置 UI 可自修复） */
export function readCustomLayer(profileDir: string, proc: 'host' | 'shell' | 'webui'): CustomLayer {
  const file = path.join(profileDir, proc + '-custom.patch.yml');
  if (!fs.existsSync(file)) return { disabled: new Set(), warnings: [] }; // 缺席 = 空层（常态）
  let entries: CustomEntry[];
  try {
    const data = yaml.load(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!Array.isArray(data)) {
      return { disabled: new Set(), warnings: [proc + '-custom.patch.yml 顶层非数组（按空层继续）'] };
    }
    entries = data.filter((e): e is CustomEntry =>
      e !== null && typeof e === 'object' && typeof (e as CustomEntry).id === 'string');
  } catch (err: unknown) {
    return { disabled: new Set(), warnings: [proc + '-custom.patch.yml 不可读（按空层继续）：' + (err instanceof Error ? err.message : String(err))] };
  }
  return {
    disabled: new Set(entries.filter((e) => e.disabled === true).map((e) => e.id)),
    warnings: [],
  };
}
