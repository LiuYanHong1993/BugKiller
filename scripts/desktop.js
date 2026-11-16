#!/usr/bin/env node
// 桌面壳启动器：优先 Electron，缺包时回退 Node 壳（架构一致，仅无窗口管理）
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);

let electronPath = null;
try {
  electronPath = require2('electron'); // electron 包的主导出是其可执行文件路径
} catch {
  electronPath = null;
}

if (electronPath && typeof electronPath === 'string') {
  const r = spawnSync(electronPath, [resolve(here, '..', 'apps', 'desktop', 'electron')], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

console.log('未安装 electron 包 → Node 壳模式（Electron 版代码在 apps/desktop/electron/，`npm i electron` 后自动启用）');
const r = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', resolve(here, '..', 'apps', 'desktop', 'shell.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);
process.exit(r.status ?? 1);
