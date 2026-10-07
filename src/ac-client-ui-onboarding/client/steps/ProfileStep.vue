<script setup lang="ts">
// ============================================================
// client/steps/ProfileStep.vue —— 第 1 步 · 用户设置
//（plan §3.2 D1：直接编辑 user 虚拟 Agent，不新建设置节）
//
// 字段只读 name / avatar（virtual 语义——模型/工具/人格文档字段
// 给了只会误导，§2.5）。写口：agents/update-config（patch { name }）
// + 头像 HTTP 面 /api/agents/user/avatar（rosterApi 同款上传/删除）。
// 保存成功 → emit('done')（本步 ✓）。名册即时可见性：头像走
// roster.refreshAvatar（行在场时）；昵称经 agents/updated 帧自然刷新。
// ============================================================
import { ref } from 'vue';
import { Avatar, Button, FeedbackNotice, Icon } from '@agentchat/webui-kit';
import { useClientContext, VIEWER_ID } from 'ac-client-runtime';
import { uploadAvatar, deleteAvatar } from 'ac-client-ui-agents/client/index.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';

const emit = defineEmits<{ (e: 'done'): void }>();

const clientCtx = useClientContext();
const roster = clientCtx?.roster;

const props = defineProps<{ llmCount?: number }>();
void props;

// ── 昵称 ──
const name = ref('');
const loading = ref(true);
const loadError = ref('');

(async () => {
  try {
    const r = await defaultRpc.call<{ config?: { name?: string } }>('agents/get-config', { agentId: 'user' });
    name.value = r.config?.name ?? '';
  } catch (err) {
    loadError.value = `加载失败：${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
})();

// ── 头像（rosterApi 同款：版本化 URL + blob 预览 + 2MB 上限）──
const avatarPreview = ref('');
const avatarUploading = ref(false);
const avatarVersion = ref<string | undefined>(undefined);
const hasAvatar = ref(false);

function syncAvatarFromRoster(): void {
  const url = roster?.getAgentAvatar(VIEWER_ID.value);
  hasAvatar.value = !!url;
  avatarPreview.value = url ?? '';
}
syncAvatarFromRoster();

async function onAvatarFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  if (file.size > 2 * 1024 * 1024) { feedback.value = { tone: 'error', text: '文件大小不能超过 2MB' }; return; }
  avatarUploading.value = true;
  feedback.value = null;
  try {
    const r = await uploadAvatar('user', file);
    avatarVersion.value = r.version;
    hasAvatar.value = true;
    avatarPreview.value = `/api/agents/user/avatar?v=${encodeURIComponent(r.version ?? '')}`;
    roster?.refreshAvatar(VIEWER_ID.value, true, r.version);
  } catch (err) {
    feedback.value = { tone: 'error', text: `头像上传失败：${(err as Error).message}` };
  } finally {
    avatarUploading.value = false;
  }
}

async function removeAvatar(): Promise<void> {
  try {
    await deleteAvatar('user');
    hasAvatar.value = false;
    avatarPreview.value = '';
    roster?.refreshAvatar(VIEWER_ID.value, false, undefined);
  } catch (err) {
    feedback.value = { tone: 'error', text: `删除头像失败：${(err as Error).message}` };
  }
}

// ── 保存 ──
const saving = ref(false);
const feedback = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

async function save(): Promise<void> {
  const trimmed = name.value.trim();
  if (!trimmed) { feedback.value = { tone: 'error', text: '昵称不能为空' }; return; }
  saving.value = true;
  feedback.value = null;
  try {
    await defaultRpc.call('agents/update-config', { agentId: 'user', patch: { name: trimmed } });
    feedback.value = { tone: 'ok', text: '已保存' };
    emit('done');
  } catch (err) {
    feedback.value = { tone: 'error', text: `保存失败：${(err as Error).message}` };
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="pf">
    <div v-if="loading" class="pf-loading"><FeedbackNotice tone="busy" text="加载中…" /></div>
    <template v-else>
      <div class="pf-row">
        <!-- 头像：上传 / 移除（Avatar 三级回退；无头像首字占位） -->
        <div class="pf-avatar-block">
          <label class="pf-avatar-uploader" :title="avatarUploading ? '上传中…' : '点击更换头像'">
            <Avatar :src="avatarPreview || undefined" :name="name || '我'" :size="72" />
            <span v-if="avatarUploading" class="pf-avatar-loading">上传中…</span>
          </label>
          <button v-if="hasAvatar" type="button" class="pf-avatar-remove" @click="removeAvatar">
            <Icon name="x" :size="11" /> 移除头像
          </button>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden @change="onAvatarFile" />
        </div>
        <div class="pf-fields">
          <div class="pf-field">
            <label class="pf-label" for="pf-name">昵称</label>
            <input id="pf-name" v-model="name" class="pf-input" placeholder="会话气泡与署名显示的名字" :disabled="saving" @keyup.enter="save" />
          </div>
          <p class="pf-hint">头像与昵称会用在会话气泡、群聊转录与活动栏署名。其余档案（模型/工具等）不适用于用户身份。</p>
        </div>
      </div>
      <FeedbackNotice v-if="loadError" tone="error" :text="loadError" />
      <FeedbackNotice v-if="feedback" :tone="feedback.tone" :text="feedback.text" />
      <div class="pf-actions">
        <Button variant="primary" :loading="saving" @click="save">保存</Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pf { display: flex; flex-direction: column; gap: 14px; }
.pf-loading { padding: 24px 0; }
.pf-row { display: flex; gap: 20px; align-items: flex-start; }
.pf-avatar-block { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.pf-avatar-uploader { position: relative; cursor: pointer; border-radius: 50%; }
.pf-avatar-uploader:hover :deep(.ui-avatar) { box-shadow: 0 0 0 3px var(--primary-light); }
.pf-avatar-loading {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: var(--fs-2xs); color: #fff; background: rgba(0, 0, 0, 0.5); border-radius: 50%;
}
.pf-avatar-remove {
  border: none; background: none; color: var(--text-3); font-size: var(--fs-2xs);
  cursor: pointer; display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px;
  border-radius: var(--r-sm);
}
.pf-avatar-remove:hover { color: var(--err); background: var(--bg-hover); }
.pf-fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.pf-field { display: flex; flex-direction: column; gap: 5px; }
.pf-label { font-size: var(--fs-xs); color: var(--text-2); font-weight: 500; }
.pf-input {
  height: var(--ctl-h-md); padding: 0 12px; border: 1px solid var(--input-border, var(--line));
  border-radius: var(--r-sm); background: transparent; color: var(--text-1);
  font-size: var(--fs-sm); outline: none; transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.pf-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-light); }
.pf-hint { margin: 0; font-size: var(--fs-2xs); color: var(--text-3); line-height: 1.6; }
.pf-actions { display: flex; justify-content: flex-end; }

@media (max-width: 768px) {
  .pf-row { flex-direction: column; align-items: stretch; }
  .pf-avatar-block { align-self: center; }
}
</style>
