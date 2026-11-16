// Electron 主进程（M4）：真实桌面壳
//  - 用 ELECTRON_RUN_AS_NODE 复用 Electron 二进制拉起内核侧车（对照智作 assistant-host）
//  - BrowserWindow 加载内核 webserver 的带令牌地址（对照 stratex-app:// 的受控加载）
//  - contextBridge 白名单：页面拿不到 ipcRenderer，只能调用下面暴露的三个方法
// 运行：npm i electron 后 `npm run desktop`

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const vault = require('./vault.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SIDECAR_ENTRY = path.join(REPO_ROOT, 'kernel', 'src', 'ipc', 'main.ts');

/** 壳状态（preload 白名单里 shell:status 的数据源） */
const shellStatus = { sidecar: 'starting', restarts: 0, model: null, webUrl: null };

let win = null;
let sidecar = null;
let stopping = false;

function startSidecar(onReady, onExit) {
  const child = spawn(
    process.execPath, // ELECTRON_RUN_AS_NODE=1 时等于 node
    ['--experimental-strip-types', '--no-warnings', SIDECAR_ENTRY],
    { cwd: REPO_ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const pending = new Map();
  let nextId = 1;
  const request = (method, params, timeoutMs = 60_000) =>
    new Promise((resolveP, rejectP) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectP(new Error(`侧车请求超时：${method}`));
      }, timeoutMs);
      pending.set(id, { resolveP, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  child.stdout.setEncoding('utf8');
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.rejectP(new Error(msg.error.message ?? '侧车错误'));
      else p.resolveP(msg.result);
      return;
    }
    if (msg.method === 'log') console.log(`  ${msg.params?.line ?? ''}`);
    else if (msg.method === 'event' && msg.params?.event?.type === 'approval_request') {
      console.log(`  [事件] 审批请求（会话 ${msg.params?.sessionId}）`);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    const t = String(c).trim();
    if (t) console.error(`[sidecar:stderr] ${t.slice(0, 200)}`);
  });
  child.on('exit', (code) => {
    sidecar = null;
    if (!stopping) onExit(code);
  });

  // 凭据现取 + 经 IPC 注入（零落盘；内核只持内存）
  const storedKey = vault.get('model-api-key');
  request('initialize', { apiKey: storedKey || undefined })
    .then((result) => {
      shellStatus.sidecar = 'running';
      shellStatus.model = result?.state?.model ?? null;
      shellStatus.webUrl = result?.webUrl ?? null;
      onReady(result);
    })
    .catch((err) => {
      console.error('[sidecar] 握手失败：', err.message);
      app.quit();
    });

  return { child, request };
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'agent-platform',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, // 与智作同款：隔离 + 白名单
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(url);
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  const restart = () => {
    shellStatus.restarts += 1;
    if (shellStatus.restarts > 3) {
      console.error('[sidecar] 连续退出超过 3 次，应用关闭');
      app.quit();
      return;
    }
    console.log(`[sidecar] 退出，${shellStatus.restarts}/3 自动重启…`);
    setTimeout(() => startSidecar((res) => win && win.loadURL(res.webUrl), restart), 1500);
  };

  startSidecar(
    (result) => createWindow(result.webUrl),
    restart,
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && shellStatus.webUrl) createWindow(shellStatus.webUrl);
  });
});

// ---- preload 白名单对应的 IPC 处理器 ----
ipcMain.handle('shell:status', () => shellStatus);
ipcMain.handle('vault:get', (_e, name) => vault.get(String(name)));
ipcMain.handle('vault:set', (_e, payload) => {
  const { name, secret } = payload ?? {};
  vault.set(String(name), String(secret));
  return true;
});

app.on('window-all-closed', () => {
  stopping = true;
  if (sidecar) sidecar.child.kill();
  app.quit();
});
