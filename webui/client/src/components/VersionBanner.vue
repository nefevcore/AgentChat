<script setup lang="ts">
import { ref, onMounted } from 'vue';

const current = ref('');
const latest = ref('');
const hasUpdate = ref(false);
const latestUrl = ref('');
const dismissedVersion = ref('');
const showBanner = ref(false);

const emit = defineEmits<{ (e: 'showChangelog'): void }>();

onMounted(async () => {
  // 检查是否已关闭过此版本
  try {
    dismissedVersion.value = localStorage.getItem('agentchat.versionDismissed') || '';
  } catch { /* ignore */ }

  try {
    const res = await fetch('/api/version');
    if (!res.ok) return;
    const data = await res.json();
    current.value = data.current || '';
    latest.value = data.latest || '';
    hasUpdate.value = data.hasUpdate || false;
    latestUrl.value = data.latestUrl || '';

    if (hasUpdate.value && latest.value !== dismissedVersion.value) {
      showBanner.value = true;
    }
  } catch { /* 网络不可用时静默忽略 */ }
});

function dismiss() {
  showBanner.value = false;
  try {
    localStorage.setItem('agentchat.versionDismissed', latest.value);
  } catch { /* ignore */ }
}

function openChangelog() {
  emit('showChangelog');
}
</script>

<template>
  <Transition name="slide-down">
    <div v-if="showBanner" class="version-banner">
      <div class="banner-content">
        <svg class="banner-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span class="banner-text">
          新版本 <strong>{{ latest }}</strong> 可用（当前 {{ current }}）
        </span>
        <a
          v-if="latestUrl"
          :href="latestUrl"
          target="_blank"
          class="banner-link"
          title="查看 Release"
        >
          下载
        </a>
        <button class="banner-changelog" @click="openChangelog">更新日志</button>
      </div>
      <button class="banner-close" @click="dismiss" title="关闭">×</button>
    </div>
  </Transition>
</template>

<style scoped>
.version-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  padding: 8px 16px;
  font-size: 13px;
  position: relative;
  z-index: 500;
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
}
.banner-text strong {
  font-weight: 700;
}
.banner-link {
  color: #fff;
  text-decoration: underline;
  font-weight: 500;
  font-size: 12px;
  opacity: 0.9;
}
.banner-link:hover { opacity: 1; }
.banner-changelog {
  background: rgba(255,255,255,0.2);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.3);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}
.banner-changelog:hover {
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
