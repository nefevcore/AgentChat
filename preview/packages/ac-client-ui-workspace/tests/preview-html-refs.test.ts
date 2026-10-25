// ============================================================
// ac-client-ui-workspace/tests/preview-html-refs.test.ts ——
// HTML 预览相对引用改写单测（htmlPreviewRefs.ts 纯函数）
//
// 背景：HTML 预览 = <iframe srcdoc> + sandbox="allow-scripts"——
// srcdoc 文档无自身 URL，相对路径按宿主页（应用根 /）解析必 404。
// 改写面：相对 src/srcset → /api/workspace/raw 直链（拼预览文件所在
// 目录 + 读面上下文 query）；<base target="_blank"> 注入（链接外开）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  rewriteHtmlRefs,
  injectBaseTarget,
  preparePreviewHtml,
} from '../client/htmlPreviewRefs.ts';

describe('rewriteHtmlRefs', () => {
  it('相对 src → raw 直链（拼预览文件目录）', () => {
    expect(rewriteHtmlRefs('<img src="_dev/w18.svg" width="64">', 'a/b'))
      .toBe('<img src="/api/workspace/raw?path=a%2Fb%2F_dev%2Fw18.svg" width="64">');
  });

  it('无目录（根级文件）：引用直拼', () => {
    expect(rewriteHtmlRefs('<img src="x.png">', ''))
      .toBe('<img src="/api/workspace/raw?path=x.png">');
  });

  it('../ 段保留原样（服务端 resolveIn 词法归一 + 越界守卫）', () => {
    expect(rewriteHtmlRefs('<img src="../v8.svg">', 'a/b/c'))
      .toBe('<img src="/api/workspace/raw?path=a%2Fb%2Fc%2F..%2Fv8.svg">');
  });

  it('绝对 URL / 协议相对 / data / 锚点 / 根相对不改写', () => {
    const html = '<img src="https://a.b/c.png">'
      + '<img src="//cdn.a.b/c.png">'
      + '<img src="data:image/png;base64,xx">'
      + '<img src="#frag">'
      + '<img src="/root.png">';
    expect(rewriteHtmlRefs(html, 'a/b')).toBe(html);
  });

  it('srcset 多候选改写、描述符保留', () => {
    expect(rewriteHtmlRefs('<source srcset="s.png 1x, t.png 2x">', 'a'))
      .toBe('<source srcset="/api/workspace/raw?path=a%2Fs.png 1x,/api/workspace/raw?path=a%2Ft.png 2x">');
  });

  it('媒体标签 src 均改写；data-src 不动', () => {
    expect(rewriteHtmlRefs('<video src="c.mp4" poster="p.jpg"></video><audio src="a.mp3"></audio><track src="t.vtt">', 'm'))
      .toBe('<video src="/api/workspace/raw?path=m%2Fc.mp4" poster="p.jpg"></video>'
        + '<audio src="/api/workspace/raw?path=m%2Fa.mp3"></audio>'
        + '<track src="/api/workspace/raw?path=m%2Ft.vtt">');
    expect(rewriteHtmlRefs('<img data-src="x.png" src="y.png">', ''))
      .toBe('<img data-src="x.png" src="/api/workspace/raw?path=y.png">');
  });

  it('读面上下文透传（agentId/conversationId 进 query）', () => {
    expect(rewriteHtmlRefs('<img src="x.png">', '', { agentId: 'designer', conversationId: 'c1' }))
      .toBe('<img src="/api/workspace/raw?path=x.png&agentId=designer&conversationId=c1">');
  });
});

describe('injectBaseTarget', () => {
  it('紧跟 <head> 开标签注入', () => {
    expect(injectBaseTarget('<head><meta charset="utf-8"></head>'))
      .toBe('<head><base target="_blank"><meta charset="utf-8"></head>');
  });

  it('无 head 落 <html>；都没有则置顶', () => {
    expect(injectBaseTarget('<html><body></body></html>'))
      .toBe('<html><base target="_blank"><body></body></html>');
    expect(injectBaseTarget('<p>x</p>')).toBe('<base target="_blank"><p>x</p>');
  });

  it('<header> 不误判为 head（词边界）', () => {
    expect(injectBaseTarget('<html><body><header>h</header></body></html>'))
      .toBe('<html><base target="_blank"><body><header>h</header></body></html>');
  });

  it('已有 <base>：尊重作者不改', () => {
    const html = '<head><base href="x/"></head>';
    expect(injectBaseTarget(html)).toBe(html);
  });
});

describe('preparePreviewHtml', () => {
  it('改写 + 注入组合（diagnose.html 场景）', () => {
    const src = '<!doctype html><html><head><title>t</title></head><body><img src="_dev/w18.svg"></body></html>';
    expect(preparePreviewHtml(src, 'workspace/home/files/designer/logo/chipmunk/diagnose.html'))
      .toBe('<!doctype html><html><head><base target="_blank"><title>t</title></head>'
        + '<body><img src="/api/workspace/raw?path=workspace%2Fhome%2Ffiles%2Fdesigner%2Flogo%2Fchipmunk%2F_dev%2Fw18.svg"></body></html>');
  });

  it('反斜杠路径：目录段按两种分隔符取', () => {
    expect(preparePreviewHtml('<img src="p.png">', 'a\\b\\c.html'))
      .toBe('<base target="_blank"><img src="/api/workspace/raw?path=a%5Cb%2Fp.png">');
  });

  it('空内容原样返回', () => {
    expect(preparePreviewHtml('', 'a/b.html')).toBe('');
  });
});
