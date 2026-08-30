// ============================================================
// src/agents/paths.ts —— 会话键纯函数（re-export，正典已下沉契约层）
//
// 会话键构造/解析是全栈共享的底层语义（toolkit/tools/server/archive 等
// 12+ 包消费），正典定义见 @agentchat/contracts/dialog.ts（2026-08-20
// 下沉，消除低层包对 agents 的向上依赖）。本模块保留 re-export：
//   · L2 router 构造 dialogKey 直接消费本模块（既有导入不动）
//   · 新代码一律从 @agentchat/contracts 引入
//   · 纯文件路径函数见 @agentchat/toolkit（依赖契约层键函数）
// ============================================================

export {
  DIALOG_SEP, chatDialogKey, groupDialogKey, singleDialogKey,
  isGroupDialog, isSingleDialog, sessionIdOfDialog, lastSegmentOf,
  groupIdOfDialog, counterpartOfDialog, yearWeek,
} from '@agentchat/contracts';
