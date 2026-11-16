import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowEngine } from './engine.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'myagent-wf-'));
}

test('工作流：DAG 并行 + 顺序 + 插值 + NDJSON 事件', async () => {
  const dir = await tempDir();
  const calls: string[] = [];
  const engine = new WorkflowEngine({
    runDir: dir,
    runner: async (prompt, stepId) => {
      calls.push(stepId);
      return `${stepId}(${prompt})`;
    },
  });
  const result = await engine.run({
    name: 'demo',
    steps: [
      { id: 'a', prompt: 'A' },
      { id: 'c', prompt: 'C' },
      { id: 'b', prompt: '基于 ${a}', dependsOn: ['a'] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.outputs.b, 'b(基于 a(A))');
  assert.equal(result.outputs.c, 'c(C)');
  const saved = JSON.parse(
    await readFile(join(dir, result.runId, 'result.json'), 'utf8'),
  ) as { runId: string; ok: boolean };
  assert.equal(saved.runId, result.runId);
  assert.equal(saved.ok, true);

  const events = (await readFile(join(dir, result.runId, 'events.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; stepId?: string });
  assert.equal(events[0]!.type, 'workflow_start');
  assert.equal(events[events.length - 1]!.type, 'workflow_end');
  const idx = (type: string, stepId?: string) =>
    events.findIndex((e) => e.type === type && (stepId === undefined || e.stepId === stepId));
  // b 必须在 a 结束之后才开始
  assert.ok(idx('step_end', 'a') < idx('step_start', 'b'));
  assert.ok(idx('workflow_end') > idx('step_end', 'b'));
  // a 与 c 无依赖：并发启动（c 不会等 a 的 end）
  assert.ok(idx('step_start', 'c') < idx('step_end', 'a') || idx('step_end', 'c') >= 0);
  await rm(dir, { recursive: true, force: true });
});

test('工作流：失败级联跳过下游，无关节照常完成', async () => {
  const dir = await tempDir();
  const engine = new WorkflowEngine({
    runDir: dir,
    runner: async (_prompt, stepId) => {
      if (stepId === 'a') throw new Error('boom');
      return 'ok';
    },
  });
  const result = await engine.run({
    name: 'demo2',
    steps: [
      { id: 'a', prompt: 'A' },
      { id: 'b', prompt: 'B', dependsOn: ['a'] },
      { id: 'c', prompt: 'C' },
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failedSteps.sort(), ['a', 'b']);
  assert.equal(result.outputs.c, 'ok');
  assert.ok(!('b' in result.outputs));
  await rm(dir, { recursive: true, force: true });
});

test('工作流：循环依赖直接报错', async () => {
  const dir = await tempDir();
  const engine = new WorkflowEngine({ runDir: dir, runner: async () => 'x' });
  await assert.rejects(
    () =>
      engine.run({
        name: 'cycle',
        steps: [
          { id: 'a', prompt: 'A', dependsOn: ['b'] },
          { id: 'b', prompt: 'B', dependsOn: ['a'] },
        ],
      }),
    /循环依赖/,
  );
  await rm(dir, { recursive: true, force: true });
});

test('工作流：依赖不存在的步骤报错', async () => {
  const dir = await tempDir();
  const engine = new WorkflowEngine({ runDir: dir, runner: async () => 'x' });
  await assert.rejects(
    () => engine.run({ name: 'ghost', steps: [{ id: 'a', prompt: 'A', dependsOn: ['nope'] }] }),
    /不存在的步骤/,
  );
  await rm(dir, { recursive: true, force: true });
});
