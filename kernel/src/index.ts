// agent-platform 内核 CLI（M1）：一次性任务 + 交互会话
//
// 用法：
//   node scripts/dev.js "把 README 摘要写进 notes/summary.txt"   —— 一次性任务
//   node scripts/dev.js                                          —— 交互会话
//   node scripts/dev.js --list                                   —— 会话列表
//   node scripts/dev.js --session <id> [继续的任务]               —— 继续会话

import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { argv, cwd, env, exit, stdin, stdout } from 'node:process';
import type { ChatMessage } from './llm/types.ts';
import { loadCatalog, resolvePreset } from './llm/catalog.ts';
import { OpenAiCompatibleProvider } from './llm/provider.ts';
import { createDefaultRegistry } from './tools/index.ts';
import type { ApprovalRequest, ToolContext } from './tools/types.ts';
import { SessionStore } from './sessions/store.ts';
import { runTurn } from './agent/loop.ts';
import { loadPolicy } from './policy.ts';
import { replayHistory } from './sessions/replay.ts';
import { loadPlugins } from './plugins/loader.ts';

function printHelp(): void {
  console.log(
    [
      'agent-platform M1 内核 CLI',
      '',
      '用法：node scripts/dev.js [选项] [任务描述]',
      '',
      '选项：',
      '  --session <id>   继续指定会话（默认新建）',
      '  --list           列出历史会话后退出',
      '  --help           显示本帮助',
      '',
      '环境变量：',
      '  MYAGENT_WORKSPACE                      工作区根目录（默认当前目录）',
      '  MYAGENT_PRESET                         模型预设 id（默认取目录 defaultPreset）',
      '  MYAGENT_BASE_URL / MYAGENT_MODEL       覆盖预设端点与模型',
      '  MYAGENT_API_KEY                        模型凭据（本地 llama.cpp 可留空）',
      '  MYAGENT_AUTO_APPROVE=1                 无人值守：写文件审批自动通过',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    return;
  }

  const workspaceRoot = env.MYAGENT_WORKSPACE ? resolve(env.MYAGENT_WORKSPACE) : cwd();
  const policyDir = resolve(workspaceRoot, 'policy');
  const dataDir = resolve(workspaceRoot, 'data', 'sessions');

  if (args.includes('--list')) {
    const store = new SessionStore(dataDir);
    const sessions = await store.list();
    if (sessions.length === 0) {
      console.log('(还没有会话)');
      return;
    }
    for (const s of sessions) {
      console.log(`${s.id}  ${String(s.events).padStart(4)} 事件  ${s.title}`);
    }
    return;
  }

  let preset;
  try {
    preset = resolvePreset(loadCatalog(policyDir), env);
  } catch (e) {
    console.error(`[配置错误] ${(e as Error).message}`);
    exit(1);
    return;
  }

  const provider = new OpenAiCompatibleProvider(preset);
  const registry = createDefaultRegistry();
  const store = new SessionStore(dataDir);
  const policy = loadPolicy(policyDir);

  const rl = createInterface({ input: stdin, output: stdout });
  const ctx: ToolContext = {
    workspaceRoot,
    approval: async () => false,
    log: (line) => console.log(`  ${line}`),
  };
  await loadPlugins({ workspaceRoot, registry, ctx });
  ctx.approval = async (req: ApprovalRequest): Promise<boolean> => {
    if (policy.autoApprove) {
      ctx.log(`[审批] 无人值守自动通过：${req.action} → ${req.detail}`);
      return true;
    }
    const ans = await rl.question(`\n[审批] ${req.action} → ${req.detail}\n        允许？(y/N) `);
    const ok = ans.trim().toLowerCase() === 'y';
    console.log(ok ? '        ✓ 已允许' : '        ✗ 已拒绝');
    return ok;
  };

  let promptText = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session') {
      i++;
      continue;
    }
    promptText += (promptText ? ' ' : '') + args[i];
  }
  promptText = promptText.trim();

  const given = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;
  let sessionId: string =
    given ?? (await store.create(promptText ? promptText.slice(0, 60) : '交互会话'));

  console.log(`agent-platform M1 ｜ 工作区 ${workspaceRoot}`);
  console.log(
    `模型 ${preset.model} @ ${preset.baseUrl} ｜ 权限 ${policy.mode}${policy.autoApprove ? '（无人值守）' : ''} ｜ 工具 ${registry.names().join(', ')}`,
  );
  console.log(`会话 ${sessionId}（data/sessions/${sessionId}.jsonl）`);

  if (promptText) {
    const history: ChatMessage[] = [];
    try {
      const { reply, rounds } = await runTurn(promptText, history, {
        provider,
        registry,
        store,
        ctx,
        sessionId,
      });
      console.log(`\n助手：${reply}`);
      console.log(`\n（${rounds} 轮内完成，会话已存档）`);
    } catch (e) {
      console.error(`\n[模型调用失败] ${(e as Error).message}`);
      console.error('提示：确认本地模型服务已启动（例如 D:\\AI\\start-qwen.bat），或用 MYAGENT_BASE_URL/MYAGENT_MODEL 指向可用端点。');
      rl.close();
      exit(1);
    }
    rl.close();
    return;
  }

  console.log('\n输入任务或问题开始对话；命令：/list 会话列表 · /open <id> 继续会话 · /quit 退出\n');
  const history: ChatMessage[] = [];
  for (;;) {
    let line: string;
    try {
      line = (await rl.question('你：')).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === '/quit' || line === '/exit') break;
    if (line === '/list') {
      for (const s of await store.list()) {
        console.log(`  ${s.id}  ${s.events} 事件  ${s.title}`);
      }
      continue;
    }
    if (line.startsWith('/open ')) {
      const id = line.slice(6).trim();
      try {
        history.length = 0;
        history.push(...(await replayHistory(store, id)));
        sessionId = id;
        console.log(`已切换到会话 ${id}（回放 ${history.length} 条消息）`);
      } catch (e) {
        console.log(`  ${(e as Error).message}`);
      }
      continue;
    }
    try {
      const { reply } = await runTurn(line, history, { provider, registry, store, ctx, sessionId });
      console.log(`\n助手：${reply}\n`);
    } catch (e) {
      console.error(`\n[模型调用失败] ${(e as Error).message}\n`);
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error('[fatal]', e);
  exit(1);
});
