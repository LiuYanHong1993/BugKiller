// 内核侧车宿主：stdio JSON-RPC
// 壳（Electron / Node 壳）拉起本进程；带令牌 Web UI 的 URL 经 initialize 结果上报给壳
// 凭据经 initialize 参数注入 provider——只进内存，零落盘、零日志

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { cwd, env, stdin, stdout } from 'node:process';
import { loadCatalog, resolvePreset } from '../llm/catalog.ts';
import { OpenAiCompatibleProvider } from '../llm/provider.ts';
import { createDefaultRegistry } from '../tools/index.ts';
import type { ToolContext } from '../tools/types.ts';
import { SessionStore } from '../sessions/store.ts';
import type { SessionEvent } from '../sessions/store.ts';
import { replayHistory } from '../sessions/replay.ts';
import { loadPolicy } from '../policy.ts';
import { ApprovalBroker } from '../server/approvals.ts';
import { startServer } from '../server/http.ts';
import { mountMcpServers } from '../mcp/index.ts';
import { loadPlugins } from '../plugins/loader.ts';
import type { PluginLoadReport } from '../plugins/types.ts';
import { runTurn } from '../agent/loop.ts';
import { SandboxSession } from '../sandbox/session.ts';
import { loadSandboxPolicy } from '../sandbox/policy.ts';

interface RpcReq {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  stdout.write(JSON.stringify(msg) + '\n');
}

async function main(): Promise<void> {
  const workspaceRoot = env.MYAGENT_WORKSPACE ? resolve(env.MYAGENT_WORKSPACE) : cwd();
  const policyDir = resolve(workspaceRoot, 'policy');
  const dataDir = resolve(workspaceRoot, 'data', 'sessions');

  const preset = resolvePreset(loadCatalog(policyDir));
  const provider = new OpenAiCompatibleProvider(preset);
  const registry = createDefaultRegistry();
  const store = new SessionStore(dataDir);
  const policy = loadPolicy(policyDir);
  const broker = new ApprovalBroker(300_000);

  const bootCtx: ToolContext = {
    workspaceRoot,
    approval: async () => false,
    log: (l) => send({ jsonrpc: '2.0', method: 'log', params: { line: l } }),
  };

  const pluginReports: PluginLoadReport[] = await loadPlugins({ workspaceRoot, registry, ctx: bootCtx });
  const mounts = await mountMcpServers(policyDir, workspaceRoot, registry, bootCtx);
  const mcpSummary = mounts.map((m) => `${m.name}(${m.tools.join('/')})`).join(', ') || '无';
  const pluginSummary =
    pluginReports.filter((r) => r.status === 'loaded').map((r) => r.name).join(', ') || '无';

  // 内嵌 Web UI（M2 同款）：带令牌 URL 只经 initialize 上报一次
  const webUrl = await startServer({
    workspaceRoot,
    store,
    registry,
    provider,
    preset,
    policy,
    broker,
    mcpSummary,
    log: bootCtx.log,
  });

  // 事件通知：所有会话事件（无论谁写入）都推给壳
  const origAppend = store.append.bind(store);
  store.append = async (sessionId: string, type: SessionEvent['type'], data: Record<string, unknown>) => {
    const ev = await origAppend(sessionId, type, data);
    send({ jsonrpc: '2.0', method: 'event', params: { sessionId, event: ev } });
    return ev;
  };
  // create 不走 append（直接写 session_start），单独包一层
  const origCreate = store.create.bind(store);
  store.create = async (title: string) => {
    const id = await origCreate(title);
    const evs = await store.read(id).catch(() => []);
    if (evs[0]) send({ jsonrpc: '2.0', method: 'event', params: { sessionId: id, event: evs[0] } });
    return id;
  };

  const busy = new Set<string>();
  const histories = new Map<string, Awaited<ReturnType<typeof replayHistory>>>();
  const sandboxPolicy = loadSandboxPolicy(resolve(workspaceRoot, 'policy'));
  const sandboxes = new Map<string, SandboxSession>();

  const state = () => ({
    model: provider.getConfig().model,
    baseUrl: provider.getConfig().baseUrl,
    mode: policy.mode,
    autoApprove: policy.autoApprove,
    workspaceRoot,
    plugins: pluginSummary,
    mcp: mcpSummary,
    tools: registry.names(),
  });

  async function dispatch(req: RpcReq): Promise<unknown> {
    switch (req.method) {
      case 'initialize': {
        const p = req.params ?? {};
        provider.updateConfig({
          apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
          baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : undefined,
          model: typeof p.model === 'string' ? p.model : undefined,
        });
        return { protocol: 'myagent.ipc/v1', webUrl, state: state() };
      }
      case 'state.get':
        return state();
      case 'session.create': {
        const title = String((req.params ?? {}).title ?? '新会话').slice(0, 60);
        return { id: await store.create(title) };
      }
      case 'session.list':
        return { sessions: await store.list() };
      case 'session.events': {
        const p = req.params ?? {};
        const id = String(p.id ?? '');
        const since = Number(p.since ?? 0) || 0;
        const events = await store.read(id).catch(() => null);
        if (!events) throw new Error('会话不存在');
        return { events: events.filter((e) => e.seq > since), lastSeq: events.length ? events[events.length - 1]!.seq : 0 };
      }
      case 'approval.pending':
        return { pending: broker.listPending() };
      case 'approval.decide': {
        const p = req.params ?? {};
        const ok = broker.decide(String(p.id ?? ''), p.approved === true);
        if (!ok) throw new Error('审批不存在或已处理');
        return { ok: true };
      }
      case 'sandbox.rollback': {
        const p = req.params ?? {};
        const sessionId = String(p.sessionId ?? '');
        const sandbox = sandboxes.get(sessionId);
        if (!sandbox) throw new Error('该会话没有沙箱记录');
        const restored = await sandbox.rollback();
        await store.append(sessionId, 'note', { text: `[sandbox] 已回滚：${restored.join('、')}` });
        return { restored };
      }
      case 'turn.run': {
        const p = req.params ?? {};
        const sessionId = String(p.sessionId ?? '');
        const text = String(p.text ?? '').trim();
        if (!sessionId || !text) throw new Error('sessionId 与 text 必填');
        if (busy.has(sessionId)) throw new Error('该会话正在处理一轮，请稍候');
        busy.add(sessionId);
        try {
          return await runOne(sessionId, text, p.autoApprove === true);
        } finally {
          busy.delete(sessionId);
        }
      }
      default:
        throw new Error(`未知方法：${req.method}`);
    }
  }

  async function runOne(sessionId: string, text: string, autoApprove: boolean): Promise<unknown> {
    let history = histories.get(sessionId);
    if (!history) {
      history = await replayHistory(store, sessionId);
      histories.set(sessionId, history);
    }
    let sandbox = sandboxes.get(sessionId);
    if (!sandbox) {
      sandbox = new SandboxSession({
        workspaceRoot,
        journalDir: resolve(workspaceRoot, 'data', 'sandbox'),
        policy: sandboxPolicy,
        log: bootCtx.log,
      });
      sandboxes.set(sessionId, sandbox);
    }
    const turnCtx: ToolContext = {
      workspaceRoot,
      log: bootCtx.log,
      sessionId,
      sandbox,
      approval: async (req) => {
        if (autoApprove) {
          bootCtx.log(`[审批] 无人值守自动通过：${req.action} → ${req.detail}`);
          await store.append(sessionId, 'approval_decision', { approved: true, auto: true });
          return true;
        }
        const approved = await broker.request(req, sessionId, async (approvalId) => {
          await store.append(sessionId, 'approval_request', {
            approvalId,
            tool: req.tool,
            action: req.action,
            detail: req.detail,
          });
        });
        await store.append(sessionId, 'approval_decision', { approved });
        return approved;
      },
    };
    return runTurn(text, history, { provider, registry, store, ctx: turnCtx, sessionId });
  }

  const rl = createInterface({ input: stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: RpcReq;
    try {
      req = JSON.parse(trimmed) as RpcReq;
    } catch {
      return;
    }
    if (typeof req.id !== 'number' || !req.method) return;
    dispatch(req).then(
      (result) => send({ jsonrpc: '2.0', id: req.id, result }),
      (err: Error) => send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: err.message } }),
    );
  });

  bootCtx.log(`[sidecar] 就绪：${state().model} ｜ 工具 ${registry.names().length} 个 ｜ 插件 ${pluginSummary}`);
}

main().catch((e) => {
  send({ jsonrpc: '2.0', method: 'fatal', params: { message: (e as Error).message } });
  process.exit(1);
});
