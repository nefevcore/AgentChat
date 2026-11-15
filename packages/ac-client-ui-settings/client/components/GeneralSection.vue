<!-- ============================================================
  GeneralSection.vue —— 「通用」设置节（cr-1097 开发者模式全局设置）

  settings:section 选举席贡献（section: 'general'，order 10 头位）。
  开发者模式：settings.devMode 全局配置键——宿主拉壳时合成
  AGENTCHAT_DEV_MODE 注入壳 env（系统域双禁默认表不注入，凭据面
  恒禁）。保存后对新拉壳生效；已活壳需重启（本节保存钮文案明示）。
  ============================================================ -->
<template>
  <div class="gs-section">
    <div class="gs-row">
      <div class="gs-info">
        <div class="gs-name">开发者模式</div>
        <div class="gs-desc">
          解锁系统域访问（会话/账本/配置等路径可读写，便于开发迭代调试）。
          凭据与密钥文件仍受保护。开关对新启动的 Agent 壳生效——已运行的壳需重启（设置面板底部「重启后端」）。
        </div>
      </div>
      <label class="gs-switch">
        <input type="checkbox" :checked="devMode" :disabled="saving" @change="onToggle" />
        <span class="gs-slider"></span>
      </label>
    </div>
    <div v-if="error" class="gs-error">{{ error }}</div>
    <div v-else-if="saved" class="gs-ok">已保存{{ devMode ? '——重启后端后生效' : '' }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getGlobalConfig, saveSettingsDomain } from '../api.ts';

const devMode = ref(false);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

onMounted(async () => {
  try {
    const r = await getGlobalConfig();
    devMode.value = r.config.settings?.devMode === true;
  } catch (e: any) {
    error.value = '读取失败: ' + (e?.message ?? String(e));
  }
});

async function onToggle(ev: Event) {
  devMode.value = (ev.target as HTMLInputElement).checked;
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    // config/set 单键写（cr-1098）：只动 settings 键。config/save 是
    // 白名单域全量 replace 语义（payload 缺的域删除）——部分 payload
    // 会误删 llmProviders/searchProviders 兄弟域（cr-1097 首发即踩）。
    const cur = await getGlobalConfig();
    const settings = { ...(cur.config.settings as Record<string, unknown>), devMode: devMode.value };
    await saveSettingsDomain(settings);
    saved.value = true;
  } catch (e: any) {
    error.value = '保存失败: ' + (e?.message ?? String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.gs-section { display: flex; flex-direction: column; gap: 14px; }
.gs-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 12px 0; }
.gs-info { flex: 1; }
.gs-name { font-weight: 600; margin-bottom: 4px; }
.gs-desc { font-size: 12px; opacity: .75; line-height: 1.6; }
.gs-error { color: var(--danger, #e5484d); font-size: 12px; }
.gs-ok { color: var(--success, #30a46c); font-size: 12px; }
.gs-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
.gs-switch input { opacity: 0; width: 0; height: 0; }
.gs-slider { position: absolute; inset: 0; border-radius: 11px; background: var(--bg-3, #d4d4d8); transition: .2s; cursor: pointer; }
.gs-slider::before { content: ''; position: absolute; width: 16px; height: 16px; border-radius: 50%; left: 3px; top: 3px; background: #fff; transition: .2s; }
.gs-switch input:checked + .gs-slider { background: var(--accent, #6c8cff); }
.gs-switch input:checked + .gs-slider::before { transform: translateX(18px); }
</style>