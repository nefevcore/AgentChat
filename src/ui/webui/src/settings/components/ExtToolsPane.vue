<script setup lang="ts">
// ============================================================
// ExtToolsPane.vue —— 扩展与工具（左右布局，全局/Agent 双模式复用）
// 左侧：7 种 hook kind + 工具；右侧：清单 + 详情/配置弹窗
// 模式差异：
//   · agent：钩子可开关/拖拽（写 plugins 声明），工具显示自动/显式标注 + 可追加
//   · global：钩子仅目录 + 默认配置入口（无开关），工具仅目录 + 命名空间配置入口
// ============================================================
import { ref, computed } from 'vue';
import type { PluginMeta } from '../types';
import type { AgentToolInfo } from '../api';
import { Icon, Modal, Button } from '@/ui';
import NsFieldList from './NsFieldList.vue';

const props = defineProps<{
  mode: 'agent' | 'global';
  /** 钩子目录（含 kind；agent 数据带 enabled） */
  hooks: PluginMeta[];
  /** 当前 plugins 声明：{ runStart?: string[], toolExecutionStart?: string[], tools?: string[], ... } */
  decl: Record<string, any>;
  /** 编辑声明（agent 模式切换/拖拽/工具追加；global 不传 = 只读） */
  onDecl?: (patch: Record<string, any>) => void;
  /** 工具数据：catalog 全量目录 + enabled（agent 装配快照）+ explicit 显式声明 */
  tools: { catalog: AgentToolInfo[]; enabled: string[]; explicit: string[] };
  /** agent 能力标签（toolStatus/canAddTool/hasTag 用；global 传空） */
  tags?: string[];
  /** 命名空间 schema（弹窗配置表单） */
  nsSchemas: Record<string, any[]>;
  /** 弹窗配置编辑对象（钩子/工具命名空间配置均写全局） */
  config: Record<string, any>;
  /** agent 路径白名单（security-check 弹窗只读概览用） */
  allowedPaths?: string[];
}>();

const isAgent = computed(() => props.mode === 'agent');

// ── 左侧导航 ──
const HOOK_KIND_NAV: { kind: string; label: string }[] = [
  { kind: 'runStart', label: '请求前' },
  { kind: 'turnStart', label: '轮次开始' },
  { kind: 'toolExecutionStart', label: '工具执行前' },
  { kind: 'toolExecutionEnd', label: '工具执行后' },
  { kind: 'turnEnd', label: '轮次结束' },
  { kind: 'runEnd', label: '响应后' },
  { kind: 'fallback', label: '兜底' },
];
const selectedKind = ref<string>('runStart');

function kindCount(kind: string): number { return props.hooks.filter(p => p.kind === kind).length; }
const toolCount = computed(() => props.tools.catalog.length);
function kindLabelOf(kind: string): string {
  return HOOK_KIND_NAV.find(k => k.kind === kind)?.label ?? kind;
}

// ── 钩子清单 ──
function enabledNamesOf(kind: string): string[] {
  const arr = props.decl[kind];
  return Array.isArray(arr) ? arr : [];
}
/** 该 kind 清单：agent=启用按声明顺序 + 禁用目录排后；global=目录顺序全量（只读） */
function hooksOfKind(kind: string): (PluginMeta & { enabled: boolean })[] {
  const byName = new Map<string, PluginMeta>(props.hooks.map(p => [p.name, p]));
  if (!isAgent.value) {
    return props.hooks.filter(p => p.kind === kind).map(p => ({ ...p, enabled: false }));
  }
  const enabled: string[] = enabledNamesOf(kind);
  const on: (PluginMeta & { enabled: boolean })[] = [];
  for (const n of enabled) { const p = byName.get(n); if (p) on.push({ ...p, enabled: true }); }
  const off: (PluginMeta & { enabled: boolean })[] = props.hooks
    .filter(p => p.kind === kind && !enabled.includes(p.name))
    .map(p => ({ ...p, enabled: false }));
  return [...on, ...off];
}
function toggleHook(kind: string, name: string, on: boolean): void {
  if (!props.onDecl) return;
  const cur = enabledNamesOf(kind);
  const next = on ? (cur.includes(name) ? cur : [...cur, name]) : cur.filter(n => n !== name);
  props.onDecl({ [kind]: next });
}

// ── 详情/配置弹窗（钩子；configNs / security 由后端 hook 目录透出，无前端硬编码） ──
function cfgNs(p: PluginMeta): string { return p.configNs ?? ''; }
function hasHookCfg(p: PluginMeta): boolean {
  return (p.configNs ?? '') !== '' || p.security === true;
}
const detailHook = ref<{ kind: string; p: PluginMeta } | null>(null);
function openDetail(kind: string, p: PluginMeta) { detailHook.value = { kind, p }; }
function isHookEnabled(kind: string, name: string): boolean { return enabledNamesOf(kind).includes(name); }

// ── 工具区 ──
type ToolStatus = 'auto' | 'explicit' | 'off';
function toolStatus(name: string): ToolStatus {
  if (!isAgent.value) return 'off';
  if (props.tools.explicit.includes(name)) return 'explicit';
  if (props.tools.enabled.includes(name)) return 'auto';
  return 'off';
}
function canAddTool(t: AgentToolInfo): boolean {
  if (!t.requires || t.requires.length === 0) return true;
  const tags = new Set(['agent', ...(props.tags ?? [])]);
  return t.requires.every(r => tags.has(r));
}
function hasTag(r: string): boolean {
  return r === 'agent' || (props.tags ?? []).includes(r);
}
function addTool(name: string): void {
  if (!props.onDecl) return;
  const cur = enabledNamesOf('tools');
  props.onDecl({ tools: cur.includes(name) ? cur : [...cur, name] });
}
function removeTool(name: string): void {
  if (!props.onDecl) return;
  props.onDecl({ tools: enabledNamesOf('tools').filter(n => n !== name) });
}
function hasToolCfg(t: AgentToolInfo): boolean {
  return !!t.ns && !!(props.nsSchemas as any)[t.ns];
}
const toolDetail = ref<AgentToolInfo | null>(null);
function openToolDetail(t: AgentToolInfo) { toolDetail.value = t; }

// ── 拖拽排序（agent） ──
const dragType = ref('');
const dragIndex = ref(-1);
function onDragStart(kind: string, idx: number) { dragType.value = kind; dragIndex.value = idx; }
function onDrop(kind: string, targetIdx: number): void {
  if (!props.onDecl || dragType.value !== kind || dragIndex.value === targetIdx) return;
  const arr = [...enabledNamesOf(kind)];
  if (targetIdx < 0 || targetIdx >= arr.length) return;
  const [item] = arr.splice(dragIndex.value, 1);
  arr.splice(targetIdx, 0, item);
  props.onDecl({ [kind]: arr });
  dragType.value = '';
  dragIndex.value = -1;
}
</script>

<template>
  <div class="ext-pane">
    <div v-if="!isAgent" class="ext-global-hint">全局钩子为目录与默认配置（启用/停用在各 Agent 面板「扩展与工具」）</div>
    <div class="ext-layout">
      <!-- 左侧导航 -->
      <div class="ext-side">
        <div
          v-for="k in HOOK_KIND_NAV" :key="k.kind"
          class="ext-side-item" :class="{ active: selectedKind === k.kind }"
          @click="selectedKind = k.kind"
        >
          <span>{{ k.label }}</span>
          <span class="ext-side-count">{{ kindCount(k.kind) }}</span>
        </div>
        <div class="ext-side-item" :class="{ active: selectedKind === 'tool' }" @click="selectedKind = 'tool'">
          <span>工具</span>
          <span class="ext-side-count">{{ toolCount }}</span>
        </div>
      </div>

      <!-- 右侧清单 -->
      <div class="ext-main">
        <!-- 工具区 -->
        <template v-if="selectedKind === 'tool'">
          <div class="ext-main-head">
            <span class="ext-main-title">工具</span>
            <span class="ext-main-count">{{ toolCount }} 个</span>
          </div>
          <div class="info-desc" v-if="isAgent">工具按能力标签（tags → requires）自动注入，也可在此手动追加声明</div>
          <div class="info-desc" v-else>全局工具目录：各 Agent 按能力标签自动注入；命名空间配置可在此调整默认值</div>
          <div v-if="tools.catalog.length === 0" class="ext-hint">暂无可用工具</div>
          <div v-else class="ext-tool-list">
            <div
              v-for="t in tools.catalog" :key="'t-' + t.name"
              class="hook-row"
              @click="openToolDetail(t)"
            >
              <span class="hook-drag-off">·</span>
              <div class="hook-main">
                <span class="hook-name-row">
                  <span class="hook-name">{{ t.label || t.name }}</span>
                  <span v-if="hasToolCfg(t)" class="cfg-badge" title="可配置，点击行查看">配置</span>
                  <span v-if="t.requires && t.requires.length" class="tool-tags">
                    <span
                      v-for="r in t.requires" :key="r"
                      class="tool-tag" :class="{ on: hasTag(r), miss: !hasTag(r) }"
                      :title="hasTag(r) ? '已具备此标签' : '缺少此标签，无法启用'"
                    >{{ r }}</span>
                  </span>
                </span>
                <span class="hook-desc">{{ t.description }}</span>
              </div>
              <template v-if="isAgent">
                <span v-if="toolStatus(t.name) === 'auto'" class="tool-badge auto" title="由能力标签自动注入">自动</span>
                <span v-else-if="toolStatus(t.name) === 'explicit'" class="tool-badge exp" title="已在 plugins.tools 显式声明">显式</span>
                <button v-if="toolStatus(t.name) === 'explicit'" class="tool-act danger" @click.stop="removeTool(t.name)" title="移除显式声明">移除</button>
                <button v-else-if="toolStatus(t.name) === 'off' && canAddTool(t)" class="tool-act" @click.stop="addTool(t.name)" title="追加到 plugins.tools">添加</button>
              </template>
            </div>
          </div>
        </template>

        <!-- 钩子区 -->
        <template v-else>
          <div class="ext-main-head">
            <span class="ext-main-title">{{ kindLabelOf(selectedKind) }}</span>
            <span class="ext-main-count">{{ kindCount(selectedKind) }} 个能力</span>
          </div>
          <div class="info-desc" v-if="isAgent">拖动调整执行顺序 · 开关启用/停用（关闭保留位置）</div>
          <div class="info-desc" v-else>全局目录：点击行查看该能力的默认配置</div>
          <div v-if="hooksOfKind(selectedKind).length === 0" class="ext-hint">暂无该类型的能力</div>
          <div
            v-for="(p, idx) in hooksOfKind(selectedKind)" :key="'h-' + p.name"
            class="hook-row" :class="{ off: isAgent && !p.enabled }"
            :draggable="isAgent && p.enabled"
            @dragstart="isAgent && p.enabled && onDragStart(selectedKind, idx)"
            @dragover.prevent
            @drop="onDrop(selectedKind, idx)"
            @click="openDetail(selectedKind, p)"
          >
            <span v-if="isAgent && p.enabled" class="hook-drag" title="拖动排序"><Icon name="grip-vertical" :size="13" /></span>
            <span v-else class="hook-drag-off">·</span>
            <div class="hook-main">
              <span class="hook-name-row">
                <span class="hook-name">{{ p.label }}</span>
                <span v-if="hasHookCfg(p)" class="cfg-badge" title="可配置，点击行查看">配置</span>
              </span>
              <span class="hook-desc">{{ p.description }}</span>
            </div>
            <label v-if="isAgent" class="hook-toggle" :title="p.enabled ? '停用' : '启用'" @click.stop>
              <input type="checkbox" :checked="p.enabled" @change="toggleHook(selectedKind, p.name, ($event.target as HTMLInputElement).checked)" />
            </label>
          </div>
        </template>
      </div>
    </div>

    <!-- 钩子详情弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="!!detailHook" :title="detailHook?.p.label ?? ''" :width="440" :z-index="1200" @close="detailHook = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ detailHook?.p.description }}</div>
        <div class="ext-modal-status" v-if="detailHook && isAgent">
          当前状态：{{ isHookEnabled(detailHook.kind, detailHook.p.name) ? '已启用' : '已停用' }}
        </div>
        <div class="ext-modal-status" v-else-if="detailHook">全局默认配置（各 Agent 可覆盖）</div>
        <template v-if="detailHook?.p.configNs">
          <div class="ext-modal-cfg">
            <div class="ext-modal-cfg-title">配置项</div>
            <NsFieldList :ns-key="detailHook.p.configNs" :config="config" :schema="(nsSchemas as any)[detailHook.p.configNs]" :title="'配置'" />
          </div>
        </template>
        <template v-else-if="detailHook?.p.security">
          <div class="ext-modal-cfg">
            <div class="ext-modal-cfg-title">当前路径白名单</div>
            <div v-if="(allowedPaths?.length ?? 0) > 0" class="ext-sec-paths">
              <div v-for="p in allowedPaths" :key="p" class="ext-sec-path">{{ p }}</div>
            </div>
            <div v-else class="ext-sec-none">{{ isAgent ? '未配置 — 仅允许工作区内路径' : '全局未配置（白名单在各 Agent 安全页签）' }}</div>
            <div v-if="isAgent" class="ext-sec-goto">路径白名单在「安全」页签编辑</div>
          </div>
        </template>
        <div v-else-if="detailHook" class="ext-modal-none">此能力无额外配置项</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="detailHook = null">关闭</Button>
      </template>
    </Modal>

    <!-- 工具配置弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="!!toolDetail" :title="toolDetail ? (toolDetail.label || toolDetail.name) : ''" :width="440" :z-index="1200" @close="toolDetail = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ toolDetail?.description }}</div>
        <div class="ext-modal-status" v-if="toolDetail && isAgent">
          {{ toolStatus(toolDetail.name) === 'auto' ? '由能力标签自动注入' : toolStatus(toolDetail.name) === 'explicit' ? '已在 plugins.tools 显式声明' : '未启用' }}
          <span v-if="toolDetail.requires && toolDetail.requires.length" class="ext-modal-tags">
            <span v-for="r in toolDetail.requires" :key="r" class="tool-tag" :class="{ on: hasTag(r), miss: !hasTag(r) }">{{ r }}</span>
          </span>
        </div>
        <div class="ext-modal-status" v-else-if="toolDetail">全局工具（各 Agent 按能力标签自动注入）</div>
        <template v-if="toolDetail?.ns && (nsSchemas as any)[toolDetail.ns]">
          <div class="ext-modal-cfg">
            <div class="ext-modal-cfg-title">配置项</div>
            <NsFieldList :ns-key="toolDetail.ns" :config="config" :schema="(nsSchemas as any)[toolDetail.ns]" :title="'配置'" />
          </div>
        </template>
        <div v-else-if="toolDetail" class="ext-modal-none">此工具无额外配置项</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="toolDetail = null">关闭</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* ── 左右布局（与 Agent 面板一致） ──
   根元素 .ext-pane 需 :global（scoped 不命中组件自身根），唯一使用者无冲突 */
:global(.ext-pane) { display: flex; flex-direction: column; gap: 10px; height: 100%; flex: 1; min-height: 0; }
.ext-global-hint { font-size: 11px; color: var(--text-3); background: var(--bg-hover); border-radius: var(--r-sm); padding: 6px 10px; }
.ext-layout { display: flex; gap: 12px; min-height: 0; flex: 1; height: 100%; }
.ext-side { width: 150px; flex-shrink: 0; display: flex; flex-direction: column; gap: 3px; border-right: 1px solid var(--line); padding-right: 10px; overflow-y: auto; }
.ext-side-item {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 6px 10px; border-radius: var(--r-md); font-size: 12px; color: var(--text-2);
  cursor: pointer; transition: background var(--dur-fast), color var(--dur-fast);
}
.ext-side-item:hover { background: var(--bg-hover); }
.ext-side-item.active { background: var(--primary-light); color: var(--primary); font-weight: 500; }
.ext-side-count { font-size: 10px; min-width: 18px; text-align: center; padding: 0 5px; border-radius: var(--r-full); background: var(--bg-hover); color: var(--text-3); }
.ext-side-item.active .ext-side-count { background: var(--primary); color: #fff; }
.ext-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 0; padding-right: 6px; }
.ext-main-head { display: flex; align-items: center; gap: 8px; }
.ext-main-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
.ext-main-count { font-size: 11px; color: var(--text-3); }
.ext-hint { font-size: 12px; color: var(--text-3); padding: 2px 0; }
.info-desc { font-size: 11px; color: var(--text-3); }

/* ── 行 ── */
.hook-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-surface); cursor: pointer;
  transition: opacity var(--dur-fast), border-color var(--dur-fast);
}
.hook-row:hover { border-color: color-mix(in srgb, var(--primary) 40%, transparent); }
.hook-row.off { opacity: .55; }
.hook-drag { display: inline-flex; align-items: center; color: var(--text-3); cursor: grab; flex-shrink: 0; }
.hook-drag-off { color: var(--line-strong); font-size: 12px; flex-shrink: 0; }
.hook-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hook-name { font-size: 12px; font-weight: 500; color: var(--text-1); }
.hook-row.off .hook-name { color: var(--text-3); font-weight: 400; }
.hook-desc { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hook-toggle input { accent-color: var(--primary); cursor: pointer; }
.hook-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.hook-name-row .hook-name { white-space: nowrap; }

/* ── 工具 ── */
.tool-tags { display: inline-flex; gap: 3px; flex-shrink: 0; overflow: hidden; }
.tool-tag {
  font-size: 11px; line-height: 1; padding: 2px 8px; border-radius: 999px;
  font-family: var(--font-mono); white-space: nowrap;
}
.tool-tag.on { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.tool-tag.miss { color: var(--text-3); background: var(--bg-hover); }
.ext-modal-tags { display: inline-flex; gap: 4px; margin-left: 8px; vertical-align: middle; }
.cfg-badge {
  font-size: 10px; line-height: 1; padding: 2px 6px; border-radius: 999px; flex-shrink: 0;
  color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.tool-badge { flex-shrink: 0; font-size: 10px; line-height: 1; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.tool-badge.auto { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.tool-badge.exp { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.tool-act {
  flex-shrink: 0; border: none; background: transparent;
  color: var(--text-2); font-size: 11px; padding: 3px 10px; border-radius: var(--r-md);
  cursor: pointer; transition: border-color var(--dur-fast), color var(--dur-fast);
}
.tool-act:hover { background: var(--bg-hover); color: var(--text-1); }
.tool-act.danger { color: var(--err); }
.tool-act.danger:hover { background: color-mix(in srgb, var(--err) 10%, transparent); color: var(--err); }

/* ── 弹窗 ── */
.ext-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.ext-modal-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; }
.ext-modal-status { font-size: 12px; color: var(--text-1); }
.ext-modal-cfg { border: 1px solid var(--line); border-radius: var(--r-md); padding: 8px 10px; background: var(--bg-base); }
.ext-modal-cfg-title { font-size: 12px; font-weight: 600; color: var(--text-1); margin-bottom: 6px; }
.ext-modal-none { font-size: 12px; color: var(--text-3); padding: 8px 10px; background: var(--bg-hover); border-radius: var(--r-sm); }
.ext-sec-paths { display: flex; flex-direction: column; gap: 4px; }
.ext-sec-path { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); background: var(--bg-base); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 4px 8px; word-break: break-all; }
.ext-sec-none { font-size: 12px; color: var(--text-3); padding: 8px 10px; background: var(--bg-hover); border-radius: var(--r-sm); }
.ext-sec-goto { font-size: 12px; color: var(--primary); padding-top: 2px; }
</style>
