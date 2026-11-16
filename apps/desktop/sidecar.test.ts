// 内核侧车（stdio JSON-RPC）集成测试：握手 / 凭据注入 / 会话 / 事件通知

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sidecarEntry = resolve(repoRoot, 'kernel', 'src', 'ipc', 'main.ts');

interface RpcMsg {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

test('侧车：握手 → 状态 → 建会话 → 事件通知', async () => {
  const child: ChildProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', sidecarEntry],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } },
  );

  const events: Array<{ sessionId?: string; event?: { type?: string } }> = [];
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const done = new Promise<void>((resolveDone, rejectDone) => {
    const timer = setTimeout(() => rejectDone(new Error('侧车测试超时')), 60_000);
    const fail = (e: Error) => {
      clearTimeout(timer);
      rejectDone(e);
    };
    child.on('exit', () => {
      clearTimeout(timer);
      // 侧车退出：拒绝所有挂起请求，避免测试悬挂
      for (const [, p] of pending) p.reject(new Error('侧车进程已退出'));
      pending.clear();
      resolveDone();
    });
    child.on('error', (e) => fail(new Error(`侧车启动失败：${e.message}`)));
  });

  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (!line.trim()) return;
    let msg: RpcMsg;
    try {
      msg = JSON.parse(line) as RpcMsg;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error'));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method === 'event') events.push((msg.params ?? {}) as { sessionId?: string; event?: { type?: string } });
  });

  const request = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolveP, rejectP) => {
      pending.set(id, {
        resolve: resolveP,
        reject: rejectP,
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  try {
    // 1. 握手：协议版本 + 带令牌 webUrl + 状态
    const init = await request('initialize', { apiKey: 'sk-injected-from-vault' });
    assert.equal(init.protocol, 'myagent.ipc/v1');
    assert.match(String(init.webUrl), /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/);
    const state = init.state as Record<string, unknown>;
    assert.equal(state.mode, 'workspace-write');
    assert.ok((state.tools as string[]).includes('read_file'));

    // 2. 建会话 → session_start 事件已通知（轮询容忍调度延迟）
    const created = await request('session.create', { title: 'ipc 测试' });
    const sessionId = String(created.id);
    let sawStart = false;
    for (let i = 0; i < 20 && !sawStart; i++) {
      await new Promise((r) => setTimeout(r, 100));
      sawStart = events.some((e) => e.event?.type === 'session_start');
    }
    assert.ok(sawStart);

    // 3. 读事件流
    const evs = await request('session.events', { id: sessionId, since: 0 });
    assert.equal((evs.events as unknown[]).length, 1);
    assert.equal(evs.lastSeq, 1);

    // 4. 未知方法 → 错误响应
    await assert.rejects(() => request('nope.method'), /未知方法/);
  } finally {
    child.kill();
    await done;
  }
});
