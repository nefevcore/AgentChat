// ============================================================
// ac-plugin-core/src/manifest.ts —— 插件 manifest 类型与校验
//
// src core/agent-config/manifest.ts 的 preview 适配：
//   · provides 收敛为 { tools }（preview 无 hooks 配置域；M25 P2 扩展
//     events 为 Array<string | {name, description}>）
//   · ui.slots 只做 param-case 格式校验（不锁死清单——slot 白名单是
//     宿主 declareSlot 的动态集合，存在性校验在注册期 fail-closed）
//   · permissions 词汇原样（fs/network/process/shell/ui）
// ============================================================
import { isValidContractsRange } from './contracts.ts';

/** manifest.ui 的声明形状 */
export interface PluginUiManifest {
  entry?: string;
  styles?: string[];
  slots?: string[];
  isolated?: boolean;
}

export interface PluginManifest {
  name: string;
  version: string;
  /** 入口文件（相对插件目录；缺省 index.ts） */
  entry: string;
  /** 依赖的 ctx 服务名（装载前检查可满足性） */
  inject?: string[];
  /** 兼容的宿主契约范围（semver range，如 "^1"） */
  contracts?: string;
  /** 行配置（激活时传入 apply） */
  config?: Record<string, unknown>;
  /** 声明的权限（装载边界：超出授予即拒绝 import） */
  permissions?: PluginPermission[];
  /**
   * 供给面声明（M23 E3/G4 对象形状；兼容存量 {tools}——tools 键恒收编为
   * 数组）。用途：① 装载后对账（tools/llmProviders 到名字级；events 规约
   * 级 warn 不阻断）② 注册制目录行元数据 ③ 可视化分组 ④ 保留字护栏
   * （F13/G1：tools/llmProviders/agents 三面比对内置名常量表，冲突拒绝）。
   */
  provides?: {
    /** 工具名清单（装载后对账到名字级） */
    tools?: string[];
    /** provider 名清单（对账 ctx.llm 注册面） */
    llmProviders?: string[];
    /**
     * 订阅事件名（规约级对账：warn 不阻断）。M25 P2 扩展：
     * `string[]` | `Array<{ name, description? }>`（M23 对账语义兼容——
     * 描述进事件视图声明目录）。
     */
    events?: Array<string | { name: string; description?: string }>;
    /** 携带 UI 扩展（对账 manifest.ui 挂载） */
    ui?: boolean;
    /** 注册的预设 Agent id 清单（保留字护栏 + 对账；G1 agents 面） */
    agents?: string[];
  };
  ui?: PluginUiManifest;
  description?: string;
  author?: string;
}

/** 市场安装的来源锚定（本地发布缺省 local） */
export interface PluginSource {
  kind: 'github' | 'local' | 'tarball';
  repo?: string;
  ref?: string;
  commit?: string;
  /** 原始定位串（如 github:acme/hello#v1） */
  spec?: string;
}

export interface InstalledPluginRecord {
  manifest: PluginManifest;
  /** 相对 plugins 根的目录名（= manifest.name） */
  dir: string;
  owner: string;
  permissions: PluginPermission[];
  hash: string;
  installedAt: string;
  source?: PluginSource;
}

export interface PluginRegistryDoc {
  version: 1;
  plugins: Record<string, InstalledPluginRecord>;
}

export interface PluginStagingRecord {
  id: string;
  manifest: PluginManifest;
  sourceDir: string;
  stagedDir: string;
  hash: string;
  owner: string;
  createdAt: string;
  requiredGrants: PluginPermission[];
  source?: PluginSource;
}

interface ManifestValidation {
  ok: boolean;
  errors: string[];
  manifest?: PluginManifest;
}

/** 插件可声明的权限词汇表 */
export const KNOWN_PERMISSIONS = ['fs', 'network', 'process', 'shell', 'ui'] as const;
export type PluginPermission = (typeof KNOWN_PERMISSIONS)[number];

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SLOT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isValidRelativePath(p: string): boolean {
  return p.trim() !== '' && !p.includes('..') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p);
}

/** 校验并规范化插件 manifest（纯函数；未知字段丢弃） */
export function validatePluginManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest 必须是 JSON 对象'] };
  }
  const obj = raw as Record<string, unknown>;

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) errors.push('name 必填');
  else if (!NAME_RE.test(name)) errors.push(`name "${name}" 非法（仅小写字母/数字/连字符，字母数字开头）`);

  const version = typeof obj.version === 'string' ? obj.version.trim() : '';
  if (!version) errors.push('version 必填');
  else if (!VERSION_RE.test(version)) errors.push(`version "${version}" 非法（semver，如 1.0.0）`);

  const entry = obj.entry === undefined ? 'index.ts' : obj.entry;
  if (typeof entry !== 'string' || entry.trim() === '') errors.push('entry 必须是非空字符串');
  else if (!isValidRelativePath(entry)) errors.push('entry 必须是插件目录内的相对路径');

  let inject: string[] | undefined;
  if (obj.inject !== undefined) {
    if (!Array.isArray(obj.inject) || obj.inject.some((d) => typeof d !== 'string')) {
      errors.push('inject 必须是字符串数组');
    } else {
      inject = obj.inject as string[];
    }
  }

  let config: Record<string, unknown> | undefined;
  if (obj.config !== undefined) {
    if (obj.config === null || typeof obj.config !== 'object' || Array.isArray(obj.config)) {
      errors.push('config 必须是对象');
    } else {
      config = obj.config as Record<string, unknown>;
    }
  }

  let permissions: PluginPermission[] | undefined;
  if (obj.permissions !== undefined) {
    if (!Array.isArray(obj.permissions) || obj.permissions.some((p) => typeof p !== 'string')) {
      errors.push('permissions 必须是字符串数组');
    } else {
      for (const p of obj.permissions as string[]) {
        if (!KNOWN_PERMISSIONS.includes(p as PluginPermission)) {
          errors.push(`permissions 含未知权限 "${p}"（可选：${KNOWN_PERMISSIONS.join('/')}）`);
        }
      }
      permissions = obj.permissions as PluginPermission[];
    }
  }

  let contracts: string | undefined;
  if (obj.contracts !== undefined) {
    if (typeof obj.contracts !== 'string') {
      errors.push('contracts 必须是字符串（semver range，如 "^1"）');
    } else if (!isValidContractsRange(obj.contracts)) {
      errors.push(`contracts "${obj.contracts}" 非法（semver range，如 "^1" / ">=1 <2" / "*"）`);
    } else {
      contracts = obj.contracts.trim();
    }
  }

  let ui: PluginUiManifest | undefined;
  const uiDeclared = obj.ui !== undefined;
  if (uiDeclared) {
    if (obj.ui === null || typeof obj.ui !== 'object' || Array.isArray(obj.ui)) {
      errors.push('ui 必须是对象');
    } else {
      const candidate = obj.ui as Record<string, unknown>;
      let uiEntry: string | undefined;
      if (candidate.entry !== undefined) {
        if (typeof candidate.entry !== 'string' || candidate.entry.trim() === '') {
          errors.push('ui.entry 必须是非空字符串');
        } else if (!isValidRelativePath(candidate.entry)) {
          errors.push('ui.entry 必须是插件目录内的相对路径');
        } else {
          uiEntry = candidate.entry;
        }
      }

      let uiStyles: string[] | undefined;
      if (candidate.styles !== undefined) {
        if (!Array.isArray(candidate.styles) || candidate.styles.some((s) => typeof s !== 'string')) {
          errors.push('ui.styles 必须是字符串数组');
        } else {
          for (const s of candidate.styles as string[]) {
            if (!isValidRelativePath(s)) errors.push(`ui.styles 含非法路径 "${s}"（必须是插件目录内的相对路径）`);
          }
          uiStyles = [...new Set(candidate.styles as string[])];
        }
      }

      let uiSlots: string[] | undefined;
      if (candidate.slots !== undefined) {
        if (!Array.isArray(candidate.slots) || candidate.slots.some((s) => typeof s !== 'string')) {
          errors.push('ui.slots 必须是字符串数组');
        } else {
          for (const s of candidate.slots as string[]) {
            if (!SLOT_ID_RE.test(s)) errors.push(`ui.slots 含非法 slot id "${s}"（param-case）`);
          }
          uiSlots = [...new Set(candidate.slots as string[])];
        }
      }

      if (candidate.isolated !== undefined && typeof candidate.isolated !== 'boolean') {
        errors.push('ui.isolated 必须是 boolean');
      }

      ui = {
        ...(uiEntry !== undefined ? { entry: uiEntry } : {}),
        ...(uiStyles !== undefined ? { styles: uiStyles } : {}),
        ...(uiSlots !== undefined ? { slots: uiSlots } : {}),
        ...(candidate.isolated !== undefined ? { isolated: candidate.isolated as boolean } : {}),
      };
    }
  }

  // manifest.ui 存在时 ui 权限必须声明（整包原子装载）
  if (uiDeclared && !(permissions ?? []).includes('ui')) {
    errors.push('manifest.ui 存在时 permissions 必须包含 "ui"');
  }

  let provides: PluginManifest['provides'];
  if (obj.provides !== undefined) {
    const value = obj.provides;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push('provides 必须是 { tools, llmProviders, events, ui, agents } 对象');
    } else {
      const candidate = value as Record<string, unknown>;
      // 各清单键：字符串数组 → 去重保序；ui → boolean；全部可缺省。
      // events（M25 P2）：string | {name, description?} 混排 → 收编保序。
      const listOf = (key: string): string[] | undefined => {
        const v = candidate[key];
        if (v === undefined) return undefined;
        if (!Array.isArray(v) || v.some((n) => typeof n !== 'string')) {
          errors.push(`provides.${key} 必须是字符串数组`);
          return undefined;
        }
        return [...new Set(v as string[])];
      };
      const tools = listOf('tools');
      const llmProviders = listOf('llmProviders');
      const agents = listOf('agents');
      let events: NonNullable<PluginManifest['provides']>['events'];
      {
        const v = candidate.events;
        if (v !== undefined) {
          if (!Array.isArray(v)) {
            errors.push('provides.events 必须是数组（string | {name, description?}）');
          } else {
            const out: Array<string | { name: string; description?: string }> = [];
            for (const item of v) {
              if (typeof item === 'string') {
                out.push(item);
              } else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
                const desc = (item as { description?: unknown }).description;
                out.push({
                  name: (item as { name: string }).name,
                  ...(typeof desc === 'string' && desc ? { description: desc } : {}),
                });
              } else {
                errors.push('provides.events 条目必须是 string 或 { name, description? }');
              }
            }
            events = out;
          }
        }
      }
      let ui: boolean | undefined;
      if (candidate.ui !== undefined) {
        if (typeof candidate.ui !== 'boolean') errors.push('provides.ui 必须是 boolean');
        else ui = candidate.ui;
      }
      if (tools !== undefined || llmProviders !== undefined || events !== undefined || agents !== undefined || ui !== undefined) {
        provides = {
          ...(tools !== undefined ? { tools } : {}),
          ...(llmProviders !== undefined ? { llmProviders } : {}),
          ...(events !== undefined ? { events } : {}),
          ...(ui !== undefined ? { ui } : {}),
          ...(agents !== undefined ? { agents } : {}),
        };
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const manifest: PluginManifest = {
    name: name as string,
    version: version as string,
    entry: entry as string,
    ...(inject ? { inject } : {}),
    ...(contracts ? { contracts } : {}),
    ...(config ? { config } : {}),
    ...(permissions ? { permissions } : {}),
    ...(provides ? { provides } : {}),
    ...(ui ? { ui } : {}),
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    ...(typeof obj.author === 'string' ? { author: obj.author } : {}),
  };
  return { ok: true, errors: [], manifest };
}

// ============================================================
// 权限授予策略（src plugins/permissions.ts 原样搬运）
// ============================================================

/** 默认授予（无需人工审批） */
export const DEFAULT_GRANTED_PERMISSIONS: readonly PluginPermission[] = ['fs', 'network'];

/** 执行期强制显式授予的权限（可执行任意进程/命令） */
export const EXECUTION_EXPLICIT_REQUIRED: readonly PluginPermission[] = ['process', 'shell'];

/** 人审层需要宿主显式勾选的权限（含 ui——与 process/shell 同级强制） */
export const REVIEW_EXPLICIT_REQUIRED: readonly PluginPermission[] = ['process', 'shell', 'ui'];

/** manifest 声明的权限中需要宿主显式授予/审查的集合（去重、保序） */
export function requiredGrants(manifest: PluginManifest): PluginPermission[] {
  const declared = new Set(manifest.permissions ?? []);
  return REVIEW_EXPLICIT_REQUIRED.filter((p) => declared.has(p));
}

/** 默认权限 + 显式 grants 的组合（去重；未知权限抛错） */
export function grantPermissions(grants: unknown): PluginPermission[] {
  const extra = Array.isArray(grants) ? grants : [];
  const out = new Set<PluginPermission>(DEFAULT_GRANTED_PERMISSIONS);
  for (const g of extra) {
    if (typeof g !== 'string') continue;
    if (!KNOWN_PERMISSIONS.includes(g as PluginPermission)) {
      throw new Error(`未知权限 "${g}"（可选：${KNOWN_PERMISSIONS.join('/')}）`);
    }
    out.add(g as PluginPermission);
  }
  return [...out];
}

/** manifest 声明了但未被授予的执行期强制权限（空数组 = 全部满足） */
export function missingPermissions(manifest: PluginManifest, allowed: Iterable<PluginPermission> | undefined): PluginPermission[] {
  const granted = new Set(allowed ?? []);
  const missing = (manifest.permissions ?? []).filter(
    (p) => EXECUTION_EXPLICIT_REQUIRED.includes(p) && !granted.has(p),
  );
  if (manifest.ui && !granted.has('ui')) {
    missing.push('ui');
  }
  return missing;
}

/** 装载前权限检查；未通过抛错（列出缺失项） */
export function assertPermissionsGranted(manifest: PluginManifest, allowed: Iterable<PluginPermission> | undefined): void {
  const missing = missingPermissions(manifest, allowed);
  if (missing.length > 0) {
    throw new Error(`插件 "${manifest.name}" 声明了未授予的权限：${missing.join('/')}（请在注册的 grants / 发布 approve 的授予环节中显式授予）`);
  }
}
