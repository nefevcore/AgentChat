<script setup lang="ts">
// ============================================================
// EntryPickerModal.vue —— 本机路径选择弹窗（目录 / 文件双模式）
// 数据面 = workspace/browse-dirs RPC（快捷根 → 逐层下钻；mode 'file'
// 附带文件名清单——只列名不读内容）。共用方：
//   · ExtensionSettingsModal（type:'file' 字段的「浏览…」）
//   · SessionList（新增工作区的文件夹选择）
// 浏览器实现单源——各弹窗不再各自复制。
// ============================================================
import { ref, watch } from 'vue';
import { Icon, Modal, Button } from '@/ui';
import { browseDirs, type BrowseDirsResult } from '../../api/files';

const props = defineProps<{
  visible: boolean;
  /** dir = 选目录（「选择当前目录」回填绝对路径）；file = 选文件（点文件行即选定） */
  mode: 'dir' | 'file';
  title?: string;
  /** 弹窗层叠（宿主弹窗之上时传更高值；缺省 1200） */
  zIndex?: number;
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'pick', path: string): void }>();

const loading = ref(false);
const roots = ref<Array<{ name: string; path: string }>>([]);
/** null = 快捷根视图；否则当前目录浏览结果（含 error 降级） */
const current = ref<BrowseDirsResult | null>(null);

async function loadRoots(): Promise<void> {
  current.value = null;
  loading.value = true;
  try {
    const r = await browseDirs('', { files: props.mode === 'file' });
    roots.value = r.roots ?? [];
  } catch (err: any) {
    // 快捷根拉取失败：保留弹窗（当前目录仍可经手输进入）；错误就地降级显示
    roots.value = [];
    current.value = { path: '', dirs: [], error: `快捷根加载失败：${err.message}` };
  } finally {
    loading.value = false;
  }
}
async function enterDir(path: string): Promise<void> {
  loading.value = true;
  try {
    current.value = await browseDirs(path, { files: props.mode === 'file' });
  } catch (err: any) {
    // 保留导航上下文（path/parent/既有列表），错误就地降级显示
    current.value = { ...(current.value ?? { path, dirs: [] }), path, error: `读取失败：${err.message}` };
  } finally {
    loading.value = false;
  }
}
function pickFile(p: string): void {
  emit('pick', p);
  emit('close');
}
function pickCurrentDir(): void {
  const p = current.value?.path;
  if (p) emit('pick', p);
  emit('close');
}

// 每次翻开重置到快捷根（导航状态不留跨次）
watch(() => props.visible, (v) => { if (v) void loadRoots(); }, { immediate: true });
</script>

<template>
  <Modal
    :visible="visible"
    :title="title ?? (mode === 'file' ? '选择文件' : '选择文件夹')"
    :width="480"
    :z-index="zIndex ?? 1200"
    @close="emit('close')"
  >
    <div class="entry-picker">
      <div class="entry-crumbs">
        <button type="button" class="entry-crumb" :class="{ active: current === null }" @click="loadRoots">本机快捷根</button>
        <template v-if="current">
          <span class="entry-sep">›</span>
          <span class="entry-crumb-current" :title="current.path">{{ current.path }}</span>
        </template>
      </div>
      <div v-if="loading" class="entry-status">读取中…</div>
      <template v-else-if="current === null">
        <div v-if="roots.length === 0" class="entry-status">无快捷根</div>
        <div class="entry-list">
          <button v-for="r in roots" :key="r.path" type="button" class="entry-row" @click="enterDir(r.path)">
            <span class="entry-name"><Icon name="folder" :size="13" />{{ r.name }}</span>
            <span class="entry-path">{{ r.path }}</span>
          </button>
        </div>
      </template>
      <template v-else>
        <div v-if="current.error" class="entry-error">{{ current.error }}</div>
        <div class="entry-list">
          <button v-if="current.parent" type="button" class="entry-row entry-up" @click="enterDir(current.parent)">
            <span class="entry-name">..</span>
            <span class="entry-path">{{ current.parent }}</span>
          </button>
          <button v-for="d in current.dirs" :key="d.path" type="button" class="entry-row" @click="enterDir(d.path)">
            <span class="entry-name"><Icon name="folder" :size="13" />{{ d.name }}</span>
            <span class="entry-path">{{ d.path }}</span>
          </button>
          <!-- 文件行（mode file）：点击即选定回填 -->
          <button v-for="f2 in current.files ?? []" :key="f2.path" type="button" class="entry-row entry-file" :title="`选择 ${f2.path}`" @click="pickFile(f2.path)">
            <span class="entry-name"><Icon name="file-text" :size="13" />{{ f2.name }}</span>
            <span class="entry-path">{{ f2.path }}</span>
          </button>
          <div v-if="!current.error && current.dirs.length === 0 && (current.files ?? []).length === 0" class="entry-status">
            {{ mode === 'file' ? '无子目录/文件' : '无子目录（可直接「选择当前目录」）' }}
          </div>
        </div>
      </template>
    </div>
    <template #footer>
      <Button variant="ghost" size="sm" @click="emit('close')">取消</Button>
      <Button v-if="mode === 'dir'" variant="primary" size="sm" :disabled="!current?.path" title="把当前目录的绝对路径回填" @click="pickCurrentDir">选择当前目录</Button>
      <span v-else class="entry-foot-hint">点击文件行即选定</span>
    </template>
  </Modal>
</template>

<style scoped>
.entry-picker { padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; min-height: 240px; }
.entry-crumbs { display: flex; align-items: center; gap: 6px; font-size: 12px; flex-wrap: wrap; }
.entry-crumb {
  border: none; background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
  padding: 2px 6px; border-radius: var(--r-sm);
}
.entry-crumb:hover { background: var(--bg-hover); color: var(--text-1); }
.entry-crumb.active { color: var(--primary); background: var(--primary-light); font-weight: 500; }
.entry-sep { color: var(--text-3); }
.entry-crumb-current { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); word-break: break-all; }
.entry-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; flex: 1; min-height: 0; }
.entry-row {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px;
  border: none; border-radius: var(--r-sm); background: transparent; cursor: pointer; text-align: left;
}
.entry-row:hover { background: var(--bg-hover); }
.entry-name { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-1); flex-shrink: 0; }
.entry-up .entry-name { color: var(--text-3); font-family: var(--font-mono); }
.entry-file .entry-name { color: var(--text-1); }
.entry-file:hover .entry-name { color: var(--primary); }
.entry-path { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-status { font-size: 12px; color: var(--text-3); padding: 8px 4px; }
.entry-error { font-size: 12px; color: var(--err); padding: 6px 8px; background: color-mix(in srgb, var(--err) 8%, transparent); border-radius: var(--r-sm); }
.entry-foot-hint { font-size: 11px; color: var(--text-3); align-self: center; }
</style>
