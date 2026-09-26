import { describe, it, expect } from 'vitest';
import { extractElements, serializeElements, extractText } from '../src/perceive.ts';
import type { CdpSnapshotDoc } from '../src/protocol.ts';

// strings: 0'html' 1'body' 2'a' 3'button' 4'input' 5'href' 6'https://x' 7'aria-label' 8'提交' 9'placeholder' 10'搜索' 11'Click me' 12'My Page' 13'Hello' 14'Intro' 15'head' 16'title' 17'h1' 18'p'
const S = ['html', 'body', 'a', 'button', 'input', 'href', 'https://x', 'aria-label', '提交', 'placeholder', '搜索', 'Click me', 'My Page', 'Hello', 'Intro', 'head', 'title', 'h1', 'p'];

/** 元素夹具：doc > html > body > [A(text 'Click me'), BUTTON(aria-label 提交), INPUT(placeholder 搜索), BUTTON(无 layout)] */
function elementsFixture(): CdpSnapshotDoc {
  return {
    strings: S,
    documents: [{
      title: 12,
      nodes: {
        // 0:doc(9) 1:html 2:body 3:a 4:'Click me' 5:button 6:input 7:button(无 layout)
        parentIndex: [-1, 0, 1, 2, 3, 2, 2, 2],
        nodeType: [9, 1, 1, 1, 3, 1, 1, 1],
        nodeName: [-1, 0, 1, 2, -1, 3, 4, 3],
        textValue: [-1, -1, -1, -1, 11, -1, -1, -1],
        backendNodeId: [1, 2, 3, 11, 12, 13, 14, 15],
        attributes: [[], [], [], [5, 6], [], [7, 8], [9, 10], []],
      },
      // 文档级布局（nodeIndex[i] → 节点下标；第 7 个 button 不在布局 = 无 layout 被滤）
      layout: {
        nodeIndex: [0, 1, 2, 3, 5, 6],
        bounds: [
          [0, 0, 1280, 720],
          [0, 0, 1280, 720],
          [0, 0, 1280, 720],
          [10, 20, 80, 24],
          [10, 60, 60, 30],
          [10, 100, 200, 30],
        ],
      },
    }],
  };
}

describe('extractElements（扁平索引形态）', () => {
  it('交互元素：视口内 + 有 layout；ref 文档序；text 子节点命名', () => {
    const refs = extractElements(elementsFixture(), { width: 1280, height: 720 });
    expect(refs.map((r) => r.tag)).toEqual(['a', 'button', 'input']);
    expect(refs[0]).toMatchObject({ ref: 1, role: 'link', name: 'Click me', x: 50, y: 32 });
    expect(refs[1]).toMatchObject({ ref: 2, role: 'button', name: '提交' }); // aria-label 优先于（无）文本
    expect(refs[2]).toMatchObject({ ref: 3, tag: 'input', name: '搜索' });
  });

  it('序列化 [n] <tag role name>；隐式 role 省略；无 layout 元素被滤', () => {
    const lines = serializeElements(extractElements(elementsFixture(), { width: 1280, height: 720 }));
    expect(lines).toEqual(['[1] <a role=link> Click me', '[2] <button> 提交', '[3] <input> 搜索']);
  });
});

describe('extractText（扁平索引形态）', () => {
  it('标题 markdown + 段落 + title（HEAD 文本不进正文）；跳过 button 文本', () => {
    // 树: 0:doc 1:html 2:head 3:title 4:text('My Page') 5:body 6:h1 7:text('Hello') 8:p 9:text('Intro') 10:button 11:text('Click me')
    const doc2: CdpSnapshotDoc = {
      strings: S,
      documents: [{
        title: 12,
        nodes: {
          parentIndex: [-1, 0, 1, 2, 3, 1, 5, 6, 5, 8, 5, 10],
          nodeType: [9, 1, 1, 1, 3, 1, 1, 3, 1, 3, 1, 3],
          nodeName: [-1, 0, 15, 16, -1, 1, 17, -1, 18, -1, 3, -1],
          textValue: [-1, -1, -1, -1, 12, -1, -1, 13, -1, 14, -1, 11],
          backendNodeId: new Array(12).fill(0),
          attributes: [[], [], [], [], [], [], [], [], [], [], [], []],
        },
      }],
    };
    const r = extractText(doc2, 8000);
    expect(r.title).toBe('My Page');
    expect(r.text.split('\n')).toEqual(['# Hello', 'Intro']);
  });
});
