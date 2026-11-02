// ============================================================
// client/openWithMenu.ts —— 「打开方式」共享菜单状态（cr-829）
//
// 三处挂点（FilePreviewTabPane / FileEditsPanel / WorkspaceTree）共用
// 一份可用目标清单与记住的选择（dsh file-applications store 同思路：
// 同页面多挂载共享一次查询；查询失败 ≠ 空列表——失败时回落「系统默认
// 程序」且现有 open-local 动作保持可用）。记住的选择 localStorage
// 持久化（agentchat.openWith.choice），记住的 id 不在可用列表时回落
// 系统默认。
// ============================================================
import { readonly, ref, type Ref } from 'vue';
import type { RpcClientFace } from 'ac-client-runtime';

type Rpc = Pick<RpcClientFace, 'call'>;

export interface OpenTarget {
  id: string;
  label: string;
  kind: 'dir' | 'file' | 'both';
  /** 真实应用图标（dataURL；null/缺 = 前端回落线性图标） */
  icon?: string | null;
}

const CHOICE_KEY = 'agentchat.openWith.choice';

// 模块级单例（同页面共享；无引用计数——清单轻量且常驻页面）
const targets: Ref<OpenTarget[]> = ref([]);
const state: Ref<'idle' | 'loading' | 'error'> = ref('idle');
let loaded = false;
let requested = false;

const remembered: Ref<string> = ref(readChoice() || 'default');

function readChoice(): string {
  try { return localStorage.getItem(CHOICE_KEY) ?? ''; } catch { return ''; }
}

function persistChoice(id: string): void {
  // 值域：''（未设置）/ 'default'（显式系统默认）/ 应用 id。空串无法区分
  // 「未记住」与「显式选默认」，哨兵分离两态（主钮回落序依赖）
  remembered.value = id === '' ? 'default' : id;
  try {
    localStorage.setItem(CHOICE_KEY, remembered.value);
  } catch { /* 私密模式等存储失败——会话级记忆即可 */ }
}

/** 拉取可用目标清单（幂等：已载/在途不重复请求；失败保持 error 态可重试） */
async function loadTargets(rpc: Rpc): Promise<void> {
  if (loaded || requested) return;
  requested = true;
  state.value = 'loading';
  try {
    const r = await rpc.call<{ targets?: OpenTarget[] }>('workspace/open-targets');
    targets.value = Array.isArray(r.targets) ? r.targets : [];
    state.value = 'idle';
    loaded = true;
  } catch {
    state.value = 'error'; // 失败 ≠ 空列表：不置 loaded，下次挂载可重试
  } finally {
    requested = false;
  }
}


/** 菜单选项（真图标 dataURL 优先，iconIcon = lucide 回落名） */
export interface OpenOption {
  value: string;
  label: string;
  /** 真实应用图标 dataURL（win exe 提取；null = 用 iconIcon 线性图标） */
  icon: string | null;
  /** lucide 回落图标名（真图标缺失时渲染） */
  iconIcon: string;
}

/**
 * 按目标类型过滤的菜单选项：首项恒「系统默认程序」（value 空 = 现有
 * open-local/open-dir 行为），其后按 kind 过滤的可用应用。
 */
export function optionsFor(kind: 'file' | 'dir', list: readonly OpenTarget[]): OpenOption[] {
  const out: OpenOption[] = [{ value: '', label: '系统默认程序', icon: null, iconIcon: 'external-link' }];
  for (const t of list) {
    if (t.kind === kind || t.kind === 'both') {
      out.push({ value: t.id, label: t.label, icon: t.icon ?? null, iconIcon: fallbackIconOf(t.id) });
    }
  }
  return out;
}

/** 目标 id → lucide 回落图标名（真图标缺席时；与后端目录表 id 对应） */
function fallbackIconOf(id: string): string {
  if (id === 'vscode' || id === 'cursor') return 'app-window';
  if (id === 'explorer') return 'folder';
  if (id === 'notepad') return 'file-text';
  if (id === 'windowsterminal' || id === 'terminal') return 'square-terminal';
  return 'external-link';
}

/**
 * 主钮生效选择（dsh 回落序）：显式记住的应用 > 第一个可用应用 > 系统
 * 默认。主钮图标与点击行为恒一致——未记住时也显示具体应用的原生图标
 *（而非通用箭头）；「系统默认程序」保持菜单首项供显式选择。
 */
export function effectiveMainChoice(kind: 'file' | 'dir', list: readonly OpenTarget[], rememberedId: string): string {
  if (rememberedId === 'default') return '';
  if (rememberedId !== '' && list.some((t) => t.id === rememberedId)) return rememberedId;
  const first = optionsFor(kind, list).find((o) => o.value !== '');
  return first?.value ?? '';
}

/** 菜单状态面（挂点消费：targets/state/remembered + 动作） */
export function useOpenWithMenu() {
  return {
    targets: readonly(targets),
    state: readonly(state),
    remembered: readonly(remembered),
    load: loadTargets,
    persistChoice,
  };
}