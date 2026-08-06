// ============================================================
// AppState —— 运行时全局状态（键值字典）
//
// 设计原则：
//   · 键值对形式，方便任意扩展，牺牲类型安全换灵活性
//   · 工具/扩展通过 getAppState() 按键名获取运行时引用
//   · 由 bootstrap 在 Router 创建后调用 setAppState() 初始化
//
// 已知键：
//   registry  AgentRegistry 实例
//   router    AgentRouter 实例
// ============================================================

import { logger } from '@utils/logger';

type State = Record<string, unknown>;

let _state: State | null = null;

/** 由 bootstrap 在 Router/Registry 创建后调用 */
export function setAppState(state: State): void {
  if (_state) {
    logger.warn('[AppState] 已初始化，正在覆盖');
  }
  _state = state;
}

/** 工具/扩展通过此函数获取运行时引用 */
export function getAppState(): State {
  if (!_state) {
    throw new Error(
      '[AppState] 尚未初始化。请确保在 Router/Registry 创建后再调用 getAppState()。'
    );
  }
  return _state;
}
