// 工作流工具步骤执行器（M5）：步骤 = 带工具的 agent loop（无会话库落盘）
// 写操作经沙箱（守卫 + 写前镜像）；对照智作 autonomous 流程节点的能力面

import type { ChatMessage } from '../../kernel/src/llm/types.ts';
import type { OpenAiCompatibleProvider } from '../../kernel/src/llm/provider.ts';
import type { ToolRegistry } from '../../kernel/src/tools/registry.ts';
import type { ToolContext } from '../../kernel/src/tools/types.ts';
import type { SandboxSession } from '../../kernel/src/sandbox/session.ts';
import { runTurn } from '../../kernel/src/agent/loop.ts';
import type { StepRunner } from './engine.ts';

export interface ToolRunnerOptions {
  provider: OpenAiCompatibleProvider;
  registry: ToolRegistry;
  workspaceRoot: string;
  /** 每次运行共享一个沙箱会话（可整体回滚） */
  sandbox?: SandboxSession;
  maxToolRounds?: number;
  /** 工作流步骤默认无人值守（引擎驱动，无人在环） */
  unattended?: boolean;
  log?: (line: string) => void;
}

export function makeToolRunner(opts: ToolRunnerOptions): StepRunner {
  return async (prompt: string, stepId: string): Promise<string> => {
    const history: ChatMessage[] = [];
    const sandbox = opts.sandbox;
    const ctx: ToolContext = {
      workspaceRoot: opts.workspaceRoot,
      log: (l) => opts.log?.(`[${stepId}] ${l}`),
      ...(sandbox ? { sandbox } : {}),
      approval: async (req) => {
        if (opts.unattended !== false) {
          opts.log?.(`[${stepId}] [审批] 无人值守自动通过：${req.action} → ${req.detail}`);
          return true;
        }
        return false; // 在环模式：工作流步骤无审批通道 → 拒绝（fail-closed）
      },
    };
    const { reply } = await runTurn(prompt, history, {
      provider: opts.provider,
      registry: opts.registry,
      ctx,
      maxToolRounds: opts.maxToolRounds ?? 6,
    });
    return reply;
  };
}
