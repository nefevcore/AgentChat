<script setup lang="ts">
// ============================================================
// PluginLibraryPane.vue —— 插件库（P3）
// 三个页签：已安装 / 待审暂存 / 开发目录（会话加载/卸载/发布）
// 所有动作成功后 emit('refresh')，由 SettingsPanel 触发目录/库刷新；
// WS plugin.catalog.changed 会再触发一次，但动作后立即刷新保证反馈及时。
// ============================================================
import { ref, computed } from 'vue';
import type { PluginInfo, PluginPermissionsView, StagingRecord, MarketEntry } from '../types';
import * as api from '../api';
import { Icon, Modal, Button } from '@/ui';
import PluginCard from './PluginCard.vue';
import PluginDevCard from './PluginDevCard.vue';
import StagingReviewModal from './StagingReviewModal.vue';
import ConfirmDialog from './ConfirmDialog.vue';

const props = defineProps<{
  installed: PluginInfo[];
  staging: StagingRecord[];
  dev: PluginInfo[];
  session: PluginInfo[];
  permissions: PluginPermissionsView | null;
}>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

const tab = ref<'installed' | 'staging' | 'dev' | 'market'>('installed');
const busyName = ref('');
const error = ref('');
const success = ref('');
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);
const reviewRecord = ref<StagingRecord | null>(null);

function flash(msg: string) {
  success.value = msg;
  setTimeout(() => { success.value = ''; }, 3500);
}

async function uninstall(name: string) {
  const ok = await confirmRef.value?.ask({
    title: '卸载插件？',
    message: `将把插件 "${name}" 从插件库移除，目录移动到 <workspace>/plugins/.backup/<name>-<version>-<ts>。\n\nAgent 配置中的 presets 引用会保留（未注册插件在烘焙时自动跳过）。`,
    confirmLabel: '卸载',
    danger: true,
  });
  if (!ok) return;
  busyName.value = name;
  error.value = '';
  try {
    const result = await api.uninstallPlugin(name);
    flash(`已卸载 "${name}"${result.backupDir ? `，备份到 ${result.backupDir}` : ''}`);
    emit('refresh');
  } catch (e: any) {
    error.value = `卸载失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

function sessionLoaded(name: string): boolean {
  return props.session.some((p) => p.name === name);
}

// ── 会话注册 grants 勾选（高危权限开发期也要显式授予） ──
const registerTarget = ref<PluginInfo | null>(null);
const registerGrants = ref<string[]>([]);
const registerMissing = computed(() =>
  (registerTarget.value?.permissions ?? []).filter(
    (p) => p !== 'fs' && p !== 'network' && !registerGrants.value.includes(p),
  ),
);

function requiredGrantsOf(plugin: PluginInfo): string[] {
  return (plugin.permissions ?? []).filter((p) => p !== 'fs' && p !== 'network');
}

async function registerDev(plugin: PluginInfo) {
  const required = requiredGrantsOf(plugin);
  if (required.length > 0) {
    registerTarget.value = plugin;
    registerGrants.value = [];
    return;
  }
  await doRegister(plugin, []);
}

async function doRegister(plugin: PluginInfo, grants: string[]) {
  if (!plugin.dir) {
    error.value = `开发插件 "${plugin.name}" 缺少目录信息`;
    return;
  }
  registerTarget.value = null;
  busyName.value = plugin.name;
  error.value = '';
  try {
    const result = await api.registerSessionPlugin(plugin.dir, plugin.owner, grants);
    flash(`"${plugin.name}" 已加载为会话级插件（${result.status === 'replaced' ? '已替换旧实例' : '已加载'}），并已加入 owner Agent（${plugin.owner ?? 'unknown'}）的 presets 自动生效。`);
    emit('refresh');
  } catch (e: any) {
    error.value = `会话注册失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

async function unregisterDev(name: string) {
  const ok = await confirmRef.value?.ask({
    title: '卸载会话插件？',
    message: `会话级插件 "${name}" 将从当前进程卸载（源码目录保留；重启后自动失效）。`,
    confirmLabel: '卸载会话',
    danger: true,
  });
  if (!ok) return;
  busyName.value = name;
  error.value = '';
  try {
    await api.unloadSessionPlugin(name);
    flash(`会话插件 "${name}" 已卸载，并已从 owner Agent presets 移除`);
    emit('refresh');
  } catch (e: any) {
    error.value = `会话卸载失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

async function stageDev(plugin: PluginInfo) {
  if (!plugin.dir) {
    error.value = `开发插件 "${plugin.name}" 缺少目录信息`;
    return;
  }
  busyName.value = plugin.name;
  error.value = '';
  try {
    const result = await api.stagePlugin(plugin.dir, plugin.owner ?? 'user');
    flash(`"${plugin.name}" 已暂存待审（id: ${result.staging.id}）`);
    tab.value = 'staging';
    emit('refresh');
  } catch (e: any) {
    error.value = `暂存失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

// ── 市场 tab（search 显式触发；安装失败需 grants → 回落 stage + 人审流） ──
const marketQuery = ref('');
const marketEntries = ref<MarketEntry[]>([]);
const marketStale = ref(false);
const marketSearched = ref(false);
const searching = ref(false);
const busyRepo = ref('');

async function searchMarket() {
  searching.value = true;
  error.value = '';
  try {
    const result = await api.searchMarket(marketQuery.value);
    marketEntries.value = result.entries;
    marketStale.value = result.stale;
    marketSearched.value = true;
    if (result.stale) flash(`在线搜索失败（${result.error ?? '未知错误'}），显示本地缓存`);
    else if (result.error) flash(`部分源失败：${result.error}`);
  } catch (e: any) {
    error.value = `市场搜索失败: ${e.message}`;
  } finally {
    searching.value = false;
  }
}

async function loadCachedMarket() {
  try {
    const result = await api.getCachedMarket();
    marketEntries.value = result.entries;
    marketSearched.value = true;
  } catch (e: any) {
    error.value = `读取市场缓存失败: ${e.message}`;
  }
}

function switchToMarket() {
  if (!marketSearched.value && marketEntries.value.length === 0) void loadCachedMarket();
}

/** 市场条目声明的高危权限（fs/network 之外） */
function marketRequiredGrants(entry: MarketEntry): string[] {
  return (entry.manifest?.permissions ?? []).filter((p) => p !== 'fs' && p !== 'network');
}

async function installFromMarket(entry: MarketEntry) {
  busyRepo.value = entry.repo;
  error.value = '';
  try {
    const result = await api.installMarket(entry.repo);
    flash(`已从市场安装 "${result.installed.name}@${result.installed.version}"`);
    emit('refresh');
  } catch (e: any) {
    const message = String(e.message ?? '');
    if (message.includes('未授予的权限')) {
      // 声明了高危权限的市场插件：回落人审流（stage → 待审 tab 逐文件审查 + 授予）
      try {
        await api.stageMarket(entry.repo);
        flash(`"${entry.name}" 需要授予权限（${marketRequiredGrants(entry).join('/') || '见待审'}），已转入待审暂存`);
        tab.value = 'staging';
        emit('refresh');
      } catch (e2: any) {
        error.value = `市场暂存失败: ${e2.message}`;
      }
    } else {
      error.value = `市场安装失败: ${message}`;
    }
  } finally {
    busyRepo.value = '';
  }
}

async function uninstallFromMarket(name: string) {
  const ok = await confirmRef.value?.ask({
    title: '卸载市场插件？',
    message: `将把插件 "${name}" 从插件库移除（运行中的实例热卸载，目录移 .backup）。`,
    confirmLabel: '卸载',
    danger: true,
  });
  if (!ok) return;
  busyName.value = name;
  error.value = '';
  try {
    const result = await api.uninstallPlugin(name);
    flash(`已卸载 "${name}"${result.backupDir ? `，备份到 ${result.backupDir}` : ''}`);
    emit('refresh');
  } catch (e: any) {
    error.value = `卸载失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

function onReviewDone(kind: 'approved' | 'rejected') {
  reviewRecord.value = null;
  if (kind === 'approved') tab.value = 'installed';
  flash(kind === 'approved' ? '暂存插件已批准安装' : '暂存插件已拒绝');
  emit('refresh');
}

/** 直接拒绝暂存插件（不必进审查弹窗；此前"拒绝"按钮与"审查"行为完全相同） */
async function rejectStaging(s: StagingRecord) {
  const ok = await confirmRef.value?.ask({
    title: '拒绝暂存插件？',
    message: `将拒绝插件 "${s.manifest.name}" 的安装请求并移除暂存记录。`,
    confirmLabel: '拒绝安装',
    danger: true,
  });
  if (!ok) return;
  busyName.value = s.manifest.name;
  error.value = '';
  try {
    await api.rejectPlugin(s.id);
    flash(`已拒绝 "${s.manifest.name}"`);
    emit('refresh');
  } catch (e: any) {
    error.value = `拒绝失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}
</script>

<template>
  <div class="plugin-library">
    <div class="pl-head">
      <div class="pl-tabs">
        <button class="pl-tab" :class="{ active: tab === 'installed' }" @click="tab = 'installed'">已安装（{{ installed.length }}）</button>
        <button class="pl-tab" :class="{ active: tab === 'staging' }" @click="tab = 'staging'">待审暂存（{{ staging.length }}）</button>
        <button class="pl-tab" :class="{ active: tab === 'dev' }" @click="tab = 'dev'">开发目录（{{ dev.length }}）</button>
        <button class="pl-tab" :class="{ active: tab === 'market' }" @click="tab = 'market'; switchToMarket()">市场</button>
      </div>
      <button class="pl-refresh" title="刷新插件库" @click="emit('refresh')"><Icon name="refresh-cw" :size="13" />刷新</button>
    </div>
    <div v-if="success" class="pl-success">{{ success }}</div>
    <div v-if="error" class="pl-error">{{ error }}</div>

    <!-- 已安装 -->
    <div v-if="tab === 'installed'" class="pl-list">
      <div v-if="installed.length === 0" class="pl-empty">暂无已安装插件（发布 = stage → 人审 → approve）</div>
      <PluginCard
        v-for="p in installed" :key="p.name"
        :plugin="p" :permissions="permissions" :busy="busyName === p.name"
        @uninstall="uninstall"
      />
    </div>

    <!-- 待审暂存 -->
    <div v-else-if="tab === 'staging'" class="pl-list">
      <div v-if="staging.length === 0" class="pl-empty">暂无待审暂存插件</div>
      <div v-for="s in staging" :key="s.id" class="staging-card">
        <div class="staging-head">
          <span class="staging-name">{{ s.manifest.name }}</span>
          <span class="staging-version">v{{ s.manifest.version }}</span>
          <span class="staging-owner">owner: {{ s.owner }}</span>
          <span class="staging-hash" :title="s.hash">hash {{ s.hash.slice(0, 8) }}…</span>
          <span class="staging-time">{{ s.createdAt.replace('T', ' ').slice(0, 16) }}</span>
        </div>
        <div class="staging-grants" v-if="s.requiredGrants.length">
          需宿主授予：
          <code v-for="p in s.requiredGrants" :key="p" class="staging-grant">{{ p }}</code>
        </div>
        <div class="staging-actions">
          <button class="pl-btn" @click="reviewRecord = s">审查文件与授予</button>
          <button class="pl-btn danger" :disabled="busyName === s.manifest.name" @click="rejectStaging(s)">拒绝</button>
        </div>
      </div>
    </div>

    <!-- 插件市场（topic:agentchat-plugin 发现；显式搜索，构造零网络） -->
    <div v-else-if="tab === 'market'" class="pl-list">
      <div class="market-bar">
        <input
          v-model="marketQuery" class="market-input" type="text"
          placeholder="搜索市场（GitHub topic:agentchat-plugin；留空 = 全部）"
          @keydown.enter="searchMarket"
        />
        <button class="pl-btn" :disabled="searching" @click="searchMarket">{{ searching ? '搜索中…' : '搜索' }}</button>
        <button class="pl-btn" title="只读本地缓存索引（离线可用）" @click="loadCachedMarket">缓存</button>
      </div>
      <div v-if="marketStale" class="market-stale">⚠ 在线源不可达，以下为本地缓存索引</div>
      <div v-if="marketSearched && marketEntries.length === 0 && !searching" class="pl-empty">市场无结果（仓库需挂 topic:agentchat-plugin 且根目录有 manifest.json）</div>
      <div v-for="entry in marketEntries" :key="entry.repo" class="market-card">
        <div class="market-head">
          <span class="market-name">{{ entry.manifest?.name ?? entry.name }}</span>
          <span v-if="entry.manifest" class="market-version">v{{ entry.manifest.version }}</span>
          <span class="market-repo">{{ entry.repo }}</span>
          <span v-if="entry.stars !== undefined" class="market-stars">★ {{ entry.stars }}</span>
          <span v-if="entry.updatedAt" class="market-time">{{ entry.updatedAt.slice(0, 10) }}</span>
        </div>
        <div v-if="entry.description" class="market-desc">{{ entry.description }}</div>
        <div v-if="entry.manifest?.permissions?.length" class="market-perms">
          权限：<code v-for="pm in entry.manifest.permissions" :key="pm" class="market-perm" :class="{ high: pm !== 'fs' && pm !== 'network' }">{{ pm }}</code>
        </div>
        <div class="market-actions">
          <span v-if="installed.some((p) => p.name === entry.manifest?.name)" class="market-installed-mark">✓ 已安装</span>
          <button
            v-if="installed.some((p) => p.name === entry.manifest?.name)"
            class="pl-btn danger" :disabled="busyName === entry.manifest?.name"
            @click="entry.manifest && uninstallFromMarket(entry.manifest.name)"
          >卸载</button>
          <button
            v-else class="pl-btn" :disabled="busyRepo === entry.repo || searching"
            @click="installFromMarket(entry)"
          >{{ busyRepo === entry.repo ? '安装中…' : '安装' }}</button>
        </div>
      </div>
    </div>

    <!-- 开发目录 -->
    <div v-else class="pl-list">
      <div class="pl-dev-hint">扫描范围：<code>&lt;workspace&gt;/plugins/&lt;agentId&gt;/&lt;name&gt;/</code>（仅一层 manifest.json）</div>
      <div v-if="dev.length === 0" class="pl-empty">暂无开发插件。把 manifest.json + entry 放进上述目录后刷新。</div>
      <PluginDevCard
        v-for="p in dev" :key="p.name"
        :plugin="p" :loaded="sessionLoaded(p.name)" :busy="busyName === p.name"
        @register="registerDev" @unregister="unregisterDev" @stage="stageDev"
      />
    </div>


    <!-- 会话注册 grants 勾选（高危权限开发期显式授予） -->
    <Modal :visible="!!registerTarget" title="注册会话插件（授予权限）" :width="440" :z-index="1250" @close="registerTarget = null">
      <div class="register-modal">
        <div class="register-desc">开发插件 <strong>{{ registerTarget?.name }}</strong> 声明了需显式授予的权限，勾选后才会执行代码。</div>
        <label v-for="p in registerTarget?.permissions ?? []" :key="p" class="register-grant">
          <template v-if="p === 'fs' || p === 'network'">
            <input type="checkbox" checked disabled /><code>{{ p }}</code><span>默认授予</span>
          </template>
          <template v-else>
            <input v-model="registerGrants" type="checkbox" :value="p" /><code>{{ p }}</code>
            <span v-if="p === 'ui'">⚠ UI 代码将在浏览器会话上下文中执行</span>
            <span v-else>高危：需宿主显式授予</span>
          </template>
        </label>
      </div>
      <template #footer>
        <Button variant="ghost" @click="registerTarget = null">取消</Button>
        <Button variant="primary" :disabled="registerMissing.length > 0" @click="registerTarget && doRegister(registerTarget, registerGrants)">
          {{ registerMissing.length ? `请先勾选：${registerMissing.join('/')}` : '注册会话' }}
        </Button>
      </template>
    </Modal>

    <!-- 暂存人审弹窗 -->
    <StagingReviewModal
      :record="reviewRecord"
      :permissions="permissions"
      @close="reviewRecord = null"
      @done="onReviewDone"
    />
    <ConfirmDialog ref="confirmRef" />
  </div>
</template>

<style scoped>
.plugin-library { display: flex; flex-direction: column; gap: 10px; }
.pl-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pl-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); }
.pl-tab {
  padding: 7px 14px; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px;
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.pl-tab:hover { color: var(--text-1); background: var(--bg-hover); }
.pl-tab.active { color: var(--primary); border-bottom-color: var(--primary); font-weight: 500; }
.pl-refresh {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
  border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer;
}
.pl-refresh:hover { background: var(--bg-hover); color: var(--text-1); }
.pl-success { padding: 6px 10px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--ok) 10%, transparent); color: var(--ok); font-size: 12px; }
.pl-error { padding: 6px 10px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--err) 10%, transparent); color: var(--err); font-size: 12px; }
.pl-list { display: flex; flex-direction: column; gap: 8px; }
.pl-empty { text-align: center; padding: 24px; color: var(--text-3); font-size: 12px; }
.pl-dev-hint { font-size: 11px; color: var(--text-3); }
.pl-dev-hint code { font-family: var(--font-mono); }
.pl-btn {
  padding: 4px 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.pl-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.pl-btn.danger { color: var(--err); }
.pl-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--err) 10%, transparent); }
.pl-btn:disabled { opacity: .5; cursor: not-allowed; }

/* staging card */
.staging-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-surface);
}
.staging-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.staging-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
.staging-version { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.staging-owner, .staging-time { font-size: 11px; color: var(--text-3); }
.staging-hash { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.staging-grants { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); flex-wrap: wrap; }
.staging-grant { font-family: var(--font-mono); padding: 2px 7px; border-radius: 999px; color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.staging-actions { display: flex; justify-content: flex-end; gap: 6px; }

/* register grants modal */
.register-modal { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.register-desc { font-size: 12px; color: var(--text-2); line-height: 1.5; }
.register-grant { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-1); }
.register-grant input { accent-color: var(--primary); }
.register-grant code { font-family: var(--font-mono); font-size: 12px; }
.register-grant span { font-size: 11px; color: var(--text-3); }

/* market tab */
.market-bar { display: flex; gap: 6px; }
.market-input {
  flex: 1; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: var(--bg-surface); color: var(--text-1); font-size: 12px;
}
.market-input:focus { outline: none; border-color: var(--primary); }
.market-stale { padding: 5px 10px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--warn) 10%, transparent); color: var(--warn); font-size: 11px; }
.market-card {
  display: flex; flex-direction: column; gap: 5px;
  padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-surface);
}
.market-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.market-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
.market-version { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.market-repo { font-size: 11px; color: var(--primary); font-family: var(--font-mono); }
.market-stars { font-size: 11px; color: var(--text-3); }
.market-time { font-size: 11px; color: var(--text-3); }
.market-desc { font-size: 12px; color: var(--text-2); }
.market-perms { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-3); flex-wrap: wrap; }
.market-perm { font-family: var(--font-mono); padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, var(--text-3) 12%, transparent); }
.market-perm.high { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.market-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.market-installed-mark { font-size: 11px; color: var(--ok); }
</style>
