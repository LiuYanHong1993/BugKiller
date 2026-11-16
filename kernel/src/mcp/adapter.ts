// 把 MCP 服务器暴露的工具适配为内核 ToolDef

import type { JsonSchema } from '../llm/types.ts';
import type { ToolDef } from '../tools/types.ts';
import type { McpClientLike, McpToolInfo } from './client.ts';

export function mcpToolDef(serverName: string, client: McpClientLike, tool: McpToolInfo): ToolDef {
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: `[MCP:${serverName}] ${tool.description ?? ''}`.trim(),
    parameters: (tool.inputSchema ?? { type: 'object' }) as JsonSchema,
    requiredApproval: () => null,
    async execute(args) {
      return client.callTool(tool.name, args);
    },
  };
}
