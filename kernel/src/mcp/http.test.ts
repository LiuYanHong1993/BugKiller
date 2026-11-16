// MCP HTTP 客户端单测：内置 stub 的 streamable-HTTP JSON-RPC 服务器

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { McpHttpClient } from './client.ts';

function startStub(): Promise<{ server: Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(String(req.headers['mcp-session-id'] ?? ''));
      const msg = JSON.parse(body) as { id?: number; method?: string };
      const reply = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json', ...(msg.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {}) });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {} });
      else if (msg.method === 'tools/list') reply({ tools: [{ name: 'ping', description: '回一声' }] });
      else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: `pong: ${String((msg.params as { arguments?: { text?: string } }).arguments?.text ?? '')}` }] });
      else reply({});
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolveP({ server, port: addr.port, seen });
    });
  });
}

test('MCP HTTP 客户端：initialize → listTools → callTool（会话头维持）', async () => {
  const { server, port, seen } = await startStub();
  const client = new McpHttpClient({ name: 'stub', url: `http://127.0.0.1:${port}/mcp`, log: () => {} });
  await client.start();

  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'ping');
  assert.match(tools[0]!.description ?? '', /回一声/);

  const r = await client.callTool('ping', { text: '测试' });
  assert.ok(r.ok);
  assert.equal(r.output, 'pong: 测试');

  // 会话头：initialize 之后的所有请求都应带 mcp-session-id
  assert.ok(seen.length >= 3);
  assert.ok(seen.slice(1).every((v) => v === 'sess-1'), '会话头应维持');

  client.stop();
  server.close();
});
