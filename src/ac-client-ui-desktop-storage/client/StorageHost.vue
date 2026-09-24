<script setup lang="ts">
// ============================================================
// StorageHost.vue —— 存储管理节宿主（桌面壳数据根设置）
//     桥探活失败（非桌面形态/端口被占）→ 自摘设置节（静默，非错误）。
//     设计对齐 webui-kit 令牌体系（tokens.css：--primary/--line/
//     --text-*/--bg-*/--r-*/--space-*)与 Button/StatusDot/Modal
//     组件——双主题自适应（样板：RemoteDevices.vue）。
// ============================================================
import { ref } from 'vue';
import { Button, Modal, StatusDot, formatFileSize } from '@agentchat/webui-kit';
import { useDesktopBridge } from './bridge.ts';

const { info, ready, pick, setRoot } = useDesktopBridge();
const picking = ref(false);
const confirming = ref(false);
const pickedPath = ref('');
const migrate = ref(true);
const busy = ref(false);
const error = ref('');
const restarting = ref(false);

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
  confirming.value = false;
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
    <p class="sub">数据根是 AgentChat 全部数据的存放位置（会话、记忆、工作区文件）。仅桌面版可修改。</p>

    <div v-if="error" class="error-banner">
      <StatusDot status="err" :size="7" /> {{ error }}
    </div>

    <!-- 当前状态 -->
    <div class="card">
      <div class="stat-row">
        <span class="k">当前位置</span>
        <code class="mono-v">{{ info.dataRoot }}</code>
        <span v-if="info.customized" class="custom-badge">自定义</span>
      </div>
      <div class="stat-row">
        <span class="k">占用</span>
        <span class="v">{{ formatFileSize(info.total) }}</span>
      </div>
      <div v-if="Object.keys(info.breakdown).length" class="breakdown">
        <div v-for="(size, sub) in info.breakdown" :key="sub" class="stat-row small">
          <span class="k">{{ subdirLabel[sub] ?? sub }}</span><span class="v">{{ formatFileSize(size) }}</span>
        </div>
      </div>
    </div>

    <!-- 迁移编排 -->
    <div v-if="!restarting" class="card">
      <div class="stat-row">
        <span class="k">迁移数据到新位置</span>
        <Button variant="ghost" size="sm" :loading="picking" @click="onPick">选择目录…</Button>
      </div>
      <div v-if="pickedPath" class="picked">
        <code class="mono-v">{{ pickedPath }}</code>
        <label class="migrate-opt">
          <input type="checkbox" v-model="migrate" />
          迁移现有数据（{{ formatFileSize(info.total) }}）到新位置——取消勾选则新位置从空白社区开始
        </label>
        <div class="warn">
          <p>· 切换后 AgentChat 将自动重启</p>
          <p>· 目标目录必须为空（防止覆盖已有数据）</p>
          <p v-if="!migrate">· <b>不迁移</b>：当前数据保留在原位置，新位置从全新社区开始</p>
        </div>
        <div class="actions">
          <Button variant="primary" size="sm" :disabled="busy" @click="confirming = true">切换存储位置</Button>
        </div>
      </div>
    </div>

    <!-- 重启中 -->
    <div v-else class="card restarting">
      <div class="restart-line"><StatusDot status="running" :size="8" /> 存储位置已切换，AgentChat 正在重启…</div>
      <p class="sub">若 10 秒后窗口未自动恢复，请手动启动 AgentChat。</p>
    </div>

    <!-- 确认弹层（ui/Modal 统一外壳；z-index 高于设置面板 1000） -->
    <Modal :visible="confirming" title="确认切换存储位置" :width="440" :z-index="1200" @close="confirming = false">
      <div class="confirm-body">
        <p>{{ migrate ? '将迁移全部数据到' : '将切换到（不迁移现有数据）' }}：</p>
        <code class="mono-v">{{ pickedPath }}</code>
        <p class="warn-inline">此操作会自动重启 AgentChat。</p>
      </div>
      <template #footer>
        <Button variant="ghost" @click="confirming = false">取消</Button>
        <Button variant="primary" :loading="busy" @click="onConfirm">确认切换</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.storage-pane { display: flex; flex-direction: column; gap: var(--space-3); }
.sub { color: var(--text-3); font-size: 12px; margin: 0; line-height: 1.5; }

/* 卡片：tokens.css 中层容器语义（--r-md + surface 底 + line 描边） */
.card { background: var(--bg-surface); border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--space-3) var(--space-4); }

/* 错误横幅：role-active 语义（错误细节由文案承载） */
.error-banner { display: flex; align-items: center; gap: var(--space-2); font-size: 12px; color: var(--err); background: color-mix(in srgb, var(--err) 8%, transparent); border: 1px solid color-mix(in srgb, var(--err) 25%, transparent); border-radius: var(--r-sm); padding: 6px 10px; }

/* 状态卡行 */
.stat-row { display: flex; align-items: center; gap: var(--space-2); padding: 3px 0; min-height: 30px; }
.stat-row.small { font-size: 12px; color: var(--text-3); padding: 1px 0 1px 12px; min-height: 0; }
.k { color: var(--text-3); min-width: 72px; font-size: 12px; flex: none; }
.v { font-size: 13px; font-variant-numeric: tabular-nums; }
.mono-v { font-family: var(--font-mono); font-size: 11.5px; background: var(--bg-hover); padding: 2px 8px; border-radius: var(--r-sm); word-break: break-all; }
.custom-badge { font-size: 10px; color: var(--primary); border: 1px solid color-mix(in srgb, var(--primary) 40%, transparent); border-radius: var(--r-full); padding: 0 6px; line-height: 16px; flex: none; }
.breakdown { margin-top: var(--space-1); border-top: 1px dashed var(--line); padding-top: var(--space-1); }

/* 迁移编排 */
.picked { margin-top: var(--space-2); display: flex; flex-direction: column; gap: var(--space-2); }
.migrate-opt { font-size: 12px; color: var(--text-2); display: flex; gap: var(--space-2); align-items: flex-start; }
.warn { font-size: 12px; color: var(--text-3); border-left: 2px solid color-mix(in srgb, var(--warn) 45%, transparent); padding-left: 10px; }
.warn p { margin: 2px 0; }
.actions { display: flex; justify-content: flex-end; }

/* 重启中 */
.restarting { display: flex; flex-direction: column; align-items: center; gap: var(--space-1); padding: var(--space-5) var(--space-4); text-align: center; }
.restart-line { display: flex; align-items: center; gap: var(--space-2); font-size: 13px; color: var(--text-1); }

/* 确认弹层 */
.confirm-body { padding: 6px 20px 2px; display: flex; flex-direction: column; gap: var(--space-2); }
.confirm-body p { margin: 0; font-size: 13px; color: var(--text-1); }
.warn-inline { color: var(--warn); font-size: 12px; }
</style>
