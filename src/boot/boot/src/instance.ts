// ============================================================
// @agentchat/boot/src/instance.ts —— boot 侧 profile holder
//
// workspace 运行时标识（.runtime：获取/发现/更新/释放/迁移 shim）已下沉
// @agentchat/toolkit/runtime.ts（timer 与 boot 共用，避免 boot→timer 反向环）。
// 本模块只保留 boot 域自己的东西：本次 boot 的组合 profile 传递。
//
// cordis Context 代理对未注入属性的读取直接抛错（"cannot get property
// without inject"），不能在 finalize 里 (ctx as any).cmdlineArgs?.profile
// 可选链读取——loader-boot（有 --profile）在 boot 前写入这里，直调
// bootstrap 路径缺省 web-app。
// ============================================================
import { workspaceRoot } from '@agentchat/toolkit';

/** 缺省 workspace（解析链单一事实源在 @agentchat/toolkit：env → cwd 已有 → 机器 home） */
export function defaultWorkspaceDir(): string {
  return workspaceRoot();
}

let currentBootProfile = 'web-app';

/** 记录本次 boot 的组合 profile（loader-boot --profile / 缺省 web-app） */
export function setBootProfile(profile: string): void {
  currentBootProfile = profile;
}

/** 读取本次 boot 的组合 profile */
export function bootProfile(): string {
  return currentBootProfile;
}
