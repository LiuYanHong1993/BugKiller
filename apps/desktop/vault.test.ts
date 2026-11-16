import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vaultCli = join(repoRoot, 'apps', 'desktop', 'vault.cjs');

const win32Only = process.platform === 'win32' ? test : test.skip;

function vault(dir: string, args: string[], input?: string): { status: number; out: string } {
  const r = execFileSync(process.execPath, [vaultCli, ...args], {
    input: input ?? '',
    encoding: 'utf8',
    env: { ...process.env, MYAGENT_VAULT_DIR: dir },
    windowsHide: true,
  });
  return { status: 0, out: r };
}

win32Only('凭据库：DPAPI set/get 往返', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-vault-'));
  try {
    vault(dir, ['set', 'model-api-key'], 'sk-test-秘密123');
    const r = execFileSync(process.execPath, [vaultCli, 'get', 'model-api-key'], {
      encoding: 'utf8',
      env: { ...process.env, MYAGENT_VAULT_DIR: dir },
      windowsHide: true,
    });
    assert.equal(r, 'sk-test-秘密123'); // 无换行污染
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

win32Only('凭据库：密文不等于明文（DPAPI 加密落盘）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-vault-'));
  try {
    vault(dir, ['set', 'k1'], 'PLAINTEXT-SECRET');
    const { readFileSync } = await import('node:fs');
    const blob = readFileSync(join(dir, 'k1.bin'), 'utf8');
    assert.ok(!blob.includes('PLAINTEXT-SECRET'));
    assert.match(blob, /^[A-Za-z0-9+/=]+$/); // base64 密文
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

win32Only('凭据库：list / delete / 取不存在的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-vault-'));
  try {
    vault(dir, ['set', 'a'], '1');
    vault(dir, ['set', 'b'], '2');
    const listed = vault(dir, ['list']).out.trim().split('\n').sort();
    assert.deepEqual(listed, ['a', 'b']);
    vault(dir, ['delete', 'a']);
    assert.equal(vault(dir, ['list']).out.trim(), 'b');
    // get 不存在的：退出码 1
    let failed = false;
    try {
      execFileSync(process.execPath, [vaultCli, 'get', 'nope'], {
        encoding: 'utf8',
        env: { ...process.env, MYAGENT_VAULT_DIR: dir },
        windowsHide: true,
      });
    } catch {
      failed = true;
    }
    assert.ok(failed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
