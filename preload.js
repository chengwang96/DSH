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
});
