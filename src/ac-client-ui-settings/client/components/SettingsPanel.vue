<script setup lang="ts">
// ============================================================
// SettingsPanel.vue —— 统一设置面板（替代 GlobalSettings + AgentSettings）
// 纯壳：左树（叶自 settings:section 席位派生）+ 节选举 + 全局保存编排
// 数据：schema 驱动；展示 effective、编辑 raw
// ============================================================
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useSettings } from '../useSettings.ts';
import { Button, Icon, StatusDot, toastOk } from '@agentchat/webui-kit';
import NsFieldList from './NsFieldList.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { sortedSettingsTabs, resolveTabProps } from '../extensionTabs.ts';
import { deriveSectionLeaves } from '../sectionTree.ts';
import { useClientContext } from 'ac-client-runtime';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import type { SlotEntry } from 'ac-client-slots';

const props = defineProps<{ visible: boolean; initialAgentId?: string; initialSection?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const settings = useSettings();
const clientCtx = useClientContext();
const ui = useUiStore();

// ── 状态 ──
const selectedNode = ref('agents');
const saving = ref(false);
const restarting = ref(false);
const errorText = computed(() => settings.error.value);

// ── 树（2026-11 左树数据化）：域行叶自 settings:section 席位条目派生
//    （贡献 meta.section/meta.label + 顶层 order，见 sectionTree.ts），
//    动态全局插件页签（settings-tab:global）order 升序追加其后 ──
type TreeNode = { id: string; label: string };

// settings:section 版本计数轴（D14）：声明/注册/撤销/退位均递增——
// 左树叶与右区节选举共用的响应式锚（域行装卸 → 叶/节即时出现/消失）
const sectionVersion = ref(clientCtx?.slots.version('settings:section') ?? 0);
const offSectionSlot = clientCtx?.on('slots/changed', (key: string) => {
  if (key === 'settings:section') sectionVersion.value++;
});
onBeforeUnmount(() => offSectionSlot?.());

const sectionEntries = computed<readonly SlotEntry[]>(() => {
  void sectionVersion.value; // 依赖锚
  return clientCtx?.slots.entries('settings:section') ?? [];
});

const tree = computed<TreeNode[]>(() => [
  ...deriveSectionLeaves(sectionEntries.value),
  ...sortedSettingsTabs.value.map(tab => ({ id: `ui-tab:${tab.id}`, label: tab.label })),
]);

// 默认选中守卫：选中叶不在场（行卸载 / 初始默认缺席）→ 回落偏好叶
// （agents——壳 UX 偏好常量，非域知识）否则首叶；深链
// initialSection/initialAgentId 经 visible watch 置位，叶在场时不被覆盖
watch(tree, (nodes) => {
  if (nodes.some(n => n.id === selectedNode.value)) return;
  selectedNode.value = nodes.find(n => n.id === 'agents')?.id ?? nodes[0]?.id ?? '';
}, { immediate: true });

/** 当前选中的插件全局设置页签（若 selectedNode 命中 ui-tab:*） */
const currentPluginSettingsTab = computed(() => {
  if (!selectedNode.value.startsWith('ui-tab:')) return null;
  return sortedSettingsTabs.value.find(t => `ui-tab:${t.id}` === selectedNode.value) ?? null;
});

const globalPluginTabProps = computed<Record<string, unknown>>(() => {
  const tab = currentPluginSettingsTab.value;
  if (!tab) return {};
  return resolveTabProps(tab, {
    globalConfig: settings.globalConfig.value,
    nsSchemas: settings.nsSchemas.value,
    pools: settings.pools.value,
  });
});

const currentTitle = computed(() => tree.value.find(n => n.id === selectedNode.value)?.label ?? '');

function selectNode(id: string) {
  // 节切换守护：正在编辑的 Agent 有未保存编辑时先确认——节宿主卸载即
  // resetAgent（「已放弃」的编辑不复活），不拦会静默丢失（与关闭守护同款）
  if (id !== selectedNode.value && ui.agentEditorDirty) {
    void confirmDiscard().then((ok) => { if (ok) selectedNode.value = id; });
    return;
  }
  selectedNode.value = id;
}

// ── 域行大件节选举席（M28 P2 + 2026-11 左树数据化）：settings:section
//    贡献携带 meta.section 与 selectedNode 匹配（模型管理 ← ui-llm-pool、
//    搜索引擎 ← ui-search-pool 等）；左树叶与节选举同源（sectionEntries
//    共用版本轴，D14）——域行装卸时节与叶同步即时出现/消失；无贡献 =
//    空态，壳不残废 ──
const domainSection = computed<SlotEntry | null>(
  () => sectionEntries.value.find((e) => e.meta?.section === selectedNode.value) ?? null,
);

// （M28 P2：池更新/默认同步/定向落盘编排随 PoolManager 迁
//  ac-client-ui-llm-pool——LlmPoolsHost 自理（搜索引擎节 2026-11
//  再拆 ui-search-pool——SearchPoolsHost 随行走）；
//  Agent 设置节迁 ui-agents（AgentSettingsHost 自理列表/编辑双态））

// （M28 P2：全局定时任务节迁 ui-timer——GlobalTimerHost 自理节 + 编辑弹窗）

// ── 保存 / 重启 / 关闭 ──
//（M29 P1-3b：agent 编辑编排归 ui-agents（AgentSettingsHost/useAgentSettings
//  自足 + 编辑器内保存钮）——壳层 saveAll 只管全局配置；agent dirty 经
//  uiStore.agentEditorDirty 发布（发布方 = AgentSettingsHost watch），壳层
//  关闭/切节守护消费）

/** 壳层保存钮管辖面：域行大件节（settings:section 贡献）自理保存——
 *  Agent 编辑器内置保存钮、池管理即时落盘、定时/插件库同理；壳层保存
 *  只对命名空间表单（ns.*）与插件全局页签（ui-tab:*）有意义。域节在场
 *  时隐藏壳层保存钮，避免与域内保存动作形成「两个保存配置」的歧义。 */
const shellSaveRelevant = computed(() =>
  selectedNode.value.startsWith('ns.') || selectedNode.value.startsWith('ui-tab:'),
);

async function saveAll() {
  if (!settings.globalDirty.value) return; // 无可保存：不弹假「已保存」
  saving.value = true;
  settings.error.value = '';
  const ok = await settings.saveGlobal();
  if (ok) toastOk('全局配置已保存 · 下次运行生效');
  saving.value = false;
}

const isDirty = computed(() => settings.globalDirty.value);

// ── 通用确认弹窗（ConfirmDialog 组件，替代原生 confirm） ──
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);

/** 未保存守护的统一询问（全局配置 + Agent 编辑——M29 收口余留：agent
 *  编辑态住节宿主，壳层此前只看 globalDirty，带编辑关面板/切节静默丢失） */
async function confirmDiscard(): Promise<boolean> {
  return (await confirmRef.value?.ask({
    title: '放弃未保存的更改？',
    message: '有未保存的更改，离开后这些更改将丢失。是否仍要离开？',
    confirmLabel: '放弃更改并离开',
    danger: true,
  })) ?? false;
}

async function requestClose() {
  if (isDirty.value || ui.agentEditorDirty) {
    if (!(await confirmDiscard())) return;
  }
  emit('close');
}

function requestRestart() {
  if (restarting.value) return;
  void confirmRef.value?.ask({
    title: '重启后端？',
    message: '将完全重启后端，进行中的任务会被中断，几秒后自动恢复。',
    confirmLabel: '确认重启',
  }).then((ok) => {
    if (!ok) return;
    restarting.value = true;
    // 兜底解锁：此前只有 send 同步抛错才复位——WS 事件链路无回调时按钮永久
    // 卡在"正在重启"（后端 15s 内未发 systemRestarting 或事件丢失的场合）
    if (restartResetTimer) clearTimeout(restartResetTimer);
    restartResetTimer = setTimeout(() => { restarting.value = false; }, 30_000);
    try {
      settings.restartBackend();
    } catch {
      restarting.value = false;
    }
  });
}
let restartResetTimer: ReturnType<typeof setTimeout> | null = null;

// ── 加载 ──
watch([() => props.visible, () => props.initialAgentId, () => props.initialSection], ([v, agentId, section]) => {
  if (v) {
    settings.error.value = '';
    settings.loadMeta();
    settings.loadGlobal();
    // 定位到指定 Agent（来自聊天页/侧边栏的入口）：选中 agents 节——
    // 编辑态定位由 ui-agents AgentSettingsHost 经 uiStore.settingsAgentTarget 自理
    if (agentId) selectedNode.value = 'agents';
    // 定位到指定设置页签（如 /timer 快捷命令 → sys.timer 定时任务）
    if (section) selectedNode.value = section;
  }
  // 关闭：agent 编辑态随节宿主卸载自清（M29 P1-3b 编排归域）
});
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="sp-overlay" @mousedown.self="requestClose()">
      <div class="sp-panel" @click.stop>
        <!-- Header -->
        <div class="sp-header">
          <span class="sp-accent"></span>
          <h3 class="sp-title">设置</h3>
          <span v-if="currentTitle" class="sp-subtitle">{{ currentTitle }}</span>
          <span v-if="isDirty || ui.agentEditorDirty" class="sp-dirty-badge"><StatusDot status="thinking" :size="7" /> 未保存</span>
          <button class="sp-close" @click="requestClose()" title="关闭"><Icon name="x" :size="15" /></button>
        </div>

        <div class="sp-body">
          <!-- 左侧树（2026-11 左树数据化：平铺叶自 settings:section 席位派生 +
               settings-tab:global 动态页签追加——行卸载叶同步退场） -->
          <div class="sp-tree">
            <div
              v-for="node in tree" :key="node.id"
              class="sp-tree-leaf sp-root-leaf" :class="{ active: selectedNode === node.id }"
              @click="selectNode(node.id)"
            >{{ node.label }}</div>
          </div>

          <!-- 右侧内容 -->
          <div class="sp-main">
            <div v-if="settings.loading.value" class="sp-status">加载中...</div>
            <template v-else>
              <!-- 域行大件节（settings:section 选举席——M28 P2：Agent 设置 ←
                   ui-agents、模型管理 ← ui-llm-pool、搜索引擎 ← ui-search-pool、
                   插件库 ← ui-plugin-registry、全局定时 ← ui-timer；贡献携带
                   meta.section 与 selectedNode 匹配，无贡献 = 空态） -->
              <component :is="domainSection?.component" v-if="domainSection" />

              <!-- 插件全局设置页签（settings-tab:global slot） -->
              <div v-else-if="currentPluginSettingsTab" class="plugin-settings-tab">
                <component :is="currentPluginSettingsTab.component" v-bind="globalPluginTabProps" />
              </div>

              <!-- 命名空间配置（扩展/工具/系统） -->
              <NsFieldList
                v-else-if="selectedNode.startsWith('ns.')"
                :ns-key="selectedNode.slice(3)"
                :config="settings.globalConfig.value"
                :schema="(settings.nsSchemas.value as any)[selectedNode.slice(3)]"
                :title="currentTitle"
              />

            </template>
          </div>
        </div>

        <!-- Footer -->
        <div class="sp-footer">
          <div class="sp-footer-left">
            <span v-if="errorText" class="sp-error">{{ errorText }}</span>
            <span v-else-if="isDirty && !errorText" class="sp-hint">有未保存的更改</span>
            <button
              class="sp-restart-minor" :disabled="restarting"
              @click="requestRestart" title="完全重启后端（会中断所有进行中的任务，几秒后自动恢复）"
            >{{ restarting ? '正在重启…' : '重启后端' }}</button>
          </div>
          <div class="sp-footer-actions">
            <Button variant="ghost" @click="requestClose()">关闭</Button>
            <!-- 壳层保存只管全局配置（ns.* / 插件全局页签）：域节自理保存，
                 隐藏壳层钮——消「两个保存配置」歧义；文案点明管辖面 -->
            <Button
              v-if="shellSaveRelevant"
              variant="primary" :disabled="saving || !isDirty"
              :title="isDirty ? '保存全局配置（Agent 等域节用各自编辑器内的保存钮）' : '无未保存更改'"
              @click="saveAll"
            >{{ saving ? '保存中...' : '保存全局配置' }}</Button>
          </div>
        </div>

        <!-- 通用确认弹窗（未保存关闭 / 重启后端，替代原生 confirm） -->
        <ConfirmDialog ref="confirmRef" />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* ── Shell ── */
.sp-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.sp-panel {
  width: 82vw; max-width: 1100px; height: 82vh; max-height: 88vh;
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--r-lg); box-shadow: var(--shadow-panel);
  display: flex; flex-direction: column; overflow: hidden;
}

.sp-header { display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.sp-accent { width: 4px; height: 14px; border-radius: 2px; background: var(--primary); flex-shrink: 0; }
.sp-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-1); }
.sp-subtitle { font-size: 11px; color: var(--text-3); }
.sp-dirty-badge { font-size: 10px; color: var(--warn); margin-left: 4px; display: inline-flex; align-items: center; gap: 4px; }
.sp-close { margin-left: auto; background: none; border: none; color: var(--text-3); cursor: pointer; padding: 0 4px; line-height: 1; display: inline-flex; align-items: center; }
.sp-close:hover { color: var(--text-1); }

/* 注意：ChatView 非 scoped 的 .sp-body { padding:16px 20px } 会泄漏全局，
   这里显式 padding:0 覆盖（scoped 特异性更高） */
.sp-body { flex: 1; overflow: hidden; display: flex; padding: 0; }

/* ── 左侧树（星卡风格；平铺叶） ── */
.sp-tree {
  width: 200px; flex-shrink: 0; overflow-y: auto;
  border-right: 1px solid var(--line);
  padding: 12px 8px;
}
.sp-tree-leaf {
  padding: 6px 10px 6px 24px; font-size: 13px;
  color: var(--text-2); cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-radius: var(--r-md); margin: 1px 0;
  border: 1px solid transparent;
  transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast), box-shadow var(--dur-fast);
}
/* 选中态对齐会话/Agent 列表（.list-item.active）：--role-selected-bg
   主色系底 + 透明边框 + 无阴影（原 --bg-surface+--line-strong 描边
   规格与独立会话侧边栏选中态不一致）；hover 维持 --bg-hover */
.sp-tree-leaf:hover { background: var(--bg-hover); color: var(--text-1); }
.sp-tree-leaf.active {
  background: var(--role-selected-bg);
  color: var(--text-1); font-weight: 500;
  border-color: transparent;
  box-shadow: none;
}
.sp-root-leaf { padding-left: 10px; }

/* ── 右侧内容 ── */
.sp-main { flex: 1; overflow-y: auto; }
/* 移除 sp-body 外层留白：内容组件根容器统一紧凑内边距（避免贴死面板边缘） */
.sp-main > * { padding: 12px 16px 12px; }
.sp-status { text-align: center; padding: 40px; color: var(--text-3); font-size: 14px; }

/* ── Footer ── */
.sp-footer { display: flex; align-items: center; justify-content: space-between; padding: 9px 16px; border-top: 1px solid var(--line); flex-shrink: 0; }
.sp-footer-left { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sp-restart-minor {
  padding: 2px 8px; border: none; border-radius: var(--r-md);
  background: transparent; color: var(--text-3); font-size: 11px; cursor: pointer;
  transition: all var(--dur-fast); margin-left: 4px;
}
.sp-restart-minor:hover:not(:disabled) { background: var(--role-active-bg); color: var(--warn); }
.sp-restart-minor:disabled { opacity: .5; cursor: not-allowed; }
.sp-error { color: var(--err); font-size: 12px; }
.sp-hint { color: var(--warn); font-size: 12px; }
.sp-footer-actions { display: flex; gap: 8px; flex-shrink: 0; }

/* ── 全局定时任务 ── */
/* （g-timer/sp-modal 族样式随 GlobalTimerHost 迁 ui-timer） */

.modal-enter-active, .modal-leave-active { transition: opacity .2s ease; }
.modal-enter-active .sp-panel, .modal-leave-active .sp-panel { transition: transform .2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .sp-panel { transform: scale(.96) translateY(8px); }
.modal-leave-to .sp-panel { transform: scale(.96) translateY(8px); }
</style>
