// ============================================================
// ac-webui-extensions/src/service.ts —— UI 扩展 slot 注册表（ctx.uiExtensions）
//
// src 前端 slot 白名单机制的 preview 服务化（地图 §3.3 / 资产 #9，
// 与 fiber 语义同构——原样移植）：
//   · 宿主先开口：declareSlot 声明可用 slot（白名单）；行 apply 时
//     声明内置六 slot（src 前端 registry 全集）
//   · 插件后填空：register 校验 slot ∈ 白名单，未声明 → 抛错
//     （fail-closed，代码不进目录）
//   · install 超时守护：def.install 永不 resolve（插件 bug）不得挂起
//     后续注册——15s 超时 → 回滚本条已注册项（src INSTALL_TIMEOUT_MS
//     原样）；单个失败隔离，不影响宿主与其他扩展
//   · 同名替换：同 name 重注册先回收旧条目（disposer 逆序）
//   · isolated 档：不信任扩展不进 slot 注册表（拿不到 slot 填充能力
//     ——src P5.5 sandbox iframe 档的桥接面只有 request/事件订阅；
//     preview 形态 = 只登记清单条目供前端 iframe 宿主发现）
//
// 后端注册表的意义：声明目录 + 声明期校验（比前端自校验更早失败）。
// 前端宿主拉清单后在自己的运行时执行插件 install（前端宿主另有
// 同款超时守护——两层守护语义对齐，src 原样）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';

/** 宿主可声明的 slot 描述 */
export interface UiSlotDef {
  /** slot id（param-case；白名单键） */
  id: string;
  /** 展示名（前端渲染用） */
  label?: string;
  /** slot 说明（插件作者参考） */
  description?: string;
}

/** 插件注册进 slot 的条目（component 等前端载荷后端不解释，透传） */
export interface UiExtensionDef {
  /** 扩展名（= manifest.name；同 name 重注册 = 替换） */
  name: string;
  version: string;
  /** 目标 slot id（须已声明；isolated 条目忽略本字段） */
  slot: string;
  /** 排序（缺省 100；同 order 按注册先后，src 同款稳定排序） */
  order?: number;
  /** 前端载荷（组件描述/入口等；后端透传不解释） */
  payload?: unknown;
  /** 装载初始化（后端执行；永不 resolve 将被超时守护回收） */
  install?: () => void | Promise<void>;
  /** 不信任档：sandbox iframe 隔离——只登记清单，不填 slot */
  isolated?: boolean;
  /** 会话级（重启即失；清单 status 展示用） */
  sessionOnly?: boolean;
}

/** 注册表条目（list 查询形状） */
export interface UiExtensionEntry {
  name: string;
  version: string;
  slot: string;
  order: number;
  payload?: unknown;
  isolated: boolean;
  sessionOnly: boolean;
}

/** install() 超时（src 原样 15s） */
export const INSTALL_TIMEOUT_MS = 15_000;

/** 内置 slot 全集（src 前端 registry：slot.ts 三件 + 三 registry） */
export const BUILTIN_SLOTS: UiSlotDef[] = [
  { id: 'settings-tab', label: '全局设置页签', description: '宿主全局设置页的页签' },
  { id: 'agent-settings-tab', label: 'Agent 设置页签', description: 'Agent 设置页的页签' },
  { id: 'sidebar-action', label: '侧边栏动作', description: '侧边栏的动作按钮' },
  { id: 'perspective', label: '视图透镜', description: '主内容区的视角切换' },
  { id: 'tool-result-view', label: '工具结果视图', description: '按工具名匹配的结果渲染' },
  { id: 'message-view', label: '消息视图', description: '消息条目的自定义渲染' },
];

interface RegisteredEntry extends UiExtensionEntry {
  disposers: Array<() => void>;
}

export class UiExtensionsService extends Service {
  private slots = new Map<string, UiSlotDef>();
  private entries = new Map<string, RegisteredEntry>();

  constructor(ctx: Context) {
    super(ctx, 'uiExtensions');
  }

  /** 宿主开口：声明可用 slot（重复声明 = 幂等更新描述） */
  declareSlot(def: UiSlotDef): () => void {
    this.slots.set(def.id, def);
    return () => {
      // 仅当未被后续声明覆盖时回收
      if (this.slots.get(def.id) === def) this.slots.delete(def.id);
    };
  }

  /** 已声明 slot 清单（插件作者参考 + 前端白名单同步） */
  listSlots(): UiSlotDef[] {
    return [...this.slots.values()];
  }

  /**
   * 插件填空：注册扩展进 slot（须已声明，fail-closed）。
   * install 超时 → 整条回滚并抛错（挂起的插件不得阻塞后续注册）。
   * @returns disposer（手动撤销；同 name 重注册时旧条目先行回收）
   */
  async register(def: UiExtensionDef): Promise<() => void> {
    if (!def.isolated && !this.slots.has(def.slot)) {
      throw new Error(
        `UI 扩展 "${def.name}" 目标 slot "${def.slot}" 未声明（宿主先开口插件后填空；可用：${[...this.slots.keys()].join('/') || '无'}）`,
      );
    }

    // 同名替换：先回收旧条目（disposer 逆序）
    const old = this.entries.get(def.name);
    if (old) {
      this.entries.delete(def.name);
      this.teardown(old);
    }

    const entry: RegisteredEntry = {
      name: def.name,
      version: def.version,
      slot: def.slot,
      order: def.order ?? 100,
      ...(def.payload !== undefined ? { payload: def.payload } : {}),
      isolated: def.isolated ?? false,
      sessionOnly: def.sessionOnly ?? false,
      disposers: [],
    };

    if (def.install) {
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`install() 超时（${INSTALL_TIMEOUT_MS}ms）`)), INSTALL_TIMEOUT_MS);
        entry.disposers.push(() => clearTimeout(to));
        Promise.resolve(def.install!()).then(
          () => {
            clearTimeout(to);
            resolve();
          },
          (err) => {
            clearTimeout(to);
            reject(err);
          },
        );
      }).catch((err) => {
        // 安装中途抛错/超时也可能已注册部分副作用：回滚本条，失败隔离
        this.teardown(entry);
        throw new Error(`UI 扩展 "${def.name}" 安装失败（已回滚）: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    this.entries.set(def.name, entry);
    return () => {
      if (this.entries.get(def.name) === entry) {
        this.entries.delete(def.name);
        this.teardown(entry);
      }
    };
  }

  /** 条目清单（可按 slot 过滤；按 order 升序 + 注册先后稳定排序） */
  list(slot?: string): UiExtensionEntry[] {
    return [...this.entries.values()]
      .filter((e) => (slot === undefined ? true : e.slot === slot))
      .sort((a, b) => a.order - b.order)
      .map(({ disposers: _d, ...rest }) => rest);
  }

  /** 按 name 撤销（返回是否确有撤销） */
  unregister(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    this.entries.delete(name);
    this.teardown(entry);
    return true;
  }

  /** 逆序执行 disposers（src 卸载语义原样；单项异常不阻断） */
  private teardown(entry: RegisteredEntry): void {
    for (let i = entry.disposers.length - 1; i >= 0; i--) {
      try {
        entry.disposers[i]();
      } catch { /* 卸载异常不阻断 */ }
    }
    entry.disposers = [];
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** UI 扩展 slot 注册表（ac-webui-extensions 提供） */
    uiExtensions: UiExtensionsService;
  }
}
