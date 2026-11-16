// 默认工具集装配（M1：read_file + write_file；M7：run_command + web_fetch + todo）

import { ToolRegistry } from './registry.ts';
import { readFileTool } from './read-file.ts';
import { writeFileTool } from './write-file.ts';
import { runCommandTool } from './run-command.ts';
import { webFetchTool } from './web-fetch.ts';
import { todoWriteTool, todoReadTool } from './todo.ts';

export function createDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(readFileTool);
  reg.register(writeFileTool);
  reg.register(runCommandTool);
  reg.register(webFetchTool);
  reg.register(todoWriteTool);
  reg.register(todoReadTool);
  return reg;
}

export { ToolRegistry } from './registry.ts';
export type { ApprovalGate, ApprovalRequest, ToolContext, ToolDef, ToolResult } from './types.ts';
export { loadTodos, saveTodos } from './todo.ts';
export type { TodoItem } from './todo.ts';
