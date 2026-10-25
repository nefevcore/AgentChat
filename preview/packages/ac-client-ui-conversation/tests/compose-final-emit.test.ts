// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/compose-final-emit.test.ts ——
// 短 IME 组合（…… 直出标点类）定稿 emit 补发回归
//
// 场景（2026-12-00 用户报告：输入框无法发送六个点的省略号）：
// 短组合的定稿 DOM 变更可被 MutationObserver 在 compositionend 之前 flush
// 成事务（composing 仍 true）——onUpdate 组合门拦下 emit 后无人补发，
// v-model 永久滞留旧值：界面显示文字、数据层为空，发送按钮灰死。
// 修复 = 组合门拦 emit 时置 pending，compositionend 后两跳微任务补发定稿。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';

/** PromptEditor 的 onUpdate 门 + compositionend 补发（被测逻辑同构移植） */
function makeEditor() {
  const emitted: string[] = [];
  let composeEmitPending = false;
  const ed = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: [Document, Paragraph, Text],
    onUpdate({ editor }) {
      if (editor.view.composing) { composeEmitPending = true; return; }
      composeEmitPending = false;
      emitted.push(editor.getText({ blockSeparator: '\n' }));
    },
    editorProps: {
      handleDOMEvents: {
        compositionend: () => {
          Promise.resolve().then(() => Promise.resolve().then(() => {
            if (!composeEmitPending) return;
            composeEmitPending = false;
            emitted.push(ed.getText({ blockSeparator: '\n' }));
          }));
          return false;
        },
      },
    },
  });
  return { ed, emitted };
}

async function tick(n: number) { for (let i = 0; i < n; i++) await Promise.resolve(); }

/** PM 私有组合态操纵（view.input 类型未公开；运行时存在——模拟 IME 组合期时序） */
function setComposing(ed: Editor, v: boolean): void {
  (ed.view as unknown as { input: { composing: boolean } }).input.composing = v;
}


describe('短 IME 组合定稿 emit 补发', () => {
  it('定稿事务早于 compositionend（…… 直出序列）：compositionend 后补发定稿', async () => {
    const { ed, emitted } = makeEditor();
    setComposing(ed, true);
    ed.view.dispatch(ed.state.tr.insertText('……', 1)); // 组合期定稿上账（被门拦）
    ed.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await tick(5);
    expect(emitted).toEqual(['……']); // 修复前为 []——v-model 滞空，发不出
    ed.destroy();
  });

  it('常规序列（compositionend 后内置 flush 定稿）：仅一次定稿 emit，无中间态无重复', async () => {
    const { ed, emitted } = makeEditor();
    setComposing(ed, true);
    ed.view.dispatch(ed.state.tr.insertText('nihao', 1)); // 组合中间态（被拦，pending 置位）
    // compositionend：我们监听先排两跳检查；PM 内置清 composing + 一跳 flush dispatch 定稿
    ed.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    setComposing(ed, false);
    Promise.resolve().then(() => {
      ed.view.dispatch(ed.state.tr.insertText('你好', 1, 1 + 5)); // 定稿（composing=false 正常 emit，清 pending）
    });
    await tick(6);
    expect(emitted).toEqual(['你好']);
    ed.destroy();
  });

  it('多段组合连续定稿：每段各自补发，无丢失无重复', async () => {
    const { ed, emitted } = makeEditor();
    for (let round = 0; round < 2; round++) {
      setComposing(ed, true);
      ed.view.dispatch(ed.state.tr.insertText('……', 1 + round * 2));
      ed.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await tick(5);
    }
    expect(emitted).toEqual(['……', '…………']);
    ed.destroy();
  });
});
