// 自研最小 MCP 服务器：长期记忆（stdio 传输）
// 独立运行：node --experimental-strip-types kernel/src/mcp/servers/memory.ts
// 对照智作平台：stdio 拉起 @modelcontextprotocol/server-memory 的替代实现（零依赖）

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

interface Rec {
  ts: string;
  content: string;
  tags?: string[];
}

const memoryFile = process.env.MYAGENT_MEMORY_FILE
  ? resolve(process.env.MYAGENT_MEMORY_FILE)
  : resolve(process.cwd(), 'data', 'memory', 'memory.jsonl');

const TOOLS = [
  {
    name: 'memory_save',
    description: '保存一条长期记忆（用户偏好、重要事实、长期约定等）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: { type: 'string', description: '记忆内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
      },
    },
  },
  {
    name: 'memory_recall',
    description: '按关键词检索已保存的记忆，返回最近的匹配项。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词（空 = 全部）' },
        limit: { type: 'number', description: '条数上限，默认 20' },
      },
    },
  },
];

async function save(content: string, tags?: string[]): Promise<string> {
  await mkdir(dirname(memoryFile), { recursive: true });
  const rec: Rec = { ts: new Date().toISOString(), content, tags };
  await appendFile(memoryFile, JSON.stringify(rec) + '\n', 'utf8');
  return '已保存记忆';
}

async function recall(query: string, limit: number): Promise<string> {
  let text = '';
  try {
    text = await readFile(memoryFile, 'utf8');
  } catch {
    return '(还没有任何记忆)';
  }
  const recs: Rec[] = text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Rec);
  const q = query.trim().toLowerCase();
  const hits = recs.filter((r) => !q || r.content.toLowerCase().includes(q));
  const slice = hits.slice(-limit);
  if (slice.length === 0) return '(没有匹配的记忆)';
  return slice.map((r) => `[${r.ts}] ${r.content}`).join('\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: { id?: number; method?: string; params?: { name?: string; arguments?: unknown } };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof msg.id !== 'number') return; // 通知：忽略

  try {
    let result: unknown;
    switch (msg.method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'memory', version: '0.1.0' },
        };
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (name === 'memory_save') {
          const text = await save(String(args.content ?? ''), args.tags as string[] | undefined);
          result = { content: [{ type: 'text', text }] };
        } else if (name === 'memory_recall') {
          const text = await recall(
            String(args.query ?? ''),
            Math.min(100, Math.max(1, Number(args.limit ?? 20) || 20)),
          );
          result = { content: [{ type: 'text', text }] };
        } else {
          result = { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
        }
        break;
      }
      case 'ping':
        result = {};
        break;
      default:
        respond(msg.id, undefined, { code: -32601, message: `方法不存在：${msg.method}` });
        return;
    }
    respond(msg.id, result);
  } catch (err) {
    respond(msg.id, undefined, { code: -32603, message: (err as Error).message });
  }
}

function respond(id: number, result?: unknown, error?: { code: number; message: string }): void {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\n');
}
