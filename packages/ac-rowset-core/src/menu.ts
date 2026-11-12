// ============================================================
// menu.ts —— 菜单合成引擎（cr-1022 批1 / docs/design/assembly/menu-assembly.md）
//
// 装配第二模型：菜单合成取代菜单求值——
//   menu(agent) = 骨架区(shell.yml) ∪ agent.patch.yml 定义 ∪ installed
// 合并即装配：产物是装载器条目（自带 name: link: 装载路径），无引用
// 解析步骤。三护栏：
//   · 撞名：骨架 > patch > installed，低优先丢弃 + notice（fail-soft）；
//   · requires 完备性校验：合并后每行 requires ⊆ 菜单，缺失 = fail-loud
//     列名（不做自动注入——菜单不因 requires 静默长行，与「不进即不装」
//     同哲学）；
//   · 词汇白名单（cr-1025）：patch/installed 定义入口只许
//     id/name/requires/config——tools/packs/bundle 及一切「真值在带内
//     另有所属」的派生词禁入；基座词汇由 readBaseDoc、包自述行由
//     aggregatePackageRows 各自 fail-loud 守（cr-1033 B3 起单区读面），
//     引擎不重复守。
//
// 纯函数：无身份、无 fs。旧求值引擎（evaluate.ts）原样并存，批 2/3
// 换轨后退役。
// ============================================================

/** 菜单行定义（= cordis-plugin-loader 条目词汇——白名单即类型面） */
import * as crypto from 'node:crypto';
import type { AssemblyEntry } from './custom-layer.ts';

export interface MenuEntry {
  /** 稳定行 id */
  id: string;
  /** 行定位（link: 仓库相对路径——装载路径） */
  name?: string;
  /** 硬依赖行 id 清单（完备性校验输入——静态闭包的本体输入） */
  requires?: string[];
  /** 行内配置（cordis 方言原生——levels 机制归位于此） */
  config?: Record<string, unknown>;
}

/** 行定义词汇白名单（cr-1025 立法：id / name / requires / config） */
export const MENU_ENTRY_KEYS: readonly string[] = ['id', 'name', 'requires', 'config'];

/** 合成输入（三源——骨架区由调用方从双区基座文档喂入） */
export interface MergeMenuInput {
  /** 骨架区行（shell.yml 骨架区——最高优先，恒装面） */
  skeleton: MenuEntry[];
  /** 实例菜单片段（agent.patch.yml 行定义数组） */
  patch?: MenuEntry[];
  /** 第三方行（fit(installed × shell) 结果——现行机制不变） */
  installed?: MenuEntry[];
}

/** 菜单（合并即装配——产物直接交装载器） */
export interface Menu {
  /** 合并后行定义全集（按 id 排序稳定） */
  entries: MenuEntry[];
  /** 降级通知（撞名丢弃——fail-soft 面） */
  notices: string[];
  /** 合成矛盾（白名单外字段 / 同源重复定义 / requires 缺失——boot 必炸） */
  errors: string[];
}

type MenuSource = 'skeleton' | 'patch' | 'installed';

// —— 溯源指纹（§2.3 定义副本是缓存，不是数据——批2 写入面，批3 校准面） ——

/** 规范化序列化（键序递归排序的稳定 JSON——指纹输入单源） */
export function canonicalMenuJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalMenuJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalMenuJson((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** 行定义指纹（出厂/installed 定义的规范化哈希——sha256 前 16 hex）。
 * src-fingerprint 是溯源元数据，不是行定义词汇（§2.1 白名单仍四字段）：
 * v3 读侧剥离、写侧随行，mergeMenu 不见。 */
export function menuDefinitionFingerprint(def: MenuEntry): string {
  const pick: MenuEntry = {
    id: def.id,
    ...(def.name !== undefined ? { name: def.name } : {}),
    ...(def.requires !== undefined ? { requires: def.requires } : {}),
  };
  return crypto.createHash('sha256').update(canonicalMenuJson(pick)).digest('hex').slice(0, 16);
}

/** 用户全局层（<base>.patch.yml）应用到菜单：停用（骨架 = 恒装面，停用
 * 拒绝生效；except 豁免）+ config 合并。fail-soft：未命中/护栏 = notice。
 * rowConfigKeys（cr-1037 批3）：行 id → 包自述 config 键面——在场时未知
 * 键 warn 不阻断（键改名提示；缺席 = 行未自述，不校验）。 */
export function applyAssemblyLayer(
  menu: Menu,
  layer: AssemblyEntry[],
  agentId: string | undefined,
  skeletonIds: readonly string[],
  rowConfigKeys?: ReadonlyMap<string, readonly string[]>,
): { entries: MenuEntry[]; notices: string[] } {
  const notices: string[] = [];
  const byId = new Map(menu.entries.map((e) => [e.id, e] as const));
  const skeleton = new Set(skeletonIds);
  const disabled = new Set<string>();
  for (const entry of layer) {
    if (entry.disabled === true) {
      if (!byId.has(entry.id)) {
        notices.push('disable 点名不在菜单（跳过）：' + entry.id);
        continue;
      }
      const exempted = agentId !== undefined && (entry.except ?? []).includes(agentId);
      if (skeleton.has(entry.id)) {
        notices.push(entry.id + '：骨架行不可停用（拒绝生效——恒装面）');
        continue;
      }
      if (!exempted) disabled.add(entry.id);
      continue;
    }
    const hit = byId.get(entry.id);
    if (hit === undefined) {
      notices.push('用户层 config 条目未命中菜单（跳过）：' + entry.id);
      continue;
    }
    if (entry.config !== undefined) {
      // 键面校验（cr-1037 批3：以包自述为准——configKeys 缺席不校验；
      // 未知键 warn 不阻断——前向兼容回退场景）；机制保留键豁免
      //（'configVersion'/'legacy' 字面量与 ac-agents-core config-chain 常量同义——
      // 依赖方向禁引，改动须两处同步）
      const known = rowConfigKeys?.get(entry.id);
      if (known !== undefined) {
        const unknown = Object.keys(entry.config)
          .filter((k) => !known.includes(k) && k !== 'configVersion' && k !== 'legacy');
        if (unknown.length > 0) {
          notices.push('行 ' + entry.id + ' config 未知键（不在包自述键面——可能已改名，请核对）：' + unknown.join(', '));
        }
      }
      hit.config = { ...(hit.config ?? {}), ...entry.config };
    }
  }
  const entries = menu.entries.filter((e) => !disabled.has(e.id));
  return { entries, notices };
}



/** 词汇白名单校验：定义入口条目出现白名单外字段 → 错误（点名源/行/字段） */
function vocabularyErrors(entries: MenuEntry[], source: MenuSource): string[] {
  const errors: string[] = [];
  for (const entry of entries) {
    for (const key of Object.keys(entry)) {
      if (!MENU_ENTRY_KEYS.includes(key)) {
        errors.push(
          source + ' 行 ' + entry.id + ' 含白名单外字段：' + key
          + '（行定义词汇 = id/name/requires/config）',
        );
      }
    }
  }
  return errors;
}

/** 菜单合成（§2.2）：三源并集 + 撞名护栏 + requires 完备性校验 */
export function mergeMenu(input: MergeMenuInput): Menu {
  const notices: string[] = [];
  const errors: string[] = [];
  errors.push(...vocabularyErrors(input.patch ?? [], 'patch'));
  errors.push(...vocabularyErrors(input.installed ?? [], 'installed'));
  // —— 三源并集：低优先先入、高优先覆盖（骨架 > patch > installed） ——
  const byId = new Map<string, { entry: MenuEntry; source: MenuSource }>();
  const add = (entries: MenuEntry[], source: MenuSource): void => {
    for (const entry of entries) {
      const hit = byId.get(entry.id);
      if (hit === undefined) {
        byId.set(entry.id, { entry, source });
        continue;
      }
      if (hit.source === source) {
        errors.push(source + ' 内行定义重复：' + entry.id);
        continue;
      }
      byId.set(entry.id, { entry, source });
      notices.push(
        '撞名丢弃（skeleton > patch > installed）：' + hit.source + ' 行 '
        + entry.id + ' 被 ' + source + ' 定义取代',
      );
    }
  };
  add(input.installed ?? [], 'installed');
  add(input.patch ?? [], 'patch');
  add(input.skeleton, 'skeleton');
  // —— requires 完备性校验（缺失 = fail-loud 列名，不做自动注入） ——
  for (const { entry } of byId.values()) {
    for (const req of entry.requires ?? []) {
      if (!byId.has(req)) {
        errors.push(
          '行 ' + entry.id + ' requires 缺失：' + req
          + '（requires ⊆ 菜单——不进即不装，patch 需显式携带）',
        );
      }
    }
  }
  const entries = [...byId.values()]
    .map((v) => v.entry)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { entries, notices, errors };
}
