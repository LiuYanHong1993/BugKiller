import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from './registry.ts';
import type { ToolContext, ToolDef } from './types.ts';

function fakeCtx(approved: boolean): ToolContext {
  return {
    workspaceRoot: '/tmp/wk',
    approval: async () => approved,
    log: () => {},
  };
}

const demo: ToolDef = {
  name: 'demo',
  description: 'demo tool',
  parameters: { type: 'object', properties: {} },
  requiredApproval: () => ({ tool: 'demo', action: '演示动作', detail: '测试审批' }),
  execute: async () => ({ ok: true, output: 'done' }),
};

test('审批拒绝时不执行工具', async () => {
  const reg = new ToolRegistry();
  reg.register(demo);
  const r = await reg.invoke('demo', '{}', fakeCtx(false));
  assert.equal(r.ok, false);
  assert.match(r.output, /拒绝/);
});

test('审批通过后执行并返回输出', async () => {
  const reg = new ToolRegistry();
  reg.register(demo);
  const r = await reg.invoke('demo', '{"x":1}', fakeCtx(true));
  assert.equal(r.ok, true);
  assert.equal(r.output, 'done');
});

test('未知工具与坏参数返回错误结果而不是抛异常', async () => {
  const reg = new ToolRegistry();
  const r1 = await reg.invoke('nope', '{}', fakeCtx(true));
  assert.equal(r1.ok, false);
  assert.match(r1.output, /未知工具/);

  reg.register(demo);
  const r2 = await reg.invoke('demo', '{bad json', fakeCtx(true));
  assert.equal(r2.ok, false);
  assert.match(r2.output, /JSON/);
});
