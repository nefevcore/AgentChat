// ============================================================
// utils/undoRedo.ts —— PromptEditor 的 undo/redo 扩展（自建）
//
// 官方 @tiptap/extension-undo-redo 不在本仓依赖集（registry 未收录），
// 故以 @tiptap/pm/history（prosemirror-history 1.5 的官方代理）等价自建：
//   · 键位：Mod-z 撤销 / Mod-Shift-z、Mod-y 重做（Mod = Ctrl|Cmd）；
//   · 编辑/粘贴/mention 替换均进栈（400ms 邻接聚组）；
//   · 程序性整体重写（发送清空/草稿恢复）在 PromptEditor 侧以
//     addToHistory:false 事务直通（官方 focus/blur 事务同款）——不进栈，
//     跨消息状态不可被 Ctrl+Z 撤回。
// ============================================================
import { Extension } from '@tiptap/core';
import { history, undo, redo, undoDepth, redoDepth } from '@tiptap/pm/history';
import type { EditorState, Transaction } from '@tiptap/pm/state';

// 命令声明合并（官方扩展同款）：undo/redo 进入全局 Commands 接口后，
// editor.commands.undo() 调用点（其他 ts 文件）即通过类型检查
declare module '@tiptap/core' {
  interface Commands<ReturnType = any> {
    undo: () => ReturnType;
    redo: () => ReturnType;
  }
}

/** 找到 history 插件在当前 editor state 里的 meta key（'history$N'，N 为
 *  PluginKey 全局序号——按 key 前缀从 plugin 实例反查，不依赖序号猜测） */
function historyPluginKey(state: EditorState): string | null {
  for (const p of state.plugins) {
    const k = (p as unknown as { key?: string }).key;
    if (typeof k === 'string' && k.startsWith('history$')) return k;
  }
  return null;
}

/** 取 history 插件的当前状态（含 done/undone 两个 Branch 与分组游标） */
function historyStateOf(state: EditorState): { done: { eventCount: number; constructor: { empty: unknown } }; undone: { eventCount: number } } | null {
  const key = historyPluginKey(state);
  if (!key) return null;
  return (state as unknown as Record<string, unknown>)[key] as never;
}

/** 程序性清空 undo/redo 栈（发送清空/草稿恢复后调用）：上一条消息的
 *  编辑史不可被下一条的 Ctrl+Z 撤回（对齐旧 textarea：程序性重置打断
 *  原生栈）。实现 = 以 historyKey meta 整体替换插件状态为空态——
 *  prosemirror-history apply 首行对带 meta 的事务直接采用所给 historyState。 */
export function clearChatHistory(ed: { state: EditorState; view: { dispatch: (tr: Transaction) => void } }): void {
  const hist = historyStateOf(ed.state);
  if (!hist) return;
  if (undoDepth(ed.state) === 0 && redoDepth(ed.state) === 0) return; // 空栈无痕直通
  // 空态：Branch.empty 单例（经 done.constructor 反查，不 import 内部类）
  const BranchCtor = hist.done.constructor as { empty: unknown };
  const empty = BranchCtor.empty;
  const fresh = { done: empty, undone: empty, prevRanges: null, prevTime: 0, prevComposition: -1 };
  const tr = ed.state.tr.setMeta(historyPluginKey(ed.state) as string, { historyState: fresh });
  ed.view.dispatch(tr);
}

export const ChatUndoRedo = Extension.create({
  name: 'chatUndoRedo',
  addOptions() {
    return { depth: 200, newGroupDelay: 400 };
  },
  addKeyboardShortcuts() {
    // this.editor.commands 在 Extension.create 泛型 this 下无 augmentation（同文件内
    // 合并不进泛型推导），故经 commands.command 直调底层命令（官方键位表等价）
    return {
      'Mod-z': () => this.editor.commands.command(({ state, dispatch }) => undo(state, dispatch)),
      'Mod-shift-z': () => this.editor.commands.command(({ state, dispatch }) => redo(state, dispatch)),
      'Mod-y': () => this.editor.commands.command(({ state, dispatch }) => redo(state, dispatch)),
    };
  },
  addCommands() {
    // 返回值经 any 放行：同文件 augmentation 不进泛型约束检查（约束求值早于合并
    // 可见）；消费方侧 augmentation 生效，commands.undo() 类型完整
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmds: any = {
      undo: () => ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) =>
        undo(state, dispatch),
      redo: () => ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) =>
        redo(state, dispatch),
    };
    return cmds;
  },
  addProseMirrorPlugins() {
    const { depth, newGroupDelay } = this.options;
    return [history({ depth, newGroupDelay })];
  },
});
