// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/compose-send-clear.test.ts ——
// 发送清空 vs 迟到 IME 组合定稿 emit 竞争回归（cr-850）
//
// 场景（用户报告：发送后文本遗留在输入框——消息已发出）：IME 组合期
// v-model 被组合门拦住（inputText = 组合前旧值）；Windows/Android 存在
// 发送 Enter 的 keydown（isComposing=false）先于/紧邻 compositionend 的
// 时序——send 读旧值、清空 modelValue，迟到的组合定稿 emit 随后覆盖
// modelValue，PromptEditor 守门比较 getText()===v 误判 echo 短路
// setContent，文本永久遗留在输入框。
//
// 修复（cr-850，PromptEditor 侧）：
//   · 程序性改写（watch modelValue）前先 domObserver.flush()——把在途
//     组合变异同步上账进 doc，守门与 setContent 基于真实现势；
//   · 发送路径经 takeText()：flush + 作废 pending 补发 + 直读 doc——
//     定稿文本经返回值交调用方消费，不再有迟到的异步 emit 写回。
// 被测链路 = makeEditor 内的 v-model 同构实现（与 compose-final-emit.test
// 同款移植法；setComposing 操纵 PM 私有组合态的先例亦出自该文件）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';

/** PM 私有面受控断言（domObserver.flush 未进类型面，运行时公开——
 * PM 自身 contextmenu/blur 即直调；view.input 同款先例） */
function flushPendingDom(ed: Editor): void {
  (ed.view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
}

/** 父侧 v-model 状态 + PromptEditor 双向链同构（守门 flush / 等值短路 /
 * setContent / takeText 含 pending 作废）——被测逻辑与组件逐句对应。 */
function makeEditor() {
  let modelValue = "";
  const emitted: string[] = [];
  let composeEmitPending = false;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const ed = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text],
    onUpdate({ editor }) {
      if (editor.view.composing) { composeEmitPending = true; return; }
      composeEmitPending = false;
      modelValue = editor.getText({ blockSeparator: "\n" });
      emitted.push(modelValue);
    },
    editorProps: {
      handleDOMEvents: {
        compositionend: () => {
          Promise.resolve().then(() => Promise.resolve().then(() => {
            if (!composeEmitPending) return;
            composeEmitPending = false;
            modelValue = ed.getText({ blockSeparator: "\n" });
            emitted.push(modelValue);
          }));
          return false;
        },
      },
    },
  });
  /** PromptEditor watch(modelValue) 同构（修复本体：flush-first 守门） */
  const applyExternalValue = (v: string) => {
    flushPendingDom(ed);
    if (ed.getText({ blockSeparator: "\n" }) === v) return;
    ed.commands.setContent(textToHtml(v), { emitUpdate: false });
  };
  /** PromptEditor takeText 同构（发送读取面：flush + 作废 pending） */
  const takeText = () => {
    flushPendingDom(ed);
    composeEmitPending = false;
    return ed.getText({ blockSeparator: "\n" });
  };
  return {
    ed, emitted, applyExternalValue, takeText,
    getModel: () => modelValue, setModel: (v: string) => { modelValue = v; },
  };
}

function textToHtml(text: string): string {
  if (text === '') return '<p></p>';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.split('\n').map(l => (l === '' ? '<p><br></p>' : '<p>' + esc(l) + '</p>')).join('');
}

async function tick(n: number) { for (let i = 0; i < n; i++) await Promise.resolve(); }

/** PM 私有组合态操纵（view.input 类型未公开；运行时存在——模拟 IME 组合期时序） */
function setComposing(ed: Editor, v: boolean): void {
  (ed.view as unknown as { input: { composing: boolean } }).input.composing = v;
}

describe('发送清空 vs 迟到 IME 组合定稿（cr-850）', () => {
  it('变体①（keydown 先行，isComposing=false）：flush-first 守门下清空不被定稿覆盖，输入框无遗留', async () => {
    const t = makeEditor();
    setComposing(t.ed, true);
    t.ed.view.dispatch(t.ed.state.tr.insertText("你好", 1)); // 组合中间态（被门拦）
    // —— 用户按 Enter 发送：send 经 takeText 读到定稿文本（flush 后 doc 现势）
    const sent = t.takeText();
    expect(sent).toBe("你好"); // 发出的是用户真实所见（不再丢组合尾巴）
    t.setModel("");
    t.applyExternalValue(""); // 发送清空（修复后：flush 先行）
    // compositionend 迟到到达（怪癖时序）：PM flush 定稿 + 我方两跳补发检查
    setComposing(t.ed, false);
    t.ed.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await tick(6);
    // 断言：无迟到 emit 把旧文本写回、doc 保持空、v-model 保持空
    expect(t.emitted).toEqual([]);
    expect(t.ed.getText({ blockSeparator: "\n" })).toBe("");
    expect(t.getModel()).toBe("");
    t.ed.destroy();
  });

  it('变体②（常规序列：compositionend 先行，PM 微任务 flush 定稿在途）：flush 抢先消费，无重复无遗留', async () => {
    const t = makeEditor();
    setComposing(t.ed, true);
    t.ed.view.dispatch(t.ed.state.tr.insertText("nihao", 1)); // 组合中间态（pending）
    setComposing(t.ed, false);
    t.ed.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    // PM 内置处理已排微任务 flush 定稿（未执行）；此刻用户立刻按 Enter 发送——
    // send 的 takeText 抢先同步 flush：定稿事务立即上账，迟到者变 no-op
    const sent = t.takeText();
    expect(sent).toBe("nihao");
    t.setModel("");
    t.applyExternalValue("");
    await tick(6); // PM 微任务 flush + 我方两跳补发检查全部走完
    expect(t.emitted).toEqual([]); // 迟到 flush no-op（队列已空）+ pending 已作废——无写回
    expect(t.ed.getText({ blockSeparator: "\n" })).toBe("");
    expect(t.getModel()).toBe("");
    t.ed.destroy();
  });

  it('对照（症状锁定）：守门不 flush 的旧行为下，迟到定稿 emit 覆盖清空 → 守门误判 echo 短路 → 文本遗留', async () => {
    const t = makeEditor();
    setComposing(t.ed, true);
    t.ed.view.dispatch(t.ed.state.tr.insertText("你好", 1)); // 组合期（门拦，v-model 滞空）
    // 旧行为：send 读滞后的 modelValue（""）、清空 v-model；守门不 flush
    t.setModel("");
    // 迟到 compositionend：PM flush 定稿 emit —— modelValue 被写回 "你好"
    setComposing(t.ed, false);
    t.ed.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await tick(6);
    expect(t.emitted).toEqual(["你好"]);
    // 旧守门：getText()（doc 现势 "你好"）=== modelValue（"你好"）→ 短路，不清 DOM
    expect(t.getModel()).toBe("你好");
    expect(t.ed.getText({ blockSeparator: "\n" })).toBe("你好"); // ← 遗留坐实
    t.ed.destroy();
  });

  it('守门 flush 不误伤常规程序性改写（非组合态恢复草稿照常 setContent）', async () => {
    const t = makeEditor();
    t.applyExternalValue("草稿");
    expect(t.ed.getText({ blockSeparator: "\n" })).toBe("草稿");
    expect(t.emitted).toEqual([]); // 程序性改写不 emit（emitUpdate:false + flush 无变异）
    t.ed.destroy();
  });
});
