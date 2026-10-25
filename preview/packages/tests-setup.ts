// ============================================================
// tests-setup.ts —— preview vitest 全局 setup（8.5b 第二批）
//
// jsdom 无 matchMedia——垫桩须在测试文件 import 链求值**前**就位
//（markdown-render re-export 面模块级触 useMarkdown→getIsDark→
// window.matchMedia；beforeAll 垫桩晚于 import，不及）。setupFiles
// 由 vitest 保证先跑。主线 clients-theme.test.ts 同款桩形。
// ============================================================
// TEMP 锚定（cr-665，leftovers B3）：测试树与测试拉起的子进程（壳/宿主 e2e）
// 不写本机 %TEMP%（cr-593 同域瞬时 EPERM——实时防护占用/沙箱拒写）。产品
// 路径无 %TEMP% 写点（激活锁在数据根、compile-cache 未启用、ui build 已锚
// 包内）；残余风险全在测试进程树，单点在此收口。os.tmpdir() 每次调用现读
// env——worker 与 spawn 子进程均生效。
try {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const tmp = fileURLToPath(new URL('../../sandbox/tmp', import.meta.url));
  fs.mkdirSync(tmp, { recursive: true });
  process.env.TEMP = tmp;
  process.env.TMP = tmp;
} catch { /* 锚定失败回落本机 TEMP——不阻塞测试 */ }

if (typeof window !== 'undefined') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}