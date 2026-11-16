import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { loadPlugins } from './loader.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function silentCtx(root: string, logs: string[] = []): ToolContext {
  return { workspaceRoot: root, approval: async () => false, log: (l) => logs.push(l) };
}

test('插件：装载 example-echo 且 patch 注入 prefix 生效', async () => {
  const registry = new ToolRegistry();
  const reports = await loadPlugins({
    workspaceRoot: repoRoot,
    registry,
    ctx: silentCtx(repoRoot),
  });
  const echo = reports.find((r) => r.name === 'example-echo');
  assert.equal(echo?.status, 'loaded');
  assert.ok(echo?.tools?.includes('echo'));
  assert.ok(reports.some((r) => r.status === 'disabled'));

  const res = await registry.invoke('echo', JSON.stringify({ text: 'hello' }), silentCtx(repoRoot));
  assert.equal(res.ok, true);
  assert.equal(res.output, '[echo] hello');
});

test('插件：禁用项不报错、坏插件被拦截不影响其他插件', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'myagent-plugins-'));
  const pdir = resolve(dir, 'plugins');
  await mkdir(pdir, { recursive: true });
  await writeFile(
    resolve(pdir, 'plugins.json'),
    JSON.stringify({
      plugins: [
        { name: 'bad', entry: 'bad.ts' },
        { name: 'off', entry: 'off.ts', enabled: false },
      ],
    }),
  );
  await writeFile(
    resolve(pdir, 'bad.ts'),
    'export default { name: "bad", setup() { throw new Error("boom"); } };',
  );
  await writeFile(resolve(pdir, 'off.ts'), 'export default { name: "off", setup() {} };');

  const registry = new ToolRegistry();
  const reports = await loadPlugins({ workspaceRoot: dir, registry, ctx: silentCtx(dir) });
  assert.equal(reports.find((r) => r.name === 'bad')?.status, 'failed');
  assert.equal(reports.find((r) => r.name === 'bad')?.error, 'boom');
  assert.equal(reports.find((r) => r.name === 'off')?.status, 'disabled');
  await rm(dir, { recursive: true, force: true });
});

test('插件：清单缺失返回空', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'myagent-plugins-'));
  const registry = new ToolRegistry();
  const reports = await loadPlugins({ workspaceRoot: dir, registry, ctx: silentCtx(dir) });
  assert.deepEqual(reports, []);
  await rm(dir, { recursive: true, force: true });
});
