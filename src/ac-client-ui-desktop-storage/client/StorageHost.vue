<!-- StorageHost.vue —— 存储管理节宿主（桌面壳数据根设置） -->
<!-- 桥探活失败（非桌面形态/端口被占）→ 自摘设置节（静默，不是错误）。 -->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useDesktopBridge } from './bridge.ts';

const { info, ready, pick, setRoot } = useDesktopBridge();
const picking = ref(false);
const confirming = ref(false);
const pickedPath = ref('');
const migrate = ref(true);
const busy = ref(false);
const error = ref('');
const restarting = ref(false);

const fmt = (b: number) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : (b / 1024 ** 2).toFixed(0) + ' MB');
const subdirLabel: Record<string, string> = {
  sessions: '会话记录', agents: 'Agent 数据', workspace: '工作区文件',
  logs: '日志', reports: '诊断报告', backups: '备份',
};

async function onPick() {
  picking.value = true;
  try {
    const r = await pick();
    if (!r.canceled && r.path) pickedPath.value = r.path;
  } finally { picking.value = false; }
}

async function onConfirm() {
  busy.value = true;
  error.value = '';
  try {
    await setRoot(pickedPath.value, migrate.value);
    restarting.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally { busy.value = false; }
}
</script>

<template>
  <div v-if="ready && info" class="storage-pane">
    <h3>存储管理</h3>
    <p class="sub">数据根是 AgentChat 全部数据的存放位置（会话、记忆、工作区文件）。仅桌面版可修改。</p>

    <div class="current card">
      <div class="row"><span class="k">当前位置</span><code class="path">{{ info.dataRoot }}</code>
        <span v-if="info.customized" class="badge">自定义</span></div>
      <div class="row"><span class="k">占用</span><span class="v">{{ fmt(info.total) }}</span></div>
      <div v-if="Object.keys(info.breakdown).length" class="breakdown">
        <div v-for="(size, sub) in info.breakdown" :key="sub" class="row small">
          <span class="k">{{ subdirLabel[sub] ?? sub }}</span><span class="v">{{ fmt(size) }}</span>
        </div>
      </div>
    </div>

    <div v-if="!restarting" class="card">
      <div class="row">
        <span class="k">迁移数据到新位置</span>
        <button class="btn" :disabled="picking" @click="onPick">{{ picking ? '选择中…' : '选择目录…' }}</button>
      </div>
      <div v-if="pickedPath" class="picked">
        <code class="path">{{ pickedPath }}</code>
        <label class="migrate-opt">
          <input type="checkbox" v-model="migrate" />
          迁移现有数据（{{ fmt(info.total) }}）到新位置——取消勾选则新位置从空白社区开始
        </label>
        <div class="warn">
          <p>· 切换后 AgentChat 将自动重启</p>
          <p>· 目标目录必须为空（防止覆盖已有数据）</p>
          <p v-if="!migrate">· <b>不迁移</b>：当前数据保留在原位置，新位置从全新社区开始</p>
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="busy" @click="confirming = true">切换存储位置</button>
        </div>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
    </div>

    <div v-else class="card restarting">
      <p>✅ 存储位置已切换，AgentChat 正在重启…</p>
      <p class="sub">若 10 秒后窗口未自动恢复，请手动启动 AgentChat。</p>
    </div>

    <!-- 确认弹层 -->
    <div v-if="confirming" class="modal-mask" @click.self="confirming = false">
      <div class="modal">
        <h4>确认切换存储位置</h4>
        <p>{{ migrate ? '将迁移全部数据到' : '将切换到（不迁移现有数据）' }}：</p>
        <code class="path">{{ pickedPath }}</code>
        <p class="warn-inline">此操作会自动重启 AgentChat。</p>
        <div class="modal-actions">
          <button class="btn" @click="confirming = false">取消</button>
          <button class="btn primary" :disabled="busy" @click="onConfirm(); confirming = false">
            {{ busy ? '执行中…' : '确认切换' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.storage-pane { display: flex; flex-direction: column; gap: 14px; }
h3 { margin: 0 0 2px; font-size: 1.02rem; }
.sub { color: var(--tx2, #888); font-size: .85rem; margin: 0; }
.card { border: 1px solid var(--line, rgba(127,127,127,.25)); border-radius: 10px; padding: 14px 16px; }
.row { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.row.small { font-size: .82rem; color: var(--tx2, #888); padding: 1px 0 1px 12px; }
.k { color: var(--tx2, #888); min-width: 72px; font-size: .88rem; }
.v { font-variant-numeric: tabular-nums; font-size: .9rem; }
.path { font-family: ui-monospace, monospace; font-size: .82rem; background: var(--bg2, rgba(127,127,127,.08)); padding: 2px 7px; border-radius: 5px; word-break: break-all; }
.badge { font-size: .72rem; color: #4c8dff; background: rgba(76,141,255,.1); padding: 1px 8px; border-radius: 99px; }
.breakdown { margin-top: 6px; border-top: 1px dashed var(--line, rgba(127,127,127,.2)); padding-top: 6px; }
.btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--line, rgba(127,127,127,.3)); background: transparent; color: inherit; cursor: pointer; font-size: .88rem; }
.btn:hover:not(:disabled) { border-color: currentColor; }
.btn.primary { background: #4c8dff; border-color: #4c8dff; color: #fff; }
.btn:disabled { opacity: .5; cursor: default; }
.picked { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.migrate-opt { font-size: .85rem; display: flex; gap: 8px; align-items: flex-start; }
.warn { font-size: .8rem; color: var(--tx2, #888); border-left: 2px solid rgba(127,127,127,.3); padding-left: 10px; }
.warn p { margin: 2px 0; }
.error { color: #e5484d; font-size: .85rem; }
.restarting { text-align: center; padding: 24px; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--bg, #fff); border-radius: 12px; padding: 20px 22px; max-width: 440px; width: 92%; }
.modal h4 { margin: 0 0 10px; }
.warn-inline { color: #d97706; font-size: .85rem; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
</style>
