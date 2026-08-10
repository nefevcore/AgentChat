// ============================================================
// messages/index.ts —— 消息视图注册（渲染插槽装配）
//
// 新增消息类型：新建组件 + 在此 registerMessageView 一行。
// TurnDisplayItem 通过 getMessageView(kind) 分发，不改框架。
// ============================================================

import { registerMessageView } from '@/framework/messageViews';
import UserMessage from './UserMessage.vue';
import AssistantMessage from './AssistantMessage.vue';
import ToolMessage from './ToolMessage.vue';
import TriggerMessage from './TriggerMessage.vue';

registerMessageView('user', UserMessage);
registerMessageView('assistant', AssistantMessage);
registerMessageView('tool', ToolMessage);
registerMessageView('trigger', TriggerMessage);
