import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeToolRunner } from './tool-runner.ts';
import type { OpenAiCompatibleProvider } from '../../kernel/src/llm/provider.ts';
import type { ChatResponse } from '../../kernel/src/llm/types.ts';
import { ToolRegistry } from '../../kernel/src/tools/registry.ts';
import { SandboxSession } from '../../kernel/src/sandbox/session.ts';
import { loadSandboxPolicy } from '../../kernel/src/sandbox/policy.ts';

/** 桩 provider：按脚本逐次返回 chat 响应 */
function stubProvider(script: Array<Partial<ChatResponse>>): OpenAiCompatibleProvider {
  let i = 0;
  const fake = {
    chat: async () => {
      const s = script[Math.min(i, script.length - 1)]!;
      i++;
      return {
        id: 'stub',
        model: 'stub',
        choices: [{ index: 0, finish_reason: 'stop', message: s.choices![0]!.message }],
      } as ChatResponse;
    },
  };
  return fake as unknown as OpenAiCompatibleProvider;
}

function resp(message: ChatResponse['choices'][number]['message']): Partial<ChatResponse> {
  return { choices: [{ index: 0, finish_reason: 'stop', message }] };
}

test('工具步骤：模型调用 echo 工具后给出最终回答', async () => {
  const provider = stubProvider([
    resp({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }],
    }),
    resp({ role: 'assistant', content: '最终回答：echo 已完成' }),
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: '回显',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    requiredApproval: () => null,
    async execute(args) {
      return { ok: true, output: String(args.text ?? '') };
    },
  });

  const runner = makeToolRunner({ provider, registry, workspaceRoot: process.cwd() });
  const out = await runner('帮我 echo hi', 'step-echo');
  assert.equal(out, '最终回答：echo 已完成');
});

test('工具步骤：write_file 走沙箱（可整体回滚）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'myagent-wfrun-'));
  const journal = await mkdtemp(join(tmpdir(), 'myagent-wfj-'));
  try {
    const provider = stubProvider([
      resp({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"notes/step.txt","content":"步骤产物"}' } },
        ],
      }),
      resp({ role: 'assistant', content: '已写入' }),
    ]);
    const { createDefaultRegistry } = await import('../../kernel/src/tools/index.ts');
    const registry = createDefaultRegistry();
    const sandbox = new SandboxSession({
      workspaceRoot: root,
      journalDir: journal,
      policy: loadSandboxPolicy(root),
      log: () => {},
    });
    const runner = makeToolRunner({ provider, registry, workspaceRoot: root, sandbox });
    const out = await runner('把产物写进 notes/step.txt', 'step-write');
    assert.equal(out, '已写入');
    assert.equal(await readFile(join(root, 'notes', 'step.txt'), 'utf8'), '步骤产物');

    const restored = await sandbox.rollback();
    await assert.rejects(() => readFile(join(root, 'notes', 'step.txt'), 'utf8'), /ENOENT/);
    assert.ok(restored.some((r) => r.includes('notes/step.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
  }
});
