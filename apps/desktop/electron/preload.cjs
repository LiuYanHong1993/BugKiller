// preload 白名单（M4）：页面只能看到这三个方法，拿不到 ipcRenderer / nodeIntegration
// 对照智作 window.stratex preload 的最小面暴露原则

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myagentShell', {
  status: () => ipcRenderer.invoke('shell:status'),
  vaultGet: (name) => ipcRenderer.invoke('vault:get', String(name)),
  vaultSet: (name, secret) => ipcRenderer.invoke('vault:set', { name: String(name), secret: String(secret) }),
});
