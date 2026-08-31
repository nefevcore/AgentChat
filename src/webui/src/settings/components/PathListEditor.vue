<script setup lang="ts">
// ============================================================
// PathListEditor.vue —— 路径穿透白名单编辑器
// 消费：AgentPane 安全页签（raw.allowedPaths，保存映射
// hooks.security.allowedPaths，见 settings/api.ts saveAgentConfig）。
// UI = 路径清单（✕ 删除）+ 手动输入（Enter 加入，支持相对路径）+
// 「选择文件夹…」目录选择弹窗（Modal 复用 ui/Modal.vue）：
// 快捷根（browseDirs('')）→ 逐层下钻（dirs）/上翻（parent/..），
// 「选择当前目录」回填绝对路径。加入项一律 trim + 去重。
// ============================================================
import { ref } from 'vue';
import { Icon, Modal, Button } from '@/ui';
import { browseDirs, type BrowseDirsResult } from '../../api/files';

const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string[]): void }>();

const manualInput = ref('');

/** 加入清单：trim + 去重（空串忽略） */
function addPath(p: string): void {
  const t = p.trim();
  if (!t || props.modelValue.includes(t)) return;
  emit('update:modelValue', [...props.modelValue, t]);
}
function removePath(p: string): void {
  emit('update:modelValue', props.modelValue.filter(x => x !== p));
}
function submitManual(): void {
  addPath(manualInput.value);
  manualInput.value = '';
}

// ── 目录选择弹窗 ──
const pickerOpen = ref(false);
const pickerLoading = ref(false);
const roots = ref<Array<{ name: string; path: string }>>([]);
/** null = 快捷根视图；否则当前目录浏览结果（含 error 降级） */
const current = ref<BrowseDirsResult | null>(null);

async function openPicker(): Promise<void> {
  pickerOpen.value = true;
  current.value = null;
  pickerLoading.value = true;
  try {
    const r = await browseDirs('');
    roots.value = r.roots ?? [];
  } catch (err: any) {
    // 快捷根拉取失败：保留弹窗（当前目录仍可经手输进入）；错误就地降级显示
    roots.value = [];
    current.value = { path: '', dirs: [], error: `快捷根加载失败：${err.message}` };
  } finally {
    pickerLoading.value = false;
  }
}
async function enterDir(path: string): Promise<void> {
  pickerLoading.value = true;
  try {
    current.value = await browseDirs(path);
  } catch (err: any) {
    // 保留导航上下文（path/parent/既有列表），错误就地降级显示
    current.value = { ...(current.value ?? { path, dirs: [] }), path, error: `读取失败：${err.message}` };
  } finally {
    pickerLoading.value = false;
  }
}
function showRoots(): void {
  current.value = null;
}
function pickCurrent(): void {
  const p = current.value?.path;
  if (p) addPath(p);
  pickerOpen.value = false;
}
</script>

<template>
  <div class="path-editor">
    <div v-if="modelValue.length === 0" class="path-empty">未配置——仅允许工作区内路径</div>
    <div v-else class="path-list">
      <div v-for="p in modelValue" :key="p" class="path-row">
        <span class="path-value" :title="p">{{ p }}</span>
        <button type="button" class="path-x" title="移除该路径" @click="removePath(p)">✕</button>
      </div>
    </div>
    <div class="path-add">
      <input
        v-model="manualInput" type="text" class="path-input"
        placeholder="输入路径（支持相对路径如 ../shared），回车加入"
        @keyup.enter="submitManual"
      />
      <Button variant="soft" size="sm" @click="openPicker">选择文件夹…</Button>
    </div>

    <!-- 目录选择弹窗（快捷根 → 逐层下钻；「选择当前目录」回填绝对路径） -->
    <Modal :visible="pickerOpen" title="选择文件夹" :width="480" :z-index="1200" @close="pickerOpen = false">
      <div class="dir-picker">
        <div class="dir-crumbs">
          <button type="button" class="dir-crumb" :class="{ active: current === null }" @click="showRoots">本机快捷根</button>
          <template v-if="current">
            <span class="dir-sep">›</span>
            <span class="dir-crumb-current" :title="current.path">{{ current.path }}</span>
          </template>
        </div>
        <div v-if="pickerLoading" class="dir-status">读取中…</div>
        <template v-else-if="current === null">
          <div v-if="roots.length === 0" class="dir-status">无快捷根</div>
          <div class="dir-list">
            <button v-for="r in roots" :key="r.path" type="button" class="dir-row" @click="enterDir(r.path)">
              <span class="dir-name"><Icon name="folder" :size="13" />{{ r.name }}</span>
              <span class="dir-path">{{ r.path }}</span>
            </button>
          </div>
        </template>
        <template v-else>
          <div v-if="current.error" class="dir-error">{{ current.error }}</div>
          <div class="dir-list">
            <button v-if="current.parent" type="button" class="dir-row dir-up" @click="enterDir(current.parent)">
              <span class="dir-name">..</span>
              <span class="dir-path">{{ current.parent }}</span>
            </button>
            <button v-for="d in current.dirs" :key="d.path" type="button" class="dir-row" @click="enterDir(d.path)">
              <span class="dir-name"><Icon name="folder" :size="13" />{{ d.name }}</span>
              <span class="dir-path">{{ d.path }}</span>
            </button>
            <div v-if="!current.error && current.dirs.length === 0" class="dir-status">无子目录（可直接「选择当前目录」）</div>
          </div>
        </template>
      </div>
      <template #footer>
        <Button variant="ghost" size="sm" @click="pickerOpen = false">取消</Button>
        <Button variant="primary" size="sm" :disabled="!current?.path" title="把当前目录的绝对路径加入白名单" @click="pickCurrent">选择当前目录</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.path-editor { display: flex; flex-direction: column; gap: 8px; }
.path-empty { font-size: 12px; color: var(--text-3); padding: 8px 10px; background: var(--bg-hover); border-radius: var(--r-sm); }
.path-list { display: flex; flex-direction: column; gap: 4px; }
.path-row {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 6px 4px 10px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--bg-base);
}
.path-value { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12px; color: var(--text-2); word-break: break-all; }
.path-x {
  border: none; background: transparent; color: var(--text-3); cursor: pointer; flex-shrink: 0;
  font-size: 12px; width: 20px; height: 20px; border-radius: var(--r-sm);
  display: inline-flex; align-items: center; justify-content: center;
}
.path-x:hover { color: var(--err); background: color-mix(in srgb, var(--err) 10%, transparent); }
.path-add { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.path-input {
  flex: 1; min-width: 200px; padding: 6px 9px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 12px; font-family: var(--font-mono);
}
.path-input:focus { outline: none; border-color: var(--input-focus); }

/* 目录选择弹窗 */
.dir-picker { padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; min-height: 240px; }
.dir-crumbs { display: flex; align-items: center; gap: 6px; font-size: 12px; flex-wrap: wrap; }
.dir-crumb {
  border: none; background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
  padding: 2px 6px; border-radius: var(--r-sm);
}
.dir-crumb:hover { background: var(--bg-hover); color: var(--text-1); }
.dir-crumb.active { color: var(--primary); background: var(--primary-light); font-weight: 500; }
.dir-sep { color: var(--text-3); }
.dir-crumb-current { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); word-break: break-all; }
.dir-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; flex: 1; min-height: 0; }
.dir-row {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px;
  border: none; border-radius: var(--r-sm); background: transparent; cursor: pointer; text-align: left;
}
.dir-row:hover { background: var(--bg-hover); }
.dir-name { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-1); flex-shrink: 0; }
.dir-up .dir-name { color: var(--text-3); font-family: var(--font-mono); }
.dir-path { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dir-status { font-size: 12px; color: var(--text-3); padding: 8px 4px; }
.dir-error { font-size: 12px; color: var(--err); padding: 6px 8px; background: color-mix(in srgb, var(--err) 8%, transparent); border-radius: var(--r-sm); }
</style>
