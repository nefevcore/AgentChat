// electron-shim.mjs —— 桌面壳 main.mjs 的测试态 electron 垫片
// （vitest alias 'electron' → 本文件；仅测试态生效，electron-builder 打包不经 vitest）
// main.mjs 顶层读 app.isPackaged/getPath/requestSingleInstanceLock/whenReady——
// 垫片全部安全应答；BrowserWindow/Tray 等类只实例化不使用（测试不起窗口）。
const app = {
  isPackaged: false,
  getPath: () => process.cwd(),
  getAppPath: () => '.',
  requestSingleInstanceLock: () => true,
  setAppUserModelId: () => undefined,
  on: () => undefined,
  quit: () => undefined,
  relaunch: () => undefined,
  exit: () => undefined,
  whenReady: () => Promise.resolve(),
};
class BrowserWindow {
  constructor() { /* 测试不起窗口 */ }
}
class Tray {}
const Menu = { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) };
const Notification = { isSupported: () => false };
const dialog = {
  showErrorBox: () => undefined,
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};
const nativeImage = { createFromPath: () => ({ resize: () => ({}) }) };
const shell = { openExternal: async () => undefined };
export { app, BrowserWindow, Tray, Menu, Notification, dialog, nativeImage, shell };
export default { app, BrowserWindow, Tray, Menu, Notification, dialog, nativeImage, shell };
