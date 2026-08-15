<script setup lang="ts">
// ============================================================
// StagingReviewModal.vue —— 暂存插件人审（P3）
// 文件树 + 内容预览 + requiredGrants 强制勾选 + 批准/拒绝
// ============================================================
import { ref, watch } from 'vue';
import type { StagingRecord, StagingFileInfo, PluginPermissionsView } from '../types';
import * as api from '../api';
import { Modal, Button } from '@/ui';

const props = defineProps<{
  record: StagingRecord | null;
  permissions: PluginPermissionsView | null;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'done', kind: 'approved' | 'rejected'): void;
}>();

const files = ref<StagingFileInfo[]>([]);
const selected = ref('');
const content = ref('');
const fileError = ref('');
const grants = ref<string[]>([]);
const busy = ref(false);
const error = ref('');
const copied = ref(false);

function reset() {
  files.value = [];
  selected.value = '';
  content.value = '';
  fileError.value = '';
  grants.value = [];
  busy.value = false;
  error.value = '';
  copied.value = false;
}

watch(() => props.record, (record) => {
  reset();
  if (!record) return;
  void loadTree(record.id);
});

async function loadTree(id: string) {
  try {
    const data = await api.getStagingTree(id);
    files.value = data.files ?? [];
    if (files.value.length > 0) await openFile(files.value[0].path);
  } catch (e: any) {
    fileError.value = `文件树加载失败: ${e.message}`;
  }
}

async function openFile(path: string) {
  if (!props.record) return;
  selected.value = path;
  fileError.value = '';
  try {
    const data = await api.getStagingFile(props.record.id, path);
    content.value = data.content;
  } catch (e: any) {
    fileError.value = `文件读取失败: ${e.message}`;
    content.value = '';
  }
}

async function copyHash() {
  if (!props.record) return;
  try {
    await navigator.clipboard.writeText(props.record.hash);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    error.value = '复制失败（浏览器未授权剪贴板）';
  }
}

async function approve() {
  if (!props.record) return;
  busy.value = true;
  error.value = '';
  try {
    await api.approvePlugin(props.record.id, grants.value);
    emit('done', 'approved');
  } catch (e: any) {
    error.value = `批准失败: ${e.message}`;
  } finally {
    busy.value = false;
  }
}

async function reject() {
  if (!props.record) return;
  busy.value = true;
  error.value = '';
  try {
    await api.rejectPlugin(props.record.id);
    emit('done', 'rejected');
  } catch (e: any) {
    error.value = `拒绝失败: ${e.message}`;
  } finally {
    busy.value = false;
  }
}

const missingGrants = () =>
  (props.record?.requiredGrants ?? []).filter((p) => !grants.value.includes(p));
</script>

<template>
  <Modal :visible="!!record" title="暂存插件人审" :width="760" :z-index="1250" @close="emit('close')">
    <div v-if="record" class="review-body">
      <!-- 概览 -->
      <div class="review-overview">
        <div class="review-line">
          <span class="review-label">插件</span>
          <strong>{{ record.manifest.name }}</strong>
          <span class="review-ver">v{{ record.manifest.version }}</span>
          <span class="review-owner">owner: {{ record.owner }}</span>
        </div>
        <div class="review-line">
          <span class="review-label">源目录</span>
          <code>{{ record.sourceDir }}</code>
        </div>
        <div class="review-line">
          <span class="review-label">哈希</span>
          <code class="review-hash" :title="record.hash">{{ record.hash.slice(0, 8) }}…</code>
          <button class="review-copy" @click="copyHash">{{ copied ? '已复制' : '复制' }}</button>
        </div>
        <div class="review-line">
          <span class="review-label">创建时间</span>
          <span>{{ record.createdAt.replace('T', ' ').slice(0, 19) }}</span>
        </div>
      </div>

      <!-- 授予勾选（高危权限缺省不勾） -->
      <div class="review-grants">
        <div class="review-grants-title">授予权限（人审确认）</div>
        <div class="review-grants-desc">fs / network 默认授予；以下权限必须宿主显式勾选后才写入 registry 授予快照。</div>
        <label v-for="p in record.requiredGrants" :key="p" class="review-grant">
          <input v-model="grants" type="checkbox" :value="p" />
          <code>{{ p }}</code>
          <span v-if="p === 'ui'" class="grant-warn">⚠ UI 代码将在浏览器会话上下文中执行（同源信任）</span>
          <span v-else-if="p === 'process' || p === 'shell'" class="grant-warn">高危：可执行任意进程/命令</span>
        </label>
        <div v-if="record.requiredGrants.length === 0" class="review-grants-none">无需额外授予（仅 fs/network 默认权限）</div>
      </div>

      <!-- 文件树 + 内容 -->
      <div class="review-files">
        <div class="review-files-tree">
          <div class="review-files-title">文件（{{ files.length }}）</div>
          <div
            v-for="f in files" :key="f.path"
            class="review-file" :class="{ active: selected === f.path }"
            @click="openFile(f.path)"
          >
            <span class="review-file-path">{{ f.path }}</span>
            <span class="review-file-size">{{ f.size }} B</span>
          </div>
          <div v-if="files.length === 0" class="review-files-empty">{{ fileError || '暂无文件' }}</div>
        </div>
        <pre class="review-file-content"><code>{{ content }}</code></pre>
      </div>

      <div v-if="error" class="review-error">{{ error }}</div>
    </div>
    <template #footer>
      <Button variant="ghost" @click="emit('close')">关闭</Button>
      <Button variant="danger" :disabled="busy" @click="reject">拒绝并删除暂存</Button>
      <Button variant="primary" :disabled="busy || missingGrants().length > 0" @click="approve">
        {{ busy ? '处理中…' : missingGrants().length ? `请先勾选授予：${missingGrants().join('/')}` : '批准安装' }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.review-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 12px; max-height: 62vh; overflow-y: auto; }
.review-overview { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--line); border-radius: var(--r-md); padding: 10px 12px; background: var(--bg-base); }
.review-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-2); }
.review-label { width: 54px; flex-shrink: 0; color: var(--text-3); }
.review-line code { font-family: var(--font-mono); font-size: 11px; color: var(--text-1); word-break: break-all; }
.review-ver { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.review-owner { font-size: 11px; color: var(--text-3); }
.review-hash { cursor: default; }
.review-copy { border: none; background: transparent; color: var(--primary); font-size: 11px; cursor: pointer; padding: 2px 6px; }
.review-copy:hover { background: var(--primary-light); border-radius: var(--r-sm); }
.review-grants { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--line); border-radius: var(--r-md); padding: 10px 12px; background: var(--bg-base); }
.review-grants-title { font-size: 12px; font-weight: 600; color: var(--text-1); }
.review-grants-desc, .review-grants-none { font-size: 11px; color: var(--text-3); }
.review-grant { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
.review-grant input { accent-color: var(--primary); }
.review-grant code { font-family: var(--font-mono); font-size: 12px; }
.grant-warn { font-size: 11px; color: var(--warn); }
.review-files { display: flex; gap: 10px; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; min-height: 200px; }
.review-files-tree { width: 240px; flex-shrink: 0; border-right: 1px solid var(--line); overflow-y: auto; max-height: 300px; background: var(--bg-base); }
.review-files-title { padding: 8px 10px; font-size: 11px; font-weight: 600; color: var(--text-2); border-bottom: 1px solid var(--line); }
.review-file { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 10px; cursor: pointer; font-size: 11px; color: var(--text-2); }
.review-file:hover { background: var(--bg-hover); }
.review-file.active { background: var(--primary-light); color: var(--primary); }
.review-file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.review-file-size { color: var(--text-3); flex-shrink: 0; }
.review-files-empty { padding: 10px; font-size: 11px; color: var(--text-3); }
.review-file-content { flex: 1; margin: 0; padding: 10px; overflow: auto; max-height: 300px; font-size: 11px; line-height: 1.5; background: var(--bg-base); }
.review-file-content code { font-family: var(--font-mono); white-space: pre; }
.review-error { color: var(--err); font-size: 12px; }
</style>
