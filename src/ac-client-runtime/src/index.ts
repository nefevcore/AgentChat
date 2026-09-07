// ============================================================
// ac-client-runtime —— 浏览器侧客户端运行时（M27 S0 基建三包之一）
//
// 契约出口：ClientContext 类型身份（D22）+ 客户端事件目录类型增强；
// 纯核（SlotCore）住 ac-client-slots 单独 import。
// ============================================================
export { ClientContext, createClient, clientPlugin } from './context.ts';
export type { ClientPluginObject } from './context.ts';
export type { Fiber } from '@agentchat/cordis';
export { SlotsService } from './slots.ts';
export type { SlotRenderer } from './slots.ts';
export { ObjectsService } from './objects.ts';
export { CLIENT_CONTEXT_KEY, SLOT_OWNER_KEY, useContext, useClientContext, wrapComponent } from './vue.ts';
export type { RpcClientFace } from './rpc.ts';
export type {} from './rpc.ts';

// 契约出口：客户端事件目录类型增强（消费方 import type {} 即得
// 'slots/changed' 等客户端事件的 on/emit 类型；零运行时依赖）
export type {} from './events.ts';
