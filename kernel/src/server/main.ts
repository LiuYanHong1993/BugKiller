// 服务模式入口：node scripts/serve.js

import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { readFileSync } from 'node:fs';
import { loadCatalog, resolvePreset, type ModelPreset } from '../llm/catalog.ts';
import { OpenAiCompatibleProvider } from '../llm/provider.ts';
import { createDefaultRegistry } from '../tools/index.ts';
import type { ToolContext } from '../tools/types.ts';
import { SessionStore } from '../sessions/store.ts';
import { loadPolicy } from '../policy.ts';
import { ApprovalBroker } from './approvals.ts';
import { startServer } from './http.ts';
import { mountMcpServers } from '../mcp/index.ts';
import { logLine } from './logbuf.ts';

// 接管 console 输出：写入环形缓冲（/api/logs 查看）+ 原样输出到 stdout（客户端捕获）
const origStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a: unknown[]): void => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  logLine(line);
  origStdoutWrite(line + '\n');
};
console.error = (...a: unknown[]): void => {
  const line = '[err] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  logLine(line);
  origStdoutWrite(line + '\n');
};
import { loadPlugins } from '../plugins/loader.ts';

async function main(): Promise<void> {
  // 客户端（父进程）被杀后内核继续存活：忽略 EPIPE，别让日志写进已关闭的管道导致进程退出
  process.stdout?.on?.('error', () => {});
  process.stderr?.on?.('error', () => {});
  const workspaceRoot = process.env.MYAGENT_WORKSPACE
    ? resolve(process.env.MYAGENT_WORKSPACE)
    : cwd();
  const policyDir = resolve(workspaceRoot, 'policy');
  const dataDir = resolve(workspaceRoot, 'data', 'sessions');

  const preset = resolvePreset(loadCatalog(policyDir));
  const policy = loadPolicy(policyDir);

  // 配置层叠：catalog（含 env 覆盖）→ data/kernel-settings.json（设置页持久层，最后生效）
  // 注意：apiKey 永不进该文件（零落盘原则），仅经 IPC/API 进内存
  let settings: { baseUrl?: string; model?: string; autoApprove?: boolean; vision?: { baseUrl?: string; model?: string }; params?: { temperature?: number; maxTokens?: number }; tokenDailyLimit?: number } = {};
  try {
    settings = JSON.parse(readFileSync(resolve(workspaceRoot, 'data', 'kernel-settings.json'), 'utf8'));
  } catch {
    /* 无设置文件则跳过 */
  }
  if (settings.baseUrl) preset.baseUrl = settings.baseUrl;
  if (settings.model) preset.model = settings.model;
  if (typeof settings.autoApprove === 'boolean') policy.autoApprove = settings.autoApprove;
  // 视觉（多模态）端点：设置页配置，带图请求自动路由
  let visionPreset: ModelPreset | null = null;
  const vs = settings.vision;
  if (vs && vs.baseUrl) {
    visionPreset = {
      id: 'vision',
      protocol: 'openai-chat',
      baseUrl: vs.baseUrl,
      model: vs.model || 'vision',
      apiKey: '',
      usagePolicy: { unattendedAutomation: 'allowed', note: '视觉端点（多模态模型）' },
    };
  }

  // Auto-model：主预设之外的全部预设作为 fallback（失败自动换模型，）
  const catalog = loadCatalog(policyDir);
  const primaryId = preset.id;
  const fallbacks = Object.keys(catalog.presets)
    .filter((id) => id !== primaryId)
    .slice(0, 3)
    .map((id) => {
      try {
        return resolvePreset(catalog, { ...process.env, MYAGENT_PRESET: id });
      } catch {
        return null;
      }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  const provider = new OpenAiCompatibleProvider(preset, { maxAttempts: 3, baseDelayMs: 500 }, fallbacks);
  const registry = createDefaultRegistry();
  const store = new SessionStore(dataDir);

  const bootCtx: ToolContext = {
    workspaceRoot,
    approval: async () => false,
    log: (l) => console.log(l),
  };
  const pluginReports = await loadPlugins({ workspaceRoot, registry, ctx: bootCtx });
  const pluginSummary =
    pluginReports
      .filter((r) => r.status === 'loaded')
      .map((r) => `${r.name}(${(r.tools ?? []).join('/')})`)
      .join(', ') || '无';
  const mounts = await mountMcpServers(policyDir, workspaceRoot, registry, bootCtx);
  const mcpSummary = mounts.map((m) => `${m.name}(${m.tools.join('/')})`).join(', ') || '无';

  const broker = new ApprovalBroker(300_000);
  const url = await startServer({
    workspaceRoot,
    store,
    registry,
    provider,
    preset,
    policy,
    broker,
    mcpSummary,
    vision: visionPreset,
    params: settings.params ?? null,
    tokenDailyLimit: typeof settings.tokenDailyLimit === 'number' ? settings.tokenDailyLimit : null,
    log: (l) => console.log(l),
  });

  console.log('agent-platform 内核服务（M6）');
  console.log(`模型 ${preset.model} @ ${preset.baseUrl} ｜ 权限 ${policy.mode}${policy.autoApprove ? '（无人值守）' : ''}`);
  console.log(`Auto-model fallback：${fallbacks.map((f) => f.model || f.id).join('、') || '无'}`);
  console.log(`插件 ${pluginSummary}`);
  console.log(`工具 ${registry.names().join(', ')}`);
  console.log(`MCP：${mcpSummary}`);
  console.log(`\n打开：${url}`);
  console.log('（令牌仅此一次打印；Ctrl+C 停止）');
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
