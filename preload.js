'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  saveCredentials: (payload) => ipcRenderer.invoke('dsh:save-credentials', payload),
  finishOnboarding: () => ipcRenderer.invoke('dsh:finish-onboarding'),
  getState: () => ipcRenderer.invoke('dsh:get-state'),
  openLogs: () => ipcRenderer.invoke('dsh:open-logs'),
  openSettingsWindow: () => ipcRenderer.invoke('dsh:open-settings-window'),
  // Settings
  getSettings: () => ipcRenderer.invoke('dsh:get-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('dsh:save-settings', payload),
  pickFile: (payload) => ipcRenderer.invoke('dsh:pick-file', payload),
  testRuntime: (payload) => ipcRenderer.invoke('dsh:test-runtime', payload),
  applySettings: () => ipcRenderer.invoke('dsh:apply-settings'),
  // OpenCode multi-key proxy
  proxyGetState: () => ipcRenderer.invoke('dsh:proxy-get-state'),
  proxySaveConfig: (payload) => ipcRenderer.invoke('dsh:proxy-save-config', payload),
  proxyRotate: () => ipcRenderer.invoke('dsh:proxy-rotate'),
  // DeepSeek official balance
  deepseekBalance: () => ipcRenderer.invoke('dsh:deepseek-balance'),
});

// Ctrl + mouse wheel zoom (zoom by font/page size from any page).
window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const direction = event.deltaY < 0 ? 1 : -1;
  void ipcRenderer.invoke('dsh:zoom-by-wheel', direction);
}, { passive: false });
