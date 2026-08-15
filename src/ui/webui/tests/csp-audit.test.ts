// ============================================================
// P5.5 生产 CSP 审计：dist 只允许 self + 内联样式 + 插件 entry 静态资源
// （先 `pnpm --filter @agentchat/webui build` 后运行）
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

function readBuilt(name: string): string | null {
  const file = path.join(__dirname, '..', 'dist', name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function cspOf(html: string): string {
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  if (!match) throw new Error('未找到 CSP meta');
  return match[1];
}

describe('P5.5 生产 CSP 审计', () => {
  it('主 SPA：self script + 内联样式 + ws 连接；无 remote script URL', () => {
    const html = readBuilt('index.html');
    expect(html, '请先构建 @agentchat/webui（pnpm build）').not.toBeNull();
    const csp = cspOf(html!);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("object-src 'none'");
    // 生产入口不能引用外站脚本（插件 entry 是 self /ui-plugin/*）
    const remoteScripts = [...html!.matchAll(/<script[^>]+src="(https?:)?\/\/[^"]+"/g)];
    expect(remoteScripts).toEqual([]);
  });

  it('isolated 容器页：script-src self + default-src none（iframe 内只能经父窗口桥接）', () => {
    const html = readBuilt('ui-plugin-iframe.html');
    expect(html, '请先构建 @agentchat/webui（pnpm build）').not.toBeNull();
    const csp = cspOf(html!);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    // 容器页自身不得内联脚本
    expect(html!).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
  });
});
