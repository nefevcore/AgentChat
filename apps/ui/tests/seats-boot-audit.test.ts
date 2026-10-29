// @vitest-environment jsdom
// ============================================================
// seats-boot-audit.test.ts —— 29 通道全装运行时对账门（cr-798）
//
// 与 seats-gate.test.ts（静态扫描门）互补的运行时门：全通道按 boot graph
// 真装载（jsdom），断言 seatAudit 零漂移——锁定 auditSeats 双轴满足判定
// （即时贡献 diff + 窗口内新挂起的 inject 待声明效果）。
//
// cr-798 缺陷回归面：todo 行 cr-454 引入 slots.inject 惰性注册形态后，
// 声明方通道装载序在后的 13 域行被误判 declaredNotRegistered 假阳性。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bootUiClient } from '../client/boot.ts';
import { conversationClientPlugin } from 'ac-client-ui-conversation/client';
import { toolClientPlugin } from 'ac-client-ui-tool/client';
import { settingsClientPlugin } from 'ac-client-ui-settings/client';
import { markdownRenderPlugin } from '../channel/markdown-render/src/index.ts';
import type { BootGraphEntry } from 'ac-webui-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

function entry(name: string, over: Partial<BootGraphEntry> = {}): BootGraphEntry {
  return { name, version: '1.0.0', platform: 'web', base: '/ui-plugin/' + name + '/', entry: 'ui/index.js', styles: [], seats: [], isolated: false, channelImports: [], ...over };
}

// 通道名 → 主线包说明符（通道包 = re-export 主线 clientPlugin；jsdom 内
// 直接动态 import 主线包等价装载）
const MAINLINE: Record<string, string> = {
  conversation: 'ac-client-ui-conversation/client',
  tool: 'ac-client-ui-tool/client',
  settings: 'ac-client-ui-settings/client',
  runview: 'ac-client-ui-runview/client', workspace: 'ac-client-ui-workspace/client',
  singles: 'ac-client-ui-singles/client', group: 'ac-client-ui-group/client',
  agents: 'ac-client-ui-agents/client', usage: 'ac-client-ui-usage/client',
  system: 'ac-client-ui-system/client', timer: 'ac-client-ui-timer/client',
  shell: 'ac-client-ui-shell/client', fs: 'ac-client-ui-fs/client',
  web: 'ac-client-ui-web/client', browser: 'ac-client-ui-browser/client',
  subagent: 'ac-client-ui-subagent/client', 'run-code': 'ac-client-ui-run-code/client',
  'run-nodes': 'ac-client-ui-run-nodes/client', 'llm-pool': 'ac-client-ui-llm-pool/client',
  'plugin-registry': 'ac-client-ui-plugin-registry/client', 'search-pool': 'ac-client-ui-search-pool/client',
  onboarding: 'ac-client-ui-onboarding/client', remote: 'ac-client-ui-remote/client',
  todo: 'ac-client-ui-todo/client', jobs: 'ac-client-ui-jobs/client',
  goal: 'ac-client-ui-goal/client', skill: 'ac-client-ui-skill/client',
  'desktop-storage': 'ac-client-ui-desktop-storage/client',
};

describe('cr-798 · 29 通道全装运行时对账', () => {
  it('全通道真装载 → seatAudit 零漂移零 err', async () => {
    setActivePinia(createPinia());
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const channelRoot = path.join(repoRoot, 'apps', 'ui', 'channel');
    const graph: BootGraphEntry[] = [];
    for (const e of fs.readdirSync(channelRoot, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const m = JSON.parse(fs.readFileSync(path.join(channelRoot, e.name, 'manifest.json'), 'utf-8'));
      graph.push(entry(m.name, { seats: m.seats ?? [] }));
    }
    const builtin: Record<string, unknown> = {
      conversation: conversationClientPlugin,
      tool: toolClientPlugin,
      settings: settingsClientPlugin,
      'markdown-render': markdownRenderPlugin,
    };
    const { channel, seatAudit } = await bootUiClient({
      rpcWire: {
        call: async <T,>(_m: string) => null as T,
        onEvent: () => () => { /* 桩 */ },
        onOpen: () => () => { /* 桩 */ },
        onAck: () => () => { /* 桩 */ },
        onClose: () => () => { /* 桩 */ },
        connected: () => true,
      },
      fetchGraph: async () => graph,
      loadChannel: async (e) => {
        if (builtin[e.name]) return { default: builtin[e.name] };
        const mod = await import(/* @vite-ignore */ MAINLINE[e.name]!);
        return { default: mod.default };
      },
    });
    const errs = [...channel.entries()].filter(([, v]) => v === 'err').map(([k]) => k);
    const drift = [...seatAudit.entries()]
      .filter(([, r]) => r.declaredNotRegistered.length > 0 || r.registeredNotDeclared.length > 0)
      .map(([k, r]) => k + ': ' + JSON.stringify(r));
    expect(errs, '装载失败条目: ' + errs.join(', ')).toEqual([]);
    expect(drift, '对账漂移:\n' + drift.join('\n')).toEqual([]);
  }, 120_000);
});
