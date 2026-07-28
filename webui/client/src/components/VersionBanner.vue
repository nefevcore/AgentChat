<script setup lang="ts">
import { ref, onMounted } from 'vue';

const current = ref('');
const latest = ref('');
const hasUpdate = ref(false);
const latestUrl = ref('');
const showBanner = ref(true);

const emit = defineEmits<{ (e: 'showChangelog'): void }>();

onMounted(async () => {
  // 检查是否已关闭过此版本的更新提示
  try {
    const dismissed = localStorage.getItem('agentchat.versionDismissed');
    if (dismissed) {
      const dv = JSON.parse(dismissed) as string;
      // 等拿到最新版本号后再判断是否要重新显示
    }
  } catch { /* ignore */ }

  try {
    const res = await fetch('/api/version');
    if (!res.ok) return;
    const data = await res.json();
    current.value = data.current || '';
    latest.value = data.latest || '';
    hasUpdate.value = data.hasUpdate || false;
    latestUrl.value = data.latestUrl || '';

    // 有更新时，检查是否已关闭过该版本
    if (hasUpdate.value) {
      try {
        const dismissed = localStorage.getItem('agentchat.versionDismissed');
        if (dismissed && JSON.parse(dismissed) === latest.value) {
          showBanner.value = false;
        }
      } catch { /* ignore */ }
    }
    // 无更新时始终显示（展示当前版本号 + 更新日志入口）
  } catch { /* 网络不可用时仍然显示，展示当前版本 */ }
});

function dismiss() {
  if (hasUpdate.value) {
    showBanner.value = false;
    try {
      localStorage.setItem('agentchat.versionDismissed', JSON.stringify(latest.value));
    } catch { /* ignore */ }
  }
}

function openChangelog() {
  emit('showChangelog');
}
</script>

<template>
  <Transition name="slide-down">
    <div v-if="showBanner" class="version-banner" :class="{ 'has-update': hasUpdate }">
      <div class="banner-content">
        <svg class="banner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line v-if="!hasUpdate" x1="8" y1="12" x2="16" y2="12"/>
          <template v-else>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </template>
        </svg>

        <span v-if="hasUpdate" class="banner-text">
          新版本 <strong>v{{ latest }}</strong> 可用（当前 v{{ current }}）
        </span>
        <span v-else class="banner-text normal">
          v{{ current }} · 已是最新
        </span>

        <a
          v-if="hasUpdate && latestUrl"
          :href="latestUrl"
          target="_blank"
          class="banner-link"
          title="查看 Release"
        >下载</a>
        <button class="banner-changelog" @click="openChangelog">更新日志</button>
      </div>

      <button v-if="hasUpdate" class="banner-close" @click="dismiss" title="关闭">×</button>
    </div>
  </Transition>
</template>

<style scoped>
.version-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #fff;
  padding: 6px 16px;
  font-size: 12px;
  position: relative;
  z-index: 500;
  background: var(--color-bg-subtle, #f8f8f8);
  color: var(--color-text-secondary, #7f8c8d);
  border-bottom: 1px solid var(--color-border-secondary, #e8e8e8);
}
.version-banner.has-update {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  border-bottom: none;
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.3);
}
.banner-content {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}
.banner-icon {
  flex-shrink: 0;
  opacity: 0.6;
}
.has-update .banner-icon { opacity: 1; }
.banner-text.normal {
  opacity: 0.7;
}
.banner-text strong {
  font-weight: 700;
}
.banner-link {
  color: #fff;
  text-decoration: underline;
  font-weight: 500;
  font-size: 11px;
  opacity: 0.9;
}
.banner-link:hover { opacity: 1; }
.banner-changelog {
  background: none;
  border: 1px solid var(--color-border-secondary, #ddd);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  color: inherit;
  opacity: 0.8;
}
.has-update .banner-changelog {
  background: rgba(255,255,255,0.2);
  border-color: rgba(255,255,255,0.3);
  color: #fff;
  opacity: 1;
}
.banner-changelog:hover {
  opacity: 1;
  background: var(--color-bg-surface, #f0f0f0);
}
.has-update .banner-changelog:hover {
  background: rgba(255,255,255,0.3);
}
.banner-close {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: rgba(255,255,255,0.7);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.banner-close:hover { color: #fff; }

/* Transition */
.slide-down-enter-active, .slide-down-leave-active {
  transition: all 0.3s ease;
}
.slide-down-enter-from, .slide-down-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}
</style>
