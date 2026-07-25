<script setup lang="ts">
import { ref, reactive } from 'vue';
import { saveSettings } from '../utils/storage';
import type { ApiSettings } from '../types';

const props = defineProps<{
  settings: ApiSettings;
}>();

const emit = defineEmits<{
  save: [settings: ApiSettings];
  close: [];
}>();

const form = reactive<ApiSettings>({ ...props.settings });
const showApiKey = ref(false);

function handleSave() {
  const s: ApiSettings = { ...form };
  saveSettings(s);
  emit('save', s);
  emit('close');
}
</script>

<template>
  <div class="dialog-overlay" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h3>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -4px; margin-right: 6px;">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          API 设置
        </h3>
        <button class="btn-close" @click="emit('close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="dialog-body">
        <!-- API Key -->
        <label class="field">
          <span class="field-label">API Key</span>
          <div class="password-wrap">
            <input
              :type="showApiKey ? 'text' : 'password'"
              v-model="form.apiKey"
              class="field-input"
              placeholder="sk-..."
            />
            <button class="toggle-vis" @click="showApiKey = !showApiKey">
              <svg v-if="showApiKey" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
              <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </label>

        <!-- API 地址 -->
        <label class="field">
          <span class="field-label">API 地址</span>
          <input
            v-model="form.baseUrl"
            class="field-input"
            placeholder="https://api.deepseek.com"
          />
        </label>

        <!-- 模型 -->
        <label class="field">
          <span class="field-label">模型</span>
          <select v-model="form.model" class="field-input">
            <option value="deepseek-chat">deepseek-chat</option>
            <option value="deepseek-reasoner">deepseek-reasoner</option>
          </select>
        </label>

        <!-- 思考模式 -->
        <label class="field-checkbox">
          <input type="checkbox" v-model="form.thinking" />
          <span>启用深度思考</span>
        </label>

        <!-- 思考强度 -->
        <label class="field" v-if="form.thinking">
          <span class="field-label">思考强度</span>
          <select v-model="form.reasoningEffort" class="field-input">
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
        </label>

        <!-- Temperature -->
        <label class="field">
          <span class="field-label">Temperature</span>
          <input
            v-model.number="form.temperature"
            type="number"
            class="field-input"
            min="0"
            max="2"
            step="0.1"
            placeholder="默认"
          />
        </label>

        <!-- Max Tokens -->
        <label class="field">
          <span class="field-label">Max Tokens</span>
          <input
            v-model.number="form.maxTokens"
            type="number"
            class="field-input"
            min="1"
            max="65536"
            placeholder="默认"
          />
        </label>
      </div>

      <div class="dialog-footer">
        <button class="btn-cancel" @click="emit('close')">取消</button>
        <button class="btn-save" @click="handleSave">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--dialog-bg);
  border-radius: 16px;
  width: 440px;
  max-width: 90vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border-color);
}

.dialog-header h3 {
  margin: 0;
  font-size: 17px;
  color: var(--text-primary);
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 18px;
  padding: 4px;
  border-radius: 4px;
}

.btn-close:hover {
  color: var(--text-primary);
}

.dialog-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.field-input {
  padding: 9px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 14px;
  background: var(--input-bg);
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
}

.field-input:focus {
  border-color: var(--accent-color);
}

.field-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.field-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-color);
}

.password-wrap {
  display: flex;
  position: relative;
}

.password-wrap .field-input {
  flex: 1;
  padding-right: 40px;
}

.toggle-vis {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
}

.btn-cancel {
  padding: 8px 20px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 14px;
  transition: background 0.15s;
}

.btn-cancel:hover {
  background: var(--hover-bg);
}

.btn-save {
  padding: 8px 20px;
  background: var(--accent-color);
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  transition: opacity 0.15s;
}

.btn-save:hover {
  opacity: 0.85;
}
</style>
