import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File, signManifest, verifyUpdate } from './updater.ts';

async function makeFixture(): Promise<{ dir: string; privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-update-'));
  await writeFile(join(dir, 'app.asar'), Buffer.from('ASAR-CONTENT-v1'));
  await writeFile(join(dir, 'host.exe'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    dir,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

test('更新：合法清单双校验通过', async () => {
  const { dir, privateKey, publicKey } = await makeFixture();
  const f1 = await sha256File(join(dir, 'app.asar'));
  const f2 = await sha256File(join(dir, 'host.exe'));
  const manifest = {
    version: '0.2.0',
    files: [
      { path: 'app.asar', ...f1 },
      { path: 'host.exe', ...f2 },
    ],
    signature: '',
  };
  manifest.signature = signManifest(manifest, privateKey);
  const result = await verifyUpdate(dir, manifest, publicKey);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  await rm(dir, { recursive: true, force: true });
});

test('更新：文件被篡改 → 摘要不符', async () => {
  const { dir, privateKey, publicKey } = await makeFixture();
  const f1 = await sha256File(join(dir, 'app.asar'));
  const f2 = await sha256File(join(dir, 'host.exe'));
  const manifest = { version: '0.2.0', files: [{ path: 'app.asar', ...f1 }, { path: 'host.exe', ...f2 }], signature: '' };
  manifest.signature = signManifest(manifest, privateKey);
  // 篡改一个字节
  await writeFile(join(dir, 'host.exe'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 9]));
  const result = await verifyUpdate(dir, manifest, publicKey);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('host.exe')));
  await rm(dir, { recursive: true, force: true });
});

test('更新：清单被篡改（换版本号）→ 签名失败优先拒绝', async () => {
  const { dir, privateKey, publicKey } = await makeFixture();
  const f1 = await sha256File(join(dir, 'app.asar'));
  const manifest = { version: '0.2.0', files: [{ path: 'app.asar', ...f1 }], signature: '' };
  manifest.signature = signManifest(manifest, privateKey);
  const tampered = { ...manifest, version: '9.9.9' };
  const result = await verifyUpdate(dir, tampered, publicKey);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['manifest 签名校验失败']);
  await rm(dir, { recursive: true, force: true });
});

test('更新：缺文件 / 错公钥 都过不了', async () => {
  const { dir, privateKey, publicKey } = await makeFixture();
  const f1 = await sha256File(join(dir, 'app.asar'));
  const manifest = { version: '0.2.0', files: [{ path: 'app.asar', ...f1 }, { path: 'ghost.dll', sha256: '00', size: 1 }], signature: '' };
  manifest.signature = signManifest(manifest, privateKey);
  const r1 = await verifyUpdate(dir, manifest, publicKey);
  assert.ok(r1.problems.some((p) => p.includes('缺少文件')));

  const other = generateKeyPairSync('ed25519');
  const wrongPub = other.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const r2 = await verifyUpdate(dir, manifest, wrongPub);
  assert.deepEqual(r2.problems, ['manifest 签名校验失败']);
  await rm(dir, { recursive: true, force: true });
});
