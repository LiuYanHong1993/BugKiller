import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDockerRunArgs, imageRef } from './docker-executor.ts';

test('Docker：digest 钉死 + 只读 + 断网（默认）', () => {
  const args = buildDockerRunArgs({
    image: 'myagent/sandbox',
    digest: 'sha256:abc123',
    cmd: ['node', 'run.js'],
  });
  assert.deepEqual(args, [
    'run', '--rm', '--pull=never', '--read-only', '--network', 'none',
    'myagent/sandbox@sha256:abc123', 'node', 'run.js',
  ]);
});

test('Docker：挂载默认只读、env、workdir、可写根覆盖', () => {
  const args = buildDockerRunArgs({
    image: 'myagent/sandbox',
    workdir: '/workspace',
    mounts: [
      { host: 'C:\\ws', container: '/workspace' },
      { host: 'C:\\tmp', container: '/tmp', readOnly: false },
    ],
    env: { MYAGENT_PRESET: 'local-llamacpp' },
    network: 'bridge',
    writableRootFs: true,
    cmd: ['node', 'step.js'],
  });
  assert.equal(args.filter((a) => a === '--read-only').length, 0);
  assert.ok(args.includes('--pull=missing'));
  assert.ok(args.includes('--volume'));
  assert.ok(args.some((a) => a === 'C:\\ws:/workspace:ro'));
  assert.ok(args.some((a) => a === 'C:\\tmp:/tmp'));
  assert.equal(args[args.indexOf('--env') + 1], 'MYAGENT_PRESET=local-llamacpp');
  assert.equal(args[args.indexOf('--workdir') + 1], '/workspace');
  assert.equal(args[args.indexOf('--network') + 1], 'bridge');
});

test('Docker：imageRef 补全 sha256 前缀', () => {
  assert.equal(imageRef('img', 'sha256:aa'), 'img@sha256:aa');
  assert.equal(imageRef('img', 'aa'), 'img@sha256:aa');
  assert.equal(imageRef('img'), 'img');
});
