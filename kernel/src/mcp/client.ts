// MCP stdio 客户端：JSON-RPC 2.0 over 新行分隔 NDJSON
// 对照智作平台：dsh-mcp-client 的最小子集（initialize / tools/list / tools/call）

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpClientOptions {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  log: (line: string) => void;
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpStdioClient {
  private opts: McpClientOptions;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private buffer = '';

  constructor(opts: McpClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.proc = spawn(this.opts.command, this.opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.opts.env },
    });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) this.opts.log(`[mcp:${this.opts.name}] ${line.slice(0, 200)}`);
    });
    this.proc.on('exit', (code) => {
      this.opts.log(`[mcp:${this.opts.name}] 进程退出（${code}）`);
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP 服务器 ${this.opts.name} 已退出`));
      }
      this.pending.clear();
      this.proc = null;
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-platform', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
  }

  async listTools(timeoutMs?: number): Promise<McpToolInfo[]> {
    const res = (await this.request('tools/list', {}, timeoutMs)) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; output: string }> {
    let res: unknown;
    try {
      res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    } catch (err) {
      return { ok: false, output: `MCP 调用失败：${(err as Error).message}` };
    }
    const text = contentText(res);
    if ((res as { isError?: boolean })?.isError) {
      return { ok: false, output: `工具返回错误：${text}` };
    }
    return { ok: true, output: text };
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* 忽略 */
      }
      this.proc = null;
    }
  }

  private write(msg: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable) throw new Error(`MCP 服务器 ${this.opts.name} 未启动`);
    stdin.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; error?: { message?: string }; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
        else entry.resolve(msg.result);
      }
    }
  }
}

function contentText(res: unknown): string {
  const r = res as { content?: Array<{ type?: string; text?: string }> } | null;
  if (r?.content && Array.isArray(r.content)) {
    return r.content
      .map((c) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(res);
}

/** 两类 MCP 客户端的公共面（挂载器只依赖它） */
export interface McpClientLike {
  listTools(timeoutMs?: number): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; output: string }>;
  stop(): void;
}

export interface McpHttpOptions {
  name: string;
  url: string;
  headers?: Record<string, string>;
  log: (line: string) => void;
}

/**
 * MCP Streamable HTTP 客户端：JSON-RPC 2.0 over HTTP POST。
 * 兼容两种响应：application/json（单帧）与 text/event-stream（SSE 帧，取匹配 id 的那条）。
 * 服务端返回 Mcp-Session-Id 时后续请求自动携带。
 */
export class McpHttpClient {
  private opts: McpHttpOptions;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(opts: McpHttpOptions) {
    this.opts = opts;
  }

  private async post(body: unknown, timeoutMs = 30_000): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(this.opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.opts.headers,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 从响应（JSON 或 SSE）里提取 JSON-RPC result */
  private async parseRpc(res: Response, id: number): Promise<unknown> {
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('text/event-stream')) {
      const text = await res.text();
      for (const frame of text.split('\n\n')) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const msg = JSON.parse(line.slice(5).trim()) as { id?: number; result?: unknown; error?: { message?: string } };
            if (msg.id === id) {
              if (msg.error) throw new Error(String(msg.error.message ?? JSON.stringify(msg.error)));
              return msg.result;
            }
          } catch (e) {
            if ((e as Error).message && !(e as Error).message.startsWith('Unexpected')) throw e;
          }
        }
      }
      throw new Error(`SSE 响应中未找到 id=${id} 的结果`);
    }
    const msg = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (msg.error) throw new Error(String(msg.error.message ?? JSON.stringify(msg.error)));
    return msg.result;
  }

  private async rpc(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    const sid = res.headers.get('mcp-session-id');
    if (sid && !this.sessionId) this.sessionId = sid;
    return this.parseRpc(res, id);
  }

  async start(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-platform', version: '0.1.0' },
    });
    // notifications/initialized：无需响应
    try {
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 5_000);
    } catch {
      /* 通知类失败忽略 */
    }
    this.opts.log(`[mcp:${this.opts.name}] HTTP 已连接`);
  }

  async listTools(timeoutMs?: number): Promise<McpToolInfo[]> {
    const res = (await this.rpc('tools/list', {}, timeoutMs ?? 30_000)) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; output: string }> {
    try {
      const res = (await this.rpc('tools/call', { name, arguments: args }, timeoutMs)) as Record<string, unknown>;
      const text = contentText(res);
      if ((res as { isError?: boolean })?.isError) return { ok: false, output: `工具返回错误：${text}` };
      return { ok: true, output: text };
    } catch (err) {
      return { ok: false, output: `MCP 调用失败：${(err as Error).message}` };
    }
  }

  stop(): void {
    /* HTTP 无进程可停；会话随连接结束 */
  }
}
