// ============================================================
// receipt.ts —— 回执两轴（cr-903 / cr-901 v2.1 批2 切片二 §4.5）
//
// install-result（applied / failed / needs-reinstall）× effective-state
//（live / restart-required / overridden / blocked-by-live-process）。
// 「装了但没生效」不可能静默：生效轴显式回报，联动 activation.lock
//（活壳在场 = 新装配 boot 装载，恒 restart-required；Windows 文件占用
//（EPERM/EBUSY）显式归 blocked-by-live-process，不冒充 failed）。
//
// 纯求值器：活进程清单由调用方探活后传入（数据根扫描住宿主/安装器
// 编排层——纯库不做进程探测）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pluginsRoot, readRegistry } from './store.ts';

/** 安装结果轴 */
export type InstallResultAxis = 'applied' | 'failed' | 'needs-reinstall';

/** 生效状态轴（per 进程种类） */
export type EffectiveStateAxis = 'live' | 'restart-required' | 'overridden' | 'blocked-by-live-process';

/** 进程种类（§4.7 注册表词汇；安装回执面用 host/shell/webui 三词） */
export type ProcKind = 'host' | 'shell' | 'webui';

/** 活进程描述（探活由调用方完成） */
export interface LiveProcess {
  kind: ProcKind;
  pid: number;
}

/**
 * 生效状态求值（纯函数；优先级 blocked > overridden > restart-required
 * > live）：
 *   · blocked——物化撞活进程文件占用（Windows EPERM/EBUSY，安装器捕获
 *     后显式标注——等待中的重试/重启属恢复面，不冒充 failed）；
 *   · overridden——custom 层 disable 命中（装了但被用户偏好停用）；
 *   · restart-required——目标进程种类有活实例（动态行恒 boot 装载）；
 *   · live——无活实例：下次启动即装载（对安装者即「已生效」）。
 */
export function effectiveStateOf(input: {
  scope: ProcKind;
  liveProcesses: LiveProcess[];
  overridden?: boolean;
  blocked?: boolean;
}): EffectiveStateAxis {
  if (input.blocked === true) return 'blocked-by-live-process';
  if (input.overridden === true) return 'overridden';
  if (input.liveProcesses.some((p) => p.kind === input.scope)) return 'restart-required';
  return 'live';
}

/**
 * needs-reinstall 求值（备份口径恢复钩子）：registry 有记录但物化目录
 * 缺席（npm 形态 node_modules 重装 / 目录形态 plugins/<name>/ 丢失）。
 */
export function needsReinstallOf(root: string, name: string): boolean {
  try {
    const record = readRegistry(root).plugins[name];
    if (record === undefined) return false;
    return !fs.existsSync(path.join(pluginsRoot(root), record.dir));
  } catch {
    return false;
  }
}
