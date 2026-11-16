// preload 白名单（M4）：页面只能看到这三个方法，拿不到 ipcRenderer / nodeIntegration
// 最小暴露面原则

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myagentShell', {
  status: () => ipcRenderer.invoke('shell:status'),
  vaultGet: (name) => ipcRenderer.invoke('vault:get', String(name)),
  vaultSet: (name, secret) => ipcRenderer.invoke('vault:set', { name: String(name), secret: String(secret) }),
});
