// ============================================================
// 历史消息 markdown 渲染耗时基准（1:1 复刻 useMarkdown 管线）
//
// 诊断背景：切会话"卡在正在加载历史消息…"≥1s。useChunkedMarkdown 对
// 非流式（历史）消息同步全量渲染；TurnDisplayItem 思维链用 v-show
// （折叠但挂载）→ 历史页加载时页内全部 thinking/正文/工具输出都在
// 同一次 Vue flush 里同步跑 markdown-it + highlight.js + KaTeX。
// 本基准量化该成本（Node 环境无 DOM patch 开销，测的是渲染字符串
// 本身；浏览器端只会更慢）。
// ============================================================
import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import * as texmathModule from 'markdown-it-texmath';
import katex from 'katex';

// ESM/CJS interop：Vite 下 default = 插件函数；vitest 下具名导出 use
const texmath: any = (texmathModule as any).default?.use ?? (texmathModule as any).use ?? texmathModule;

// ── 复刻 useMarkdown.createBaseInstance + texmath 配置 ──
function createInstance(withKatex: boolean): MarkdownIt {
  const md = new MarkdownIt({
    html: false, linkify: true, breaks: true,
    highlight(str: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(str, { language: lang }).value; } catch { /* fallthrough */ }
      }
      return md.utils.escapeHtml(str);
    },
  });
  md.linkify.set({ fuzzyLink: false });
  if (withKatex) {
    md.use(texmath, {
      engine: katex, delimiters: 'dollars',
      katexOptions: { throwOnError: false, errorColor: '#cc0000', strict: 'ignore' },
    });
  }
  return md;
}
const mdFull = createInstance(true);
const mdPlain = createInstance(false);
const render = (s: string) => mdFull.render(s);      // 正文（含 KaTeX）
const renderPlain = (s: string) => mdPlain.render(s); // thinking（无 KaTeX）

// ── 真实感内容合成 ──
const tsLine = 'const result = await session.query({ from: viewerId, to: agentId, limit, offset }); // 分页查询';
function tsCode(kb: number): string {
  const lines: string[] = [];
  let n = 0;
  while (n < kb * 1024) { const l = `${tsLine} // ${n}`; lines.push(l); n += l.length + 1; }
  return lines.join('\n');
}
const prosePara = '会话历史的加载路径现在经过轮次窗口分页，后端只需扫描尾部窗口即可返回；索引文件在首次跨入归档时惰性构建，构建过程异步进行，不会阻塞查询。';
function prose(kb: number): string {
  const out: string[] = []; let n = 0;
  while (n < kb * 1024) { out.push(prosePara); n += prosePara.length + 2; }
  return out.join('\n\n');
}
function thinking(kb: number, codeKb = 0): string {
  return prose(kb) + (codeKb > 0 ? `\n\n分析这段实现：\n\n\`\`\`typescript\n${tsCode(codeKb)}\n\`\`\`\n` : '');
}
function finalMsg(kb: number, codeKb = 0): string {
  return prose(kb) + (codeKb > 0 ? `\n\n\`\`\`typescript\n${tsCode(codeKb)}\n\`\`\`\n` : '');
}

const ms = (t: number) => `${t.toFixed(0)}ms`;

describe('历史页 markdown 渲染耗时（同步、阻塞主线程）', () => {
  it('单项成本：hljs / markdown-it / katex', () => {
    let t0 = performance.now();
    hljs.highlight(tsCode(30), { language: 'typescript' });
    const hl30 = performance.now() - t0;
    t0 = performance.now();
    hljs.highlight(tsCode(100), { language: 'typescript' });
    const hl100 = performance.now() - t0;
    t0 = performance.now();
    renderPlain(prose(50));
    const md50 = performance.now() - t0;
    t0 = performance.now();
    render(Array.from({ length: 200 }, (_, i) => `$E = mc^${i}$`).join(' ， '));
    const kt200 = performance.now() - t0;
    console.log(`[render] hljs 30KB ts代码 ${ms(hl30)} | hljs 100KB ${ms(hl100)} | md纯文本50KB ${ms(md50)} | katex 200公式 ${ms(kt200)}`);
    expect(true).toBe(true);
  });

  it('整页成本：历史页加载时同一次 flush 内同步渲染的全部内容', () => {
    type Scenario = { label: string; renderAll: () => void; estBytes: number };
    const scenarios: Scenario[] = [
      {
        label: '轻页：5轮×[thinking 6KB, final 2KB]（无代码）',
        estBytes: 5 * 8 * 1024,
        renderAll: () => {
          for (let i = 0; i < 5; i++) { renderPlain(thinking(6)); render(finalMsg(2)); }
        },
      },
      {
        label: 'dev典型：5轮×[2步 thinking 各8KB(含2KB代码), final 3KB+3KB代码]',
        estBytes: 5 * 24 * 1024,
        renderAll: () => {
          for (let i = 0; i < 5; i++) {
            renderPlain(thinking(6, 2)); renderPlain(thinking(6, 2));
            render(finalMsg(3, 3));
          }
        },
      },
      {
        label: 'dev重页：3轮×[2步 thinking 12KB(含6KB代码), 工具输出 20KB代码, final 4KB+8KB代码]',
        estBytes: 3 * 76 * 1024,
        renderAll: () => {
          for (let i = 0; i < 3; i++) {
            renderPlain(thinking(6, 6)); renderPlain(thinking(6, 6));
            render(`\`\`\`typescript\n${tsCode(20)}\n\`\`\``); // ToolResultCode 路径
            render(finalMsg(4, 8));
          }
        },
      },
      {
        label: '极端：单条 final 含 100KB 代码块（粘贴大文件）',
        estBytes: 100 * 1024,
        renderAll: () => { render(finalMsg(2, 100)); },
      },
    ];
    for (const s of scenarios) {
      // 两次取稳态（首次含 JIT/语言注册预热）
      s.renderAll();
      const t0 = performance.now();
      s.renderAll();
      const cost = performance.now() - t0;
      console.log(`[render] ${s.label} ≈ ${(s.estBytes / 1024).toFixed(0)}KB → ${ms(cost)}`);
    }
    expect(true).toBe(true);
  });
});
