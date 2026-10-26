// ============================================================
// client/systemActions.ts —— 备份执行器 + 版本检查（cr-332 并源：
// ActivityBar 更多菜单与 MobileMoreSheet 常用项的公共数据面。
//
// 归并前两份内联实现已走散（模板串 vs 拼接、sizeMB 保留位差异）——
// 本模块是唯一实现；toast 同 key 'backup' 原位刷新（busy → ok/error）
// 的反馈语义保持不变。
// ============================================================
import { ref } from 'vue';
import { toastBusy, toastOk, toastError } from '@agentchat/webui-kit';
import { backupNow, fetchVersion, simulateUpdateChannel } from 'ac-client-ui-system/client/systemApi.ts';

type Rpc = { call<T>(m: string, p?: Record<string, unknown>): Promise<T> };

/** 备份执行器（busy 防重入；rpc 缺席 = 网络错误路径走 toastError） */
export function createBackupRunner(rpc: Rpc | undefined): { busy: ReturnType<typeof ref<boolean>>; run: () => Promise<void> } {
  const busy = ref(false);
  async function run(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    toastBusy('正在备份…', { key: 'backup' });
    try {
      const d = await backupNow(rpc!);
      if (d.status === 'ok') {
        toastOk(`备份完成：${d.file}（${((d.size ?? 0) / 1024 / 1024).toFixed(1)}MB，现有 ${d.count} 份备份）`, { key: 'backup' });
      } else {
        toastError(`备份失败：${d.error || '未知错误'}`, { key: 'backup' });
      }
    } catch (err) {
      // catch 值现实可为非 Error（throw 字符串等）——message 读取失败回落网络错误文案
      const msg = err instanceof Error ? err.message : '';
      toastError(`备份失败：${msg || '网络错误'}`, { key: 'backup' });
    } finally {
      busy.value = false;
    }
  }
  return { busy, run };
}

/** 版本检查一次（挂载即查；simulate 测试通道垫片单源；失败静默 false——
 *  更新红点只在确认有更新时亮，检查失败不误报） */
export async function checkUpdateOnce(rpc: Rpc | undefined): Promise<boolean> {
  try {
    const simulate = simulateUpdateChannel();
    const data = await fetchVersion(simulate, rpc!);
    return data.hasUpdate || false;
  } catch {
    return false;
  }
}
