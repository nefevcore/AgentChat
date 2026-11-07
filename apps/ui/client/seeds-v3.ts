// ============================================================
// seeds-v3.ts —— 壳 v3 种子词表（cr-930 切片②；webui-v3 §4.4 ①支）
//
// 种子词 = 壳 in-bundle 活实例的寻址词：基座库（vue/pinia/cordis/
// protocol/runtime/slots/webui-kit）+ 骨架 3 件包级与深路径词 + 域行
// 深路径共享面（sharedModules——cr-930 中间态裁决：agents↔conversation
// 等包级环的深路径互引回壳 in-bundle 单例，行级 bare 引用走 wire 行③支；
// 全惰性化 = 包结构债务，后继立项）。
// 通道行包词的 bare 形不入种子——经 wire 行③支解析。
// ============================================================
import * as vue from 'vue';
import * as pinia from 'pinia';
import * as cordis from '@agentchat/cordis';
import * as protocol from '@agentchat/protocol';
import * as clientRuntime from 'ac-client-runtime';
import * as clientSlots from 'ac-client-slots';
import * as webuiKit from '@agentchat/webui-kit';
import * as clientUiTheme from 'ac-client-ui-theme/client';
import * as clientUiRenderer from 'ac-client-ui-renderer/client';
import * as clientUiLayout from 'ac-client-ui-layout/client';
// 骨架 3 件深路径词（宿主模块表深词中归属非通道行包者）
import * as themeStore from 'ac-client-ui-theme/client/themeStore.ts';
import * as auxSidebarViews from 'ac-client-ui-layout/client/auxSidebarViews.ts';
import * as mainViews from 'ac-client-ui-layout/client/mainViews.ts';
import * as uiStore from 'ac-client-ui-layout/client/uiStore.ts';
import * as codeCard from 'ac-client-ui-renderer/client/CodeCard.vue';
import * as scrollableViewport from 'ac-client-ui-renderer/client/ScrollableViewport.vue';
import * as slotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';
import * as codeFence from 'ac-client-ui-renderer/client/codeFence.ts';
import * as hljsLanguages from 'ac-client-ui-renderer/client/hljs-languages.ts';
import * as rendererLogger from 'ac-client-ui-renderer/client/logger.ts';
import * as markdownMath from 'ac-client-ui-renderer/client/markdownMath.ts';
import * as useMarkdown from 'ac-client-ui-renderer/client/useMarkdown.ts';
import { sharedModules } from './shared-modules.ts';

/** 壳 v3 种子词表（词 → 壳活实例） */
export function skeletonSeedsV3(): Record<string, unknown> {
  return {
    vue,
    pinia,
    '@agentchat/cordis': cordis,
    '@agentchat/protocol': protocol,
    'ac-client-runtime': clientRuntime,
    'ac-client-slots': clientSlots,
    '@agentchat/webui-kit': webuiKit,
    'ac-client-ui-theme/client': clientUiTheme,
    'ac-client-ui-theme/client/themeStore.ts': themeStore,
    'ac-client-ui-renderer/client': clientUiRenderer,
    'ac-client-ui-renderer/client/CodeCard.vue': codeCard,
    'ac-client-ui-renderer/client/ScrollableViewport.vue': scrollableViewport,
    'ac-client-ui-renderer/client/SlotOutlet.vue': slotOutlet,
    'ac-client-ui-renderer/client/codeFence.ts': codeFence,
    'ac-client-ui-renderer/client/hljs-languages.ts': hljsLanguages,
    'ac-client-ui-renderer/client/logger.ts': rendererLogger,
    'ac-client-ui-renderer/client/markdownMath.ts': markdownMath,
    'ac-client-ui-renderer/client/useMarkdown.ts': useMarkdown,
    'ac-client-ui-layout/client': clientUiLayout,
    'ac-client-ui-layout/client/auxSidebarViews.ts': auxSidebarViews,
    'ac-client-ui-layout/client/mainViews.ts': mainViews,
    'ac-client-ui-layout/client/uiStore.ts': uiStore,
    ...sharedModules(),
  };
}
