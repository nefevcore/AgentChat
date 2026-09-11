// @vitest-environment jsdom
// ============================================================
// webui/tests/slot-catalog.test.ts —— D13 公开子集校验 + D8 收窄验收
//
// · 桥注册前校验（assertDeclarableSlot）：未声明 / 席位未公开 /
//   席位未声明 → 拒绝且可诊断；真 boot 六席全过（公开子集在场）。
// · D8 静态断言：webui 内部无旧注册面直用（bridge 外零调用——
//   组件类六项唯一入口 = bridge 纯转发；内置批次走 slots 直注册）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'ac-client-runtime';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { resetClientRuntime, setClientRuntime } from '../src/runtime/clientRuntime';
import {
  assertDeclarableSlot,
  highRiskOf,
  COMPONENT_CLASS_SLOTS,
} from '../src/core/extensions/slotCatalog';

const DESC = (slots: string[]) => ({ name: 'probe-plugin', slots: slots as never[] });

describe('D13 开口策略 · assertDeclarableSlot（公开子集校验）', () => {
  it('未在 manifest 声明 → 拒绝（运行时不超声明）', async () => {
    await bootWebuiRuntime();
    expect(() => assertDeclarableSlot(DESC([]), 'perspective')).toThrowError(/未在 manifest\.ui\.slots 中声明/);
  });

  it('席位未在账本声明 / 未公开 → 拒绝且可诊断（公开子集 fail-closed）', async () => {
    // 裸客户端运行时：席位未声明 → 拒绝
    const bare = await createClient();
    setClientRuntime(bare);
    expect(() => assertDeclarableSlot(DESC(['perspective']), 'perspective')).toThrowError(/未在声明账本中 declare/);

    // 席位已声明但非 public → 拒绝
    bare.slots.declare({ key: 'main:perspective', kind: 'single' });
    expect(() => assertDeclarableSlot(DESC(['perspective']), 'perspective')).toThrowError(/未公开（public 子集之外）/);

    // 常设通道（ws-event / global-style）不受席位裁可（授权照旧）
    expect(() => assertDeclarableSlot(DESC(['ws-event']), 'ws-event')).not.toThrow();
    expect(() => assertDeclarableSlot(DESC(['global-style']), 'global-style')).not.toThrow();
    resetClientRuntime();
  });

  it('真 boot：组件类六项全过公开子集（既有第三方 manifest 永久可装载）', async () => {
    await bootWebuiRuntime();
    for (const id of COMPONENT_CLASS_SLOTS) {
      expect(() => assertDeclarableSlot(DESC([id]), id), id).not.toThrow();
    }
  });

  it('highRiskOf：⚠ 名单镜像（perspective 整面板替换）', () => {
    expect(highRiskOf(undefined)).toEqual([]);
    expect(highRiskOf(['tool-result'])).toEqual([]);
    expect(highRiskOf(['perspective', 'message-view'])).toEqual(['perspective']);
  });
});

// ------------------------------------------------------------
// D8 静态断言：webui 内部无旧注册面直用
// ------------------------------------------------------------

const WEBUI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 递归收集 .ts/.vue 文件 */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (/\.(ts|vue)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('D8 收窄 · 内部无旧注册面直用（bridge = 唯一转发入口）', () => {
  it('registerXxx 六件仅 bridge.ts 与定义模块调用（其余内部零直用）', () => {
    const legacyFns = [
      'registerPerspective',
      'registerMessageView',
      'registerToolResultView',
      'registerSettingsTab',
      'registerAgentSettingsTab',
      'registerActivityBarAction',
    ];
    const allowed = [
      // 转发本体（bridge）、API 面声明（types.ts 接口方法）与定义模块（解析面自用/回落分支）
      join('core', 'extensions', 'bridge.ts'),
      join('core', 'extensions', 'types.ts'),
      join('core', 'registry', 'perspectives.ts'),
      join('core', 'registry', 'messageViews.ts'),
      join('core', 'registry', 'toolResultViews.ts'),
      join('core', 'extensions', 'slots.ts'),
    ];
    const offenders: string[] = [];
    for (const file of collectFiles(WEBUI_SRC)) {
      const rel = file.slice(WEBUI_SRC.length + 1).replace(/\\/g, '/');
      if (allowed.some((a) => rel.endsWith(a.replace(/\\/g, '/')))) continue;
      const src = readFileSync(file, 'utf8');
      for (const fn of legacyFns) {
        // 调用形态（排除 import type / 注释里的词形对齐：只匹配 '(' 调用）
        const re = new RegExp(`(?<![\\w.'])${fn}\\s*\\(`, 'g');
        const hits = src.match(re);
        if (hits) offenders.push(`${rel}: ${fn} ×${hits.length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
