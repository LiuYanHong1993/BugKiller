// 内核 HTTP 服务：静态 UI + REST API + 令牌鉴权
// 仅回环、随机端口、令牌 URL 一次性打印

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ChatMessage } from '../llm/types.ts';
import type { OpenAiCompatibleProvider } from '../llm/provider.ts';
import type { ModelPreset } from '../llm/catalog.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import type { SessionStore } from '../sessions/store.ts';
import { SessionProjection } from '../sessions/projection.ts';
import { replayHistory } from '../sessions/replay.ts';
import type { PolicyConfig } from '../policy.ts';
import type { ApprovalBroker } from './approvals.ts';
import { runTurn, runTurnStream } from '../agent/loop.ts';
import { buildSystemPrompt } from '../agent/system-prompt.ts';
import { SandboxSession, assertGuardedPath, assertSizeOk } from '../sandbox/session.ts';
import { loadSandboxPolicy } from '../sandbox/policy.ts';
import { loadTodos } from '../tools/todo.ts';
import { mkdir, readdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ServerDeps {
  workspaceRoot: string;
  store: SessionStore;
  registry: ToolRegistry;
  provider: OpenAiCompatibleProvider;
  preset: ModelPreset;
  policy: PolicyConfig;
  broker: ApprovalBroker;
  mcpSummary: string;
  /** 视觉（多模态）预设：带图请求自动路由（main.ts 从 kernel-settings.json 解析） */
  vision?: ModelPreset | null;
  /** 模型参数（temperature / maxTokens）：设置页在线调节，runTurn 时注入每次请求 */
  params?: { temperature?: number; maxTokens?: number } | null;
  log: (line: string) => void;
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

export function startServer(deps: ServerDeps): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const webDir = resolve(deps.workspaceRoot, 'apps', 'web');
  const busy = new Set<string>();
  const histories = new Map<string, ChatMessage[]>();
  const aborts = new Map<string, AbortController>(); // sessionId -> 进行中回合的中止器
  const allowlist = new Map<string, Set<string>>(); // sessionId -> 已记忆放行的工具（审批记忆）
  const sandboxPolicy = loadSandboxPolicy(resolve(deps.workspaceRoot, 'policy'));
  const sandboxes = new Map<string, SandboxSession>();
  // 运行时可变设置（设置页在线修改；持久层见 data/kernel-settings.json）
  const runtime = {
    autoApprove: deps.policy.autoApprove === true,
    vision: deps.vision ? { baseUrl: deps.vision.baseUrl, model: deps.vision.model } : null,
    params: {
      temperature: typeof deps.params?.temperature === 'number' ? deps.params.temperature : 0.4,
      maxTokens: typeof deps.params?.maxTokens === 'number' && deps.params.maxTokens > 0 ? deps.params.maxTokens : null,
    },
  };
  deps.provider.setVision(deps.vision ?? null);
  // SQLite 投影（懒加载；无 --experimental-sqlite 时 available=false 优雅降级）
  const projection = new SessionProjection(resolve(deps.workspaceRoot, 'data', 'sessions.db'));
  void projection.init();
  const projAppend = deps.store.append.bind(deps.store);
  deps.store.append = async (sid, type, data) => {
    const ev = await projAppend(sid, type, data);
    void projection.indexEvent(sid, ev);
    return ev;
  };
  const projRename = deps.store.rename.bind(deps.store);
  deps.store.rename = async (sid, title) => {
    await projRename(sid, title);
    await projection.updateTitle(sid, title);
  };
  // 回填存量会话（INSERT OR REPLACE 幂等）
  void projection.init().then(async () => {
    if (!projection.available) return;
    const sessions = await deps.store.list().catch(() => []);
    for (const s of sessions) {
      const events = await deps.store.read(s.id).catch(() => []);
      for (const ev of events) await projection.indexEvent(s.id, ev);
    }
    deps.log(`[projection] 已回填 ${sessions.length} 个会话 → ${'data/sessions.db'}`);
  });

  function loadAgents(): Array<{ id: string; name: string; desc: string; icon: string; opening: string }> {
    try {
      const raw = JSON.parse(readFileSync(resolve(deps.workspaceRoot, 'policy', 'agents.json'), 'utf8'));
      return Array.isArray(raw.agents) ? raw.agents : [];
    } catch {
      return [];
    }
  }

  async function persistSettings(): Promise<void> {
    const cfg = deps.provider.getConfig();
    const dir = resolve(deps.workspaceRoot, 'data');
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, 'kernel-settings.json'),
      JSON.stringify(
        { baseUrl: cfg.baseUrl, model: cfg.model, autoApprove: runtime.autoApprove, vision: runtime.vision, params: runtime.params },
        null,
        2,
      ),
      'utf8',
    );
  }

  const server = createServer((req, res) => {
    void route(req, res);
  });

  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveReady(`http://127.0.0.1:${port}/?token=${token}`);
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      if (pathname === '/api/health') {
        return json(res, 200, { ok: true });
      }

      // 静态资源放行（不含数据；令牌只保护 API）
      const staticEntry = STATIC_FILES[pathname];
      if (staticEntry && req.method === 'GET') {
        const body = readFileSync(join(webDir, staticEntry.file));
        res.writeHead(200, { 'content-type': staticEntry.type, 'cache-control': 'no-store' });
        res.end(body);
        return;
      }

      const authorized =
        req.headers.authorization === `Bearer ${token}` ||
        url.searchParams.get('token') === token;
      if (!authorized) {
        return json(res, 401, { error: '未授权：令牌缺失或不匹配' });
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        const cfg = deps.provider.getConfig();
        return json(res, 200, {
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          mode: deps.policy.mode,
          autoApprove: runtime.autoApprove,
          vision: runtime.vision,
          params: runtime.params,
          workspaceRoot: deps.workspaceRoot,
          tools: deps.registry.names(),
          mcp: deps.mcpSummary,
        });
      }

      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await readJson(req);
        deps.provider.updateConfig({
          apiKey: typeof body?.apiKey === 'string' && body.apiKey ? String(body.apiKey) : undefined,
          baseUrl: typeof body?.baseUrl === 'string' && body.baseUrl ? String(body.baseUrl) : undefined,
          model: typeof body?.model === 'string' && body.model ? String(body.model) : undefined,
        });
        if (typeof body?.autoApprove === 'boolean') runtime.autoApprove = body.autoApprove;
        // 模型参数（temperature 0-1 / maxTokens 正整数或 null=默认）
        if (body?.params && typeof body.params === 'object') {
          const p = body.params as { temperature?: unknown; maxTokens?: unknown };
          if (typeof p.temperature === 'number' && p.temperature >= 0 && p.temperature <= 1) runtime.params.temperature = p.temperature;
          runtime.params.maxTokens = typeof p.maxTokens === 'number' && p.maxTokens > 0 ? p.maxTokens : null;
        }
        // 视觉端点（多模态）：{baseUrl, model}；清空 baseUrl 即关闭
        if (body?.vision && typeof body.vision === 'object') {
          const v = body.vision as { baseUrl?: string; model?: string };
          if (v.baseUrl) {
            deps.provider.setVision({
              id: 'vision',
              protocol: 'openai-chat',
              baseUrl: v.baseUrl,
              model: v.model || 'vision',
              apiKey: '',
            });
            runtime.vision = { baseUrl: v.baseUrl, model: v.model || 'vision' };
          } else {
            deps.provider.setVision(null);
            runtime.vision = null;
          }
        }
        // 持久化（apiKey 除外 —— 零落盘）
        await persistSettings().catch(() => {});
        const cfg = deps.provider.getConfig();
        return json(res, 200, { ok: true, model: cfg.model, baseUrl: cfg.baseUrl, autoApprove: runtime.autoApprove, vision: runtime.vision });
      }

      if (pathname === '/api/feedback' && req.method === 'POST') {
        const body = await readJson(req);
        const content = String(body?.content ?? '').trim();
        if (!content) return json(res, 400, { error: 'content 不能为空' });
        const dir = resolve(deps.workspaceRoot, 'data');
        await mkdir(dir, { recursive: true });
        await appendFile(
          resolve(dir, 'feedback.jsonl'),
          JSON.stringify({ ts: new Date().toISOString(), content }) + '\n',
          'utf8',
        );
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/feedback' && req.method === 'GET') {
        let items: Array<{ ts: string; content: string }> = [];
        try {
          const text = await readFile(resolve(deps.workspaceRoot, 'data', 'feedback.jsonl'), 'utf8');
          items = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { ts: string; content: string }).reverse();
        } catch {
          /* 无反馈文件 */
        }
        return json(res, 200, { items });
      }

      if (pathname === '/api/sessions' && req.method === 'GET') {
        return json(res, 200, { sessions: await deps.store.list() });
      }
      if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readJson(req);
        const id = await deps.store.create(String(body?.title ?? '新会话').slice(0, 60));
        return json(res, 200, { id });
      }

      let m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)\/events$/);
      if (m && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0) || 0;
        const events = await deps.store.read(m[1]!).catch(() => null);
        if (!events) return json(res, 404, { error: '会话不存在' });
        const fresh = events.filter((e) => e.seq > since);
        const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
        return json(res, 200, { events: fresh, lastSeq });
      }

      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)\/turns$/);
      if (m && req.method === 'POST') {
        const sessionId = m[1]!;
        const body = await readJson(req);
        const text = String(body?.text ?? '').trim();
        if (!text) return json(res, 400, { error: 'text 不能为空' });
        if (busy.has(sessionId)) return json(res, 409, { error: '该会话正在处理一轮，请稍候' });
        busy.add(sessionId);
        void runOne(sessionId, text, body, res);
        return;
      }

      // 流式回合（SSE）：delta 逐 token；过程事件实时；客户端断开 = 中断生成
      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)\/turns\/stream$/);
      if (m && req.method === 'POST') {
        const sessionId = m[1]!;
        const body = await readJson(req);
        const text = String(body?.text ?? '').trim();
        if (!text) return json(res, 400, { error: 'text 不能为空' });
        if (busy.has(sessionId)) return json(res, 409, { error: '该会话正在处理一轮，请稍候' });
        busy.add(sessionId);

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const sse = (event: string, data: unknown): void => {
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch {
            /* 客户端断开 */
          }
        };
        const ac = new AbortController();
        let closed = false;
        aborts.set(sessionId, ac);
        // 断开检测挂在 res 上（req 的 close 在 body 读完就触发，不能作为中断信号）
        res.on('close', () => {
          closed = true;
          ac.abort();
        });

        try {
          const history = await getHistory(sessionId);
          // 多模态：parts（含图片分片）与附件路径由 UI 构造并校验透传
          const parts = Array.isArray(body?.parts) ? (body.parts as Array<Record<string, unknown>>).slice(0, 8) : undefined;
          const attachments = Array.isArray(body?.attachments)
            ? (body.attachments as unknown[]).map(String).slice(0, 8)
            : undefined;
          const result = await runTurnStream(
            text,
            history,
            {
              provider: deps.provider,
              registry: deps.registry,
              store: deps.store,
              ctx: buildTurnCtx(sessionId, body?.autoApprove === true, sse),
              sessionId,
              signal: ac.signal,
              maxHistoryMessages: 40,
              temperature: runtime.params.temperature,
              maxTokens: typeof runtime.params.maxTokens === 'number' && runtime.params.maxTokens > 0 ? runtime.params.maxTokens : undefined,
              ...(parts && parts.length ? { parts: parts as unknown as import('../llm/types.ts').ContentPart[] } : {}),
              ...(attachments && attachments.length ? { attachments } : {}),
            },
            sse,
          );
          if (!closed) sse('done', { reply: result.reply, rounds: result.rounds });
          void autoTitle(sessionId, text, result.reply); // 流式同样触发自动标题
        } catch (err) {
          if (!closed) sse('error', { message: (err as Error).message });
        } finally {
          busy.delete(sessionId);
          aborts.delete(sessionId);
          if (!closed) res.end();
        }
        return;
      }

      // 显式中止端点：不依赖客户端断开 socket（keep-alive 下 abort 不一定关连接）
      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)\/abort$/);
      if (m && req.method === 'POST') {
        const ac = aborts.get(m[1]!);
        ac?.abort();
        return json(res, 200, { ok: true, aborted: ac ? ac.signal.aborted : false });
      }

      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)\/rename$/);
      if (m && req.method === 'POST') {
        const body = await readJson(req);
        const title = String(body?.title ?? '').trim();
        if (!title) return json(res, 400, { error: 'title 不能为空' });
        await deps.store.rename(m[1]!, title);
        return json(res, 200, { ok: true });
      }

      // 编辑重发：截断 beforeSeq 之后的所有事件（含该消息），历史缓存作废
      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)\/truncate$/);
      if (m && req.method === 'POST') {
        const body = await readJson(req);
        const beforeSeq = Number(body?.beforeSeq);
        const kept = await deps.store.truncateTo(m[1]!, beforeSeq);
        histories.delete(m[1]!);
        return json(res, 200, { kept });
      }

      // 分叉会话：复制全部历史到新会话
      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)\/fork$/);
      if (m && req.method === 'POST') {
        const newId = await deps.store.fork(m[1]!);
        return json(res, 200, { id: newId });
      }

      // 归档/取消归档
      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)\/archive$/);
      if (m && req.method === 'POST') {
        const body = await readJson(req);
        await deps.store.setArchived(m[1]!, body?.archived !== false);
        return json(res, 200, { ok: true, archived: body?.archived !== false });
      }

      if (pathname === '/api/approvals/pending' && req.method === 'GET') {
        return json(res, 200, { pending: deps.broker.listPending() });
      }
      m = pathname.match(/^\/api\/approvals\/([a-f0-9]+)\/decision$/);
      if (m && req.method === 'POST') {
        const body = await readJson(req);
        const ok = deps.broker.decide(m[1]!, body?.approved === true);
        // 审批记忆：勾选「总是允许」→ 本会话内该工具后续直接放行
        if (ok && body?.approved === true && typeof body?.rememberTool === 'string' && body.rememberTool) {
          if (!allowlist.has(String(body.sessionId))) allowlist.set(String(body.sessionId), new Set());
          allowlist.get(String(body.sessionId))!.add(String(body.rememberTool));
        }
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: '审批不存在或已处理' });
      }

      m = pathname.match(/^\/api\/sandbox\/rollback$/);
      if (m && req.method === 'POST') {
        const body = await readJson(req);
        const sessionId = String(body?.sessionId ?? '');
        const sandbox = sandboxes.get(sessionId);
        if (!sandbox) return json(res, 404, { error: '该会话没有沙箱记录' });
        const restored = await sandbox.rollback();
        await deps.store.append(sessionId, 'note', { text: `[sandbox] 已回滚：${restored.join('、')}` });
        return json(res, 200, { restored });
      }

      m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]+)$/);
      if (m && req.method === 'DELETE') {
        await deps.store.delete(m[1]!);
        histories.delete(m[1]!);
        sandboxes.delete(m[1]!);
        return json(res, 200, { ok: true });
      }

      // ---- 办公套件：工作区笔记文件（守卫 + 大小限制，仅 notes/ 目录） ----
      if (pathname === '/api/notes' && req.method === 'GET') {
        const dir = assertGuardedPath(sandboxPolicy, deps.workspaceRoot, 'notes').abs;
        await mkdir(dir, { recursive: true });
        const names = (await readdir(dir)).filter((f) => !f.startsWith('.'));
        const out = [];
        for (const name of names) {
          const st = await stat(resolve(dir, name));
          if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
        }
        out.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return json(res, 200, { files: out });
      }
      if (pathname === '/api/note' && req.method === 'GET') {
        const p = url.searchParams.get('path') ?? '';
        const { abs, rel } = assertGuardedPath(sandboxPolicy, deps.workspaceRoot, p);
        if (!rel.startsWith('notes/')) return json(res, 400, { error: '笔记只允许 notes/ 目录' });
        const content = await readFile(abs, 'utf8');
        return json(res, 200, { path: rel, content });
      }
      if (pathname === '/api/note' && req.method === 'POST') {
        const body = await readJson(req);
        const p = String(body?.path ?? '');
        const content = String(body?.content ?? '');
        const { abs, rel } = assertGuardedPath(sandboxPolicy, deps.workspaceRoot, p);
        if (!rel.startsWith('notes/')) return json(res, 400, { error: '笔记只允许 notes/ 目录' });
        assertSizeOk(sandboxPolicy, content);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
        return json(res, 200, { ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') });
      }
      if (pathname === '/api/note' && req.method === 'DELETE') {
        const p = url.searchParams.get('path') ?? '';
        const { abs, rel } = assertGuardedPath(sandboxPolicy, deps.workspaceRoot, p);
        if (!rel.startsWith('notes/')) return json(res, 400, { error: '笔记只允许 notes/ 目录' });
        await rm(abs, { force: true });
        return json(res, 200, { ok: true });
      }

      // ---- 附件上传（存工作区 attachments/；图片可内联给多模态端点） ----
      if (pathname === '/api/upload' && req.method === 'POST') {
        const body = await readJson(req);
        const nameRaw = String(body?.name ?? 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        const b64 = String(body?.base64 ?? '');
        if (!b64) return json(res, 400, { error: 'base64 不能为空' });
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 8 * 1024 * 1024) return json(res, 400, { error: '附件超过 8MB 上限' });
        const isImage = /^image\//.test(String(body?.mime ?? ''));
        const dir = resolve(deps.workspaceRoot, 'attachments');
        await mkdir(dir, { recursive: true });
        const stamp = Date.now();
        const file = `${stamp}-${nameRaw}`;
        await writeFile(resolve(dir, file), buf);
        return json(res, 200, { path: `attachments/${file}`, isImage, bytes: buf.length });
      }

      if (pathname === '/api/agents' && req.method === 'GET') {
        return json(res, 200, { agents: loadAgents() });
      }

      // ---- 上下文分析（统计卡/组成/趋势；token 为字符估算口径） ----
      m = pathname.match(/^\/api\/context\/([A-Za-z0-9-]+)$/);
      if (m && req.method === 'GET') {
        const events = await deps.store.read(m[1]!).catch(() => []);
        const estTok = (s: unknown) => Math.ceil(String(s ?? '').length / 2);
        const sysPrompt = buildSystemPrompt(deps.workspaceRoot, deps.registry.names());
        const toolsJson = JSON.stringify(deps.registry.toSpecs());
        const systemTok = estTok(sysPrompt) + estTok(toolsJson);

        let userTok = 0, asstTok = 0, toolResTok = 0;
        for (const e of events) {
          if (e.type === 'user') userTok += estTok(e.text);
          else if (e.type === 'assistant' && !e.withToolCalls) asstTok += estTok(e.text);
          else if (e.type === 'tool_result') toolResTok += estTok(e.preview);
        }

        // 趋势：逐请求累计上下文估算；compaction 事件为重置点
        const trend = [];
        let run = systemTok;
        let turn = 0;
        for (const e of events) {
          if (e.type === 'compaction') {
            run = systemTok + estTok(e.summary);
            trend.push({ type: 'compaction', turn: trend.filter((t) => t.type === 'request').length, tokens: run });
            continue;
          }
          if (e.type === 'user') {
            turn += 1;
            run += estTok(e.text);
            trend.push({ type: 'request', turn, tokens: run });
            continue;
          }
          run += estTok(e.type === 'assistant' ? e.text : (e.preview ?? e.summary ?? ''));
        }

        let billingIn = 0, billingOut = 0;
        for (const e of events) {
          if (e.usage && typeof e.usage.total_tokens === 'number') {
            billingIn += e.usage.prompt_tokens ?? 0;
            billingOut += e.usage.completion_tokens ?? 0;
          }
        }

        const callTs = new Map();
        let toolCalls = 0, toolMs = 0;
        for (const e of events) {
          if (e.type === 'tool_call') { toolCalls += 1; callTs.set(String(e.callId), Date.parse(e.ts)); }
          else if (e.type === 'tool_result') {
            const t0 = callTs.get(String(e.callId));
            if (t0) toolMs += Math.max(0, Date.parse(e.ts) - t0);
          }
        }
        const activeMs = events.length > 1 ? Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts) : 0;

        return json(res, 200, {
          rounds: events.filter((e) => e.type === 'user').length,
          steps: toolCalls,
          billing: { input: billingIn, output: billingOut },
          toolCalls, toolMs, activeMs,
          modelCalls: events.filter((e) => e.type === 'assistant' && !e.withToolCalls).length,
          model: deps.provider.getConfig().model,
          window: null, // 端点未报告窗口大小
          composition: { system: systemTok, user: userTok, assistant: asstTok, toolResult: toolResTok },
          currentTokens: systemTok + userTok + asstTok + toolResTok,
          trend,
          compactions: events.filter((e) => e.type === 'compaction').length,
        });
      }

      // ---- 审计：跨会话审批请求/决策汇总（按时间倒序） ----
      if (pathname === '/api/audit' && req.method === 'GET') {
        const summaries = await deps.store.list().catch(() => []);
        const rows: Array<{ ts: string; sid: string; title: string; kind: 'request' | 'decision'; tool: string; detail: string }> = [];
        for (const s of summaries.slice(0, 80)) {
          let text = '';
          try { text = await readFile(s.file, 'utf8'); } catch { continue; }
          const lines = text.split('\n').filter((l) => l.trim());
          const pend = new Map<string, string>();
          for (const l of lines) {
            let e: Record<string, unknown>;
            try { e = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
            const rid = String(e.requestId ?? '');
            if (e.type === 'approval_request') {
              pend.set(rid, String(e.tool ?? ''));
              rows.push({ ts: String(e.ts ?? ''), sid: s.id, title: s.title, kind: 'request', tool: String(e.tool ?? ''), detail: String(e.detail ?? '') });
            } else if (e.type === 'approval_decision') {
              rows.push({ ts: String(e.ts ?? ''), sid: s.id, title: s.title, kind: 'decision', tool: pend.get(rid) ?? '', detail: e.approved ? '允许' : '拒绝' });
            }
          }
          if (rows.length >= 300) break;
        }
        rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
        return json(res, 200, { rows: rows.slice(0, 300) });
      }

      // ---- 会话计划（todo 工具的存储） ----
      m = pathname.match(/^\/api\/todos\/([A-Za-z0-9-]+)$/);
      if (m && req.method === 'GET') {
        const items = await loadTodos(deps.workspaceRoot, m[1]!);
        return json(res, 200, { items });
      }

      // ---- 全文检索（SQLite 投影；不可用时空结果） ----
      if (pathname === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const hits = await projection.search(q);
        return json(res, 200, { hits, available: projection.available });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }

  /** 每会话历史（跨轮记忆） */
  async function getHistory(sessionId: string): Promise<ChatMessage[]> {
    let history = histories.get(sessionId);
    if (!history) {
      history = await replayHistory(deps.store, sessionId);
      histories.set(sessionId, history);
    }
    return history;
  }

  /** 回合工具上下文：沙箱 + 审批门（审批事件可同时 emit 给 SSE） */
  function buildTurnCtx(sessionId: string, autoApproveOnce: boolean, emit?: (event: string, data: Record<string, unknown>) => void): ToolContext {
    let sandbox = sandboxes.get(sessionId);
    if (!sandbox) {
      sandbox = new SandboxSession({
        workspaceRoot: deps.workspaceRoot,
        journalDir: resolve(deps.workspaceRoot, 'data', 'sandbox'),
        policy: sandboxPolicy,
        log: deps.log,
      });
      sandboxes.set(sessionId, sandbox);
    }
    return {
      workspaceRoot: deps.workspaceRoot,
      log: deps.log,
      sessionId,
      sandbox,
      approval: async (req) => {
        // 审批记忆：本会话已允许过的工具直接放行
        if (allowlist.get(sessionId)?.has(req.tool)) {
          const ev0 = await deps.store.append(sessionId, 'approval_decision', { approved: true, remembered: true });
          emit?.('approval_decision', ev0 as unknown as Record<string, unknown>);
          return true;
        }
        if (autoApproveOnce || runtime.autoApprove) {
          deps.log(`[审批] 无人值守自动通过：${req.action} → ${req.detail}`);
          const ev = await deps.store.append(sessionId, 'approval_decision', { approved: true, auto: true });
          emit?.('approval_decision', ev as unknown as Record<string, unknown>);
          return true;
        }
        let approvalIdRef: string | null = null;
        const approved = await deps.broker.request(req, sessionId, async (approvalId) => {
          approvalIdRef = approvalId;
          const ev = await deps.store.append(sessionId, 'approval_request', {
            approvalId,
            tool: req.tool,
            action: req.action,
            detail: req.detail,
          });
          emit?.('approval_request', ev as unknown as Record<string, unknown>);
        });
        const ev = await deps.store.append(sessionId, 'approval_decision', {
          approved,
          approvalId: approvalIdRef,
        });
        emit?.('approval_decision', ev as unknown as Record<string, unknown>);
        return approved;
      },
    };
  }

  async function runOne(
    sessionId: string,
    text: string,
    body: { autoApprove?: boolean } | null,
    res: ServerResponse,
  ): Promise<void> {
    const history = await getHistory(sessionId);
    const turnCtx = buildTurnCtx(sessionId, body?.autoApprove === true);
    try {
      const { reply, rounds } = await runTurn(text, history, {
        provider: deps.provider,
        registry: deps.registry,
        store: deps.store,
        ctx: turnCtx,
        sessionId,
        maxHistoryMessages: 40,
      });
      json(res, 200, { reply, rounds });
      void autoTitle(sessionId, text, reply); // 首轮成功后自动生成标题（后台执行）
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    } finally {
      busy.delete(sessionId);
    }
  }

  /** 会话自动标题（：标题仍是「新会话」时，首轮完成后用 LLM 生成 8 字内标题 */
  async function autoTitle(sessionId: string, userText: string, reply: string): Promise<void> {
    try {
      const events = await deps.store.read(sessionId);
      const first = events[0] as { type?: string; title?: string } | undefined;
      if (!first || first.type !== 'session_start' || (first.title ?? '') !== '新会话') return;
      const res = await deps.provider.chat({
        messages: [
          { role: 'system', content: '为对话生成一个不超过 8 个汉字的中文标题。只输出标题本身，不要引号、句号或任何解释。' },
          { role: 'user', content: `用户说：${userText.slice(0, 300)}\n\n助手答：${reply.slice(0, 200)}` },
        ],
        temperature: 0.2,
        maxTokens: 32,
      });
      let title = (res.choices[0]?.message?.content ?? '').trim().replace(/^["'「『]|["'」』]$/g, '').split('\n')[0]!.slice(0, 20);
      title = title.replace(/^标题[:：]\s*/, '');
      // 2-bit 小模型会把指令复述成"标题"：含指令词或长度异常 → 用用户消息前 12 字兜底
      const junk = title.length < 2 || title.length > 16 || /标题|汉字|输出|生成|翻译|解释|规则|助手/.test(title);
      if (!title || junk) title = userText.replace(/\s+/g, ' ').slice(0, 12);
      if (!title || title === '新会话') return;
      await deps.store.rename(sessionId, title);
      deps.log(`[title] 会话 ${sessionId} →「${title}」`);
    } catch {
      /* 标题生成失败无所谓 */
    }
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('请求体过大');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
