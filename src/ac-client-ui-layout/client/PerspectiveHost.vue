<script setup lang="ts">
// ============================================================
// client/PerspectiveHost.vue —— 视角容器
//
// 渲染当前激活视角（core/registry/perspectives 注册表驱动）。
// 主区域只此一个容器；新增视角 = 注册项，不改主框架。
//
// M27 S1：D18-1 bail 权限门控——宿主/权限面可经客户端
// 'activity/perspective' bail 事件拒绝视角（无监听 = 放行；默认拒绝
// 形态随权限面启用）。视角专座渲染 = main 席位内的 PerspectiveHost
//（AppFrame 挂载；D9 于 S2 升 keyed 选举）。
//
// 视图级错误边界（M30 §5.1 遗留收口）：壳条目（main#
// perspective-host）的 EntryErrorBoundary 语义是"退位让次位接任"——
// 对 single-candidate 壳席位过猛（退位 = 主区空白直到重载）。本边界
// 在视角视图粒度截停渲染期崩溃：就地降级错误卡（重试 / 切视角自愈），
// 止播不上抛（壳条目不退位）。事件处理器等运行期错误不降级视图
//（视图树仍健康，走默认传播链）。
// ============================================================

import { computed, ref, watch, onErrorCaptured } from 'vue';
import { activePerspective, perspectiveVersion, type Perspective } from './perspectives.ts';
import { useClientContext } from 'ac-client-runtime';

const ctx = useClientContext();

/** D18-1 bail 权限：'activity/perspective' 返回非空 = 拒绝（无监听放行） */
function bailAllowed(p: Perspective): boolean {
  if (!ctx || !p.bail) return true;
  return ctx.bail('activity/perspective', p) == null;
}

// 读取版本号建立响应式依赖：插件注册/注销视角时本容器自动重解析
const active = computed(() => {
  void perspectiveVersion.value;
  const p = activePerspective();
  return p && bailAllowed(p) ? p : null;
});

function buildProps(): Record<string, unknown> {
  // 安全求值：props 工厂抛错 = 回落空 props（缺陷 def 不击穿容器——
  // 与 activePerspective 的 safeActive 同款防御，M30 D4 后置防线）
  try {
    return active.value?.props?.() ?? {};
  } catch (err) {
    console.warn(`[perspectives] 视角 "${active.value?.id}" 的 props() 工厂抛错——回落空 props`, err);
    return {};
  }
}

// ── 视图级错误边界（见文件头注）：渲染期崩溃 → 错误卡 + 止播 ──
const viewCrash = ref<{ id: string; message: string } | null>(null);

onErrorCaptured((err, _instance, info) => {
  // 仅截停渲染期错误（render/setup/生命周期/组件更新——视图树已不可
  // 用）；事件处理器/watcher 回调等运行期错误不降级视图
  if (!/render|setup|lifecycle|component update/i.test(info)) return;
  const id = active.value?.id ?? '(未知视角)';
  viewCrash.value = { id, message: err instanceof Error ? err.message : String(err) };
  console.error(`[perspectives] 视角 "${id}" 渲染崩溃——就地降级错误卡（不退位壳条目；${info}）`, err);
  return false; // 止播：不上抛 EntryErrorBoundary（壳条目不退位）
});

// 视角切换 = 自愈机会：清除崩溃态，重试新视角
watch(() => active.value?.id, () => { viewCrash.value = null; });

/** 重试渲染（v-if/v-else 切换即重挂载——全新渲染尝试） */
function retryRender() {
  viewCrash.value = null;
}
</script>

<template>
  <div v-if="viewCrash" class="perspective-crash" role="alert">
    <p class="pc-title">视角「{{ viewCrash.id }}」渲染崩溃</p>
    <p class="pc-msg">{{ viewCrash.message }}</p>
    <div class="pc-actions">
      <button class="pc-retry" @click="retryRender">重试渲染</button>
    </div>
    <p class="pc-hint">切换会话或视角将自动重试</p>
  </div>
  <component
    v-else
    :is="active?.component"
    v-bind="buildProps()"
  />
</template>

<style scoped>
.perspective-crash {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 24px; text-align: center; min-width: 0;
}
.pc-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--err, #e5484d); }
.pc-msg {
  margin: 0; max-width: 60%; font-size: 13px; line-height: 1.6;
  color: var(--color-text-secondary, #666);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pc-retry {
  padding: 6px 16px; border-radius: 6px; border: 1px solid var(--color-border-secondary, #ddd);
  background: var(--color-bg-page, #fff); color: var(--color-text-primary, #333);
  font-size: 13px; cursor: pointer;
}
.pc-retry:hover { border-color: var(--color-primary, #4f46e5); color: var(--color-primary, #4f46e5); }
.pc-hint { margin: 0; font-size: 12px; color: var(--color-text-tertiary, #999); }
</style>
