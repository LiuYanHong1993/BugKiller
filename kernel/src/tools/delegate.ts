// 子代理委派工具：在独立上下文里完成调研/分析类子任务，只把结论带回主对话
// 只读白名单（read_file / web_fetch / echo / todo_read）——不触发审批、无副作用、无递归
import type { ChatMessage } from '../llm/types.ts';
import type { SubagentChatResponse, ToolContext, ToolDef, ToolResult } from './types.ts';
import { cap } from './registry.ts';

const ALLOWED = new Set(['read_file', 'web_fetch', 'echo', 'todo_read']);
const MAX_ROUNDS = 5;

export function createDelegateTool(reg: {
  toSpecs(): ToolSpec[];
  invoke(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult>;
}): ToolDef {
  const specs: ToolSpec[] = reg
    .toSpecs()
    .filter((s) => ALLOWED.has(s.function.name));

  const toolSpecs = specs;

  return {
    name: 'delegate',
    description:
      '委派一个独立上下文的子代理完成调研/分析类子任务（只读：可以读工作区文件、检索网页），子代理的全部中间过程不会进入主对话，只把最终结论返回。适用于：需要多步检索但不想占用主对话上下文、需要先调研再汇总的子任务。',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', description: '交给子代理的完整任务描述（要自包含：子代理看不到主对话历史）' },
      },
    },
    requiredApproval: () => null,
    async execute(args, ctx): Promise<ToolResult> {
      const task = String(args.task ?? '').trim();
      if (!task) return { ok: false, output: '缺少 task 参数' };

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            `你是被主对话委派的子代理，负责独立完成一个只读调研任务。当前工作区：${ctx.workspaceRoot}。` +
            `规则：只使用提供的只读工具（读文件/检索网页），不做任何写入；完成后输出一段结构化的最终结论（事实 + 依据 + 建议），不要反问。`,
        },
        { role: 'user', content: task },
      ];

      ctx.log(`[subagent] 启动：${task.slice(0, 60)}`);
      const started = Date.now();

      for (let round = 0; round < MAX_ROUNDS; round++) {
        let acc = '';
        let msg;
        try {
          msg = await ctx.chat({
            messages,
            tools: toolSpecs,
            temperature: 0.3,
          });
        } catch (err) {
          return { ok: false, output: `[subagent] 子代理调用模型失败：${(err as Error).message}` };
        }
        const choice = msg.choices[0]?.message;
        if (!choice) return { ok: false, output: '[subagent] 模型响应缺少 message' };
        acc = choice.content ?? '';
        if (choice.tool_calls && choice.tool_calls.length > 0) {
          messages.push({ role: 'assistant', content: acc, tool_calls: choice.tool_calls });
          for (const call of choice.tool_calls) {
            ctx.log(`[subagent] → ${call.function.name}`);
            const r = await reg.invoke(call.function.name, call.function.arguments, ctx);
            ctx.log(`[subagent] ← ${r.ok ? '完成' : '失败'}: ${String(r.output).slice(0, 60)}`);
            messages.push({ role: 'tool', tool_call_id: call.id, content: r.output });
          }
          continue;
        }
        // 最终结论
        const secs = Math.round((Date.now() - started) / 1000);
        ctx.log(`[subagent] 完成（${secs} 秒，结论 ${acc.length} 字）`);
        return {
          ok: true,
          output: cap(`[子代理结论 · ${secs} 秒 · ${rounds + 1} 轮]\n\n${acc}`),
        };
      }
      return { ok: false, output: `[subagent] 超出最大轮数（${MAX_ROUNDS}）仍未得出结论，请拆分任务后重试` };
    },
  };
}