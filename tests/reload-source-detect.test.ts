// ============================================================
// reload 插件源码变更检测单元测试
//
// 背景（2026-08-12 二次分析）：reload 只重载配置、不重载插件源码。
// 为避免 Agent 改完 src/plugins/ 代码后调 reload「静默不生效」，
// makeReloadTool 在 global/all 范围检测进程启动后的插件源码改动并提示。
// 本测试覆盖 findChangedPluginSources 的检出逻辑。
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { findChangedPluginSources } from '@plugins/builtin/tools/app';

describe('findChangedPluginSources（reload 插件源码变更检测）', () => {
  const root = path.join(tmpdir(), `agentchat-reload-src-${Date.now()}`);
  const future = Date.now() + 60_000; // 晚于进程启动（模块加载时刻）

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('进程启动后改动的插件源码被检出（返回相对路径）', () => {
    const file = path.join(root, 'src', 'plugins', 'builtin', 'tools', 'demo.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export {}');
    fs.utimesSync(file, new Date(future), new Date(future));
    expect(findChangedPluginSources(root)).toEqual([path.relative(root, file)]);
  });

  it('进程启动前的旧文件不被检出', () => {
    const old = path.join(root, 'src', 'plugins', 'builtin', 'tools', 'old.ts');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, 'export {}');
    fs.utimesSync(old, new Date(0), new Date(0));
    expect(findChangedPluginSources(root)).toEqual([]);
  });

  it('src/plugins 之外的源码改动不涉及（不被检出）', () => {
    const out = path.join(root, 'src', 'core', 'x.ts');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'export {}');
    fs.utimesSync(out, new Date(future), new Date(future));
    expect(findChangedPluginSources(root)).toEqual([]);
  });

  it('src/plugins 目录不存在时静默返回空', () => {
    expect(findChangedPluginSources(root)).toEqual([]);
  });
});
