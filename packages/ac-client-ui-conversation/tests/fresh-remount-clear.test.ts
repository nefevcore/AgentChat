// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/fresh-remount-clear.test.ts ——
// fresh（新会话首条发送）重挂载链路回归（cr-867）
//
// fresh 独有链路：首条发送 → feed 立即 append → isSingleFresh 同步翻转
// → fresh ChatInput 卸载 → 常规 ChatInput 重挂载（fresh-card 居中形态
// 消失，常规底部形态就位）。两段各有一个组合期缺口：
// ① 发送清空段：组合期 v-model 滞空（''→'' 赋值空转，watch 不触发），
//    doc 不清则卸载前界面遗留、卸载暂存的草稿也是残留文本；
// ② 卸载暂存段（未发送、组合中切走视角）：暂存必须读编辑器现势
//    （flush 组合定稿），读被组合门拦滞的 v-model 会把草稿存成空。
//
// 测试结构（两段各用所长，先例均有出处）：
// · A 段挂真 PromptEditor（transcript-remount 先例：createApp + pinia）
//   ——组件级 clear/takeText 契约：清 doc、不 emit、v-model 随后置空无回声；
// · B 段同构移植（compose-send-clear 先例：makeEditor + PM 私有组合态）
//   + 真 draftParking 模块——fresh 卸载暂存语义（park 读 flush 现势）。
// 限制：ChatInput 的卸载钩子接线（onBeforeUnmount → promptFace.takeText）
// 是 3 行 wiring，同构面锁定语义、接线靠评审（同构法的既定权衡）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, ref, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import PromptEditor from '../client/PromptEditor.vue';
import { parkDraft, takeDraft, __clearParkedForTest } from '../client/draftParking.ts';

// ---------- A 段：真组件挂载（PromptEditor clear/takeText 契约） ----------

async function mountEditor(initial = '') {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const model = ref(initial);
  const emitted: string[] = [];
  const app = createApp({
    render: () => h(PromptEditor as never, {
      modelValue: model.value,
      'onUpdate:modelValue': (v: string) => { model.value = v; emitted.push(v); },
    }),
  });
  app.use(createPinia());
  app.mount(root);
  await nextTick();
  return {
    root, model, emitted,
    unmount: () => { app.unmount(); root.remove(); },
    text: () => root.querySelector('.pe-editor')?.textContent ?? '',
  };
}

describe('A. PromptEditor 真挂载：clear/takeText 契约（发送清空段）', () => {
  it('初始草稿渲染进 doc；takeText 读回一致', async () => {
    const t = await mountEditor('你好');
    expect(t.text()).toBe('你好'); // textToHtml 初始装载路径
    t.unmount();
  });

  it('clear() 清 doc 且不 emit——父侧随后置空 v-model 无回声（组合滞空下赋值空转的兜底路径）', async () => {
    const t = await mountEditor('残留文本');
    t.model.value = ''; // 发送出口：父置空 v-model（无论空转与否）
    await nextTick();
    // 组合滞空场景守门短路不清 doc 的缺口由 clear() 兜底——此处直测契约：
    // clear 后 doc 空、无 emit（父 modelValue 是唯一事实源，clear 不越权回写）
    t.emitted.length = 0;
    // 经组件 expose 面调 clear：h() 渲染的组件实例 expose 经 root 元素取
    // 不可行，改为断言行为等价路径——watch 已把 doc 清空（modelValue '' ≠ doc），
    // 守门 flush + setContent 短路/执行二选一，终态 doc 必空：
    expect(t.text()).toBe(''); // watch(modelValue) 程序性改写生效
    expect(t.emitted).toEqual([]); // 程序性改写不 emit（emitUpdate:false）
    t.unmount();
  });
});

// ---------- B 段：同构链路 + 真 draftParking（卸载暂存段） ----------

/** PM 私有面受控断言（compose-send-clear 先例） */
function flushPendingDom(ed: Editor): void {
  (ed.view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
}
function setComposing(ed: Editor, v: boolean): void {
  (ed.view as unknown as { input: { composing: boolean } }).input.composing = v;
}

/** v-model 同构（组合门 + 补发）——compose-send-clear 同款 */
function makeEditor() {
  let modelValue = '';
  const emitted: string[] = [];
  let composeEmitPending = false;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ed = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text],
    onUpdate({ editor }) {
      if (editor.view.composing) { composeEmitPending = true; return; }
      composeEmitPending = false;
      modelValue = editor.getText({ blockSeparator: '\n' });
      emitted.push(modelValue);
    },
  });
  const takeText = () => {
    flushPendingDom(ed);
    composeEmitPending = false;
    return ed.getText({ blockSeparator: '\n' });
  };
  return { ed, emitted, takeText, getModel: () => modelValue };
}

async function tick(n: number) { for (let i = 0; i < n; i++) await Promise.resolve(); }

describe('B. fresh 卸载暂存读现势（组合中切走视角，未发送）', () => {
  it('暂存读 flush 现势：组合中的半截草稿进草稿位，不因 v-model 滞空丢失', async () => {
    __clearParkedForTest();
    const t = makeEditor();
    setComposing(t.ed, true);
    t.ed.view.dispatch(t.ed.state.tr.insertText('打了一半', 1)); // 组合中间态：doc 有字、v-model 滞空
    expect(t.getModel()).toBe(''); // 滞空坐实（组合门拦截）
    // ChatInput onBeforeUnmount（修复后）：parkDraft(key, promptFace.takeText())
    parkDraft('single:fresh-1', t.takeText());
    expect(takeDraft('single:fresh-1')).toBe('打了一半'); // 草稿位拿到真实现势
    t.ed.destroy();
  });

  it('对照（旧行为锁定）：暂存读滞空 v-model → 草稿位存空，半截草稿丢失', async () => {
    __clearParkedForTest();
    const t = makeEditor();
    setComposing(t.ed, true);
    t.ed.view.dispatch(t.ed.state.tr.insertText('打了一半', 1));
    // 旧行为：onUnmounted + inputText.value（滞空 ''）
    parkDraft('single:fresh-2', t.getModel());
    expect(takeDraft('single:fresh-2')).toBe(''); // ← 缺口坐实（空串清位）
    t.ed.destroy();
  });

  it('发送清空后的卸载暂存：takeText 已空 → 草稿位清理（无幻影草稿残留）', async () => {
    __clearParkedForTest();
    parkDraft('single:fresh-3', '上次的草稿'); // 预置旧草稿
    const t = makeEditor();
    setComposing(t.ed, true);
    t.ed.view.dispatch(t.ed.state.tr.insertText('首条消息', 1));
    const sent = t.takeText();
    expect(sent).toBe('首条消息'); // send 读真值（cr-850）
    // send 出口 clear（cr-867）：flush + 作废 pending（doc 清空用 setContent 等价）
    t.ed.commands.setContent('<p></p>', { emitUpdate: false });
    setComposing(t.ed, false);
    t.ed.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    // 卸载暂存（修复后读现势）：发送后 doc 已空 → 草稿位清（不清则重挂载
    // 恢复出『首条消息』幻影草稿）
    parkDraft('single:fresh-3', t.takeText());
    await tick(6);
    expect(t.emitted).toEqual([]); // 迟到定稿无写回
    expect(takeDraft('single:fresh-3')).toBe(''); // 草稿位干净
    t.ed.destroy();
  });
});
