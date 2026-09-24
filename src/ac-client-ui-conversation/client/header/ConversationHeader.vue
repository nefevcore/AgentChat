<script setup lang="ts">
// ============================================================
// client/header/ConversationHeader.vue —— 会话头部（conversation-view-split-plan ②
// 自 ConversationView template+style 平迁：pair 双端点头 / 标题+预设徽标 /
// 思维链开关 / conversation:header-widget 席位 / 归档·忙碌反馈 chip 悬挂锚 /
// 窄屏 hamburger。store 与 inject 就地取（全局单例 / 跨层级注入成立——
// 祖先 shell → 后代 header 方向不变）；头部派生事实（title / presetChipLabel /
// ownerData）经 props 由视图的 identity 层喂入。
// ============================================================
import { computed, inject } from 'vue';
import { Avatar, Icon, FeedbackNotice, ThinkingIcon } from '@agentchat/webui-kit';
import SlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';
import { useChatStore } from '../chatStore.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import type { HeaderWidgetOwnerData } from '../useConversationIdentity.ts';

const props = defineProps<{
  /** pair 只读形态（双端点头分支） */
  isPair: boolean;
  /** 群形态（隐藏 hamburger 与反馈 chip 悬挂锚） */
  isGroup: boolean;
  /** pair 端点（其余形态为 null） */
  a?: string | null;
  b?: string | null;
  /** 会话标题（identity 派生） */
  title: string;
  /** 预设徽标文案（single 形态；空 = 不显示） */
  presetChipLabel: string;
  /** 席位 owner 上下文（conversation:header-widget SlotOutlet data） */
  ownerData: HeaderWidgetOwnerData;
}>();

const chatStore = useChatStore();
const ui = useUiStore();
const roster = useRosterCore();
/** 注入壳提供的移动端抽屉开合方法 */
const toggleDrawer = inject<() => void>('toggleDrawer', () => {});

/** pair 端点展示信息（system 端点特殊标签；头像/名称经名册解析） */
function endpointOf(id: string) {
  const isSystem = id === 'system';
  return {
    id,
    name: isSystem ? 'system（系统触发）' : (roster.getAgentName(id) || id),
    avatar: isSystem ? null : roster.getAgentAvatar(id),
  };
}
const epA = computed(() => endpointOf(props.a || ''));
const epB = computed(() => endpointOf(props.b || ''));
</script>

<template>
  <div class="chat-header">
    <template v-if="isPair">
      <div class="header-info">
        <div class="pair-title">
          <div class="pair-avatars">
            <Avatar v-if="epA.avatar" :src="epA.avatar" :name="epA.name" :size="26" />
            <span v-else class="ep-ic"><Icon name="zap" :size="13" /></span>
            <span class="pair-x"><Icon name="x" :size="9" /></span>
            <Avatar v-if="epB.avatar" :src="epB.avatar" :name="epB.name" :size="26" />
            <span v-else class="ep-ic"><Icon name="zap" :size="13" /></span>
          </div>
          <span class="agent-label">{{ epA.name }} × {{ epB.name }}</span>
          <span class="pair-sub">只读 · 双方视角</span>
        </div>
      </div>
    </template>

    <template v-else>
      <button v-if="!isGroup" class="hamburger-btn" @click="toggleDrawer" title="菜单">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
      </button>
      <div class="header-info">
        <span class="agent-label">{{ title }}</span>
        <!-- 预设徽标（single 开场固化后的身份回显——工具栏不再放预设入口） -->
        <span v-if="presetChipLabel" class="preset-chip" title="会话预设（开场时选定，发首条消息后锁定）">
          <Icon name="sparkles" :size="11" />
          {{ presetChipLabel }}
        </span>
      </div>
      <div class="header-actions">
        <!-- 思维链显示开关（全局 switch）：隐藏后思考文本、工具卡片与折叠栏
             整体不渲染，消息区仅显示正文回复。图标内嵌滑块（随开合滑动，
             关 = 灰/开 = 主色）——图标不再外置，压缩按钮整体宽度 -->
        <button
          class="thinking-switch"
          :class="{ on: ui.showThinking }"
          role="switch"
          :aria-checked="ui.showThinking"
          :title="ui.showThinking ? '思维链：显示中 · 点击隐藏（思考与工具轨迹）' : '思维链：已隐藏 · 点击显示'"
          @click="ui.setShowThinking(!ui.showThinking)"
        >
          <span class="thinking-switch-track"><span class="thinking-switch-knob"><ThinkingIcon :size="12" class="thinking-switch-icon" /></span></span>
        </button>

        <!-- 头部动作席位（list，order 序）：jobs chip（jobs 行 order 10）/
             Token 仪表（本行 order 20）/ System Prompt 预览（本行 order 25）/
             Agent·single 动作（agents·singles
             行 order 30）——贡献按 ownerProps.form 自取自gate，群/pair 形态
             全部自隐 -->
        <SlotOutlet name="conversation:header-widget" :data="ownerData" />

        <!-- 归档/忙碌反馈 chip 的悬挂锚（弹层关闭时反馈仍需可见，故 wrap
             保留为零宽锚点；single 压缩反馈同样经此悬挂） -->
        <div v-if="!isGroup" class="compress-wrap">
          <transition name="fade">
            <!-- 反馈语义控件：tone 派生图标/配色（替代文案内嵌 emoji 前缀的旧形态） -->
            <FeedbackNotice
              v-if="chatStore.compressFeedback"
              class="compress-feedback"
              variant="chip"
              :text="chatStore.compressFeedback"
              :tone="chatStore.compressTone"
            />
          </transition>
          <transition name="fade">
            <FeedbackNotice
              v-if="chatStore.busyFeedback"
              class="compress-feedback"
              variant="chip"
              :text="chatStore.busyFeedback"
              :tone="chatStore.busyTone"
            />
          </transition>
          <transition name="fade">
            <!-- 归档整理进行中（任意触发源：手工/阈值/夜间批量）——机制 run
                 流式隐藏，此状态条 + 输入框占位是对话面唯一感知。
                 busy tone = loader 旋转 + primary 色（进行中语义，非灰色） -->
            <FeedbackNotice
              v-if="chatStore.archivePending && !chatStore.compressFeedback && !chatStore.busyFeedback"
              class="compress-feedback"
              variant="chip"
              text="正在归档整理记忆…"
              tone="busy"
            />
          </transition>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-header {
  display: flex; align-items: center; gap: 10px;
  height: var(--layout-header-height); padding: 0 16px;
  border-bottom: 1px solid var(--color-border-secondary);
  background: var(--color-bg-page); flex-shrink: 0;
  backdrop-filter: blur(8px); z-index: 100;
}
.header-info { flex: 1; min-width: 0; }
/* 单行截断：主区被辅栏/主栏压缩时长标题（+ 头部 widget 挤压）不得换行
   撑破 48px 头部；pair 形态双端点名同理（.pair-title 已 min-width:0） */
.agent-label { font-size: 15px; font-weight: 600; color: var(--color-text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 汉堡菜单按钮：默认隐藏，窄屏显示 */
.hamburger-btn {
  display: none; background: none; border: none; cursor: pointer;
  color: var(--color-text-secondary); padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.hamburger-btn:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }

.header-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; align-self: stretch; }

/* ── 思维链显示开关（图标内嵌滑块的 pill switch；全局生效，localStorage 持久化）── */
.thinking-switch {
  display: flex; align-items: center;
  background: none; border: none; cursor: pointer; flex-shrink: 0;
  color: var(--color-text-secondary); padding: 6px 8px; border-radius: var(--radius-sm);
  transition: color 0.15s;
}
.thinking-switch:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }
.thinking-switch-track {
  position: relative; width: 32px; height: 18px; flex-shrink: 0;
  border-radius: var(--r-full, 999px);
  background: var(--color-border-primary, #cfd3da);
  transition: background 0.2s ease;
}
.thinking-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  color: var(--color-text-tertiary, #a8abb2);
  transition: transform 0.2s ease, color 0.2s ease;
}
/* 内嵌图标：关 = 灰（未显示思维链）/ 开 = 主色白底反色（图标以主色呈现在白滑块上） */
.thinking-switch-icon { display: block; line-height: 0; }
.thinking-switch.on { color: var(--color-primary, #6366f1); }
.thinking-switch.on .thinking-switch-track { background: var(--color-primary, #6366f1); }
.thinking-switch.on .thinking-switch-knob { transform: translateX(14px); color: var(--color-primary, #6366f1); }

/* 会话头预设徽标（开场固化后的身份回显） */
.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: var(--r-full, 999px);
  background: var(--color-primary-light, rgba(99, 102, 241, .1));
  color: var(--color-primary, #6366f1);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── pair 头部（双端点标题——自 PairDialogView 并入；返回按钮已退役：
   主区切换只由显式导航驱动，pair 视角由矩阵快照/面板入口进入，离开即
   点击其他入口，无跨页返回联动）── */
.pair-title{display:flex;align-items:center;gap:10px;min-width:0}
.pair-avatars{display:flex;align-items:center;gap:4px;flex-shrink:0}
.pair-x{display:inline-flex;align-items:center;color:var(--color-text-tertiary,#a8abb2)}
.pair-sub{font-size:11px;color:var(--color-text-tertiary,#a8abb2);white-space:nowrap;margin-left:4px}
.ep-ic{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;color:#f59e0b;background:rgba(245,158,11,.15);flex-shrink:0}

/* ── 归档反馈锚（归档入口住 Token 仪表弹层——TokenGauge 贡献）──
   wrap 拉满头部高（align-self: stretch，header-actions 同步拉满作参照）：
   按钮迁出后 wrap 只剩绝对定位 chip、内容高度为 0——top:calc(100%+…) 从
   头部垂直中心起算，chip 上浮进头部、盖住仪表下半区。拉满后 100% = 头部
   底缘，chip 恒挂头部下方。 */
.compress-wrap { position: relative; display: flex; align-items: center; align-self: stretch; }
/* 归档/忙碌反馈 chip：悬挂于头部底缘下方 10px、右缘对齐 Token 仪表右缘
   （环的正下方）——与仪表/头部控件留足间隔不阻挡；pointer-events:none
   不拦点击。Token 弹层打开时（z-60）chip 沉其下，弹层自身已带整理态展示 */
.compress-feedback { position: absolute; top: calc(100% + 10px); right: 0; pointer-events: none; white-space: nowrap; z-index: 50; }
.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ── 响应式：窄屏 ── */
@media (max-width: 768px) {
  .hamburger-btn { display: flex; align-items: center; justify-content: center; }
  .pair-sub { display: none; }
}
</style>
