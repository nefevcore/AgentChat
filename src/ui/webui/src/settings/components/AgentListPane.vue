<script setup lang="ts">
// ============================================================
// AgentListPane.vue —— Agent 池（列表 + 添加 + 删除）
// 形态与模型/搜索池一致：点击条目进入该 Agent 配置（AgentPane）
// ============================================================
import { ref, computed } from 'vue';
import type { AgentBrief } from '../useSettings';
import { toFields } from '../schema';
import { Modal, Button } from '@/ui';
import ConfirmDialog from './ConfirmDialog.vue';

const props = defineProps<{
  agents: AgentBrief[];
  llmSchemas: Record<string, any[]>;
}>();
const emit = defineEmits<{
  (e: 'edit', agentId: string): void;
  (e: 'create', payload: { id?: string; name: string; provider?: string; llm?: Record<string, any> }): void;
  (e: 'delete', agentId: string): void;
}>();

const showCreate = ref(false);
const error = ref('');
const searchQuery = ref('');

const filteredAgents = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return props.agents;
  return props.agents.filter(a =>
    (a.name || '').toLowerCase().includes(q) ||
    a.id.toLowerCase().includes(q) ||
    (a.tags || []).some(t => t.toLowerCase().includes(q))
  );
});

// 创建弹窗
const draftId = ref('');
const draftName = ref('');
const draftProvider = ref('');
const draftModel = ref('');
const providerOptions = computed(() => Object.keys(props.llmSchemas));

function openCreate() {
  draftId.value = '';
  draftName.value = '';
  draftProvider.value = '';
  draftModel.value = '';
  error.value = '';
  showCreate.value = true;
}
function onProviderChange(p: string) {
  draftProvider.value = p;
  const schema = props.llmSchemas[p];
  const modelField = schema ? toFields(schema).find(f => f.key === 'model') : undefined;
  draftModel.value = typeof modelField?.default === 'string' ? modelField.default : '';
}
function submitCreate() {
  const name = draftName.value.trim();
  if (!name) { error.value = '请输入 Agent 名称'; return; }
  const id = draftId.value.trim() || undefined;
  const payload: { id?: string; name: string; provider?: string; llm?: Record<string, any> } = { id, name };
  if (draftProvider.value) {
    payload.provider = draftProvider.value;
    payload.llm = { provider: draftProvider.value };
    if (draftModel.value.trim()) payload.llm.model = draftModel.value.trim();
  }
  emit('create', payload);
  showCreate.value = false;
}

async function requestDelete(agentId: string, name: string) {
  const ok = await confirmRef.value?.ask({
    title: '删除 Agent？',
    message: `确定删除 Agent "${name}" 吗？\n此操作将删除该 Agent 的所有配置、会话历史和凭据。`,
    confirmLabel: '永久删除',
    danger: true,
  });
  if (!ok) return;
  emit('delete', agentId);
}

/** 通用确认弹窗（删除 Agent 用，替代原生 confirm） */
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);

/** 组件生命周期内稳定的缓存破坏时间戳（避免上传头像后列表显示旧缓存） */
const avatarTs = Date.now();
function avatarOf(a: AgentBrief): string {
  return `${a.avatar ?? `/api/agents/${encodeURIComponent(a.id)}/avatar`}?t=${avatarTs}`;
}

/** 内置 tag 的说明文案 */
const TAG_HINTS: Record<string, string> = {
  agent: '基础能力',
  admin: '系统管理工具',
  dev: '开发工具',
  conductor: '子代理编排',
};
function tagHint(t: string): string {
  return TAG_HINTS[t] || `领域标签：${t}`;
}
</script>

<template>
  <div class="agent-pool">
    <div class="agent-pool-head">
      <span class="agent-pool-title">Agent 设置</span>
      <button class="agent-pool-add" @click="openCreate">+ 添加 Agent</button>
    </div>
    <div class="agent-pool-desc">管理所有 Agent。点击条目进入配置；虚拟 Agent（如 user）无配置文件，仅作路由端点。</div>

    <div class="agent-pool-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input v-model="searchQuery" class="agent-pool-search-input" placeholder="搜索 Agent（名称 / ID / 标签）" />
    </div>

    <div v-if="agents.length === 0" class="agent-pool-empty">暂无 Agent，点击"+ 添加 Agent"创建</div>
    <div v-else-if="filteredAgents.length === 0" class="agent-pool-empty">未找到匹配的 Agent</div>
    <div v-else class="agent-pool-list">
      <div v-for="a in filteredAgents" :key="a.id" class="agent-pool-item" @click="emit('edit', a.id)">
        <div class="agent-pool-avatar">
          <img v-if="a.avatar || !a.virtual" :src="avatarOf(a)" :alt="a.name || a.id" @error="($event.target as HTMLImageElement).style.display='none'" />
          <span class="agent-pool-ph">{{ (a.name || a.id).charAt(0).toUpperCase() }}</span>
        </div>
        <div class="agent-pool-info">
          <span class="agent-pool-name">{{ a.name || a.id }}</span>
          <span class="agent-pool-id">
            {{ a.id }}
            <span v-if="a.virtual" class="agent-pool-badge">虚拟</span>
          </span>
          <div v-if="a.tags && a.tags.length > 0" class="agent-pool-tags">
            <span
              v-for="t in a.tags" :key="t"
              class="agent-pool-tag" :class="'tag-' + t"
              :title="tagHint(t)"
            >{{ t }}</span>
          </div>
        </div>
        <div class="agent-pool-actions" @click.stop>
          <button class="agent-pool-btn" @click="emit('edit', a.id)" title="进入配置">编辑</button>
          <button class="agent-pool-btn danger" @click="requestDelete(a.id, a.name || a.id)" title="永久删除">删除</button>
        </div>
      </div>
    </div>

    <!-- 创建弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="showCreate" title="新建 Agent" :width="440" :z-index="1200" @close="showCreate = false">
      <div class="ap-modal-body">
        <div class="ap-row">
          <label>名称</label>
          <input v-model="draftName" type="text" class="ap-input" placeholder="Agent 显示名称" />
        </div>
        <div class="ap-row">
          <label>ID</label>
          <input v-model="draftId" type="text" class="ap-input" placeholder="留空自动生成（字母/数字/连字符/下划线）" />
        </div>
        <div class="ap-row">
          <label>模型 Provider</label>
          <div class="ap-desc">可选；留空则继承全局默认模型</div>
          <select class="ap-input" :value="draftProvider" @change="onProviderChange(($event.target as HTMLSelectElement).value)">
            <option value="">继承全局</option>
            <option v-for="p in providerOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div v-if="draftProvider" class="ap-row">
          <label>模型名称</label>
          <input v-model="draftModel" type="text" class="ap-input" placeholder="模型 ID" />
        </div>
        <div v-if="error" class="ap-error">{{ error }}</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="showCreate = false">取消</Button>
        <Button variant="primary" @click="submitCreate">创建</Button>
      </template>
    </Modal>

    <!-- 删除 Agent 确认弹窗 -->
    <ConfirmDialog ref="confirmRef" />
  </div>
</template>

<style scoped>
.agent-pool { display: flex; flex-direction: column; gap: 12px; }
.agent-pool-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.agent-pool-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.agent-pool-add {
  padding: 5px 14px; border: 1px solid var(--primary); border-radius: var(--r-md);
  background: transparent; color: var(--primary); font-size: 12px; cursor: pointer; transition: all var(--dur-fast);
}
.agent-pool-add:hover { background: var(--primary-light); }
.agent-pool-desc { font-size: 11px; color: var(--text-3); }
.agent-pool-search { position: relative; display: flex; align-items: center; }
.agent-pool-search svg { position: absolute; left: 9px; color: var(--text-3); pointer-events: none; }
.agent-pool-search-input {
  width: 100%; padding: 6px 10px 6px 28px;
  border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
}
.agent-pool-search-input:focus { outline: none; border-color: var(--input-focus); }
.agent-pool-search-input::placeholder { color: var(--text-3); }
.agent-pool-empty { text-align: center; padding: 24px; color: var(--text-3); font-size: 13px; }

.agent-pool-list { display: flex; flex-direction: column; gap: 6px; }
.agent-pool-item {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px;
  border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-surface); cursor: pointer;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.agent-pool-item:hover { border-color: var(--primary); }
.agent-pool-avatar {
  width: 38px; height: 38px; border-radius: var(--r-full); overflow: hidden; flex-shrink: 0;
  background: var(--primary-light); display: flex; align-items: center; justify-content: center; position: relative;
}
.agent-pool-avatar img { width: 100%; height: 100%; object-fit: cover; position: relative; z-index: 1; }
.agent-pool-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 600; color: var(--primary); }
.agent-pool-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.agent-pool-name { font-size: 13px; font-weight: 500; color: var(--text-1); }
.agent-pool-id { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.agent-pool-badge {
  margin-left: 6px; padding: 1px 6px; border-radius: var(--r-full);
  background: var(--bg-hover); color: var(--text-2); font-size: 10px; font-family: var(--font-ui);
}
.agent-pool-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.agent-pool-tag {
  padding: 2px 8px; border-radius: var(--r-full);
  background: var(--bg-hover); border: none;
  color: var(--text-2); font-size: 11px; line-height: 1.5; cursor: default;
  transition: all var(--dur-fast);
}
.agent-pool-tag:hover { color: var(--primary); }
.agent-pool-tag.tag-agent { color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, transparent); }
.agent-pool-tag.tag-admin { color: #dc2626; background: rgba(220,38,38,.08); }
.agent-pool-tag.tag-dev { color: #059669; background: rgba(5,150,105,.08); }
.agent-pool-tag.tag-conductor { color: #7c3aed; background: rgba(124,58,237,.08); }
.agent-pool-actions { display: flex; gap: 6px; flex-shrink: 0; }
.agent-pool-btn {
  padding: 4px 11px; border: none; border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; transition: all var(--dur-fast);
}
.agent-pool-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.agent-pool-btn.danger { color: var(--err); }
.agent-pool-btn.danger:hover { background: color-mix(in srgb, var(--err) 10%, transparent); color: var(--err); }
.agent-pool-btn.danger { color: var(--err); border-color: rgba(231,76,60,.4); }
.agent-pool-btn.danger:hover { background: rgba(231,76,60,.08); }

.ap-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.ap-row { display: flex; flex-direction: column; gap: 4px; }
.ap-row label { font-size: 12px; color: var(--text-2); }
.ap-desc { font-size: 11px; color: var(--text-3); }
.ap-input {
  padding: 6px 9px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
}
.ap-input:focus { outline: none; border-color: var(--input-focus); }
.ap-error { color: var(--err); font-size: 12px; }
</style>
