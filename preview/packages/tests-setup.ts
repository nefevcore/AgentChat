// ============================================================
// tests-setup.ts —— preview vitest 全局 setup（8.5b 第二批）
//
// jsdom 无 matchMedia——垫桩须在测试文件 import 链求值**前**就位
//（markdown-render re-export 面模块级触 useMarkdown→getIsDark→
// window.matchMedia；beforeAll 垫桩晚于 import，不及）。setupFiles
// 由 vitest 保证先跑。主线 clients-theme.test.ts 同款桩形。
// ============================================================
if (typeof window !== 'undefined') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}