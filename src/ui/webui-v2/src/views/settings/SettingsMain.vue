<!-- SettingsMain.vue —— 设置视角主视图 -->
<script setup lang="ts">
import { useUiStore } from '@/stores/ui';
import { useAgentStore } from '@/stores/agents';
import { useThemeStore } from '@/stores/theme';

const ui = useUiStore();
const agentStore = useAgentStore();
const theme = useThemeStore();
</script>

<template>
  <div class="settings-main">
    <div class="settings-header">
      <h2>设置</h2>
    </div>

    <div class="settings-section">
      <h3>外观</h3>
      <div class="setting-row">
        <span>主题</span>
        <button class="btn" @click="theme.toggleTheme()">
          {{ theme.theme === 'dark' ? '深色（点击切换亮色）' : '亮色（点击切换深色）' }}
        </button>
      </div>
    </div>

    <div class="settings-section">
      <h3>全局</h3>
      <div class="setting-row">
        <span>全局配置</span>
        <button class="btn" @click="ui.globalSettingsVisible = true">打开</button>
      </div>
      <div class="setting-row">
        <span>Token 用量</span>
        <button class="btn" @click="ui.tokenUsageVisible = true">打开</button>
      </div>
      <div class="setting-row">
        <span>关于 / 版本</span>
        <button class="btn" @click="ui.versionVisible = true">查看</button>
      </div>
    </div>

    <div class="settings-section">
      <h3>Agent</h3>
      <div class="setting-row" v-for="agent in agentStore.agents.slice(0, 10)" :key="agent.id">
        <span>{{ agent.name }}</span>
        <button class="btn" @click="ui.settingsAgentId = agent.id; ui.agentSettingsVisible = true">配置</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-main {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  background: var(--color-bg-page, #161619);
}
.settings-header h2 { font-size: 18px; color: var(--color-text-primary); margin-bottom: 20px; }
.settings-section { margin-bottom: 24px; }
.settings-section h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-tertiary, #a8abb2);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--color-text-primary);
}
.btn {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.15));
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.btn:hover { color: var(--color-text-primary); border-color: var(--color-primary, #6366f1); }
</style>
