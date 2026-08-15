// ============================================================
// @agentchat/agent-config/src/manifest.ts —— 插件 manifest 契约
//
// AgentChat 全局插件（workspace/plugins/<name>/manifest.json）的声明文件。
// 与 cordis 插件对象的对应关系：
//   · manifest.name    = cordis 插件 name = Agent config.presets 的 preset id
//   · manifest.entry   = 插件模块入口（默认 index.ts / index.js）
//   · manifest.inject  = cordis inject 声明（服务依赖，激活排序用）
//
// 铁律：本文件仅类型与纯函数（校验），不 import 运行时服务。
// ============================================================

/** UI slot v1 白名单（宿主先开口，插件后填空；与 @agentchat/protocol 保持一致，但本包零依赖不 import） */
export const UI_SLOT_IDS = [
  'perspective',
  'tool-result',
  'message-view',
  'ws-event',
  'settings-tab:global',
  'settings-tab:agent',
  'sidebar-action',
  'global-style',
] as const;
export type UISlotId = (typeof UI_SLOT_IDS)[number];

/** manifest.ui —— 深度 UI 扩展声明（P5） */
export interface PluginUIManifest {
  /** 浏览器入口（相对插件目录；缺省 ui/dist/index.js） */
  entry?: string;
  /** 额外 CSS（相对插件目录） */
  styles?: string[];
  /** 声明的插槽（白名单，见 UI_SLOT_IDS） */
  slots?: UISlotId[];
  /** true = 在 iframe 隔离容器里运行（受限桥接；P5.5） */
  isolated?: boolean;
}

/** AgentChat 插件 manifest（workspace 插件库 / 动态加载共用） */
export interface PluginManifest {
  /** 插件名（preset id，唯一；小写字母/数字/连字符，如 agentchat-my-tool） */
  name: string;
  /** 语义化版本（semver 形如 1.2.3） */
  version: string;
  /** 模块入口（相对插件目录，默认 index.ts） */
  entry?: string;
  /** 依赖的 ctx 服务（cordis inject 声明；与插件模块导出的 inject 对齐） */
  inject?: string[];
  /** 插件级配置（apply(ctx, config) 第二参数；缺省 {}） */
  config?: Record<string, unknown>;
  /** 声明需要的能力（fs / network / process / shell / ui；process/shell 需宿主显式授予，ui 执行期 gate 在 P5 接入） */
  permissions?: PluginPermission[];
  /** 权威能力声明（可选；注册后与 ToolsService/HooksService 实际 owner 反查合并，声明优先、注册中心补漏） */
  provides?: { tools: string[]; hooks: string[] };
  /** 深度 UI 扩展声明（存在时 permissions 必须包含 ui） */
  ui?: PluginUIManifest;
  /** 描述（UI / 审计） */
  description?: string;
  /** 作者（发布 Agent id 或人工署名） */
  author?: string;
}

/** 全局插件库 registry.json 中的安装记录 */
export interface InstalledPluginRecord {
  /** manifest 快照 */
  manifest: PluginManifest;
  /** 安装目录（相对 plugins 根，如 "my-plugin"） */
  dir: string;
  /** 发布者（Agent id / 用户） */
  owner: string;
  /** 安装时授予的权限快照（启动扫描用；默认 fs/network + 人工 grants） */
  permissions?: PluginPermission[];
  /** 全部文件 SHA-256（发布时计算，审计/完整性） */
  hash: string;
  /** 安装时间（ISO 字符串） */
  installedAt: string;
}

/** 插件库 registry.json 根文档 */
export interface PluginRegistryDoc {
  version: 1;
  plugins: Record<string, InstalledPluginRecord>;
}

/** staging 审查记录（publish_plugin stage 阶段产出） */
export interface PluginStagingRecord {
  /** staging id（approve 时回传） */
  id: string;
  manifest: PluginManifest;
  /** 源目录（workspace 开发目录） */
  sourceDir: string;
  /** 暂存目录 */
  stagedDir: string;
  hash: string;
  owner: string;
  createdAt: string;
  /** 需要宿主显式授予的权限（process/shell；P5 起含 ui） */
  requiredGrants?: PluginPermission[];
}

/** 校验结果 */
export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  manifest?: PluginManifest;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 相对路径守卫：非空、不含 ..、不以 / 或 Windows 盘符开头（保证路径在插件目录内） */
function isValidRelativePath(p: string): boolean {
  return p.trim() !== '' && !p.includes('..') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p);
}

/** 插件可声明的权限词汇表（manifest.permissions 只接受这些值；ui = UI 扩展权限，P1 仅词汇占位） */
export const KNOWN_PERMISSIONS = ['fs', 'network', 'process', 'shell', 'ui'] as const;
export type PluginPermission = (typeof KNOWN_PERMISSIONS)[number];

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
  else if (entry.includes('..') || entry.startsWith('/')) errors.push('entry 必须是插件目录内的相对路径');

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

  let ui: PluginUIManifest | undefined;
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

      let uiSlots: UISlotId[] | undefined;
      if (candidate.slots !== undefined) {
        if (!Array.isArray(candidate.slots) || candidate.slots.some((s) => typeof s !== 'string')) {
          errors.push('ui.slots 必须是字符串数组');
        } else {
          for (const s of candidate.slots as string[]) {
            if (!UI_SLOT_IDS.includes(s as UISlotId)) {
              errors.push(`ui.slots 含未知 slot "${s}"（可选：${UI_SLOT_IDS.join('/')}）`);
            }
          }
          uiSlots = [...new Set(candidate.slots as UISlotId[])];
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

  // P5 gate：manifest.ui 存在时，ui 必须在权限清单里（整包原子装载）
  if (uiDeclared && !(permissions ?? []).includes('ui')) {
    errors.push('manifest.ui 存在时 permissions 必须包含 "ui"');
  }

  let provides: PluginManifest['provides'];
  if (obj.provides !== undefined) {
    const value = obj.provides;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push('provides 必须是 { tools, hooks } 对象');
    } else {
      const candidate = value as Record<string, unknown>;
      let invalid = false;
      for (const key of ['tools', 'hooks'] as const) {
        const list = candidate[key];
        if (list !== undefined && (!Array.isArray(list) || list.some((n) => typeof n !== 'string'))) {
          errors.push(`provides.${key} 必须是字符串数组`);
          invalid = true;
        }
      }
      if (!invalid) {
        provides = {
          tools: Array.isArray(candidate.tools) ? [...new Set(candidate.tools as string[])] : [],
          hooks: Array.isArray(candidate.hooks) ? [...new Set(candidate.hooks as string[])] : [],
        };
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const manifest: PluginManifest = {
    name,
    version,
    entry: entry as string,
    ...(inject ? { inject } : {}),
    ...(config ? { config } : {}),
    ...(permissions ? { permissions } : {}),
    ...(provides ? { provides } : {}),
    ...(ui ? { ui } : {}),
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    ...(typeof obj.author === 'string' ? { author: obj.author } : {}),
  };
  return { ok: true, errors: [], manifest };
}
