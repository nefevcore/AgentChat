<script setup lang="ts">
// ============================================================
// client/TimersPanel.vue —— 定时任务聚合 aux 选区面板（A3；2026-09 重设计）
//
// 「到点要发生什么」监视语义归位：当前 Agent 的定时器 + 全局定时任务
// 一屏纵览。重设计后职责分层：
//   · 面板头：标题 + 统计（N 启用）+ 保存按钮（dirty 态浮现——
//     Agent 定时器是显式保存模型，全局任务即时生效无需保存）；
//   · 段头：轻量 uppercase 段题 + 段级添加按钮（+）；
//   · 段体：TimerPane / GlobalTimerHost（hideHeader 复用——行式
//     两行式 ui-row，两段视觉同构）；
//   · 底注：触发语义一句话说明。
// ============================================================
import { computed, ref, watch } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { getAgentTimers, saveAgentTimers, type TimerEntry } from './timerApi.ts';
import TimerPane from './TimerPane.vue';
import GlobalTimerHost from './GlobalTimerHost.vue';

const ctx = useClientContext();
const rpc = ctx?.rpc ?? null;
const roster = useRosterCore();
const agentId = computed(() => roster.activeAgentId.value || null);
const agentName = computed(() => agentId.value ? (roster.getAgentName(agentId.value) || agentId.value) : '');

// ── Agent 级定时器（timer/entries RPC：读 + 写回） ──
const timers = ref<TimerEntry[]>([]);
const saving = ref(false);
const dirty = ref(false);
const timerPaneRef = ref<InstanceType<typeof TimerPane> | null>(null);
const globalHostRef = ref<InstanceType<typeof GlobalTimerHost> | null>(null);

async function loadTimers() {
  const id = agentId.value;
  if (!id || !rpc) { timers.value = []; return; }
  try {
    const r = await getAgentTimers(id, rpc);
    if (agentId.value === id) { timers.value = r.entries; dirty.value = false; } // 防串台
  } catch { timers.value = []; }
}
watch(agentId, () => void loadTimers(), { immediate: true });

function onTimersUpdate(v: TimerEntry[]) {
  timers.value = v;
  dirty.value = true;
}
async function save() {
  const id = agentId.value;
  if (!id || !rpc || saving.value) return;
  saving.value = true;
  try {
    await saveAgentTimers(id, timers.value, rpc);
    dirty.value = false;
  } finally { saving.value = false; }
}

const enabledCount = computed(() => timers.value.filter(t => t.enabled !== false).length);
</script>

<template>
  <div class="tmp-panel">
    <div class="tmp-head">
      <span class="tmp-title">定时任务</span>
      <span class="tmp-count">{{ agentId ? `${enabledCount}/${timers.length} 启用` : '未选 Agent' }}</span>
      <button v-if="dirty" class="tmp-save" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
    </div>
    <div class="tmp-body">
      <!-- Agent 级（当前活跃 Agent；无选中提示） -->
      <div class="tmp-section">
        <div class="tmp-section-title">
          <span class="tmp-section-label">Agent 定时器</span>
          <span class="tmp-section-sub">{{ agentName ? agentName : '未选中 Agent' }}</span>
          <button class="tmp-add" title="添加 Agent 定时任务" :disabled="!agentId" @click="timerPaneRef?.addTimer()">＋</button>
        </div>
        <TimerPane v-if="agentId" ref="timerPaneRef" :entries="timers" :saving="saving" hide-header @update:entries="onTimersUpdate" @save="save" />
        <div v-else class="tmp-empty">在主侧边栏选择一个 Agent 查看其定时器</div>
      </div>

      <!-- 全局定时任务（sys.timer 机制任务 + 自定义） -->
      <div class="tmp-section">
        <div class="tmp-section-title">
          <span class="tmp-section-label">全局任务</span>
          <span class="tmp-section-sub">跨 Agent</span>
          <button class="tmp-add" title="添加全局定时任务" @click="globalHostRef?.startAddTask()">＋</button>
        </div>
        <GlobalTimerHost ref="globalHostRef" />
      </div>

      <div class="tmp-foot">Agent 定时器改动需保存后生效；全局任务保存即生效。</div>
    </div>
  </div>
</template>

<style scoped>
.tmp-panel {
  display: flex; flex-direction: column;
  height: 100%; min-width: 0; overflow: hidden;
  background: var(--color-bg-page, #fff);
}
.tmp-head {
  display: flex; align-items: center; gap: 8px;
  height: var(--layout-header-height, 48px); padding: 0 16px; flex-shrink: 0;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
}
.tmp-title { font-size: 13px; font-weight: 600; flex-shrink: 0; }
.tmp-count { font-size: 11px; color: var(--color-text-tertiary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tmp-save {
  border: 1px solid var(--color-primary, #6366f1); border-radius: var(--radius-sm);
  background: var(--color-primary, #6366f1); color: #fff;
  font-size: 11px; padding: 3px 12px; cursor: pointer; flex-shrink: 0;
}
.tmp-save:disabled { opacity: 0.6; cursor: default; }
.tmp-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 18px; }
.tmp-section { display: flex; flex-direction: column; gap: 6px; }
.tmp-section-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; letter-spacing: .5px; text-transform: uppercase; font-weight: 600;
  color: var(--color-text-tertiary);
  padding: 0 2px;
}
.tmp-section-label { flex-shrink: 0; }
.tmp-section-sub { font-size: 10px; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--color-text-tertiary); opacity: .8; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tmp-add {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border: 1px solid var(--color-border-secondary, #e0e0e0); border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--color-text-tertiary); font-size: 13px; line-height: 1;
  cursor: pointer; flex-shrink: 0; transition: all var(--dur-fast, .15s ease);
}
.tmp-add:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); background: var(--primary-light); }
.tmp-add:disabled { opacity: .4; cursor: not-allowed; }
.tmp-empty { padding: 10px 4px; font-size: 12px; color: var(--color-text-tertiary); }
.tmp-foot { font-size: 11px; color: var(--color-text-tertiary); padding: 4px 2px 0; border-top: 1px solid var(--color-border-light, #eee); }
</style>
