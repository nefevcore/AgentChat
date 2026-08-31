// ============================================================
// ui/index.ts —— AgentChat 自建 UI 库出口
//
// 分层：
//   L0 设计令牌  tokens.css（main.ts 引入）
//   L1 基础原语  Icon / Button / Avatar / Modal
//   工具组件    StatusDot / Tooltip
//   L2 组合组件  StarAvatar / StarCard / PulseTrace
//
// 设计规范：docs/webui-design-system.md
// ============================================================

export { default as Icon } from './Icon.vue';
export { default as Button } from './Button.vue';
export { default as Avatar } from './Avatar.vue';
export { default as Modal } from './Modal.vue';
export { default as StatusDot } from './StatusDot.vue';
export { default as Tooltip } from './Tooltip.vue';
export { default as StarAvatar } from './StarAvatar.vue';
export { default as StarCard } from './StarCard.vue';
export { default as PulseTrace } from './PulseTrace.vue';
export { iconMap, resolveIcon } from './icons';
