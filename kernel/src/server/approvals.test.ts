import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from './approvals.ts';

const REQ = { tool: 'write_file', action: '写入文件', detail: 'notes/x.txt（3 字节）' };

test('审批：同意后放行', async () => {
  const broker = new ApprovalBroker(60_000);
  const gate = broker.request(REQ, 's1');
  const pending = broker.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.sessionId, 's1');
  assert.equal(broker.decide(pending[0]!.id, true), true);
  assert.equal(await gate, true);
  assert.equal(broker.listPending().length, 0);
});

test('审批：拒绝则返回 false', async () => {
  const broker = new ApprovalBroker(60_000);
  const gate = broker.request(REQ, 's1');
  const pending = broker.listPending();
  assert.equal(broker.decide(pending[0]!.id, false), true);
  assert.equal(await gate, false);
});

test('审批：超时自动拒绝（fail-closed）', async () => {
  const broker = new ApprovalBroker(50);
  const gate = broker.request(REQ, 's1');
  assert.equal(await gate, false);
  assert.equal(broker.listPending().length, 0);
});

test('审批：未知 id 判定返回 false', async () => {
  const broker = new ApprovalBroker(60_000);
  assert.equal(broker.decide('deadbeef', true), false);
});
