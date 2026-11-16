import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SandboxSession, SandboxError } from './session.ts';
import { loadSandboxPolicy, globToRegExp } from './policy.ts';

async function makeEnv(): Promise<{ root: string; journal: string }> {
  const root = await mkdtemp(join(tmpdir(), 'myagent-sbx-'));
  const journal = await mkdtemp(join(tmpdir(), 'myagent-sbx-j-'));
  return { root, journal };
}

const silentLog = (): void => {};

test('沙箱：新建文件 → 回滚删除；覆盖文件 → 回滚还原', async () => {
  const { root, journal } = await makeEnv();
  // 预置一个会被覆盖的文件
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes', 'keep.txt'), '原始内容', 'utf8');

  const sbx = new SandboxSession({
    workspaceRoot: root,
    journalDir: journal,
    policy: loadSandboxPolicy(resolve(root)), // 无 policy 目录 → 默认策略
    log: silentLog,
  });

  await sbx.writeFile(join(root, 'notes', 'keep.txt'), '被覆盖了', 'utf8');
  await sbx.writeFile(join(root, 'notes', 'new.txt'), '新建', 'utf8');
  assert.equal(await readFile(join(root, 'notes', 'keep.txt'), 'utf8'), '被覆盖了');
  assert.equal(await readFile(join(root, 'notes', 'new.txt'), 'utf8'), '新建');

  const restored = await sbx.rollback();
  assert.equal(await readFile(join(root, 'notes', 'keep.txt'), 'utf8'), '原始内容');
  await assert.rejects(() => readFile(join(root, 'notes', 'new.txt'), 'utf8'), /ENOENT/);
  assert.equal(restored.length, 2);
  await rm(root, { recursive: true, force: true });
  await rm(journal, { recursive: true, force: true });
});

test('沙箱：多次覆盖同一文件 → 回滚到会话最初状态', async () => {
  const { root, journal } = await makeEnv();
  await writeFile(join(root, 'a.txt'), 'v0', 'utf8');
  const sbx = new SandboxSession({ workspaceRoot: root, journalDir: journal, policy: loadSandboxPolicy(root), log: silentLog });
  await sbx.writeFile(join(root, 'a.txt'), 'v1', 'utf8');
  await sbx.writeFile(join(root, 'a.txt'), 'v2', 'utf8');
  await sbx.rollback();
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'v0');
  await rm(root, { recursive: true, force: true });
  await rm(journal, { recursive: true, force: true });
});

test('沙箱：守卫名单 fail-closed + 越界拒绝 + 大小上限', async () => {
  const { root, journal } = await makeEnv();
  const sbx = new SandboxSession({ workspaceRoot: root, journalDir: journal, policy: loadSandboxPolicy(root), log: silentLog });

  // 凭据库守卫
  await assert.rejects(() => sbx.writeFile(join(root, 'data', 'vault', 'k.bin'), 'x'), /守卫名单/);
  // .git 守卫
  await assert.rejects(() => sbx.writeFile(join(root, '.git', 'config'), 'x'), /守卫名单/);
  // 越界
  await assert.rejects(() => sbx.writeFile(resolve(root, '..', 'outside.txt'), 'x'), /路径越界/);

  // 大小上限（构造 maxFileBytes=5 的策略）
  const tiny = new SandboxSession({
    workspaceRoot: root,
    journalDir: journal,
    policy: { schemaVersion: 1, maxFileBytes: 5, denyPaths: [] },
    log: silentLog,
  });
  await assert.rejects(() => tiny.writeFile(join(root, 'big.txt'), '123456'), /上限/);

  // 策略损坏 → 全拒（fail-closed）
  const brokenDir = await mkdtemp(join(tmpdir(), 'myagent-pol-'));
  await writeFile(join(brokenDir, 'sandbox.json'), '{broken', 'utf8');
  const policy = loadSandboxPolicy(brokenDir);
  assert.deepEqual(policy.denyPaths, ['**']);
  assert.equal(policy.maxFileBytes, 0);
  const strict = new SandboxSession({ workspaceRoot: root, journalDir: journal, policy, log: silentLog });
  await assert.rejects(() => strict.writeFile(join(root, 'x.txt'), 'y'), /守卫名单|上限/);

  await rm(root, { recursive: true, force: true });
  await rm(journal, { recursive: true, force: true });
  await rm(brokenDir, { recursive: true, force: true });
});

test('沙箱：glob-lite 规则', () => {
  assert.ok(globToRegExp('data/vault/**').test('data/vault/k.bin'));
  assert.ok(globToRegExp('data/vault/**').test('data/vault/sub/k.bin'));
  assert.ok(!globToRegExp('data/vault/**').test('data/notes/k.txt'));
  assert.ok(globToRegExp('policy/*.local.json').test('policy/a.local.json'));
  assert.ok(!globToRegExp('policy/*.local.json').test('policy/sub/a.local.json'));
});
