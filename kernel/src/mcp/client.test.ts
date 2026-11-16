import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpStdioClient } from './client.ts';

const serverTs = fileURLToPath(new URL('./servers/memory.ts', import.meta.url));

test('MCP stdio：握手 + memory 保存/检索 + 落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myagent-mcp-'));
  const memFile = join(dir, 'memory.jsonl');
  const client = new McpStdioClient({
    name: 'memory',
    command: process.execPath,
    args: ['--experimental-strip-types', '--no-warnings', serverTs],
    env: { MYAGENT_MEMORY_FILE: memFile },
    log: () => {},
  });
  try {
    await client.start();
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['memory_recall', 'memory_save'],
    );

    const save = await client.callTool('memory_save', { content: '用户喜欢中文回复', tags: ['pref'] });
    assert.equal(save.ok, true);

    const recall = await client.callTool('memory_recall', { query: '中文' });
    assert.equal(recall.ok, true);
    assert.match(recall.output, /用户喜欢中文回复/);

    const onDisk = await readFile(memFile, 'utf8');
    assert.match(onDisk, /用户喜欢中文回复/);
  } finally {
    client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
