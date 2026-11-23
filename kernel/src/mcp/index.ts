// 按 policy/mcp-servers.json 挂载 MCP 服务器（stdio / streamable http）
// 按开关热挂 mcp-client + server-memory

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import { McpStdioClient, McpHttpClient, type McpClientLike } from './client.ts';
import { mcpToolDef } from './adapter.ts';

export interface McpMount {
  name: string;
  tools: string[];
  client: McpClientLike;
}

interface ServerDecl {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  /** false = 停用（保留配置但不在本次启动挂载） */
  enabled?: boolean;
}

export async function mountMcpServers(
  policyDir: string,
  workspaceRoot: string,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<McpMount[]> {
  const file = resolve(policyDir, 'mcp-servers.json');
  if (!existsSync(file)) return [];
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { servers?: ServerDecl[] };
  const mounts: McpMount[] = [];

  for (const decl of cfg.servers ?? []) {
    if (decl.enabled === false) {
      ctx.log(`[mcp] ${decl.name} 已停用，跳过`);
      continue;
    }
    try {
      let client: McpClientLike;
      if (decl.url) {
        // HTTP 传输（streamable http）
        client = new McpHttpClient({ name: decl.name, url: decl.url, headers: decl.headers, log: ctx.log });
        await client.start();
      } else {
        // stdio 传输
        const command = decl.command === '$NODE' ? process.execPath : decl.command;
        // flag 参数（以 - 开头）不做路径解析
        const args = (decl.args ?? []).map((a) => (a.startsWith('-') ? a : resolve(workspaceRoot, a)));
        const stdio = new McpStdioClient({ name: decl.name, command, args, log: ctx.log });
        await stdio.start();
        client = stdio;
      }
      const tools = await client.listTools();
      for (const t of tools) registry.register(mcpToolDef(decl.name, client, t));
      mounts.push({ name: decl.name, tools: tools.map((t) => t.name), client });
      ctx.log(`[mcp] 已挂载 ${decl.name}：${tools.map((t) => t.name).join(', ')}`);
    } catch (err) {
      ctx.log(`[mcp] ${decl.name} 挂载失败：${(err as Error).message}`);
    }
  }
  return mounts;
}
