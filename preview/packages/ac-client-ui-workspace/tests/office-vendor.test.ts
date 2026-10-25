// ============================================================
// @vitest-environment jsdom
// tests/office-vendor.test.ts —— UMD 运行时加载器测试
//（script 注入路径/全局读取/并发去重/失败重试/成功常驻）
// 模块级 inflight 缓存跨用例存留——vi.resetModules + 动态 import 隔离。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// jsdom 不执行 script 内容——在 src setter 里模拟 UMD 产物落位后派发 onload
function fakeUmd(globalName: string, value: unknown) {
  return vi.spyOn(HTMLScriptElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLScriptElement, v: string) {
    if (v.includes('/vendor/')) {
      queueMicrotask(() => {
        (window as any)[globalName] = value;
        this.dispatchEvent(new Event('load'));
      });
    }
  });
}

async function freshLoader() {
  for (const g of ['vue-office-docx', 'vue-office-excel', 'vue-office-pptx']) delete (window as any)[g];
  document.querySelectorAll('script').forEach((s) => s.remove());
  return await import('../client/officeVendor.ts');
}

describe('loadOfficeComponent', () => {
  let spied: any;
  beforeEach(() => {
    vi.resetModules();
    spied = fakeUmd('vue-office-docx', { __docx: true });
  });
  afterEach(() => {
    spied.mockRestore();
    document.querySelectorAll('script').forEach((s) => s.remove());
  });

  it('注入 /vendor/vue-office-{kind}.js 并读全局产物', async () => {
    const { loadOfficeComponent } = await freshLoader();
    const comp = await loadOfficeComponent('docx');
    expect(comp).toEqual({ __docx: true });
    expect(spied).toHaveBeenCalledWith('/vendor/vue-office-docx.js');
    expect(document.querySelectorAll('script').length).toBe(1);
  });

  it('并发去重：同时两次调用只注入一个 script', async () => {
    const { loadOfficeComponent } = await freshLoader();
    const [a, b] = await Promise.all([loadOfficeComponent('docx'), loadOfficeComponent('docx')]);
    expect(a).toBe(b);
    expect(document.querySelectorAll('script').length).toBe(1);
  });

  it('失败可重试：script onerror 后清缓存（再注入新 script）', async () => {
    const { loadOfficeComponent } = await freshLoader();
    spied.mockRestore();
    const errSpy = vi.spyOn(HTMLScriptElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLScriptElement) {
      queueMicrotask(() => this.dispatchEvent(new Event('error')));
    });
    await expect(loadOfficeComponent('docx')).rejects.toThrow('加载失败');
    errSpy.mockRestore();
    spied = fakeUmd('vue-office-docx', { __docx: true });
    const comp = await loadOfficeComponent('docx');
    expect(comp).toEqual({ __docx: true });
    expect(document.querySelectorAll('script').length).toBe(2); // 失败一次 + 重试一次
  });

  it('加载成功即常驻：二次调用不再注入 script', async () => {
    const { loadOfficeComponent } = await freshLoader();
    await loadOfficeComponent('docx');
    await loadOfficeComponent('docx');
    expect(document.querySelectorAll('script').length).toBe(1);
  });
});
