import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.ts';

test('SessionStore 创建/追加/读取/列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-sessions-'));
  try {
    const store = new SessionStore(dir);
    const id = await store.create('冒烟测试');
    await store.append(id, 'user', { text: '你好' });
    await store.append(id, 'assistant', { text: '你好！' });

    const events = await store.read(id);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.type, 'session_start');
    assert.equal(events[1]?.text, '你好');
    assert.equal(events[2]?.seq, 3);

    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.title, '冒烟测试');
    assert.equal(list[0]?.events, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('重新打开会话后 seq 从已有行数继续', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-sessions-'));
  try {
    const first = new SessionStore(dir);
    const id = await first.create('续接');
    await first.append(id, 'user', { text: 'a' });

    // 模拟新进程（counters 为空）继续同一会话
    const second = new SessionStore(dir);
    const ev = await second.append(id, 'assistant', { text: 'b' });
    assert.equal(ev.seq, 3);

    const events = await second.read(id);
    assert.equal(events.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
