// 上下文压缩单测：历史超阈值 → LLM 摘要 → compaction 事件落盘 + 后续调用消息数收敛

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from './loop.ts';
import { OpenAiCompatibleProvider } from '../llm/provider.ts';
import type { ChatResponse } from '../llm/types.ts';
import { SessionStore } from '../sessions/store.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';

function stubProvider(calls: Array<{ count: number; compressed: boolean }>): OpenAiCompatibleProvider {
  const fake = {
    chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
      const count = req.messages.length;
      const compressed = req.messages.some((m) => String(m.content ?? '').includes('早期对话摘要'));
      calls.push({ count, compressed });
      return {
        id: 'stub',
        model: 'stub',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '回复' } }],
        usage: null,
      } as ChatResponse;
    },
  };
  return fake as unknown as OpenAiCompatibleProvider;
}

function mkCtx(dir: string): ToolContext {
  return { workspaceRoot: dir, approval: async () => true, log: () => {} };
}

test('上下文压缩：超过阈值触发摘要并收敛后续消息数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-compact-'));
  const store = new SessionStore(dir);
  const sessionId = await store.create('压缩测试');
  const calls: Array<{ count: number; compressed: boolean }> = [];
  const provider = stubProvider(calls);
  const ctx: ToolContext = mkCtx(dir);

  // 预置 44 条历史（22 组 user/assistant）
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let i = 1; i <= 22; i++) {
    history.push({ role: 'user', content: `问题${i}` });
    history.push({ role: 'assistant', content: `回答${i}` });
  }

  const res = await runTurn('下一个问题', history, {
    provider,
    registry: new ToolRegistry(),
    store,
    ctx,
    sessionId,
    maxHistoryMessages: 40,
  });
  assert.equal(res.reply, '回复');

  // 主调用（压缩摘要那次不算）：压缩后 = 摘要1 + 保留12 + 本轮user 1 = 14 条
  const mainCalls = calls.filter((c) => !c.compressed);
  assert.ok(mainCalls.length >= 1);
  const first = mainCalls[0]!;
  assert.equal(first.compressed, false);
  assert.ok(first.count < 20, `压缩后消息数应收敛，实际 ${first.count}`);

  // 落盘 compaction 事件
  const events = await store.read(sessionId);
  const comp = events.find((e) => e.type === 'compaction');
  assert.ok(comp, '应有 compaction 事件');
  assert.ok(String(comp.summary).includes('早期对话摘要'));

  // 回放：压缩点重建历史（摘要 1 条起步）
  const { replayHistory } = await import('../sessions/replay.ts');
  const replayed = await replayHistory(store, sessionId);
  assert.ok(replayed[0]!.content.includes('早期对话摘要'), '回放应以摘要开头');

  await rm(dir, { recursive: true, force: true });
});

test('上下文压缩：低于阈值不触发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-compact2-'));
  const store = new SessionStore(dir);
  const sessionId = await store.create('短会话');
  const calls: Array<{ count: number; compressed: boolean }> = [];
  const provider = stubProvider(calls);
  const ctx: ToolContext = mkCtx(dir);
  const history = [
    { role: 'user' as const, content: '你好' },
    { role: 'assistant' as const, content: '你好呀' },
  ];
  await runTurn('继续', history, { provider, registry: new ToolRegistry(), store, ctx, sessionId, maxHistoryMessages: 40 });
  const events = await store.read(sessionId);
  assert.ok(!events.some((e) => e.type === 'compaction'));
  await rm(dir, { recursive: true, force: true });
});
