// todo 工具：会话级任务清单（对照智作的「会话计划」卡）
// 存储：data/todos/<sessionId>.json（宿主 ctx 需带 sessionId）

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolContext, ToolDef } from './types.ts';

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const todosDir = (workspaceRoot: string): string => join(workspaceRoot, 'data', 'todos');

export async function loadTodos(workspaceRoot: string, sessionId: string): Promise<TodoItem[]> {
  try {
    const raw = await readFile(join(todosDir(workspaceRoot), `${sessionId}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveTodos(workspaceRoot: string, sessionId: string, items: TodoItem[]): Promise<void> {
  const file = join(todosDir(workspaceRoot), `${sessionId}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(items, null, 2), 'utf8');
}

function assertSession(ctx: ToolContext): string {
  if (!ctx.sessionId) throw new Error('当前上下文无会话（todo 仅在会话内可用）');
  return ctx.sessionId;
}

export const todoWriteTool: ToolDef = {
  name: 'todo_write',
  description:
    '写当前会话的任务计划（整表替换）。用户会在界面的「会话计划」卡看到进度。完成一项就把对应条目标为 completed。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        description: '任务条目（整表替换）',
        items: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: '任务描述' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '默认 pending' },
          },
        },
      },
    },
  },
  requiredApproval: () => null,
  async execute(args, ctx) {
    const sessionId = assertSession(ctx);
    const raw = Array.isArray(args.items) ? args.items : [];
    const items: TodoItem[] = raw.map((it) => {
      const o = it as { text?: unknown; status?: unknown };
      const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
      return { text: String(o.text ?? '').slice(0, 120), status };
    });
    if (items.length === 0) return { ok: false, output: 'items 不能为空' };
    await saveTodos(ctx.workspaceRoot, sessionId, items);
    const done = items.filter((i) => i.status === 'completed').length;
    ctx.log(`[todo] 计划更新：${items.length} 项（完成 ${done}）`);
    return { ok: true, output: `计划已更新：${items.length} 项（完成 ${done}）` };
  },
};

export const todoReadTool: ToolDef = {
  name: 'todo_read',
  description: '读取当前会话的任务计划（确认进度时用）。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  requiredApproval: () => null,
  async execute(_args, ctx) {
    const sessionId = assertSession(ctx);
    const items = await loadTodos(ctx.workspaceRoot, sessionId);
    if (items.length === 0) return { ok: true, output: '(当前会话没有任务计划)' };
    return { ok: true, output: items.map((i, n) => `${n + 1}. [${i.status}] ${i.text}`).join('\n') };
  },
};
