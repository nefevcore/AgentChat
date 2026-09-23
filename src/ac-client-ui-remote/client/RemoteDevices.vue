<!-- ============================================================ -->
<!-- RemoteDevices.vue —— 远程设备管理节（remote-link P1）
<!--     设计对齐 webui-kit 令牌体系（tokens.css：--primary/--line/
<!--     --text-*/--bg-*/--r-*）与 Button/StatusDot 组件——双主题自适应。 -->
<!-- ============================================================ -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { defaultRpc as rpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
import { Button, StatusDot } from '@agentchat/webui-kit';
import PairingQr from './PairingQr.vue';

interface DeviceRow {
  id: string;
  name: string;
  pubkey: string;
  scopes: string[];
  pairedAt: number;
  lastSeenAt?: number;
  online: boolean;
}

interface PairingState {
  sessionId: string;
  roomId: string;
  qrUri: string;
  expiresAt: number;
  state: 'wait-join' | 'sas-confirm' | 'done' | 'expired';
  sas?: string;
  deviceName?: string;
}

const devices = ref<DeviceRow[]>([]);
const relayUrl = ref<string | null>(null);
const identityPubkey = ref('');
const linkState = ref('idle');
const error = ref('');
const pairing = ref<PairingState | null>(null);
const pairingBusy = ref(false);
const revoking = ref<string | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 链路状态 → StatusDot 词汇映射 */
const linkDot = computed(() => {
  switch (linkState.value) {
    case 'online': return 'ok';
    case 'pairing': return 'thinking';
    case 'connecting': return 'running';
    case 'error': return 'err';
    default: return 'offline';
  }
});

const linkLabel = computed(() => ({
  idle: '待机', online: '在线', pairing: '配对中', connecting: '连接中', error: '异常',
} as Record<string, string>)[linkState.value] ?? linkState.value);

async function refresh() {
  try {
    const r = await rpc.call<{ devices: DeviceRow[]; relayUrl: string | null; identityPubkey: string }>('remote/devices');
    devices.value = r.devices;
    relayUrl.value = r.relayUrl;
    identityPubkey.value = r.identityPubkey;
    const st = await rpc.call<{ state: string }>('remote/status');
    linkState.value = st.state;
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function startPairing() {
  pairingBusy.value = true;
  error.value = '';
  try {
    const s = await rpc.call<PairingState>('remote/pair-start', {});
    pairing.value = s;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    pairingBusy.value = false;
  }
}

async function confirmPairing(accept: boolean) {
  if (!pairing.value) return;
  pairingBusy.value = true;
  try {
    const r = await rpc.call<PairingState & { sas?: string }>('remote/pair-confirm', { sessionId: pairing.value.sessionId, accept });
    pairing.value = { ...pairing.value, ...r };
    if (accept) await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    pairingBusy.value = false;
  }
}

async function cancelPairing() {
  if (!pairing.value) return;
  try {
    await rpc.call('remote/pair-cancel', { sessionId: pairing.value.sessionId });
  } catch { /* 会话可能已结束 */ }
  pairing.value = null;
}

async function revoke(id: string) {
  revoking.value = id;
  try {
    await rpc.call('remote/revoke', { deviceId: id });
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    revoking.value = null;
  }
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

// —— relay 地址在线配置（config/set → settings.remoteLink.relayUrl → 热更即时生效）——
const editingRelay = ref(false);
const relayDraft = ref('');
const savingRelay = ref(false);

function startEditRelay() {
  relayDraft.value = relayUrl.value ?? '';
  editingRelay.value = true;
}

async function saveRelay() {
  const v = relayDraft.value.trim();
  if (v !== '' && !/^wss?:\/\//.test(v)) {
    error.value = '地址须以 ws:// 或 wss:// 开头';
    return;
  }
  savingRelay.value = true;
  error.value = '';
  try {
    await rpc.call('config/set', { key: 'settings.remoteLink.relayUrl', value: v });
    editingRelay.value = false;
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    savingRelay.value = false;
  }
}

onMounted(() => {
  void refresh();
  pollTimer = setInterval(() => void refresh(), 2000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="remote-pane">
    <p class="sub">手机等远程客户端经中继服务器（端到端加密）操作本机。设备丢失时立即吊销。</p>

    <div v-if="error" class="error-banner">
      <StatusDot status="err" :size="7" /> {{ error }}
    </div>

    <!-- 链路状态 -->
    <div class="card status-card">
      <div class="stat-row">
        <span class="k">链路</span>
        <StatusDot :status="linkDot" :size="8" />
        <span class="v" :data-state="linkState">{{ linkLabel }}</span>
      </div>
      <div class="stat-row">
        <span class="k">中继</span>
        <template v-if="!editingRelay">
          <code class="mono-v">{{ relayUrl || '（未配置）' }}</code>
          <Button variant="ghost" size="sm" @click="startEditRelay">{{ relayUrl ? '修改' : '配置' }}</Button>
        </template>
        <template v-else>
          <input v-model="relayDraft" class="relay-input" placeholder="wss://your-relay:8443" spellcheck="false" />
          <Button variant="primary" size="sm" :disabled="savingRelay" @click="saveRelay">{{ savingRelay ? '保存中…' : '保存' }}</Button>
          <Button variant="ghost" size="sm" @click="editingRelay = false">取消</Button>
        </template>
      </div>
      <div class="stat-row">
        <span class="k">本机身份</span>
        <code class="mono-v dim">{{ identityPubkey.slice(0, 24) }}…</code>
      </div>
    </div>

    <!-- 未配置引导 -->
    <div v-if="!relayUrl" class="card guide-card">
      中继服务器未配置。点击上方「配置」填入 relay 地址（wss://…）即可启用远程接入——即时生效，无需重启。
    </div>

    <!-- 配对区 -->
    <div class="card pairing-card" v-if="relayUrl">
      <template v-if="!pairing">
        <div class="pair-idle">
          <span class="pair-hint">添加远程设备：扫码 → 两端核对数字 → 信任。</span>
          <Button variant="primary" size="sm" icon="plus" :disabled="pairingBusy" @click="startPairing">添加远程设备</Button>
        </div>
      </template>
      <template v-else-if="pairing.state === 'wait-join'">
        <div class="pair-title">扫码配对<span class="pair-ttl">5 分钟内有效</span></div>
        <PairingQr :uri="pairing.qrUri" />
        <p class="pair-hint center">手机 App 扫描此二维码 → 两端屏幕各显示一组数字 → 核对一致后在下面对比确认</p>
        <div class="pair-actions">
          <Button variant="ghost" size="sm" :disabled="pairingBusy" @click="cancelPairing">取消</Button>
        </div>
      </template>
      <template v-else-if="pairing.state === 'sas-confirm'">
        <div class="pair-title">核对数字（SAS）</div>
        <div class="sas-num">
          <span>{{ pairing.sas?.slice(0, 4) }}</span>
          <span class="sep">·</span>
          <span>{{ pairing.sas?.slice(4) }}</span>
        </div>
        <p class="pair-hint center">与手机屏幕显示的数字一致吗？一致 = 信任此设备；不一致 = 可能存在中间人，拒绝并重试。</p>
        <div class="pair-actions">
          <Button variant="danger" size="sm" :disabled="pairingBusy" @click="confirmPairing(false)">不一致（拒绝）</Button>
          <Button variant="primary" size="sm" :disabled="pairingBusy" @click="confirmPairing(true)">一致（信任）</Button>
        </div>
      </template>
      <template v-else-if="pairing.state === 'done'">
        <div class="pair-title done">
          <StatusDot status="ok" :size="8" /> 配对完成——设备「{{ pairing.deviceName }}」已注册
        </div>
        <div class="pair-actions">
          <Button variant="soft" size="sm" @click="pairing = null">关闭</Button>
        </div>
      </template>
      <template v-else>
        <div class="pair-title expired">配对已过期或被取消</div>
        <div class="pair-actions">
          <Button variant="primary" size="sm" @click="startPairing">重新开始</Button>
        </div>
      </template>
    </div>

    <!-- 设备列表 -->
    <div class="card list-card">
      <div class="list-head">已配对设备 <span class="count">{{ devices.length }}</span></div>
      <div v-if="!devices.length" class="empty-hint">暂无设备{{ relayUrl ? '——点击「添加远程设备」开始配对' : '' }}。</div>
      <div v-for="d in devices" :key="d.id" class="device-row">
        <StatusDot :status="d.online ? 'ok' : 'offline'" :size="8" />
        <div class="dev-info">
          <div class="dev-name">
            {{ d.name }}
            <span v-if="d.online" class="dev-badge">在线</span>
            <span v-for="s in d.scopes" :key="s" class="dev-scope">{{ s }}</span>
          </div>
          <div class="dev-meta">配对于 {{ fmtTime(d.pairedAt) }} · 最后活跃 {{ fmtTime(d.lastSeenAt) }}</div>
        </div>
        <Button variant="ghost" size="sm" :disabled="revoking === d.id" @click="revoke(d.id)">{{ revoking === d.id ? '吊销中…' : '吊销' }}</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remote-pane { display: flex; flex-direction: column; gap: var(--space-3); }
.sub { color: var(--text-3); font-size: 12px; margin: 0; line-height: 1.5; }

/* 卡片：tokens.css 中层容器语义（--r-md + surface 底 + line 描边） */
.card { background: var(--bg-surface); border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--space-3) var(--space-4); }

/* 错误横幅：role-active 语义（琥珀警示，非红——错误细节由文案承载） */
.error-banner { display: flex; align-items: center; gap: var(--space-2); font-size: 12px; color: var(--err); background: color-mix(in srgb, var(--err) 8%, transparent); border: 1px solid color-mix(in srgb, var(--err) 25%, transparent); border-radius: var(--r-sm); padding: 6px 10px; }

/* 状态卡行 */
.stat-row { display: flex; align-items: center; gap: var(--space-2); padding: 3px 0; min-height: 30px; }
.k { color: var(--text-3); min-width: 56px; font-size: 12px; flex: none; }
.v { font-size: 13px; }
.v[data-state="online"] { color: var(--ok); }
.v[data-state="error"] { color: var(--err); }
.mono-v { font-family: var(--font-mono); font-size: 11.5px; background: var(--bg-hover); padding: 2px 8px; border-radius: var(--r-sm); word-break: break-all; }
.mono-v.dim { color: var(--text-3); }
.relay-input { flex: 1; min-width: 0; background: var(--input-bg, var(--bg-raised)); border: 1px solid var(--input-border, var(--line)); border-radius: var(--r-sm); color: var(--text-1); padding: 4px 8px; font-size: 12px; font-family: var(--font-mono); outline: none; transition: border-color var(--dur-fast) var(--ease-out); }
.relay-input:focus { border-color: var(--input-focus, var(--primary)); }

/* 引导卡：role-info 语义 */
.guide-card { font-size: 12.5px; color: var(--text-2); border-style: dashed; background: transparent; }

/* 配对区 */
.pair-idle { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.pair-hint { color: var(--text-3); font-size: 12px; }
.pair-hint.center { text-align: center; margin: var(--space-2) 0; }
.pair-title { display: flex; align-items: center; gap: var(--space-2); font-size: 13px; font-weight: 600; color: var(--text-1); margin-bottom: var(--space-2); }
.pair-ttl { font-size: 11px; font-weight: normal; color: var(--text-3); margin-left: var(--space-1); }
.pair-title.done { color: var(--ok); }
.pair-title.expired { color: var(--warn); }
.pair-actions { display: flex; gap: var(--space-2); justify-content: flex-end; margin-top: var(--space-3); }

/* SAS 数字：primary-light 底的大号等宽数字——比对场景的视觉焦点 */
.sas-num { display: flex; justify-content: center; align-items: baseline; gap: var(--space-2); font-family: var(--font-mono); font-size: 30px; font-weight: 600; letter-spacing: 4px; color: var(--text-1); background: var(--primary-light); border-radius: var(--r-md); padding: var(--space-3) 0; margin: var(--space-2) 0; }
.sas-num .sep { color: var(--text-3); font-size: 20px; }

/* 设备列表 */
.list-head { font-size: 13px; font-weight: 600; color: var(--text-1); margin-bottom: var(--space-2); display: flex; align-items: center; gap: var(--space-2); }
.count { font-size: 11px; font-weight: normal; color: var(--text-3); background: var(--bg-hover); border-radius: var(--r-full); padding: 0 8px; }
.empty-hint { color: var(--text-3); font-size: 12.5px; padding: var(--space-2) 0; }
.device-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; border-top: 1px solid var(--line); }
.device-row:first-of-type { border-top: none; }
.dev-info { flex: 1; min-width: 0; }
.dev-name { font-size: 13px; color: var(--text-1); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.dev-badge { font-size: 10px; color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent); border-radius: var(--r-full); padding: 0 6px; line-height: 16px; }
.dev-scope { font-size: 10px; color: var(--text-3); background: var(--bg-hover); border-radius: var(--r-full); padding: 0 6px; line-height: 16px; }
.dev-meta { color: var(--text-3); font-size: 11px; margin-top: 2px; }
</style>