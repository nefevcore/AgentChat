<!-- InputMention.vue —— 输入框快捷输入弹层（/ 命令与技能、@ 引用）
  纯展示组件：数据/过滤/键盘由 ChatInput 持有（active 以 item.key 同步），
  这里只渲染分组列表 + 文件区导航头（@ 模式：当前目录 / 上级 / 位置快跳）。
  行用 @mousedown.prevent 保持 textarea 焦点（点击选择不闪 blur）。 -->
<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { Icon } from '../../ui';

/** 弹层条目（ChatInput 构造；nav/insert/command 三选一决定选中行为） */
export interface MentionItem {
  /** 稳定键（键盘 active 态与列表 key 对齐） */
  key: string;
  icon: string;
  label: string;
  /** 次行说明（命令/技能描述；ellipsis 截断） */
  hint?: string;
  /** 行尾小字（如 agent id / 技能来源） */
  detail?: string;
  /** 目录条目：选中 = 导航进该目录（不插入文本） */
  nav?: string;
  /** 选中插入的文本（缺省 = 本地命令动作，不插入） */
  insert?: string;
  /** 本地命令动作（ChatInput 侧执行） */
  command?: 'stop' | 'archive' | 'goal' | 'timer';
  /** 破坏性动作（停止生成：图标红显） */
  danger?: boolean;
}

export interface MentionGroup {
  key: string;
  label: string;
  items: MentionItem[];
}

const props = defineProps<{
  groups: MentionGroup[];
  /** 当前键盘 active 条目 key（null = 无） */
  activeKey: string | null;
  /** @ 模式文件区：当前目录（undefined = 无文件导航头） */
  cwd?: string;
  parent?: string;
  /** 位置快跳 chips（browseRoots：家目录 / 数据根 / 已登记工作区） */
  roots?: Array<{ name: string; path: string }>;
  loading?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'select', item: MentionItem, via?: 'primary' | 'insert'): void;
  (e: 'hover', key: string): void;
  (e: 'navigate', path: string): void;
}>();

const listEl = ref<HTMLElement>();

/** active 变化时滚进行内（键盘导航越界时贴边可见） */
watch(() => props.activeKey, async () => {
  await nextTick();
  const el = listEl.value?.querySelector<HTMLElement>(`[data-key="${CSS.escape(props.activeKey ?? '')}"]`);
  el?.scrollIntoView({ block: 'nearest' });
});

const itemCount = computed(() => props.groups.reduce((n, g) => n + g.items.length, 0));
</script>

<template>
  <!-- @click.stop：弹层内交互（目录导航/位置快跳）不冒泡到 document——
       否则 ChatInput 的 onDocClick 会在导航完成后立刻关掉弹层 -->
  <div class="im-pop" @click.stop>
    <!-- 文件区导航头（@ 模式）：上级 + 当前路径 + 位置快跳 -->
    <div v-if="cwd !== undefined" class="im-filebar">
      <button
        v-if="parent"
        type="button"
        class="im-up"
        title="上一级"
        @mousedown.prevent
        @click="emit('navigate', parent)"
      >
        <Icon name="arrow-up" :size="13" />
      </button>
      <span class="im-cwd" :title="cwd">{{ cwd }}</span>
      <div v-if="roots && roots.length > 0" class="im-roots">
        <button
          v-for="r in roots" :key="r.path" type="button" class="im-root-chip"
          :class="{ active: r.path === cwd }"
          :title="r.path"
          @mousedown.prevent
          @click="emit('navigate', r.path)"
        >{{ r.name }}</button>
      </div>
    </div>

    <div ref="listEl" class="im-list">
      <div v-if="loading" class="im-empty">加载中…</div>
      <div v-else-if="error" class="im-empty im-error">{{ error }}</div>
      <div v-else-if="itemCount === 0" class="im-empty">无匹配项</div>
      <template v-for="g in groups" :key="g.key">
        <div v-if="g.items.length > 0" class="im-group-label">{{ g.label }}</div>
        <button
          v-for="item in g.items"
          :key="item.key"
          type="button"
          class="im-item"
          :class="{ active: item.key === activeKey, danger: item.danger }"
          :data-key="item.key"
          :title="item.hint ? `${item.label} — ${item.hint}` : item.label"
          @mousedown.prevent
          @mouseenter="emit('hover', item.key)"
          @click="emit('select', item)"
        >
          <span class="im-item-icon"><Icon :name="item.icon" :size="15" /></span>
          <span class="im-item-body">
            <span class="im-item-label">{{ item.label }}</span>
            <span v-if="item.hint" class="im-item-hint">{{ item.hint }}</span>
          </span>
          <span v-if="item.detail" class="im-item-detail">{{ item.detail }}</span>
          <!-- 目录行双出口：进入（行点击/Enter = 主操作）｜引用（按钮/Tab =
               插入 @路径/ 引用，read 目录即列表） -->
          <span v-if="item.nav" class="im-row-actions">
            <button
              v-if="item.insert"
              type="button"
              class="im-ref-btn"
              title="插入为目录引用（@路径/，Agent 可 read 列目录）"
              @mousedown.prevent
              @click.stop="emit('select', item, 'insert')"
            >引用</button>
            <Icon name="chevron-right" :size="13" class="im-item-go" />
          </span>
        </button>
      </template>
    </div>

    <div class="im-foot">↑↓ 选择 · Enter 确认/进入目录 · Tab 引用目录 · Esc 关闭</div>
  </div>
</template>

<style scoped>
.im-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  width: min(440px, 100%);
  background: var(--bg-raised, var(--color-bg-page));
  border: 1px solid var(--line, var(--color-border-secondary));
  border-radius: 10px;
  box-shadow: var(--shadow-pop, 0 4px 16px rgba(0,0,0,.12));
  z-index: 320;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 文件区导航头 */
.im-filebar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  background: var(--color-bg-subtle, transparent);
  min-width: 0;
}

.im-up {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.im-up:hover { background: var(--role-hover-bg, var(--bg-hover)); color: var(--color-text-primary); }

.im-cwd {
  flex-shrink: 1;
  min-width: 40px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--color-text-tertiary, #a8abb2);
}

.im-roots {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  flex-shrink: 0;
  max-width: 55%;
  scrollbar-width: none;
}
.im-roots::-webkit-scrollbar { display: none; }

.im-root-chip {
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.im-root-chip:hover { border-color: var(--color-primary); color: var(--color-primary); }
.im-root-chip.active { border-color: var(--color-primary); color: var(--color-primary); background: var(--color-primary-light); }

/* 列表 */
.im-list {
  max-height: 264px;
  overflow-y: auto;
  padding: 4px;
}

.im-group-label {
  padding: 4px 10px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-tertiary, #a8abb2);
  letter-spacing: .3px;
}

.im-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-1, var(--color-text-primary));
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.im-item:hover, .im-item.active { background: var(--role-hover-bg, var(--bg-hover)); }
.im-item.active { color: var(--role-selected-text, #4f46e5); }

.im-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}
.im-item.active .im-item-icon { color: inherit; }
.im-item.danger .im-item-icon { color: var(--color-error, #e74c3c); }

.im-item-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.im-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.im-item-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-text-tertiary, #a8abb2);
  margin-top: 1px;
}

.im-item-detail {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 8px;
  font-size: 11px;
  color: var(--color-text-tertiary, #a8abb2);
}

.im-item-go { flex-shrink: 0; color: var(--color-text-tertiary, #a8abb2); }

.im-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* 目录行"引用"次操作：轻量文字按钮（行主体点击 = 进入） */
.im-ref-btn {
  padding: 1px 7px;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.im-ref-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--color-primary-light);
}

.im-empty {
  padding: 14px 12px;
  font-size: 12px;
  color: var(--color-text-tertiary, #a8abb2);
  text-align: center;
}
.im-error { color: var(--color-error, #e74c3c); }

.im-foot {
  padding: 4px 10px;
  border-top: 1px solid var(--color-border-secondary, #e0e0e0);
  font-size: 11px;
  color: var(--color-text-tertiary, #a8abb2);
  text-align: center;
  flex-shrink: 0;
}
</style>
