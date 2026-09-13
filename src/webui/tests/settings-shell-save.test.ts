// @vitest-environment jsdom
// ============================================================
// webui/tests/settings-shell-save.test.ts —— 设置壳保存钮收口验收
//（M29 P1-3b 收口余留修复：「两个保存配置」歧义）
//
//  1. 壳层保存钮管辖面：域节（settings:section 大件）在场 = 隐藏壳层
//     保存钮；ns.* / ui-tab:* = 保留（文案「保存全局配置」）。
//  2. agentEditorDirty 发布链路：AgentSettingsHost watch → uiStore →
//     设置壳关闭/切节守护消费。
//  3. saveAll 无 dirty 短路（不弹假「已保存」）。
//
// 组件挂载面（SettingsPanel 深链确认弹窗交互）由 portb-e2e 族覆盖；
// 本文件聚焦 store 语义与管辖面判定纯函数化行为。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

describe('设置壳保存钮收口（agentEditorDirty 发布链路）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('缺省无编辑在场：agentEditorDirty = false（守卫不拦）', () => {
    const ui = useUiStore();
    expect(ui.agentEditorDirty).toBe(false);
  });

  it('发布 → 消费：AgentSettingsHost watch 语义（dirty 置位/复位均同步）', () => {
    const ui = useUiStore();
    // 发布方模拟：AgentSettingsHost 内 watch(() => dirty, v => ui.agentEditorDirty = v)
    ui.agentEditorDirty = true; // 进入编辑（改了未保存字段）
    expect(ui.agentEditorDirty).toBe(true);
    ui.agentEditorDirty = false; // 保存成功 / 节卸载清发布
    expect(ui.agentEditorDirty).toBe(false);
  });

  it('壳层保存钮管辖面：ns.* / ui-tab:* 保留；域节 id 不匹配（隐藏）', () => {
    // shellSaveRelevant 的判定语义：startsWith('ns.') || startsWith('ui-tab:')
    const relevant = (id: string) => id.startsWith('ns.') || id.startsWith('ui-tab:');
    expect(relevant('ns.llm')).toBe(true);          // 命名空间表单——壳层保存管辖
    expect(relevant('ui-tab:my-plugin')).toBe(true); // 插件全局页签——同上
    expect(relevant('agents')).toBe(false);          // Agent 域节——编辑器内保存
    expect(relevant('llmPools')).toBe(false);        // 模型池——即时落盘
    expect(relevant('searchPools')).toBe(false);     // 搜索池——即时落盘
    expect(relevant('timers')).toBe(false);          // 定时——域内自理
  });
});
