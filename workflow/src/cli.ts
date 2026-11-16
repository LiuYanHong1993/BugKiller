// 工作流 CLI（对照智作 stratex-flow.mjs）：
//   stdin  ：WorkflowDef JSON
//   stdout ：NDJSON 事件流（机器消费）
//   stderr ：人类可读日志
//   退出码 ：0 成功 / 1 运行失败 / 2 输入非法

import { resolve } from 'node:path';
import { loadCatalog, resolvePreset } from '../../kernel/src/llm/catalog.ts';
import { OpenAiCompatibleProvider } from '../../kernel/src/llm/provider.ts';
import { createDefaultRegistry } from '../../kernel/src/tools/index.ts';
import { loadPlugins } from '../../kernel/src/plugins/loader.ts';
import { SandboxSession } from '../../kernel/src/sandbox/session.ts';
import { loadSandboxPolicy } from '../../kernel/src/sandbox/policy.ts';
import { WorkflowEngine } from './engine.ts';
import { makeToolRunner } from './tool-runner.ts';
import type { StepRunner } from './engine.ts';
import type { WorkflowDef } from './types.ts';

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) chunks.push(String(c));
  return chunks.join('');
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  let def: WorkflowDef;
  try {
    def = JSON.parse(raw) as WorkflowDef;
  } catch {
    console.error('stdin 不是合法的 WorkflowDef JSON');
    process.exit(2);
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    console.error('WorkflowDef.steps 不能为空');
    process.exit(2);
  }

  const policyDir = resolve(process.cwd(), 'policy');
  const provider = new OpenAiCompatibleProvider(resolvePreset(loadCatalog(policyDir)));
  const cwd2 = process.cwd();
  const useTools = process.argv.slice(2).includes('--tools');
  const wantRollback = process.argv.slice(2).includes('--rollback');

  // M5：--tools → 步骤 = 带工具的 agent loop（写操作进沙箱，--rollback 运行后整体回滚）
  let sandbox: SandboxSession | undefined;
  let runner: StepRunner;
  if (useTools) {
    const registry = createDefaultRegistry();
    const bootCtx = { workspaceRoot: cwd2, approval: async () => false, log: (l: string) => console.error(l) };
    await loadPlugins({ workspaceRoot: cwd2, registry, ctx: bootCtx });
    sandbox = new SandboxSession({
      workspaceRoot: cwd2,
      journalDir: resolve(cwd2, 'data', 'sandbox'),
      policy: loadSandboxPolicy(policyDir),
      log: (l) => console.error(l),
    });
    runner = makeToolRunner({ provider, registry, workspaceRoot: cwd2, sandbox, log: (l) => console.error(l) });
  } else {
    runner = async (prompt) => {
      const res = await provider.chat({
        messages: [
          // /no_think：Qwen3 软开关，流水线步骤直接给答案，别把上下文烧在思考上
          { role: 'system', content: '你是工作流步骤执行器，直接完成给定任务并只输出结果正文，不要解释。/no_think' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        // 限制步骤预算：思考 + 回答共用，防止推理把上下文烧干
        maxTokens: 800,
      });
      return res.choices[0]?.message?.content ?? '';
    };
  }

  const engine = new WorkflowEngine({
    runDir: resolve(process.cwd(), 'data', 'workflows'),
    runner,
    // stdout：纯事件 NDJSON（对照 stratex-flow 契约）
    onEvent: (ev) => console.log(JSON.stringify(ev)),
    // stderr：人类日志
    log: (l) => console.error(l),
  });

  const result = await engine.run(def);
  if (useTools && wantRollback && sandbox) {
    const restored = await sandbox.rollback();
    console.error(`[sandbox] 已整体回滚：${restored.join('、') || '(无写操作)'}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  console.error('[fatal]', err instanceof Error ? err.message : err);
  process.exit(1);
});
