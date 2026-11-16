#!/usr/bin/env node
// 启动内核 HTTP 服务模式（M2）：node scripts/serve.js
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', 'kernel', 'src', 'server', 'main.ts');

const r = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '--experimental-sqlite', entry, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);
process.exit(r.status ?? 1);
