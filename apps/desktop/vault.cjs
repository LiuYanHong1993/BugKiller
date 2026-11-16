#!/usr/bin/env node
// 凭据库（M4）：Windows DPAPI（CurrentUser 作用域）加密保管
// 对照智作 credentials 插件：密钥永不落明文；进程内存取，密文绑定当前系统用户
// 用法：node vault.cjs set <name>   （密钥从 stdin 读入）
//       node vault.cjs get <name>   （密钥写 stdout —— 仅供壳层注入内核）
//       node vault.cjs list | delete <name>

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const vaultDir =
  process.env.MYAGENT_VAULT_DIR || path.join(process.cwd(), 'data', 'vault');

if (process.platform !== 'win32') {
  console.error('本凭据库当前实现依赖 Windows DPAPI');
  process.exit(2);
}

function fileOf(name) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`非法凭据名：${name}`);
  return path.join(vaultDir, `${name}.bin`);
}

function dpapi(script, input) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input, encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0 || !String(r.stdout || '').trim()) {
    throw new Error(`DPAPI 调用失败：${String(r.stderr || '').slice(0, 200)}`);
  }
  return String(r.stdout).trim();
}

const PROTECT =
  'Add-Type -AssemblyName System.Security; ' +
  '$raw=[Console]::In.ReadToEnd(); ' +
  '$b=[System.Text.Encoding]::UTF8.GetBytes($raw); ' +
  '$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
  '[Console]::Out.Write([Convert]::ToBase64String($p))';

const UNPROTECT =
  'Add-Type -AssemblyName System.Security; ' +
  '$raw=[Console]::In.ReadToEnd(); ' +
  '$b=[Convert]::FromBase64String($raw.Trim()); ' +
  '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
  '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($p))';

function setSecret(name, secret) {
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(fileOf(name), dpapi(PROTECT, secret), 'utf8');
}

function getSecret(name) {
  const f = fileOf(name);
  if (!fs.existsSync(f)) return null;
  return dpapi(UNPROTECT, fs.readFileSync(f, 'utf8'));
}

function listNames() {
  if (!fs.existsSync(vaultDir)) return [];
  return fs
    .readdirSync(vaultDir)
    .filter((f) => f.endsWith('.bin'))
    .map((f) => f.slice(0, -4));
}

function deleteSecret(name) {
  const f = fileOf(name);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

const [, , cmd, name] = process.argv;
try {
  if (cmd === 'set' && name) {
    const secret = readStdinSync();
    if (!secret) throw new Error('stdin 未提供密钥内容');
    setSecret(name, secret);
    console.log(`已保存凭据 ${name}（DPAPI CurrentUser 加密）`);
  } else if (cmd === 'get' && name) {
    const secret = getSecret(name);
    if (secret === null) {
      console.error(`凭据不存在：${name}`);
      process.exit(1);
    }
    process.stdout.write(secret); // 无换行，避免污染注入值
  } else if (cmd === 'list') {
    for (const n of listNames()) console.log(n);
  } else if (cmd === 'delete' && name) {
    deleteSecret(name);
    console.log(`已删除凭据 ${name}`);
  } else {
    console.error('用法：node vault.cjs set|get|delete <name> | list');
    process.exit(2);
  }
} catch (e) {
  console.error(`[vault] ${e.message}`);
  process.exit(1);
}
