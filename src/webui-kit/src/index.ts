// ============================================================
// webui-kit/src/index.ts —— @agentchat/webui-kit 出口
//
// 目录分层（与 L 层对应）：
//   base/     L0 设计令牌 tokens/row/badge 三 css + L1 基础原语
//             Icon/Button/Avatar/Modal/BusyRing/CollapseRow/DockCard
//             + 工具组件 StatusDot/Tooltip/RingProgress
//   feedback/ 语义反馈 FeedbackNotice + 全局 Toast（toast.ts 单例 + ToastHost 渲染半件）
//   star/     L2 星群组合件 StarAvatar/StarCard/PulseTrace
//   icons/    思维链图标族 + icons.ts 注册表（后者不进本入口，见文件尾注）
//   根级      纯函数 format.ts / starColor.ts
//
// 风格规范与逐组件对照表：.dsh/skills/agentchat-dev/references/webui-style.md
// ============================================================

export { default as Icon } from './base/Icon.vue';
export { default as Button } from './base/Button.vue';
export { default as Chip } from './base/Chip.vue';
export { default as IconAction } from './base/IconAction.vue';
export { default as Progress } from './base/Progress.vue';
export { default as Breadcrumb } from './base/Breadcrumb.vue';
export { default as ConfirmBody } from './base/ConfirmBody.vue';
export { default as Dropdown } from './base/Dropdown.vue';
export { default as Select } from './base/Select.vue';
export { default as Input } from './base/Input.vue';
export { default as Textarea } from './base/Textarea.vue';
export { default as Checkbox } from './base/Checkbox.vue';
export { default as Slider } from './base/Slider.vue';
export { default as FieldRow } from './base/FieldRow.vue';
export { default as Label } from './base/Label.vue';
export { default as SearchInput } from './base/SearchInput.vue';
export { default as PasswordInput } from './base/PasswordInput.vue';
export { default as OptionRow } from './base/OptionRow.vue';
export { default as PickTag } from './base/PickTag.vue';
export { default as Segmented } from './base/Segmented.vue';
export { default as Tabs } from './base/Tabs.vue';
export { default as DocTabs } from './base/DocTabs.vue';
export { default as BusyRing } from './base/BusyRing.vue';
export { default as CollapseRow } from './base/CollapseRow.vue';
export { default as DockCard } from './base/DockCard.vue';
export { default as Avatar } from './base/Avatar.vue';
export { default as Modal } from './base/Modal.vue';
export { default as Sheet } from './base/Sheet.vue';
export { default as PullToRefresh } from './base/PullToRefresh.vue';
export { default as RingProgress } from './base/RingProgress.vue';
export { default as StatusDot } from './base/StatusDot.vue';
export { default as Tooltip } from './base/Tooltip.vue';

export { default as FeedbackNotice } from './feedback/FeedbackNotice.vue';
export { default as ToastHost } from './feedback/ToastHost.vue';
export {
  toast, toastOk, toastError, toastInfo, toastBusy,
  dismissToast, clearToasts, pauseToast, resumeToast, toasts,
  type ToastTone, type ToastOptions, type ToastItem,
} from './feedback/toast.ts';

export { default as StarAvatar } from './star/StarAvatar.vue';
export { default as StarCard } from './star/StarCard.vue';
export { default as PulseTrace } from './star/PulseTrace.vue';
export { default as ThinkingIcon } from './icons/ThinkingIcon.vue';
export { default as ThoughtIcon } from './icons/ThoughtIcon.vue';

// icons/icons.ts（iconMap/resolveIcon）不进本入口：~icons/* 是 unplugin-icons
// 虚拟模块，仅 webui/vite 工具链有类型源；根 tsc 经包入口跟进会把
// icons.ts 拉进无该虚拟模块的程序（M29 P0-2 实录）。零外部消费者，
// Icon.vue 内部相对引用。

// ---- 纯函数工具（M28 P3 自域行下沉——跨域消费面经 kit 直连） ----
export { formatFileSize, formatDurationMs, formatRelativeTime } from './format.ts';
export { starColor, type ThemeMode } from './starColor.ts';
