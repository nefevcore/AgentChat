// ============================================================
// boot.ts —— 骨架面共享件（cr-933 收窄：旧 bootUiClient 装载序列随
// webui-v3 cutover 退役〔cr-932/933〕；本文件只保留 boot-v3 与对账锁
// 消费的骨架件：skeletonPlugins / skeletonModuleHost / loadChannelCss）
// ============================================================
import type { ClientPluginObject } from 'ac-client-runtime';
import { themeClientPlugin } from 'ac-client-ui-theme/client';
import { rendererClientPlugin } from 'ac-client-ui-renderer/client';
import { layoutClientPlugin } from 'ac-client-ui-layout/client';
import * as vue from 'vue';
import * as pinia from 'pinia';
import * as cordis from '@agentchat/cordis';
import * as clientRuntime from 'ac-client-runtime';
import * as clientSlots from 'ac-client-slots';
// 骨架包本体 + webui-kit（toast 全局栈等模块级单例——多 bundle 各持副本即各弹各的）
import * as clientUiTheme from 'ac-client-ui-theme/client';
import * as clientUiRenderer from 'ac-client-ui-renderer/client';
import * as clientUiLayout from 'ac-client-ui-layout/client';
import * as webuiKit from '@agentchat/webui-kit';
import { sharedModules } from './shared-modules.ts';

/** 共享基座模块注册表（种子词→壳活实例；宿主模块表对账锁的面——
 * v3 装载面单源 = client/seeds-v3.ts，本表仅锁「构建面 ≡ 骨架收集面」） */
export type ModuleHost = Record<string, unknown>;

export function skeletonModuleHost(): ModuleHost {
  return {
    vue,
    pinia,
    '@agentchat/cordis': cordis,
    'ac-client-runtime': clientRuntime,
    'ac-client-slots': clientSlots,
    '@agentchat/webui-kit': webuiKit,
    'ac-client-ui-theme/client': clientUiTheme,
    'ac-client-ui-renderer/client': clientUiRenderer,
    'ac-client-ui-layout/client': clientUiLayout,
    ...sharedModules(),
  };
}

/** 已注入的通道样式表（href 去重——wire 重载不重复挂） */
const channelCssLoaded = new Set<string>();

/** 附加样式注入（revision URL——重载不重复挂；缺席/404 = 无样式合法降级） */
export function loadChannelCss(href: string): void {
  if (channelCssLoaded.has(href) || typeof document === 'undefined') return;
  channelCssLoaded.add(href);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.onerror = () => console.warn('[ui-boot] 通道样式缺席：' + href);
  document.head.appendChild(link);
}

/** 骨架 3 件（in-bundle——协议持有者；依赖序：theme → renderer → layout） */
export const skeletonPlugins: ClientPluginObject[] = [
  themeClientPlugin as unknown as ClientPluginObject,
  rendererClientPlugin as unknown as ClientPluginObject,
  layoutClientPlugin as unknown as ClientPluginObject,
];
