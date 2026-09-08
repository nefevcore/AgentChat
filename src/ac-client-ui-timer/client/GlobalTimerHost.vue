<script setup lang="ts">
// ============================================================
// client/GlobalTimerHost.vue —— 全局定时任务节宿主
//（settings:section 贡献；M28 P2：原 settings SettingsPanel 内联
// sys.timer 节 + 编辑弹窗整体迁入——P1-5 裁决注记 2 的落位）
// 数据经 settings 共享 store（timer.tasks 全局配置模型）。
// ============================================================
import { ref, computed } from 'vue';
import { Modal, Button } from '@agentchat/webui-kit';
import { useSettings } from 'ac-client-ui-settings/client/useSettings.ts';

const settings = useSettings();

// ── 全局定时任务（timer.tasks 模型：time/hint/targets） ──
interface GlobalTask { time: string; hint?: string; targets?: string[]; builtin?: boolean }

/** 系统机制任务特殊 hint（不走 LLM，纯机制执行） */
const SPECIAL_HINTS: Record<string, { label: string; desc: string }> = {
  '__archive_all__': { label: '全局归档', desc: '批量归档所有活跃 1:1 会话（深夜执行，不走 LLM）' },
  '__backup_all__': { label: '数据备份', desc: '自动打包备份全部数据（每周一次，不走 LLM）' },
};
type SysHint = keyof typeof SPECIAL_HINTS;
function specialHint(hint?: string): { label: string; desc: string } | undefined {
  return hint ? SPECIAL_HINTS[hint.trim()] : undefined;
}
function isSysTask(t: GlobalTask): boolean { return !!specialHint(t.hint); }
/** 内置系统任务（config 预置，builtin=true）：不可删除、类型锁定；用户新建的系统任务不受此保护 */
function isProtectedTask(t: GlobalTask): boolean { return isSysTask(t) && t.builtin === true; }
/** 目标展示：'*' 通配视为全部 */
function targetsText(t: GlobalTask): string {
  const ts = (t.targets ?? []).filter(x => x && x !== '*');
  return ts.length ? '→ ' + ts.join(', ') : '→ 全部';
}

const gTaskDraft = ref<GlobalTask>({ time: '', hint: '', targets: [] });
const gTaskType = ref<'custom' | SysHint>('custom');
const gTaskBuiltin = ref(false);
const gTaskTargetsText = ref('');
const gTaskEditIdx = ref<number | null>(null);
const gTaskEditing = ref(false);
const gTaskError = ref('');

const gTasks = computed<GlobalTask[]>(() => settings.globalConfig.value.timer?.tasks ?? []);

function ensureTimer() {
  if (!settings.globalConfig.value.timer) settings.globalConfig.value.timer = { enabled: true, tasks: [] };
  if (!settings.globalConfig.value.timer.tasks) settings.globalConfig.value.timer.tasks = [];
}
function startAddTask() {
  gTaskEditing.value = true; gTaskEditIdx.value = null;
  gTaskDraft.value = { time: '', hint: '', targets: [] };
  gTaskType.value = 'custom';
  gTaskBuiltin.value = false;
  gTaskTargetsText.value = ''; gTaskError.value = '';
}
function startEditTask(idx: number) {
  gTaskEditing.value = true; gTaskEditIdx.value = idx;
  const t = gTasks.value[idx];
  const sp = specialHint(t.hint);
  gTaskType.value = sp ? (t.hint!.trim() as SysHint) : 'custom';
  gTaskBuiltin.value = isProtectedTask(t);
  gTaskDraft.value = { time: t.time, hint: sp ? t.hint : (t.hint || ''), targets: [...(t.targets || [])] };
  gTaskTargetsText.value = (t.targets || []).join('\n'); gTaskError.value = '';
}
function saveTask() {
  const time = gTaskDraft.value.time.trim();
  if (!/^\d{2}:\d{2}$/.test(time)) { gTaskError.value = '时间格式需为 HH:mm（如 08:30）'; return; }
  ensureTimer();
  const isSpecial = gTaskType.value !== 'custom';
  const task: GlobalTask = {
    time,
    hint: isSpecial ? gTaskType.value : (gTaskDraft.value.hint?.trim() || undefined),
    targets: gTaskTargetsText.value.split(/[\n,，]/).map(s => s.trim()).filter(Boolean) || undefined,
  };
  const tasks = settings.globalConfig.value.timer.tasks as GlobalTask[];
  if (gTaskEditIdx.value !== null) tasks[gTaskEditIdx.value] = task;
  else tasks.push(task);
  gTaskEditing.value = false; gTaskEditIdx.value = null;
}
function removeTask(idx: number) {
  const tasks = settings.globalConfig.value.timer?.tasks;
  if (!tasks) return;
  const t = tasks[idx];
  if (isProtectedTask(t)) return; // 内置系统任务：删除按钮已禁用，双保险
  tasks.splice(idx, 1);
}
</script>

<template>
  <div class="g-timer">
    <div class="g-timer-head">
      <div>
        <div class="g-timer-title">定时任务</div>
        <div class="g-timer-desc">每个任务 = 时间点 + 提示内容 + 目标 Agent（空=全部）。提示支持占位符：&#123;&#123;now&#125;&#125; / &#123;&#123;time&#125;&#125; / &#123;&#123;date&#125;&#125;</div>
      </div>
      <button class="g-timer-add" @click="startAddTask()">+ 添加任务</button>
    </div>

    <div class="g-timer-list">
      <div v-for="(t, i) in gTasks" :key="i" class="g-timer-item ui-row">
        <div class="g-timer-info">
          <span class="g-timer-time">{{ t.time }}</span>
          <span class="g-timer-hint" :class="{ 'is-sys': isSysTask(t) }">
            {{ specialHint(t.hint)?.label ?? (t.hint || '（报时）') }}
            <span v-if="isSysTask(t)" class="g-timer-sys-badge">系统</span>
          </span>
          <span class="g-timer-targets">{{ targetsText(t) }}</span>
        </div>
        <div class="g-timer-actions">
          <button class="g-timer-btn" @click="startEditTask(i)">编辑</button>
          <button class="g-timer-btn danger" :disabled="isProtectedTask(t)" :title="isProtectedTask(t) ? '内置系统任务不可删除' : ''" @click="removeTask(i)">删除</button>
        </div>
      </div>
      <div v-if="gTasks.length === 0" class="g-timer-empty">暂无任务</div>
    </div>
  </div>

  <!-- 全局定时任务编辑弹窗（ui/Modal 统一外壳） -->
  <Modal :visible="gTaskEditing" :title="gTaskEditIdx !== null ? '编辑定时任务' : '新建定时任务'" :width="440" :z-index="1200" @close="gTaskEditing = false">
    <div class="sp-modal-body">
      <div class="sp-field">
        <label>时间（HH:mm）</label>
        <input v-model="gTaskDraft.time" type="text" class="sp-input" placeholder="08:30" />
      </div>
      <div class="sp-field">
        <label>任务类型</label>
        <div class="sp-desc">系统任务为纯机制操作（不走 LLM）；自定义任务为报时提醒</div>
        <select v-model="gTaskType" class="sp-input" :disabled="gTaskBuiltin">
          <option value="custom">自定义报时</option>
          <option value="__archive_all__">全局归档（系统）</option>
          <option value="__backup_all__">数据备份（系统）</option>
        </select>
      </div>
      <template v-if="gTaskType === 'custom'">
        <div class="sp-field">
          <label>提示内容</label>
          <div class="sp-desc">留空则使用默认报时文本。占位符：&#123;&#123;now&#125;&#125; / &#123;&#123;time&#125;&#125; / &#123;&#123;date&#125;&#125;</div>
          <textarea v-model="gTaskDraft.hint" class="sp-textarea" rows="3" placeholder="现在是 {{now}}，巡检提醒..."></textarea>
        </div>
      </template>
      <template v-else>
        <div class="sp-field">
          <label>机制说明</label>
          <div class="sp-desc">{{ specialHint(gTaskType)?.desc }}</div>
          <div class="sp-sys-fixed">hint 固定为 <code>{{ gTaskType }}</code>，{{ gTaskBuiltin ? '仅可调整时间与目标' : '保存后仍可删除或改回自定义' }}</div>
        </div>
      </template>
      <div class="sp-field">
        <label>目标 Agent</label>
        <div class="sp-desc">每行一个 Agent ID，留空 = 全部 Agent</div>
        <textarea v-model="gTaskTargetsText" class="sp-textarea" rows="3" placeholder="agent_chat_dev&#10;news"></textarea>
      </div>
      <div v-if="gTaskError" class="g-task-error">{{ gTaskError }}</div>
    </div>
    <template #footer>
      <Button variant="ghost" @click="gTaskEditing = false">取消</Button>
      <Button variant="primary" @click="saveTask">保存</Button>
    </template>
  </Modal>
</template>

<style scoped>
.g-timer { display: flex; flex-direction: column; gap: 12px; }
.g-timer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.g-timer-head > div:first-child { min-width: 0; }
.g-timer-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.g-timer-desc { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.g-timer-add { padding: 5px 14px; border: 1px solid var(--primary); border-radius: var(--r-md); background: transparent; color: var(--primary); font-size: 12px; cursor: pointer; flex-shrink: 0; }
.g-timer-add:hover { background: var(--primary-light); }
.g-timer-list { display: flex; flex-direction: column; gap: 6px; }
.g-timer-item {
  /* C8 收敛 A 语言：底座 = ui/row.css .ui-row（透明底 / hover 浮起） */
  justify-content: space-between; gap: 8px; padding: 8px 12px;
}
.g-timer-info { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.g-timer-time { font-family: var(--font-mono); font-weight: 600; color: var(--primary); flex-shrink: 0; }
.g-timer-hint { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.g-timer-hint.is-sys { color: var(--primary); font-weight: 500; }
.g-timer-sys-badge { margin-left: 6px; font-size: 10px; padding: 2px 6px; border-radius: var(--r-full); background: var(--primary-light); color: var(--primary); flex-shrink: 0; vertical-align: 1px; }
.g-timer-targets { font-size: 11px; color: var(--text-3); flex-shrink: 0; }
.g-timer-actions { display: flex; gap: 4px; flex-shrink: 0; }
.g-timer-btn { padding: 3px 10px; border: none; border-radius: var(--r-md); background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; }
.g-timer-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.g-timer-btn.danger { color: var(--err); }
.g-timer-btn.danger:hover { border-color: var(--err); }
.g-timer-btn:disabled { opacity: .4; cursor: not-allowed; }
.g-timer-btn:disabled:hover { border-color: var(--line-strong); color: var(--err); }
.g-timer-empty { text-align: center; padding: 20px; color: var(--text-3); font-size: 13px; }

/* 编辑弹窗表单（原 SettingsPanel sp-modal 族随件复制——弹窗随节走） */
.sp-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 12px; }
.sp-field { display: flex; flex-direction: column; gap: 5px; }
.sp-field label { font-size: 12px; color: var(--text-2); }
.sp-desc { font-size: 11px; color: var(--text-3); }
.sp-input, .sp-textarea {
  padding: 7px 10px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: var(--bg-surface); color: var(--text-1); font-size: 12px; width: 100%;
  box-sizing: border-box;
}
.sp-input:focus, .sp-textarea:focus { outline: none; border-color: var(--input-focus); }
.sp-textarea { resize: vertical; font-family: var(--font-mono); }
.sp-sys-fixed { font-size: 11px; color: var(--text-3); background: var(--bg-hover); padding: 6px 10px; border-radius: var(--r-sm); }
.sp-sys-fixed code { font-family: var(--font-mono); color: var(--primary); }
.sp-field select.sp-input:disabled { opacity: .6; cursor: not-allowed; }
.g-task-error { color: var(--err); font-size: 12px; }
</style>
