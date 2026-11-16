import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHealthCheckCommand, buildReleaseManifest, buildRollbackCommands, buildSwitchCommands } from './plan.ts';

test('部署：发布清单（sha256 + size + 排序）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-deploy-'));
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'b.txt'), 'hello', 'utf8');
  await writeFile(join(dir, 'lib', 'a.js'), 'export {}', 'utf8');
  const m = await buildReleaseManifest(dir, { version: 'v-test' });
  assert.equal(m.version, 'v-test');
  assert.deepEqual(
    m.files.map((f) => f.rel),
    ['b.txt', 'lib/a.js'], // 排序稳定
  );
  assert.equal(m.files[0]!.size, 5);
  assert.equal(m.files[0]!.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'); // sha256("hello")
  await rm(dir, { recursive: true, force: true });
});

test('部署：切换命令含原子 mv -T 与 previous 锚点', () => {
  const cmds = buildSwitchCommands({
    releasesDir: '/srv/myagent/releases',
    currentLink: '/srv/myagent/current',
    previousLink: '/srv/myagent/previous',
    version: '20261104-120000',
  });
  assert.equal(cmds.length, 4);
  assert.match(cmds[0]!, /readlink/); // 先记录回滚锚点
  assert.match(cmds[1]!, /ln -sfn .*\.new/);
  assert.match(cmds[2]!, /mv -T/); // 原子 rename，无半切换窗口
  assert.match(cmds[3]!, /\.last-switched/);
  // 单引号注入安全
  assert.ok(cmds.join(' ').includes(`'\\''`) === false);
});

test('部署：回滚命令从 previous 恢复 current', () => {
  const cmds = buildRollbackCommands({
    releasesDir: '/srv/myagent/releases',
    currentLink: '/srv/myagent/current',
    previousLink: '/srv/myagent/previous',
  });
  assert.match(cmds[0]!, /readlink .*previous/);
  assert.match(cmds[0]!, /exit 1/); // 无锚点则失败（fail-closed）
  assert.match(cmds[2]!, /mv -T/);
});

test('部署：健康检查命令', () => {
  const c = buildHealthCheckCommand('http://127.0.0.1:8642/health');
  assert.match(c, /curl -fsS -m 10/);
});
